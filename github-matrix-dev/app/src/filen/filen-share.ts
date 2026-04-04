/**
 * Filen P2P sharing service — cross-account data sharing via Filen dead-drop.
 *
 * Uses Filen as an async transfer medium: one peer uploads encrypted data,
 * shares a download reference + decryption key via Matrix, and another peer
 * downloads from Filen at their convenience.
 *
 * Security model:
 * - Data is encrypted with a one-time AES-256-GCM key BEFORE upload to Filen
 * - The one-time key is distributed via Matrix room events (Megolm E2EE)
 * - Filen only sees an opaque encrypted blob
 * - Public links expose the Filen-encrypted blob — useless without the Matrix key
 *
 * Two sharing modes:
 * 1. Shared Filen account (org mode) — existing, all team members share credentials
 * 2. Cross-account sharing — each user uploads to their own Filen, shares public link
 */

import type { MatrixClient } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import { readLogSince } from '../db/log';
import { filenShareEventTypes } from '../lib/matrix-domain';
import { packEodb, unpackEodb, type EodbFile } from './eodb-format';
import {
  filenUploadFile,
  filenCreatePublicLink,
  filenDownloadPublicLink,
  filenDisablePublicLink,
  filenTrashFile,
  type FilenPublicLink,
} from './filen-api';
import { useFilenStore } from './filen-store';
import { processEvent } from '../db/fold';

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────

const DEFAULT_EXPIRATION_DAYS = 7;
const MAX_ACTIVE_SHARES = 3;    // keep last 3 share files

const _shareTypes = filenShareEventTypes();
const FILEN_SHARE_EVENT = _shareTypes.share;
const FILEN_LATEST_STATE = _shareTypes.latest;

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface FilenShareReference {
  space_id: string;
  file_url: string;
  link_uuid: string;
  link_key: string;
  file_uuid: string;
  encryption_key: string;   // base64 one-time AES-256-GCM key
  iv: string;               // base64 IV
  from_seq: number;
  to_seq: number;
  event_count: number;
  size_bytes: number;
  checksum: string;
  expires_at: string;
  type: 'snapshot' | 'delta' | 'backup';
  shared_by: string;
  shared_at: string;
}

// ──────────────────────────────────────────────────────────────
// One-time encryption helpers
// ──────────────────────────────────────────────────────────────

async function generateOneTimeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,   // extractable — we need to export it for sharing
    ['encrypt', 'decrypt'],
  );
}

async function exportKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

async function importKey(base64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
}

async function encryptWithOneTimeKey(
  key: CryptoKey,
  data: Uint8Array,
): Promise<{ ciphertext: Uint8Array; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data as unknown as BufferSource),
  );
  const ivBase64 = btoa(String.fromCharCode(...iv));
  const result = new Uint8Array(iv.byteLength + ct.byteLength);
  result.set(iv, 0);
  result.set(ct, iv.byteLength);
  return { ciphertext: result, iv: ivBase64 };
}

async function decryptWithOneTimeKey(
  key: CryptoKey,
  data: Uint8Array,
): Promise<Uint8Array> {
  const iv = data.slice(0, 12);
  const ct = data.slice(12);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, ct as unknown as BufferSource),
  );
}

// ──────────────────────────────────────────────────────────────
// FilenShareService
// ──────────────────────────────────────────────────────────────

export class FilenShareService {
  private store: EoStore;
  private spaceId: string;
  private spaceName: string;
  private spaceFolderUuid: string;
  private userId: string;
  private matrixClient: MatrixClient | null;
  private roomId: string | null;

  /** Track active shares for cleanup. */
  private activeShares: Array<{
    fileUuid: string;
    linkUuid: string;
    expiresAt: string;
  }> = [];

  constructor(opts: {
    store: EoStore;
    spaceId: string;
    spaceName: string;
    spaceFolderUuid: string;
    userId: string;
    matrixClient?: MatrixClient;
    roomId?: string;
  }) {
    this.store = opts.store;
    this.spaceId = opts.spaceId;
    this.spaceName = opts.spaceName;
    this.spaceFolderUuid = opts.spaceFolderUuid;
    this.userId = opts.userId;
    this.matrixClient = opts.matrixClient || null;
    this.roomId = opts.roomId || null;
  }

