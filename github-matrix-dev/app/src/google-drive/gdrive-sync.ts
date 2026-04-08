/**
 * Google Drive sync service — uploads EO-DB backups to Google Drive via n8n.
 *
 * Runs in parallel with FilenSyncService. Each sync cycle:
 * 1. Check if there are new events since last sync
 * 2. Pack events into .eodb binary format (magic header + msgpack)
 * 3. Encrypt with room keyring (AES-256-GCM, same as Filen — no Filen-specific encryption)
 * 4. Upload encrypted binary as {content_hash}.eodb via n8n proxy
 * 5. Signal via Matrix timeline + update state event
 *
 * The n8n webhook handles Google Drive folder creation automatically.
 * Files are stored as {content_hash}.eodb inside a folder named after the space.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { LocalKeyring } from '../db/crypto-types';
import { readLogSince } from '../db/log';
import { encryptSnapshot } from '../crypto/snapshot-crypto';
import { resolveSnapshotKeyId } from '../crypto/segment-keys';
import { packEodb, type EodbFile } from '../filen/eodb-format';
import { gdriveStore, gdriveList, gdriveRetrieve, computeContentHash } from './gdrive-api';
import { unpackEodb } from '../filen/eodb-format';
import { decryptSnapshot } from '../crypto/snapshot-crypto';
import { processEvent } from '../db/fold';
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

/** Consolidate (overwrite the aggregated file) every N events. */
const CONSOLIDATE_EVERY_N_EVENTS = 256;
/** Keep at most this many incremental backup files on Drive. */
const MAX_BACKUP_FILES = 3;

