/**
 * Filen sync service — batch uploads every 30 seconds with snapshots every 5,000 updates.
 *
 * This service runs a 30-second timer. Each cycle:
 * 1. Checks if there are new events since the last sync
 * 2. Packs them into a binary .eodb file (msgpack)
 * 3. Uploads as `current.eodb` (overwriting the previous one)
 * 4. Every 5,000 cumulative events, creates an immutable `snapshot-{seq}.eodb`
 *
 * For hydration (new device), it downloads the latest snapshot + current.eodb
 * and replays them through the fold engine.
 */

import { pack, unpack } from 'msgpackr';
import type { EoStore } from '../db/encrypted-store';
import type { EoEvent } from '../db/types';
import { processEvent } from '../db/fold';
import { readLogSince } from '../db/log';
import {
  filenUploadFile,
  filenListFolder,
  filenDownloadFile,
  filenTrashFile,
  type FilenItem,
} from './filen-api';
import { useFilenStore, type FilenStoreState } from './filen-store';

// ──────────────────────────────────────────────────────────────
// .eodb file format
// ──────────────────────────────────────────────────────────────

/** Magic bytes at the start of every .eodb file: "EODB" in ASCII. */
const EODB_MAGIC = new Uint8Array([0x45, 0x4F, 0x44, 0x42]);

export interface EodbFile {
  version: 1;
  type: 'current' | 'snapshot';
  space_id: string;
  space_name: string;
  from_seq: number;
  to_seq: number;
  created_by: string;
  created_at: string;
  events: EoEvent[];
  prev_snapshots: string[];   // UUIDs of previous snapshot files (up to 10)
}

/** Pack an EodbFile into binary with magic header. */
export function packEodb(file: EodbFile): Uint8Array {
  const body = pack(file);
  const result = new Uint8Array(EODB_MAGIC.length + body.byteLength);
  result.set(EODB_MAGIC, 0);
  result.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), EODB_MAGIC.length);
  return result;
}

/** Unpack binary back to an EodbFile, validating magic header. */
export function unpackEodb(data: Uint8Array): EodbFile {
  // Check magic bytes
  for (let i = 0; i < EODB_MAGIC.length; i++) {
    if (data[i] !== EODB_MAGIC[i]) {
      throw new Error('Not a valid .eodb file (bad magic bytes)');
    }
  }
  return unpack(data.slice(EODB_MAGIC.length)) as EodbFile;
}

