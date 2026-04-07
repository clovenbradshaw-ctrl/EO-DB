/**
 * Google Drive sync service — uploads EO-DB backups to Google Drive via n8n.
 *
 * Runs in parallel with FilenSyncService. Each sync cycle:
 * 1. Check if there are new events since last sync
 * 2. Pack events into .eodb format
 * 3. Encrypt with keyring (same as Filen)
 * 4. Upload via n8n eo-store webhook (action=store)
 * 5. Signal via Matrix timeline + update state event
 *
 * The n8n webhook handles Google Drive folder creation automatically.
 * Files are stored as {content_hash}.json inside a folder named after the space.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { LocalKeyring } from '../db/crypto-types';
import { readLogSince } from '../db/log';
import { encryptSnapshot } from '../crypto/snapshot-crypto';
import { resolveSnapshotKeyId } from '../crypto/segment-keys';
import { packEodb, type EodbFile } from '../filen/eodb-format';
import { gdriveStore, computeContentHash } from './gdrive-api';
import { useGDriveStore } from './gdrive-store';

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = 30_000;       // 30 seconds (same as Filen)
const SIGNAL_THROTTLE_MS = 10_000;

// Matrix event types for Google Drive coordination
const EO_GDRIVE_SIGNAL = 'eo.gdrive.signal';
const EO_GDRIVE_HEAD = 'eo.gdrive.head';

// ──────────────────────────────────────────────────────────────
// Sync service
// ──────────────────────────────────────────────────────────────

export class GDriveSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSyncedSeq = 0;
  private syncing = false;
  private destroyed = false;
  private lastSignalAt = 0;

  private store: EoStore;
  private spaceId: string;
  private spaceName: string;
  private userId: string;
  private matrixAccessToken: string;
  private matrixClient: MatrixClient | null;
  private roomId: string | null;
  private keyring: LocalKeyring;

  /** Callback for UI status updates. */
  onStatus?: (status: 'syncing' | 'synced' | 'error', detail?: string) => void;

  constructor(opts: {
    store: EoStore;
    spaceId: string;
    spaceName: string;
    userId: string;
    matrixAccessToken: string;
    matrixClient?: MatrixClient;
    roomId?: string;
    keyring?: LocalKeyring;
  }) {
    this.store = opts.store;
    this.spaceId = opts.spaceId;
    this.spaceName = opts.spaceName;
    this.userId = opts.userId;
    this.matrixAccessToken = opts.matrixAccessToken;
    this.matrixClient = opts.matrixClient || null;
    this.roomId = opts.roomId || null;
    this.keyring = opts.keyring || { keys: new Map() };
  }

  /** Allow updating keyring after construction. */
  setKeyring(keyring: LocalKeyring): void {
    this.keyring = keyring;
  }

  /** Encrypt binary with keyring if keys are available. */
  private async encryptBinary(binary: Uint8Array): Promise<Uint8Array> {
    const keyId = resolveSnapshotKeyId(this.keyring);
    if (!keyId) return binary;
    return encryptSnapshot(binary, this.keyring, keyId);
  }

  /** Start the 30-second sync timer. */
  async start(): Promise<void> {
    if (this.timer) return;

    const savedSeq: number = (await this.store.get('meta:gdrive_synced_seq')) || 0;
    this.lastSyncedSeq = savedSeq;

    // Run an initial sync immediately
    this.syncCycle().catch(console.warn);

    this.timer = setInterval(() => {
      if (!this.syncing && !this.destroyed) {
        this.syncCycle().catch(console.warn);
      }
    }, SYNC_INTERVAL_MS);
  }

  /** Stop the sync timer. */
  stop(): void {
    this.destroyed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Force an immediate sync. */
  async forceSave(): Promise<void> {
    if (this.destroyed) return;
    await this.syncCycle();
  }

  /**
   * Read the eo.gdrive.head state event from the Matrix room.
   */
  private readGDriveHead(): { seq: number; updated_at: string; updated_by: string; content_hash: string } | null {
    if (!this.matrixClient || !this.roomId) return null;
    try {
      const room = this.matrixClient.getRoom(this.roomId);
      if (!room) return null;
      const event = room.currentState.getStateEvents(EO_GDRIVE_HEAD, this.spaceId);
      if (!event) return null;
      const content = (event as any).getContent?.() ?? event;
      if (content.seq != null) return content;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Core sync cycle — called every 30 seconds.
   */
  private async syncCycle(): Promise<void> {
    if (this.syncing || this.destroyed) return;
    this.syncing = true;
    this.onStatus?.('syncing');

    try {
      const currentSeq = await this.store.getCurrentSeq();
      console.log('[EO-DB] GDrive syncCycle: currentSeq=%d, lastSyncedSeq=%d', currentSeq, this.lastSyncedSeq);
      if (currentSeq === 0 || currentSeq === this.lastSyncedSeq) {
        this.onStatus?.('synced');
        this.syncing = false;
        return;
      }

      // Check if another client already covered this seq
      const head = this.readGDriveHead();
      if (head && head.seq >= currentSeq) {
        this.lastSyncedSeq = currentSeq;
        await this.store.put('meta:gdrive_synced_seq', currentSeq);
        this.onStatus?.('synced');
        this.syncing = false;
        return;
      }

      // Throttle
      if (head?.updated_at) {
        const headAge = Date.now() - new Date(head.updated_at).getTime();
        if (headAge < SIGNAL_THROTTLE_MS) {
          this.onStatus?.('synced');
          this.syncing = false;
          return;
        }
      }

      // Read all events since last sync
      const events = await readLogSince(this.store, this.lastSyncedSeq);
      if (events.length === 0) {
        this.onStatus?.('synced');
        this.syncing = false;
        return;
      }

      // Pack and encrypt
      const backupFile: EodbFile = {
        version: 1,
        type: 'backup',
        space_id: this.spaceId,
        space_name: this.spaceName,
        from_seq: this.lastSyncedSeq,
        to_seq: currentSeq,
        created_by: this.userId,
        created_at: new Date().toISOString(),
        events,
        prev_snapshots: [],
      };

      const binary = packEodb(backupFile);
      const encrypted = await this.encryptBinary(binary);

      // Convert to base64 for JSON transport via n8n
      const base64Data = btoa(String.fromCharCode(...encrypted));

      // Compute content hash for deterministic file naming
      const contentHash = await computeContentHash(
        `${this.spaceId}:backup:${currentSeq}:${Date.now()}`,
      );

      // Upload via n8n webhook
      const envelope = {
        content_hash: contentHash,
        space_id: this.spaceId,
        space_name: this.spaceName,
        type: 'backup',
        from_seq: this.lastSyncedSeq,
        to_seq: currentSeq,
        event_count: events.length,
        size_bytes: encrypted.byteLength,
        created_by: this.userId,
        created_at: new Date().toISOString(),
        data_base64: base64Data,
      };

      const dataType = `eodb-${this.spaceId}`;

      const result = await gdriveStore(
        this.matrixAccessToken,
        envelope,
        dataType,
        `backup-${currentSeq}-${Date.now()}`,
        contentHash,
      );

      // Update bookkeeping
      this.lastSyncedSeq = currentSeq;
      await this.store.put('meta:gdrive_synced_seq', currentSeq);

      // Signal via Matrix
      const now = Date.now();
      if (this.matrixClient && this.roomId && (now - this.lastSignalAt >= SIGNAL_THROTTLE_MS)) {
        this.lastSignalAt = now;

        try {
          await this.matrixClient.sendEvent(this.roomId, EO_GDRIVE_SIGNAL as any, {
            stream: 'gdrive-backup',
            space_id: this.spaceId,
            content_hash: contentHash,
            drive_file_id: result.drive_file_id,
            seq: currentSeq,
            event_count: events.length,
            uploader: this.userId,
            uploaded_at: new Date().toISOString(),
            size_bytes: encrypted.byteLength,
          });

          await this.matrixClient.sendStateEvent(this.roomId, EO_GDRIVE_HEAD as any, {
            content_hash: contentHash,
            drive_file_id: result.drive_file_id,
            seq: currentSeq,
            updated_at: new Date().toISOString(),
            updated_by: this.userId,
          }, this.spaceId);
        } catch (e) {
          console.warn('[EO-DB] Google Drive Matrix signal failed (data is safe on Drive):', e);
        }
      }

      useGDriveStore.getState().recordSync(this.spaceId);
      this.onStatus?.('synced');
      console.log(`[EO-DB] Google Drive backup uploaded: seq ${currentSeq}, ${events.length} events, ${encrypted.byteLength} bytes`);
    } catch (e: any) {
      console.warn('[EO-DB] Google Drive sync cycle failed:', e);
      this.onStatus?.('error', e.message);
    } finally {
      this.syncing = false;
    }
  }
}