  /**
   * Share the current database state via Filen as a dead-drop.
   *
   * 1. Read events from `fromSeq`
   * 2. Pack as .eodb
   * 3. Encrypt with a one-time AES-256-GCM key
   * 4. Upload to Filen
   * 5. Create a public link
   * 6. Signal via Matrix (share event + state update)
   */
  async shareCurrentState(fromSeq: number = 0): Promise<FilenShareReference | null> {
    const { auth, masterKeys } = useFilenStore.getState();
    if (!auth) {
      console.warn('[EO-DB] Cannot share via Filen — not authenticated');
      return null;
    }

    const events = await readLogSince(this.store, fromSeq);
    if (events.length === 0) return null;

    const currentSeq = await this.store.getCurrentSeq();

    // Pack as .eodb
    const eodbFile: EodbFile = {
      version: 1,
      type: fromSeq === 0 ? 'snapshot' : 'backup',
      space_id: this.spaceId,
      space_name: this.spaceName,
      from_seq: fromSeq,
      to_seq: currentSeq,
      created_by: this.userId,
      created_at: new Date().toISOString(),
      events,
      prev_snapshots: [],
    };
    const binary = packEodb(eodbFile);

    // Encrypt with one-time key
    const oneTimeKey = await generateOneTimeKey();
    const { ciphertext, iv } = await encryptWithOneTimeKey(oneTimeKey, binary);
    const keyBase64 = await exportKey(oneTimeKey);

    // Compute checksum of encrypted blob
    const hashBuf = await crypto.subtle.digest('SHA-256', ciphertext as unknown as BufferSource);
    const checksum = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    // Ensure shared subfolder exists
    const sharedFolderUuid = await this.ensureSharedFolder(auth.apiKey, masterKeys);

    // Upload to Filen
    const filename = `share-${currentSeq}-${Date.now()}.eodb.enc`;
    const uploaded = await filenUploadFile(
      auth.apiKey, sharedFolderUuid, filename, ciphertext, masterKeys[0],
    );

    // Create public link
    const expiresAt = new Date(Date.now() + DEFAULT_EXPIRATION_DAYS * 86400_000).toISOString();
    let publicLink: FilenPublicLink;
    try {
      publicLink = await filenCreatePublicLink(
        auth.apiKey, uploaded.uuid, uploaded.fileKey,
        `${DEFAULT_EXPIRATION_DAYS}d`,
      );
    } catch (err) {
      console.warn('[EO-DB] Failed to create public link, cleaning up upload:', err);
      try { await filenTrashFile(auth.apiKey, uploaded.uuid); } catch { /* ignore */ }
      throw err;
    }

    // Track for cleanup
    this.activeShares.push({
      fileUuid: uploaded.uuid,
      linkUuid: publicLink.uuid,
      expiresAt,
    });

    const shareRef: FilenShareReference = {
      space_id: this.spaceId,
      file_url: publicLink.downloadUrl,
      link_uuid: publicLink.uuid,
      link_key: publicLink.key,
      file_uuid: uploaded.uuid,
      encryption_key: keyBase64,
      iv,
      from_seq: fromSeq,
      to_seq: currentSeq,
      event_count: events.length,
      size_bytes: ciphertext.byteLength,
      checksum,
      expires_at: expiresAt,
      type: fromSeq === 0 ? 'snapshot' : 'backup',
      shared_by: this.userId,
      shared_at: new Date().toISOString(),
    };

    // Signal via Matrix
    await this.signalShare(shareRef);

    // Cleanup old shares (keep last MAX_ACTIVE_SHARES)
    await this.cleanupOldShares(auth.apiKey);

    return shareRef;
  }