export class GDriveSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSyncedSeq = 0;
  private syncing = false;
  private destroyed = false;
  private lastSignalAt = 0;
  /** Seq at the last consolidation (for event-count threshold). */
  private lastConsolidatedSeq = 0;

  private store: EoStore;
  private spaceId: string;
  private spaceName: string;
  private userId: string;
  private matrixAccessToken: string;
  private matrixClient: MatrixClient | null;
  private roomId: string | null;
  private keyring: LocalKeyring;

  /** Callback invoked for each event during hydration/pull (drives UI updates). */
  onEvent?: (event: any) => void;

  /** Called after a successful safety-net hydration so the UI can re-init. */
  onHydrated?: () => void;

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
    onEvent?: (event: any) => void;
    onHydrated?: () => void;
  }) {
    this.store = opts.store;
    this.spaceId = opts.spaceId;
    this.spaceName = opts.spaceName;
    this.userId = opts.userId;
    this.matrixAccessToken = opts.matrixAccessToken;
    this.matrixClient = opts.matrixClient || null;
    this.roomId = opts.roomId || null;
    this.keyring = opts.keyring || { keys: new Map() };
    this.onEvent = opts.onEvent || undefined;
    this.onHydrated = opts.onHydrated || undefined;
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
    const savedConsolidatedSeq: number = (await this.store.get('meta:gdrive_consolidated_seq')) || 0;
    this.lastSyncedSeq = savedSeq;
    this.lastConsolidatedSeq = savedConsolidatedSeq;

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

  /** Force an immediate sync (bypasses the 256-event threshold). */
  async forceSave(): Promise<void> {
    if (this.destroyed) return;
    await this.syncCycle(true);
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
   * @param force — bypass the 256-event threshold (used by forceSave)
   */
  private async syncCycle(force = false): Promise<void> {
    if (this.syncing || this.destroyed) return;
    this.syncing = true;
    this.onStatus?.('syncing');

    try {
      const currentSeq = await this.store.getCurrentSeq();
      console.log('[EO-DB] GDrive syncCycle: currentSeq=%d, lastSyncedSeq=%d', currentSeq, this.lastSyncedSeq);

      // If local store is empty but Google Drive may have data, attempt to pull.
      // Safety net: initial hydration may have been skipped due to effect re-runs.
      if (currentSeq === 0) {
        try {
          const dataType = `eodb-${this.spaceId}`;
          const hydratedSeq = await GDriveSyncService.hydrateFromGDrive(
            this.store, this.matrixAccessToken, dataType, this.onEvent, this.keyring,
          );
          if (hydratedSeq > 0) {
            this.lastSyncedSeq = hydratedSeq;
            this.lastConsolidatedSeq = hydratedSeq;
            await this.store.put('meta:gdrive_synced_seq', hydratedSeq);
            await this.store.put('meta:gdrive_consolidated_seq', hydratedSeq);
            this.onHydrated?.();
            this.onStatus?.('synced');
            console.log(`[EO-DB] GDrive sync cycle: pulled ${hydratedSeq} events from Google Drive (safety-net hydration)`);
          } else {
            this.onStatus?.('synced');
          }
        } catch (e) {
          console.warn('[EO-DB] GDrive sync cycle: safety-net hydration failed:', e);
          this.onStatus?.('error', e instanceof Error ? e.message : String(e));
        }
        this.syncing = false;
        return;
      }

      if (currentSeq === this.lastSyncedSeq) {
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

      // Track that we have pending changes but DON'T write to Drive yet.
      // Only write when the 256-event consolidation threshold is reached.
      const dataType = `eodb-${this.spaceId}`;
      const eventsSinceConsolidation = currentSeq - this.lastConsolidatedSeq;

      if (!force && eventsSinceConsolidation < CONSOLIDATE_EVERY_N_EVENTS) {
        // Not enough events yet — just update local bookkeeping, skip Drive write
        this.lastSyncedSeq = currentSeq;
        await this.store.put('meta:gdrive_synced_seq', currentSeq);
        this.onStatus?.('synced');
        console.log('[EO-DB] GDrive: %d events since consolidation, threshold %d — skipping Drive write',
          eventsSinceConsolidation, CONSOLIDATE_EVERY_N_EVENTS);
        this.syncing = false;
        return;
      }

      // Threshold reached — write consolidated file to Drive (overwrites previous)
      await this.consolidateBackup(dataType, currentSeq);
      this.lastConsolidatedSeq = currentSeq;

      // Update bookkeeping
      this.lastSyncedSeq = currentSeq;
      await this.store.put('meta:gdrive_synced_seq', currentSeq);

      // Signal via Matrix
      const contentHash = await computeContentHash(`${this.spaceId}:consolidated`);
      const now = Date.now();
      if (this.matrixClient && this.roomId && (now - this.lastSignalAt >= SIGNAL_THROTTLE_MS)) {
        this.lastSignalAt = now;

        try {
          await this.matrixClient.sendEvent(this.roomId, EO_GDRIVE_SIGNAL as any, {
            stream: 'gdrive-backup',
            space_id: this.spaceId,
            content_hash: contentHash,
            seq: currentSeq,
            event_count: eventsSinceConsolidation,
            uploader: this.userId,
            uploaded_at: new Date().toISOString(),
          });

          await this.matrixClient.sendStateEvent(this.roomId, EO_GDRIVE_HEAD as any, {
            content_hash: contentHash,
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
      console.log(`[EO-DB] Google Drive consolidated backup uploaded: seq ${currentSeq}, ${eventsSinceConsolidation} events since last consolidation`);
    } catch (e: any) {
      console.warn('[EO-DB] Google Drive sync cycle failed:', e);
      this.onStatus?.('error', e.message);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Create a consolidated backup containing ALL events, overwriting the
   * single consolidated file on Drive. Then clean up old delta files.
   * Mirrors Filen's snapshot pattern.
   */
  private async consolidateBackup(dataType: string, currentSeq: number): Promise<void> {
    try {
      // Read ALL events from the beginning
      const allEvents = await readLogSince(this.store, 0);
      if (allEvents.length === 0) return;

      const consolidatedFile: EodbFile = {
        version: 1,
        type: 'backup',
        space_id: this.spaceId,
        space_name: this.spaceName,
        from_seq: 0,
        to_seq: currentSeq,
        created_by: this.userId,
        created_at: new Date().toISOString(),
        events: allEvents,
        prev_snapshots: [],
      };

      const binary = packEodb(consolidatedFile);
      const encrypted = await this.encryptBinary(binary);

      // Stable hash per space — always overwrites the same file
      const consolidatedHash = await computeContentHash(
        `${this.spaceId}:consolidated`,
      );

      // Upload encrypted binary directly as .eodb (like Filen, without Filen encryption)
      await gdriveStore(
        this.matrixAccessToken,
        encrypted,
        dataType,
        'consolidated',
        consolidatedHash,
      );

      await this.store.put('meta:gdrive_consolidated_seq', currentSeq);
      console.log(`[EO-DB] GDrive consolidated backup: seq 0→${currentSeq}, ${allEvents.length} events, ${encrypted.byteLength} bytes`);

      // Clean up old delta backup files (keep last MAX_BACKUP_FILES)
      await this.cleanupOldBackups(dataType, consolidatedHash);
    } catch (e) {
      console.warn('[EO-DB] GDrive consolidation failed (deltas are safe):', e);
    }
  }

  /**
   * Delete old delta backup files from Drive, keeping only the most recent.
   * The consolidated file (with its own stable hash) is never deleted.
   */
  private async cleanupOldBackups(dataType: string, consolidatedHash: string): Promise<void> {
    try {
      const listing = await gdriveList(this.matrixAccessToken, dataType);
      // Identify delta files (exclude the consolidated file)
      const deltas = listing.entries
        .filter(e => e.content_hash !== consolidatedHash)
        .sort((a, b) => new Date(b.stored_at).getTime() - new Date(a.stored_at).getTime());

      // Keep the last MAX_BACKUP_FILES deltas, trash the rest
      for (let i = MAX_BACKUP_FILES; i < deltas.length; i++) {
        try {
          // Trash via Drive API (move to trash)
          const trashUrl = `https://www.googleapis.com/drive/v3/files/${deltas[i].data_id}`;
          await fetch('https://n8n.intelechia.com/webhook/eo-store', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              matrix_token: this.matrixAccessToken,
              drive_url: trashUrl,
              drive_method: 'PATCH',
              drive_body: { trashed: true },
            }),
          });
        } catch { /* non-critical */ }
      }
    } catch {
      // Cleanup failure is non-critical
    }
  }

  // ──────────────────────────────────────────────────────────
  // Hydration (new device / second client)
  // ──────────────────────────────────────────────────────────

  /**
   * Hydrate a store from Google Drive by listing and downloading .eodb files.
   *
   * Looks for the consolidated backup first, then any delta files.
   * Downloads via gdriveRetrieve (n8n proxy → Google Drive media endpoint).
   *
   * Returns the final seq after hydration.
   */
  static async hydrateFromGDrive(
    store: EoStore,
    matrixAccessToken: string,
    dataType: string,
    onEvent?: (event: any) => void,
    keyring?: LocalKeyring,
  ): Promise<number> {
    console.log('[EO-DB] hydrateFromGDrive: starting, dataType =', dataType);

    const listing = await gdriveList(matrixAccessToken, dataType);
    const entries = listing.entries;

    console.log(`[EO-DB] hydrateFromGDrive: found ${entries.length} files on Google Drive`);
    if (entries.length === 0) return 0;

    const localSeq = await store.getCurrentSeq();
    let lastAppliedSeq = localSeq;

    // Try each file — the consolidated one contains ALL events, so one
    // successful file is usually enough to fully hydrate the store.
    // Sort by stored_at descending so we try the newest file first.
    const sorted = [...entries].sort((a, b) =>
      new Date(b.stored_at).getTime() - new Date(a.stored_at).getTime(),
    );

    for (const entry of sorted) {
      try {
        console.log(`[EO-DB] hydrateFromGDrive: downloading ${entry.content_hash}.eodb...`);
        const result = await gdriveRetrieve(matrixAccessToken, entry.content_hash);
        if (!result.ok || !result.envelope) {
          console.warn('[EO-DB] hydrateFromGDrive: retrieve failed for', entry.content_hash);
          continue;
        }

        let raw: Uint8Array;
        if (result.envelope instanceof Uint8Array) {
          raw = result.envelope;
        } else if (typeof result.envelope === 'string') {
          // Legacy or unexpected format
          console.warn('[EO-DB] hydrateFromGDrive: unexpected string response for', entry.content_hash);
          continue;
        } else {
          raw = result.envelope;
        }

        console.log(`[EO-DB] hydrateFromGDrive: downloaded ${entry.content_hash} (${raw.byteLength} bytes)`);

        // Decrypt if keyring-encrypted
        const data = keyring ? await decryptSnapshot(raw, keyring) : raw;
        const eodb = unpackEodb(data);

        console.log(`[EO-DB] hydrateFromGDrive: file contains ${eodb.events.length} events (from_seq=${eodb.from_seq} to_seq=${eodb.to_seq})`);

        for (const event of eodb.events) {
          if (event.seq <= localSeq) continue;
          const seq = await processEvent(store, event, onEvent);
          lastAppliedSeq = Math.max(lastAppliedSeq, seq);
        }

        console.log(`[EO-DB] hydrateFromGDrive: applied, lastAppliedSeq = ${lastAppliedSeq}`);

        // If we got events from the consolidated file, we're done
        if (lastAppliedSeq > localSeq) break;
      } catch (e) {
        console.error('[EO-DB] hydrateFromGDrive: failed to apply file:', entry.content_hash, e);
      }
    }

    console.log(`[EO-DB] hydrateFromGDrive: complete. Applied up to seq ${lastAppliedSeq} (was ${localSeq})`);
    return lastAppliedSeq;
  }
}
