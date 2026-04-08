/**
 * Filen sync service — signal-coordinated uploads with Matrix as the pointer layer.
 *
 * Filen is the primary data store. Matrix room state events serve as pointers
 * to the current data (eo.backup.head) and latest snapshot (eo.backup.horizon).
 * Matrix timeline events (eo.backup.signal) notify other clients of uploads.
 *
 * Each sync cycle:
 * 1. Read eo.backup.head from room state (is someone else ahead?)
 * 2. If covered or throttled, skip
 * 3. Upload backup-{seq}-{ts}.eodb with a unique filename (no trash-and-replace)
 * 4. Signal via Matrix timeline + update head state event
 * 5. Cleanup old backup files (keep last 3)
 *
 * Every 5,000 events, create an immutable snapshot and update eo.backup.horizon.
 *
 * Private data is encrypted per-user and uploaded to a separate subfolder.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { LocalKeyring } from '../db/crypto-types';
import { processEvent } from '../db/fold';
import { readLogSince } from '../db/log';
import { deriveKey, encrypt } from '../lib/crypto';
import { encryptSnapshot, decryptSnapshot } from '../crypto/snapshot-crypto';
import { resolveSnapshotKeyId } from '../crypto/segment-keys';
import {
  filenUploadFile,
  filenListFolder,
  filenDownloadFile,
  filenTrashFile,
  type FilenItem,
} from './filen-api';
import { useFilenStore } from './filen-store';
import { packEodb, unpackEodb, type EodbFile } from './eodb-format';

// Re-export for backwards compatibility
export { packEodb, unpackEodb, isEodbFile, type EodbFile } from './eodb-format';

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = 30_000;       // 30 seconds
const SNAPSHOT_FREQUENCY = 5_000;      // snapshot every 5,000 events
const MAX_PREV_SNAPSHOTS = 10;
const SIGNAL_THROTTLE_MS = 10_000;     // max 1 signal per 10 seconds per client
const MAX_BACKUP_FILES = 3;            // keep last 3 backup files
const MAX_MANUAL_SNAPSHOTS = 5;       // keep last 5 manual snapshots

// Matrix event types
const EO_BACKUP_SIGNAL = 'eo.backup.signal';
const EO_BACKUP_HEAD = 'eo.backup.head';
const EO_COMPACT_SIGNAL = 'eo.compact.signal';
const EO_BACKUP_HORIZON = 'eo.backup.horizon';

function backupFilename(seq: number): string {
  return `backup-${seq}-${Date.now()}.eodb`;
}

function parseBackupSeq(filename: string): number | null {
  const m = filename.match(/^backup-(\d+)-\d+\.eodb$/);
  return m ? parseInt(m[1], 10) : null;
}

function snapshotFilename(seq: number): string {
  return `snapshot-${String(seq).padStart(8, '0')}.eodb`;
}

function parseSnapshotSeq(filename: string): number | null {
  const m = filename.match(/^snapshot-(\d+)\.eodb$/);
  return m ? parseInt(m[1], 10) : null;
}

// ──────────────────────────────────────────────────────────────
// Sync service
// ──────────────────────────────────────────────────────────────

export class FilenSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSyncedSeq = 0;
  private lastSnapshotSeq = 0;
  private prevSnapshotUuids: string[] = [];
  private syncing = false;
  private destroyed = false;
  private lastSignalAt = 0;

  private store: EoStore;
  private spaceId: string;
  private spaceName: string;
  private spaceFolderUuid: string;
  private userId: string;
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
    spaceFolderUuid: string;
    userId: string;
    matrixClient?: MatrixClient;
    roomId?: string;
    keyring?: LocalKeyring;
    onEvent?: (event: any) => void;
    onHydrated?: () => void;
  }) {
    this.store = opts.store;
    this.spaceId = opts.spaceId;
    this.spaceName = opts.spaceName;
    this.spaceFolderUuid = opts.spaceFolderUuid;
    this.userId = opts.userId;
    this.matrixClient = opts.matrixClient || null;
    this.roomId = opts.roomId || null;
    this.keyring = opts.keyring || { keys: new Map() };
    this.onEvent = opts.onEvent || undefined;
    this.onHydrated = opts.onHydrated || undefined;
  }

  /** Allow updating keyring after construction (e.g., after key heal). */
  setKeyring(keyring: LocalKeyring): void {
    this.keyring = keyring;
  }

  /** Encrypt binary with keyring if keys are available, otherwise pass through. */
  private async encryptBinary(binary: Uint8Array): Promise<Uint8Array> {
    const keyId = resolveSnapshotKeyId(this.keyring);
    if (!keyId) return binary;
    return encryptSnapshot(binary, this.keyring, keyId);
  }

  /** Start the 30-second sync timer. */
  async start(): Promise<void> {
    if (this.timer) return;

    // Recover last synced seq from local metadata
    const savedSeq: number = (await this.store.get('meta:filen_synced_seq')) || 0;
    const savedSnapshotSeq: number = (await this.store.get('meta:filen_snapshot_seq')) || 0;
    this.lastSyncedSeq = savedSeq;
    this.lastSnapshotSeq = savedSnapshotSeq;

    // Discover existing snapshot UUIDs for chain tracking
    await this.discoverExistingFiles();

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

  /** Force an immediate sync (e.g., on beforeunload). */
  async forceSave(): Promise<void> {
    if (this.destroyed) return;
    await this.syncCycle();
  }

  /**
   * Create a full manual snapshot of all events.
   * Enforces a cap of MAX_MANUAL_SNAPSHOTS — oldest snapshots are deleted.
   */
  async createManualSnapshot(): Promise<{ seq: number; filename: string }> {
    const { auth, masterKeys } = useFilenStore.getState();
    if (!auth) throw new Error('Not connected to Filen');

    const currentSeq = await this.store.getCurrentSeq();
    if (currentSeq === 0) throw new Error('No events to snapshot');

    const allEvents = await readLogSince(this.store, 0);

    const snapshotFile: EodbFile = {
      version: 1,
      type: 'snapshot',
      space_id: this.spaceId,
      space_name: this.spaceName,
      from_seq: 0,
      to_seq: currentSeq,
      created_by: this.userId,
      created_at: new Date().toISOString(),
      events: allEvents,
      prev_snapshots: this.prevSnapshotUuids.slice(0, MAX_PREV_SNAPSHOTS),
    };

    const binary = packEodb(snapshotFile);
    const encrypted = await this.encryptBinary(binary);
    const filename = snapshotFilename(currentSeq);

    const uploaded = await filenUploadFile(
      auth.apiKey, this.spaceFolderUuid, filename, encrypted, masterKeys[0],
    );

    // Update chain tracking
    this.prevSnapshotUuids.unshift(uploaded.uuid);
    if (this.prevSnapshotUuids.length > MAX_PREV_SNAPSHOTS) {
      this.prevSnapshotUuids = this.prevSnapshotUuids.slice(0, MAX_PREV_SNAPSHOTS);
    }
    this.lastSnapshotSeq = currentSeq;
    await this.store.put('meta:filen_snapshot_seq', currentSeq);

    console.log(`[EO-DB] Manual snapshot created: ${filename} (${allEvents.length} events, ${encrypted.byteLength} bytes)`);

    // Enforce snapshot cap — delete oldest beyond MAX_MANUAL_SNAPSHOTS
    try {
      const items = await filenListFolder(auth.apiKey, this.spaceFolderUuid, masterKeys);
      const snapshots: Array<FilenItem & { seq: number }> = [];
      for (const item of items) {
        if (item.type !== 'file') continue;
        const seq = parseSnapshotSeq(item.name);
        if (seq !== null) snapshots.push({ ...item, seq });
      }
      snapshots.sort((a, b) => b.seq - a.seq); // newest first
      for (let i = MAX_MANUAL_SNAPSHOTS; i < snapshots.length; i++) {
        try { await filenTrashFile(auth.apiKey, snapshots[i].uuid); } catch { /* ignore */ }
      }
    } catch {
      // Cleanup failure is non-critical
    }

    // Signal via Matrix
    if (this.matrixClient && this.roomId) {
      try {
        await this.matrixClient.sendEvent(this.roomId, EO_COMPACT_SIGNAL as any, {
          stream: 'backup',
          space_id: this.spaceId,
          filen_path: `/EO-DB/${this.spaceName}/${filename}`,
          file_uuid: uploaded.uuid,
          seq: currentSeq,
          event_count: allEvents.length,
          size_bytes: encrypted.byteLength,
          compacted_at: new Date().toISOString(),
          compacted_by: this.userId,
        });

        await this.matrixClient.sendStateEvent(this.roomId, EO_BACKUP_HORIZON as any, {
          filen_path: `/EO-DB/${this.spaceName}/${filename}`,
          file_uuid: uploaded.uuid,
          folder_uuid: this.spaceFolderUuid,
          seq: currentSeq,
          event_count: allEvents.length,
          compressed_bytes: encrypted.byteLength,
          compacted_at: new Date().toISOString(),
          compacted_by: this.userId,
        }, this.spaceId);
      } catch (e) {
        console.warn('[EO-DB] Manual snapshot signal failed (snapshot is safe on Filen):', e);
      }
    }

    return { seq: currentSeq, filename };
  }

  /**
   * Discover existing .eodb files in the space folder.
   * Recovers snapshot UUIDs for chain tracking.
   */
  private async discoverExistingFiles(): Promise<void> {
    const { auth, masterKeys } = useFilenStore.getState();
    if (!auth) return;

    try {
      const items = await filenListFolder(auth.apiKey, this.spaceFolderUuid, masterKeys);
      for (const item of items) {
        if (item.type === 'file') {
          const seq = parseSnapshotSeq(item.name);
          if (seq !== null) {
            this.prevSnapshotUuids.push(item.uuid);
          }
        }
      }
    } catch (e) {
      console.warn('[EO-DB] Failed to discover existing Filen files:', e);
    }
  }

  /**
   * Read the eo.backup.head state event from the Matrix room.
   * Returns null if no head exists or Matrix is unavailable.
   */
  private readBackupHead(): { seq: number; updated_at: string; updated_by: string; file_uuid: string } | null {
    if (!this.matrixClient || !this.roomId) return null;
    try {
      const room = this.matrixClient.getRoom(this.roomId);
      if (!room) return null;
      const event = room.currentState.getStateEvents(EO_BACKUP_HEAD, this.spaceId);
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
   *
   * Uses Matrix state for coordination:
   * - Skip if another client already covered our seq
   * - Throttle to max 1 signal per 10 seconds
   * - Upload with unique timestamped filename (no trash-and-replace)
   */
  private async syncCycle(): Promise<void> {
    if (this.syncing || this.destroyed) return;
    this.syncing = true;
    this.onStatus?.('syncing');

    try {
      const { auth, masterKeys } = useFilenStore.getState();
      if (!auth) { this.syncing = false; return; }

      const currentSeq = await this.store.getCurrentSeq();

      // If local store is empty but Filen may have data, attempt to pull.
      // This is a safety net: the initial hydration in setupSpaceStore may
      // have been skipped or failed silently due to effect re-runs / races.
      if (currentSeq === 0) {
        try {
          const hydratedSeq = await FilenSyncService.hydrateFromFilen(
            this.store, this.spaceFolderUuid, this.onEvent, this.keyring,
          );
          if (hydratedSeq > 0) {
            this.lastSyncedSeq = hydratedSeq;
            await this.store.put('meta:filen_synced_seq', hydratedSeq);
            this.onHydrated?.();
            this.onStatus?.('synced');
            console.log(`[EO-DB] Sync cycle: pulled ${hydratedSeq} events from Filen (safety-net hydration)`);
          } else {
            this.onStatus?.('synced');
          }
        } catch (e) {
          console.warn('[EO-DB] Sync cycle: safety-net hydration failed:', e);
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
      const head = this.readBackupHead();
      if (head && head.seq >= currentSeq) {
        // Another client already uploaded — we're covered
        this.lastSyncedSeq = currentSeq;
        await this.store.put('meta:filen_synced_seq', currentSeq);
        this.onStatus?.('synced');
        this.syncing = false;
        return;
      }

      // Throttle: don't signal if head was updated within the last 10 seconds
      if (head?.updated_at) {
        const headAge = Date.now() - new Date(head.updated_at).getTime();
        if (headAge < SIGNAL_THROTTLE_MS) {
          this.onStatus?.('synced');
          this.syncing = false;
          return;
        }
      }

      // Read all events since last snapshot (full delta for backup file)
      const allEventsSinceSnapshot = await readLogSince(this.store, this.lastSnapshotSeq);
      if (allEventsSinceSnapshot.length === 0) {
        this.onStatus?.('synced');
        this.syncing = false;
        return;
      }

      // Pack and upload with unique filename
      const filename = backupFilename(currentSeq);
      const backupFile: EodbFile = {
        version: 1,
        type: 'backup',
        space_id: this.spaceId,
        space_name: this.spaceName,
        from_seq: this.lastSnapshotSeq,
        to_seq: currentSeq,
        created_by: this.userId,
        created_at: new Date().toISOString(),
        events: allEventsSinceSnapshot,
        prev_snapshots: this.prevSnapshotUuids.slice(0, MAX_PREV_SNAPSHOTS),
      };

      const binary = packEodb(backupFile);
      const encrypted = await this.encryptBinary(binary);

      const uploaded = await filenUploadFile(
        auth.apiKey, this.spaceFolderUuid, filename, encrypted, masterKeys[0],
      );

      // Update bookkeeping
      this.lastSyncedSeq = currentSeq;
      await this.store.put('meta:filen_synced_seq', currentSeq);

      // Signal via Matrix (if available and not throttled)
      const now = Date.now();
      if (this.matrixClient && this.roomId && (now - this.lastSignalAt >= SIGNAL_THROTTLE_MS)) {
        this.lastSignalAt = now;

        try {
          // Timeline event: backup signal
          const txnId = `eo_backup_${now}_${Math.random().toString(36).slice(2, 8)}`;
          await this.matrixClient.sendEvent(this.roomId, EO_BACKUP_SIGNAL as any, {
            stream: 'backup',
            space_id: this.spaceId,
            filen_path: `/EO-DB/${this.spaceName}/${filename}`,
            file_uuid: uploaded.uuid,
            seq: currentSeq,
            event_count: allEventsSinceSnapshot.length,
            uploader: this.userId,
            uploaded_at: new Date().toISOString(),
            size_bytes: encrypted.byteLength,
          });

          // State event: update head pointer
          await this.matrixClient.sendStateEvent(this.roomId, EO_BACKUP_HEAD as any, {
            filen_path: `/EO-DB/${this.spaceName}/${filename}`,
            file_uuid: uploaded.uuid,
            folder_uuid: this.spaceFolderUuid,
            seq: currentSeq,
            snapshot_seq: this.lastSnapshotSeq,
            snapshot_uuid: this.prevSnapshotUuids[0] || null,
            updated_at: new Date().toISOString(),
            updated_by: this.userId,
          }, this.spaceId);
        } catch (e) {
          // Signal failure is non-critical — data is already on Filen
          console.warn('[EO-DB] Matrix signal failed (data is safe on Filen):', e);
        }
      }

      // Cleanup old backup files (keep last MAX_BACKUP_FILES)
      await this.cleanupOldBackups(auth.apiKey, masterKeys);

      // Check if we need a snapshot
      const eventsSinceSnapshot = currentSeq - this.lastSnapshotSeq;
      if (eventsSinceSnapshot >= SNAPSHOT_FREQUENCY) {
        await this.createSnapshot(auth.apiKey, masterKeys[0], currentSeq);
      }

      useFilenStore.getState().recordSync(this.spaceId);
      this.onStatus?.('synced');
    } catch (e: any) {
      console.warn('[EO-DB] Filen sync cycle failed:', e);
      this.onStatus?.('error', e.message);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Delete old backup files, keeping only the latest MAX_BACKUP_FILES.
   */
  private async cleanupOldBackups(apiKey: string, masterKeys: string[]): Promise<void> {
    try {
      const items = await filenListFolder(apiKey, this.spaceFolderUuid, masterKeys);
      const backups: Array<FilenItem & { seq: number }> = [];

      for (const item of items) {
        if (item.type !== 'file') continue;
        const seq = parseBackupSeq(item.name);
        if (seq !== null) {
          backups.push({ ...item, seq });
        }
      }

      // Sort by seq descending, trash everything after the first MAX_BACKUP_FILES
      backups.sort((a, b) => b.seq - a.seq);
      for (let i = MAX_BACKUP_FILES; i < backups.length; i++) {
        try {
          await filenTrashFile(apiKey, backups[i].uuid);
        } catch {
          // Non-critical
        }
      }
    } catch {
      // Cleanup failure is non-critical
    }
  }

  /**
   * Create an immutable snapshot containing ALL events.
   * Sends eo.compact.signal and updates eo.backup.horizon.
   */
  private async createSnapshot(
    apiKey: string,
    masterKey: string,
    currentSeq: number,
  ): Promise<void> {
    const allEvents = await readLogSince(this.store, 0);

    const snapshotFile: EodbFile = {
      version: 1,
      type: 'snapshot',
      space_id: this.spaceId,
      space_name: this.spaceName,
      from_seq: 0,
      to_seq: currentSeq,
      created_by: this.userId,
      created_at: new Date().toISOString(),
      events: allEvents,
      prev_snapshots: this.prevSnapshotUuids.slice(0, MAX_PREV_SNAPSHOTS),
    };

    const binary = packEodb(snapshotFile);
    const encrypted = await this.encryptBinary(binary);
    const filename = snapshotFilename(currentSeq);

    const uploaded = await filenUploadFile(
      apiKey, this.spaceFolderUuid, filename, encrypted, masterKey,
    );

    this.prevSnapshotUuids.unshift(uploaded.uuid);
    if (this.prevSnapshotUuids.length > MAX_PREV_SNAPSHOTS) {
      this.prevSnapshotUuids = this.prevSnapshotUuids.slice(0, MAX_PREV_SNAPSHOTS);
    }

    this.lastSnapshotSeq = currentSeq;
    await this.store.put('meta:filen_snapshot_seq', currentSeq);

    console.log(`[EO-DB] Filen snapshot created: ${filename} (${allEvents.length} events, ${encrypted.byteLength} bytes)`);

    // Signal compaction via Matrix
    if (this.matrixClient && this.roomId) {
      try {
        await this.matrixClient.sendEvent(this.roomId, EO_COMPACT_SIGNAL as any, {
          stream: 'backup',
          space_id: this.spaceId,
          filen_path: `/EO-DB/${this.spaceName}/${filename}`,
          file_uuid: uploaded.uuid,
          seq: currentSeq,
          event_count: allEvents.length,
          size_bytes: encrypted.byteLength,
          compacted_at: new Date().toISOString(),
          compacted_by: this.userId,
        });

        await this.matrixClient.sendStateEvent(this.roomId, EO_BACKUP_HORIZON as any, {
          filen_path: `/EO-DB/${this.spaceName}/${filename}`,
          file_uuid: uploaded.uuid,
          folder_uuid: this.spaceFolderUuid,
          seq: currentSeq,
          event_count: allEvents.length,
          compressed_bytes: encrypted.byteLength,
          compacted_at: new Date().toISOString(),
          compacted_by: this.userId,
        }, this.spaceId);
      } catch (e) {
        console.warn('[EO-DB] Compact signal failed (snapshot is safe on Filen):', e);
      }
    }

    // Trash old backup files covered by the snapshot
    try {
      const { masterKeys } = useFilenStore.getState();
      const items = await filenListFolder(apiKey, this.spaceFolderUuid, masterKeys);
      for (const item of items) {
        if (item.type !== 'file') continue;
        const bSeq = parseBackupSeq(item.name);
        if (bSeq !== null && bSeq <= currentSeq) {
          try { await filenTrashFile(apiKey, item.uuid); } catch { /* ignore */ }
        }
      }
    } catch {
      // Cleanup failure is non-critical
    }
  }

  // ──────────────────────────────────────────────────────────
  // Private data sync
  // ──────────────────────────────────────────────────────────

  /**
   * Sync per-user private data (settings, drafts, annotations).
   * Encrypted with the user's own key derived from userId + deviceId.
   * Uploaded to /EO-DB/{spaceName}/private/{userId}/private.eodb
   *
   * Call this alongside the shared sync cycle.
   */
  async syncPrivateData(deviceId: string, privateFolderUuid: string): Promise<void> {
    const { auth, masterKeys } = useFilenStore.getState();
    if (!auth) return;

    try {
      // Read private data from store
      const privateData = await this.store.get('meta:private_data');
      if (!privateData) return;

      // Pack as .eodb
      const file: EodbFile = {
        version: 1,
        type: 'current',
        space_id: this.spaceId,
        space_name: this.spaceName,
        from_seq: 0,
        to_seq: 0,
        created_by: this.userId,
        created_at: new Date().toISOString(),
        events: [],
        prev_snapshots: [],
      };
      // Store private data in a simple structure
      (file as any).private_data = privateData;

      const binary = packEodb(file);

      // Encrypt with user's own key
      const userKey = await deriveKey(this.userId, deviceId);
      const encrypted = await encrypt(userKey, binary);

      // Upload (trash-and-replace is OK for private data — single user)
      const existingItems = await filenListFolder(auth.apiKey, privateFolderUuid, masterKeys);
      const existing = existingItems.find(i => i.type === 'file' && i.name === 'private.eodb');
      if (existing) {
        try { await filenTrashFile(auth.apiKey, existing.uuid); } catch { /* ignore */ }
      }

      await filenUploadFile(auth.apiKey, privateFolderUuid, 'private.eodb', encrypted, masterKeys[0]);
    } catch (e) {
      console.warn('[EO-DB] Private data sync failed:', e);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Hydration (new device)
  // ──────────────────────────────────────────────────────────

  /**
   * Hydrate a store from Filen by scanning the folder directly.
   *
   * 1. List files in the space folder
   * 2. Find the latest snapshot-*.eodb (highest seq)
   * 3. Download and apply it
   * 4. Find backup-*.eodb files with seq > snapshot seq
   * 5. Download and apply those (sorted by seq)
   *
   * Returns the final seq after hydration.
   */
  static async hydrateFromFilen(
    store: EoStore,
    spaceFolderUuid: string,
    onEvent?: (event: any) => void,
    keyring?: LocalKeyring,
  ): Promise<number> {
    const { auth, masterKeys } = useFilenStore.getState();
    if (!auth) throw new Error('Not connected to Filen');

    const items = await filenListFolder(auth.apiKey, spaceFolderUuid, masterKeys);
    const localSeq = await store.getCurrentSeq();

    // Find all snapshot and backup files
    const snapshots: Array<FilenItem & { seq: number }> = [];
    const backups: Array<FilenItem & { seq: number }> = [];

    for (const item of items) {
      if (item.type !== 'file' || !item.name.endsWith('.eodb')) continue;

      const sSeq = parseSnapshotSeq(item.name);
      if (sSeq !== null && sSeq > localSeq) {
        snapshots.push({ ...item, seq: sSeq });
        continue;
      }

      const bSeq = parseBackupSeq(item.name);
      if (bSeq !== null && bSeq > localSeq) {
        backups.push({ ...item, seq: bSeq });
      }
    }

    snapshots.sort((a, b) => b.seq - a.seq);
    backups.sort((a, b) => a.seq - b.seq);

    if (snapshots.length === 0 && backups.length === 0) {
      console.warn('[EO-DB] hydrateFromFilen: no .eodb files found in folder', spaceFolderUuid);
    } else {
      console.log(`[EO-DB] hydrateFromFilen: found ${snapshots.length} snapshots, ${backups.length} backups`);
    }

    let lastAppliedSeq = localSeq;

    // Apply latest snapshot first (it contains all events from seq 0)
    if (snapshots.length > 0) {
      const latest = snapshots[0];
      if (latest.key) {
        try {
          const raw = await filenDownloadFile(
            auth.apiKey, latest.uuid, latest.key, latest.region, latest.bucket,
          );
          const data = keyring ? await decryptSnapshot(raw, keyring) : raw;
          const eodb = unpackEodb(data);
          for (const event of eodb.events) {
            if (event.seq <= localSeq) continue;
            const seq = await processEvent(store, event, onEvent);
            lastAppliedSeq = Math.max(lastAppliedSeq, seq);
          }
        } catch (e) {
          console.warn('[EO-DB] Failed to download/apply snapshot:', latest.name, e);
        }
      }
    }

    // Then apply backup files for anything after the snapshot
    for (const backup of backups) {
      if (!backup.key) continue;
      if (backup.seq <= lastAppliedSeq) continue;
      try {
        const raw = await filenDownloadFile(
          auth.apiKey, backup.uuid, backup.key, backup.region, backup.bucket,
        );
        const data = keyring ? await decryptSnapshot(raw, keyring) : raw;
        const eodb = unpackEodb(data);
        for (const event of eodb.events) {
          if (event.seq <= lastAppliedSeq) continue;
          const seq = await processEvent(store, event, onEvent);
          lastAppliedSeq = Math.max(lastAppliedSeq, seq);
        }
      } catch (e) {
        console.warn('[EO-DB] Failed to apply backup file:', backup.name, e);
      }
    }

    return lastAppliedSeq;
  }
}