  /**
   * Download and apply a shared dataset from a Filen share reference.
   *
   * The share reference is obtained from a Matrix room event.
   * The encryption key and link key are in the reference (distributed via Megolm E2EE).
   */
  async applySharedData(
    ref: FilenShareReference,
    onEvent?: (event: any) => void,
  ): Promise<number> {
    // Download from Filen public link
    const encrypted = await filenDownloadPublicLink(ref.link_uuid, ref.link_key);

    // Verify checksum
    const hashBuf = await crypto.subtle.digest('SHA-256', encrypted as unknown as BufferSource);
    const checksum = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    if (checksum !== ref.checksum) {
      throw new Error('Filen share checksum mismatch — data may be corrupted');
    }

    // Decrypt with one-time key
    const key = await importKey(ref.encryption_key);
    const decrypted = await decryptWithOneTimeKey(key, encrypted);

    // Unpack .eodb and fold events
    const eodb = unpackEodb(decrypted);
    let lastSeq = 0;

    for (const event of eodb.events) {
      const seq = await processEvent(this.store, event, onEvent || this.onEventDefault);
      lastSeq = Math.max(lastSeq, seq);
    }

    console.log(
      `[EO-DB] Applied Filen share: ${eodb.events.length} events, ` +
      `seq ${ref.from_seq}→${ref.to_seq}`,
    );

    return lastSeq;
  }

  /**
   * Check room state for the latest Filen share and apply if newer than local.
   */
  async hydrateFromLatestShare(
    onEvent?: (event: any) => void,
  ): Promise<number | null> {
    if (!this.matrixClient || !this.roomId) return null;

    const room = this.matrixClient.getRoom(this.roomId);
    if (!room) return null;

    const stateEvent = room.currentState.getStateEvents(FILEN_LATEST_STATE, this.spaceId);
    if (!stateEvent) return null;

    const content = (stateEvent as any).getContent?.() ?? stateEvent;
    if (!content.to_seq) return null;

    const localSeq = await this.store.getCurrentSeq();
    if (content.to_seq <= localSeq) return null;

    // We have a share reference in the state — reconstruct FilenShareReference
    const ref = content as FilenShareReference;
    return this.applySharedData(ref, onEvent);
  }

  // ──────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────

  private onEventDefault = (event: any) => {
    this.onEvent?.(event);
  };

  private onEvent?: (event: any) => void;

  private async ensureSharedFolder(apiKey: string, masterKeys: string[]): Promise<string> {
    // Lazy import to avoid circular dependency
    const { filenEnsureFolder } = await import('./filen-api');
    const sharedFolder = await filenEnsureFolder(
      apiKey, this.spaceFolderUuid, 'shared', masterKeys,
    );
    return sharedFolder;
  }

  private async signalShare(ref: FilenShareReference): Promise<void> {
    if (!this.matrixClient || !this.roomId) return;

    try {
      // Timeline event: share announcement
      await this.matrixClient.sendEvent(this.roomId, FILEN_SHARE_EVENT as any, ref);

      // State event: latest share pointer (O(1) lookup for new devices)
      await this.matrixClient.sendStateEvent(
        this.roomId,
        FILEN_LATEST_STATE as any,
        ref,
        this.spaceId,
      );
    } catch (err) {
      console.warn('[EO-DB] Failed to signal Filen share via Matrix:', err);
    }
  }

  private async cleanupOldShares(apiKey: string): Promise<void> {
    while (this.activeShares.length > MAX_ACTIVE_SHARES) {
      const old = this.activeShares.shift()!;
      try {
        await filenDisablePublicLink(apiKey, old.fileUuid, old.linkUuid);
        await filenTrashFile(apiKey, old.fileUuid);
      } catch {
        // Non-critical — old shares may already be expired
      }
    }
  }

  /**
   * Clean up expired shares (call periodically, e.g., on sync cycle).
   */
  async cleanupExpiredShares(): Promise<void> {
    const { auth } = useFilenStore.getState();
    if (!auth) return;

    const now = Date.now();
    const expired = this.activeShares.filter(
      s => new Date(s.expiresAt).getTime() <= now,
    );

    for (const share of expired) {
      try {
        await filenDisablePublicLink(auth.apiKey, share.fileUuid, share.linkUuid);
        await filenTrashFile(auth.apiKey, share.fileUuid);
      } catch {
        // Non-critical
      }
    }

    this.activeShares = this.activeShares.filter(
      s => new Date(s.expiresAt).getTime() > now,
    );
  }
}