/** Check if a Uint8Array starts with the EODB magic bytes. */
export function isEodbFile(data: Uint8Array): boolean {
  if (data.length < EODB_MAGIC.length) return false;
  for (let i = 0; i < EODB_MAGIC.length; i++) {
    if (data[i] !== EODB_MAGIC[i]) return false;
  }
  return true;
}

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = 30_000;     // 30 seconds
const SNAPSHOT_FREQUENCY = 5_000;     // snapshot every 5,000 events
const MAX_PREV_SNAPSHOTS = 10;
const CURRENT_FILENAME = 'current.eodb';

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

  private store: EoStore;
  private spaceId: string;
  private spaceName: string;
  private spaceFolderUuid: string;
  private userId: string;

  /** File UUID of the current.eodb on Filen (for overwrite-by-trash). */
  private currentFileUuid: string | null = null;
  private currentFileKey: string | null = null;

  /** Callback for UI status updates. */
  onStatus?: (status: 'syncing' | 'synced' | 'error', detail?: string) => void;

  constructor(opts: {
    store: EoStore;
    spaceId: string;
    spaceName: string;
    spaceFolderUuid: string;
    userId: string;
  }) {
    this.store = opts.store;
    this.spaceId = opts.spaceId;
    this.spaceName = opts.spaceName;
    this.spaceFolderUuid = opts.spaceFolderUuid;
    this.userId = opts.userId;
  }

  /** Start the 30-second sync timer. */
  async start(): Promise<void> {
    if (this.timer) return;

    // Recover last synced seq from local metadata
    const savedSeq: number = (await this.store.get('meta:filen_synced_seq')) || 0;
    const savedSnapshotSeq: number = (await this.store.get('meta:filen_snapshot_seq')) || 0;
    this.lastSyncedSeq = savedSeq;
    this.lastSnapshotSeq = savedSnapshotSeq;

    // Discover existing current.eodb UUID so we can overwrite it
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
   * Discover existing .eodb files in the space folder.
   * Recovers the current.eodb UUID for overwriting and snapshot UUIDs.
   */
  private async discoverExistingFiles(): Promise<void> {
    const { auth, masterKeys } = useFilenStore.getState();
    if (!auth) return;

    try {
      const items = await filenListFolder(auth.apiKey, this.spaceFolderUuid, masterKeys);
      for (const item of items) {
        if (item.type === 'file' && item.name === CURRENT_FILENAME) {
          this.currentFileUuid = item.uuid;
          this.currentFileKey = item.key || null;
        }
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
   * Core sync cycle — called every 30 seconds.
   */
  private async syncCycle(): Promise<void> {
    if (this.syncing || this.destroyed) return;
    this.syncing = true;
    this.onStatus?.('syncing');

    try {
      const { auth, masterKeys } = useFilenStore.getState();
      if (!auth) { this.syncing = false; return; }

      const currentSeq = await this.store.getCurrentSeq();
      if (currentSeq === 0 || currentSeq === this.lastSyncedSeq) {
        this.onStatus?.('synced');
        this.syncing = false;
        return;
      }

      // Read events since last sync
      const events = await readLogSince(this.store, this.lastSyncedSeq);
      if (events.length === 0) {
        this.onStatus?.('synced');
        this.syncing = false;
        return;
      }

      // Upload current.eodb (delta since last snapshot)
      const allEventsSinceSnapshot = await readLogSince(this.store, this.lastSnapshotSeq);
      const currentFile: EodbFile = {
        version: 1,
        type: 'current',
        space_id: this.spaceId,
        space_name: this.spaceName,
        from_seq: this.lastSnapshotSeq,
        to_seq: currentSeq,
        created_by: this.userId,
        created_at: new Date().toISOString(),
        events: allEventsSinceSnapshot,
        prev_snapshots: this.prevSnapshotUuids.slice(0, MAX_PREV_SNAPSHOTS),
      };

      const binary = packEodb(currentFile);

      // Trash old current.eodb if it exists
      if (this.currentFileUuid) {
        try {
          await filenTrashFile(auth.apiKey, this.currentFileUuid);
        } catch {
          // Non-critical — the upload will succeed regardless
        }
      }

      // Upload new current.eodb
      const uploaded = await filenUploadFile(
        auth.apiKey, this.spaceFolderUuid, CURRENT_FILENAME, binary, masterKeys[0],
      );
      this.currentFileUuid = uploaded.uuid;
      this.currentFileKey = uploaded.fileKey;

      // Update bookkeeping
      this.lastSyncedSeq = currentSeq;
      await this.store.put('meta:filen_synced_seq', currentSeq);

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
   * Create an immutable snapshot-{seq}.eodb containing ALL events.
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
    const filename = snapshotFilename(currentSeq);

    const uploaded = await filenUploadFile(
      apiKey, this.spaceFolderUuid, filename, binary, masterKey,
    );

    this.prevSnapshotUuids.unshift(uploaded.uuid);
    if (this.prevSnapshotUuids.length > MAX_PREV_SNAPSHOTS) {
      this.prevSnapshotUuids = this.prevSnapshotUuids.slice(0, MAX_PREV_SNAPSHOTS);
    }

    this.lastSnapshotSeq = currentSeq;
    await this.store.put('meta:filen_snapshot_seq', currentSeq);

    console.log(`[EO-DB] Filen snapshot created: ${filename} (${allEvents.length} events, ${binary.byteLength} bytes)`);
  }

  // ──────────────────────────────────────────────────────────
  // Hydration (new device)
  // ──────────────────────────────────────────────────────────

  /**
   * Hydrate a store from Filen.
   *
   * 1. List files in the space folder
   * 2. Find the latest snapshot-*.eodb (highest seq)
   * 3. Download and apply it
   * 4. Download current.eodb for any events after the snapshot
   * 5. Apply those too
   *
   * Returns the final seq after hydration.
   */
  static async hydrateFromFilen(
    store: EoStore,
    spaceFolderUuid: string,
    onEvent?: (event: any) => void,
  ): Promise<number> {
    const { auth, masterKeys } = useFilenStore.getState();
    if (!auth) throw new Error('Not connected to Filen');

    const items = await filenListFolder(auth.apiKey, spaceFolderUuid, masterKeys);
    const localSeq = await store.getCurrentSeq();

    // Find all snapshot files and sort by seq (highest first)
    const snapshots: Array<FilenItem & { seq: number }> = [];
    let currentFile: FilenItem | null = null;

    for (const item of items) {
      if (item.type !== 'file' || !item.name.endsWith('.eodb')) continue;
      if (item.name === CURRENT_FILENAME) {
        currentFile = item;
        continue;
      }
      const seq = parseSnapshotSeq(item.name);
      if (seq !== null && seq > localSeq) {
        snapshots.push({ ...item, seq });
      }
    }

    snapshots.sort((a, b) => b.seq - a.seq);

    let lastAppliedSeq = localSeq;

    // Apply latest snapshot first (it contains all events from seq 0)
    if (snapshots.length > 0) {
      const latest = snapshots[0];
      if (latest.key) {
        const data = await filenDownloadFile(
          auth.apiKey, latest.uuid, latest.key, latest.region, latest.bucket,
        );
        const eodb = unpackEodb(data);
        for (const event of eodb.events) {
          if (event.seq <= localSeq) continue;
          const seq = await processEvent(store, event, onEvent);
          lastAppliedSeq = Math.max(lastAppliedSeq, seq);
        }
      }
    }

    // Then apply current.eodb for anything after the snapshot
    if (currentFile?.key) {
      const data = await filenDownloadFile(
        auth.apiKey, currentFile.uuid, currentFile.key,
        currentFile.region, currentFile.bucket,
      );
      const eodb = unpackEodb(data);
      for (const event of eodb.events) {
        if (event.seq <= lastAppliedSeq) continue;
        const seq = await processEvent(store, event, onEvent);
        lastAppliedSeq = Math.max(lastAppliedSeq, seq);
      }
    }

    return lastAppliedSeq;
  }
}
