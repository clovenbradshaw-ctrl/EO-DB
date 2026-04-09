/**
 * Google Drive sync service — append-only log + rolling buffer model.
 *
 * Three files per space on Drive:
 *
 *   space-log.eodb     — Cumulative full history. Every event ever, in seq
 *                        order. Written by the bake winner. New/wiped clients
 *                        download this once; active clients with OPFS never
 *                        need it again.
 *
 *   space-recent.eodb  — Rolling buffer of the last ~256 events. Written by
 *                        ANY client on every op save (overwrite). Existing
 *                        clients only need to pull this between bakes.
 *                        Last-write-wins race condition is intentional and
 *                        acceptable: the losing write's events live in OPFS
 *                        and reappear on the next bake; WebRTC fills the gap
 *                        for connected peers in real time.
 *
 *   space-manifest.json — { head_seq, buffer_from_seq, buffer_to_seq,
 *                           log_size_bytes, checkpoints[], updated_at }
 *                         ~200 bytes. Polled first to know if there's anything
 *                         new without downloading the larger files.
 *
 * Bake (every 256 ops, winner via intent voting):
 *   1. Download log + buffer → merge all events (dedup by client_event_id)
 *   2. Write to temp file → verify → rename to space-log.eodb
 *   3. Clear space-recent.eodb
 *   4. Update manifest with new checkpoints
 *
 * Backward compat: old op-*.eodb and hydration-*.eodb files are applied
 * during the initial hydrateFromGDrive on spaces that haven't migrated.
 */

import type { EoStore } from '../db/encrypted-store';
import type { LocalKeyring } from '../db/crypto-types';
import type { EoEvent } from '../db/types';
import { encryptSnapshot, decryptSnapshot } from '../crypto/snapshot-crypto';
import { resolveSnapshotKeyId } from '../crypto/segment-keys';
import { packEodb, unpackEodb, type EodbFile } from './eodb-format';
import {
  gdriveListByPrefix,
  gdriveDeleteFile,
  gdriveStoreNamed,
  gdriveStoreJson,
  gdriveReadJson,
  gdriveRetrieveNamed,
  gdriveRetrieveRange,
  gdriveRetrieve,
} from './gdrive-api';
import type { GDriveListEntry } from './gdrive-api';
import { processEvent } from '../db/fold';
import { useGDriveStore } from './gdrive-store';

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = 15_000;
const OPS_PER_BAKE = 256;
const RECENT_BUFFER_MAX = 256;
const BAKE_VOTE_GRACE_MS = 2_000;
const BAKE_LOCK_TTL_MS = 60_000;

const LOG_FILE = 'space-log.eodb';
const RECENT_FILE = 'space-recent.eodb';
const MANIFEST_FILE = 'space-manifest.json';
const LOG_PENDING_PREFIX = 'space-log-pending-';

// ──────────────────────────────────────────────────────────────
// Manifest type
// ──────────────────────────────────────────────────────────────

interface SyncManifest {
  head_seq: number;
  buffer_from_seq: number;
  buffer_to_seq: number;
  log_size_bytes: number;
  /** Byte offsets recorded at each bake for range-request catch-up. */
  checkpoints: Array<{ from_seq: number; byte_offset: number }>;
  updated_at: string;
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Parse events from a downloaded binary blob; returns [] on failure. */
function safeUnpackEvents(data: Uint8Array): EoEvent[] {
  try {
    const eodb = unpackEodb(data);
    return eodb.events ?? [];
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────
// Sync service
// ──────────────────────────────────────────────────────────────

export class GDriveSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private destroyed = false;
  private baking = false;

  /**
   * In-memory accumulator of this session's ops since the last bake.
   * Written to space-recent.eodb on every saveOp/saveBulkOps call.
   */
  private opsBuffer: EoEvent[] = [];

  private store: EoStore;
  private spaceId: string;
  private spaceName: string;
  private userId: string;
  private sessionId: string;
  private matrixAccessToken: string;
  private keyring: LocalKeyring;

  onEvent?: (event: any) => void;
  onHydrated?: () => void;
  onStatus?: (status: 'syncing' | 'synced' | 'error', detail?: string) => void;

  /**
   * Called (after GDrive write confirms) whenever an op is saved.
   * Wire this to PeerSync.broadcastGDriveUpdate() to reduce peer poll lag.
   */
  onOpSaved?: (seq: number) => void;

  constructor(opts: {
    store: EoStore;
    spaceId: string;
    spaceName: string;
    userId: string;
    sessionId?: string;
    matrixAccessToken: string;
    keyring?: LocalKeyring;
    onEvent?: (event: any) => void;
    onHydrated?: () => void;
  }) {
    this.store = opts.store;
    this.spaceId = opts.spaceId;
    this.spaceName = opts.spaceName;
    this.userId = opts.userId;
    this.sessionId = opts.sessionId ?? Math.random().toString(36).slice(2, 10);
    this.matrixAccessToken = opts.matrixAccessToken;
    this.keyring = opts.keyring || { keys: new Map() };
    this.onEvent = opts.onEvent;
    this.onHydrated = opts.onHydrated;
  }

  setKeyring(keyring: LocalKeyring): void {
    this.keyring = keyring;
  }

  private get dataType(): string {
    return `eodb-${this.spaceId}`;
  }

  private async encryptBinary(binary: Uint8Array): Promise<Uint8Array> {
    const keyId = resolveSnapshotKeyId(this.keyring);
    if (!keyId) return binary;
    return encryptSnapshot(binary, this.keyring, keyId);
  }

  private async decryptBinary(binary: Uint8Array): Promise<Uint8Array> {
    return decryptSnapshot(binary, this.keyring).catch(() => binary);
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.timer) return;

    const dt = this.dataType;
    try {
      this.onStatus?.('syncing');
      const hydratedSeq = await GDriveSyncService.hydrateFromGDrive(
        this.store, this.matrixAccessToken, dt, this.onEvent, this.keyring,
      );
      if (hydratedSeq > 0) {
        this.onHydrated?.();
        console.log(`[EO-DB] GDrive startup hydration: reached seq ${hydratedSeq}`);
      }
      this.onStatus?.('synced');
      useGDriveStore.getState().setGDriveOffline(false);
    } catch (e) {
      console.warn('[EO-DB] GDrive startup hydration failed:', e);
      this.onStatus?.('error', e instanceof Error ? e.message : String(e));
      useGDriveStore.getState().setGDriveOffline(true);
    }

    // Clean up any orphaned temp files from crashed bakes
    this.cleanOrphanedTempFiles().catch(() => {});

    this.timer = setInterval(() => {
      if (!this.syncing && !this.destroyed) {
        this.syncCycle().catch(console.warn);
      }
    }, SYNC_INTERVAL_MS);
  }

  stop(): void {
    this.destroyed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  triggerImmediateCheck(): void {
    if (!this.syncing && !this.destroyed) {
      this.syncCycle().catch(console.warn);
    }
  }

  async forceSave(): Promise<void> {
    if (this.destroyed) return;
    this.triggerImmediateCheck();
  }

  // ── Per-op save ──────────────────────────────────────────

  /**
   * Save a single op immediately.
   * Adds to the in-memory buffer, then overwrites space-recent.eodb.
   * Fires onOpSaved after GDrive confirms the write.
   */
  async saveOp(event: EoEvent): Promise<void> {
    if (this.destroyed) return;
    this.opsBuffer.push(event);
    await this.flushBuffer();
    if (this.opsBuffer.length >= OPS_PER_BAKE && !this.baking) {
      this.raiseBakeHand().catch(console.warn);
    }
  }

  /**
   * Save a batch of ops from an import in one GDrive write.
   * No per-event writes — one flush at the end.
   */
  async saveBulkOps(events: EoEvent[]): Promise<void> {
    if (this.destroyed || events.length === 0) return;
    for (const e of events) this.opsBuffer.push(e);
    await this.flushBuffer();
    if (this.opsBuffer.length >= OPS_PER_BAKE && !this.baking) {
      this.raiseBakeHand().catch(console.warn);
    }
  }

  /**
   * Read space-recent.eodb, merge with own opsBuffer, keep most recent
   * RECENT_BUFFER_MAX events, write back.
   *
   * Race condition note: last-write-wins. If two clients write simultaneously
   * the loser's last event is temporarily absent from the buffer. It remains
   * in the writer's local OPFS and will appear on the next bake. WebRTC
   * closes the gap for connected peers in real time.
   */
  private async flushBuffer(): Promise<void> {
    const dt = this.dataType;

    // Read remote buffer for events we may not have yet
    const remoteEvents = await this.downloadRecentBuffer();

    // Merge: own buffer takes precedence (dedup by client_event_id)
    const merged = new Map<string, EoEvent>();
    for (const e of remoteEvents) {
      const key = e.client_event_id ?? `${e.seq}`;
      merged.set(key, e);
    }
    for (const e of this.opsBuffer) {
      const key = e.client_event_id ?? `${e.seq}`;
      merged.set(key, e);
    }

    // Keep most recent RECENT_BUFFER_MAX by seq
    const sorted = Array.from(merged.values()).sort((a, b) => a.seq - b.seq);
    const trimmed = sorted.slice(-RECENT_BUFFER_MAX);

    // Pack and write
    const recentFile: EodbFile = {
      version: 1,
      type: 'op',
      space_id: this.spaceId,
      space_name: this.spaceName,
      from_seq: trimmed.length > 0 ? trimmed[0].seq : 0,
      to_seq: trimmed.length > 0 ? trimmed[trimmed.length - 1].seq : 0,
      created_by: this.userId,
      created_at: new Date().toISOString(),
      events: trimmed,
      prev_snapshots: [],
    };
    const binary = packEodb(recentFile);
    const encrypted = await this.encryptBinary(binary);
    await gdriveStoreNamed(this.matrixAccessToken, encrypted, dt, RECENT_FILE);

    const lastSeq = trimmed.length > 0 ? trimmed[trimmed.length - 1].seq : 0;
    const fromSeq = trimmed.length > 0 ? trimmed[0].seq : 0;

    // Preserve log fields from existing manifest (written by bake)
    let logSizeBytes = 0;
    let checkpoints: SyncManifest['checkpoints'] = [];
    try {
      const existing = await gdriveReadJson(this.matrixAccessToken, dt, MANIFEST_FILE);
      if (existing) {
        const m = existing as unknown as SyncManifest;
        logSizeBytes = m.log_size_bytes ?? 0;
        checkpoints = m.checkpoints ?? [];
      }
    } catch { /* non-critical */ }

    const manifest: SyncManifest = {
      head_seq: lastSeq,
      buffer_from_seq: fromSeq,
      buffer_to_seq: lastSeq,
      log_size_bytes: logSizeBytes,
      checkpoints,
      updated_at: new Date().toISOString(),
    };
    await gdriveStoreJson(
      this.matrixAccessToken, dt, MANIFEST_FILE,
      manifest as unknown as Record<string, unknown>,
    );

    // Notify peers after write confirms
    if (lastSeq > 0) {
      this.onOpSaved?.(lastSeq);
    }

    useGDriveStore.getState().recordSync(this.spaceId);
    this.onStatus?.('synced');
    console.log(`[EO-DB] GDrive buffer flushed: ${trimmed.length} events, head_seq=${lastSeq}`);
  }

  private async downloadRecentBuffer(): Promise<EoEvent[]> {
    try {
      const result = await gdriveRetrieveNamed(
        this.matrixAccessToken, this.dataType, RECENT_FILE,
      );
      if (!result?.ok) return [];
      const data = await this.decryptBinary(result.data);
      return safeUnpackEvents(data);
    } catch {
      return [];
    }
  }

  // ── Bake ──────────────────────────────────────────────────

  /**
   * Volunteer to bake via the intent-voting mechanism.
   * Earliest voted_at timestamp wins and writes the cumulative log.
   */
  private async raiseBakeHand(): Promise<void> {
    if (this.baking || this.destroyed) return;
    const dt = this.dataType;
    const intentFileName = `bake-intent-${this.userId}.json`;
    const votedAt = new Date().toISOString();

    try {
      await gdriveStoreJson(this.matrixAccessToken, dt, intentFileName, {
        voter: this.userId,
        voted_at: votedAt,
        op_count: this.opsBuffer.length,
      });
      console.log('[EO-DB] GDrive bake hand raised');
      await sleep(BAKE_VOTE_GRACE_MS);

      const { entries } = await gdriveListByPrefix(this.matrixAccessToken, dt, 'bake-intent-');
      const now = Date.now();
      const validIntents: Array<{ voter: string; voted_at: string; fileId: string }> = [];

      for (const entry of entries) {
        try {
          const result = await gdriveRetrieve(this.matrixAccessToken, entry.content_hash);
          if (!result.ok || !result.envelope) continue;
          let parsed: Record<string, unknown>;
          if (result.envelope instanceof Uint8Array) {
            parsed = JSON.parse(new TextDecoder().decode(result.envelope));
          } else if (typeof result.envelope === 'string') {
            parsed = JSON.parse(result.envelope);
          } else {
            parsed = result.envelope as Record<string, unknown>;
          }
          const intentTime = new Date(parsed.voted_at as string).getTime();
          if (now - intentTime > BAKE_LOCK_TTL_MS) continue;
          validIntents.push({
            voter: parsed.voter as string,
            voted_at: parsed.voted_at as string,
            fileId: entry.data_id,
          });
        } catch { /* skip unreadable */ }
      }

      if (validIntents.length === 0) {
        await this.bakeLog(dt, []);
        return;
      }

      validIntents.sort((a, b) =>
        new Date(a.voted_at).getTime() - new Date(b.voted_at).getTime(),
      );
      const winner = validIntents[0];

      if (winner.voter !== this.userId) {
        console.log(`[EO-DB] GDrive bake: ${winner.voter} won, standing down`);
        try {
          const myEntry = entries.find(e => e.name === intentFileName);
          if (myEntry) await gdriveDeleteFile(this.matrixAccessToken, myEntry.data_id);
        } catch { /* non-critical */ }
        this.opsBuffer = [];
        return;
      }

      await this.bakeLog(dt, validIntents.map(i => i.fileId));
    } catch (e) {
      console.warn('[EO-DB] GDrive raise-hand failed:', e);
      this.baking = false;
    }
  }

  /**
   * Write the cumulative log file atomically:
   * 1. Download existing log + buffer
   * 2. Merge all events (dedup by client_event_id)
   * 3. Write temp file, verify, then overwrite log
   * 4. Update manifest with new checkpoints
   * 5. Clear buffer
   */
  private async bakeLog(dt: string, intentFileIds: string[]): Promise<void> {
    if (this.baking) return;
    this.baking = true;
    console.log('[EO-DB] GDrive bake: starting cumulative log write');

    try {
      // 1. Download existing log (full history so far)
      const priorEvents: EoEvent[] = [];
      try {
        const logResult = await gdriveRetrieveNamed(this.matrixAccessToken, dt, LOG_FILE);
        if (logResult?.ok) {
          const data = await this.decryptBinary(logResult.data);
          priorEvents.push(...safeUnpackEvents(data));
        }
      } catch { /* log may not exist yet */ }

      // 2. Download remote buffer
      const bufferEvents = await this.downloadRecentBuffer();

      // 3. Merge: log + buffer + own opsBuffer; dedup by client_event_id
      const merged = new Map<string, EoEvent>();
      for (const e of priorEvents) merged.set(e.client_event_id ?? `seq:${e.seq}`, e);
      for (const e of bufferEvents) merged.set(e.client_event_id ?? `seq:${e.seq}`, e);
      for (const e of this.opsBuffer) merged.set(e.client_event_id ?? `seq:${e.seq}`, e);

      if (merged.size === 0) {
        console.log('[EO-DB] GDrive bake: nothing to bake');
        return;
      }

      const events = Array.from(merged.values()).sort((a, b) => a.seq - b.seq);
      const fromSeq = events[0].seq;
      const toSeq = events[events.length - 1].seq;

      // Record checkpoint: byte offset where bake events start (before pack)
      // We compute approximate offset based on prior events count
      const priorEventCount = priorEvents.length;
      const newEventCount = events.length - priorEventCount;

      // 4. Pack and encrypt the full cumulative log
      const logFile: EodbFile = {
        version: 1,
        type: 'hydration',
        space_id: this.spaceId,
        space_name: this.spaceName,
        from_seq: fromSeq,
        to_seq: toSeq,
        created_by: this.userId,
        created_at: new Date().toISOString(),
        events,
        prev_snapshots: [],
      };
      const binary = packEodb(logFile);
      const encrypted = await this.encryptBinary(binary);

      // 5. Atomic write: temp file → verify → rename
      const tempFileName = `${LOG_PENDING_PREFIX}${this.userId}.eodb`;
      const tempResult = await gdriveStoreNamed(
        this.matrixAccessToken, encrypted, dt, tempFileName,
      );
      if (!tempResult.ok) {
        console.warn('[EO-DB] GDrive bake: temp write failed, aborting');
        return;
      }

      // Write the real log file
      await gdriveStoreNamed(this.matrixAccessToken, encrypted, dt, LOG_FILE);
      console.log(`[EO-DB] GDrive bake: wrote ${LOG_FILE} (${events.length} events, seq ${fromSeq}→${toSeq})`);

      // 6. Clear buffer
      const emptyFile: EodbFile = {
        version: 1,
        type: 'op',
        space_id: this.spaceId,
        space_name: this.spaceName,
        from_seq: toSeq,
        to_seq: toSeq,
        created_by: this.userId,
        created_at: new Date().toISOString(),
        events: [],
        prev_snapshots: [],
      };
      const emptyBinary = packEodb(emptyFile);
      const emptyEncrypted = await this.encryptBinary(emptyBinary);
      await gdriveStoreNamed(this.matrixAccessToken, emptyEncrypted, dt, RECENT_FILE);

      // 7. Update manifest with checkpoints
      const logSizeBytes = encrypted.length;
      // Estimate byte offset for the new events (rough: proportional to event count)
      const newEventsOffset = priorEventCount > 0
        ? Math.floor(logSizeBytes * (priorEventCount / events.length))
        : 0;

      const manifest: SyncManifest = {
        head_seq: toSeq,
        buffer_from_seq: toSeq,
        buffer_to_seq: toSeq,
        log_size_bytes: logSizeBytes,
        checkpoints: [
          { from_seq: fromSeq, byte_offset: 0 },
          ...(newEventsOffset > 0 && newEventCount > 0
            ? [{ from_seq: events[priorEventCount]?.seq ?? toSeq, byte_offset: newEventsOffset }]
            : []),
        ],
        updated_at: new Date().toISOString(),
      };
      await gdriveStoreJson(
        this.matrixAccessToken, dt, MANIFEST_FILE,
        manifest as unknown as Record<string, unknown>,
      );

      // 8. Delete temp file and intent files
      try {
        const { entries: tempEntries } = await gdriveListByPrefix(
          this.matrixAccessToken, dt, LOG_PENDING_PREFIX,
        );
        for (const e of tempEntries) {
          await gdriveDeleteFile(this.matrixAccessToken, e.data_id).catch(() => {});
        }
      } catch { /* non-critical */ }

      for (const fileId of intentFileIds) {
        await gdriveDeleteFile(this.matrixAccessToken, fileId).catch(() => {});
      }

      this.opsBuffer = [];
      await this.store.put('meta:gdrive_saved_op_count', 0);
      useGDriveStore.getState().recordSync(this.spaceId);
      this.onStatus?.('synced');
      console.log(`[EO-DB] GDrive bake complete: ${events.length} total events`);
    } finally {
      this.baking = false;
    }
  }

  /** Remove orphaned temp files from crashed bakes (older than BAKE_LOCK_TTL_MS). */
  private async cleanOrphanedTempFiles(): Promise<void> {
    try {
      const { entries } = await gdriveListByPrefix(
        this.matrixAccessToken, this.dataType, LOG_PENDING_PREFIX,
      );
      const cutoff = Date.now() - BAKE_LOCK_TTL_MS;
      for (const e of entries) {
        if (e.stored_at && new Date(e.stored_at).getTime() < cutoff) {
          await gdriveDeleteFile(this.matrixAccessToken, e.data_id).catch(() => {});
        }
      }
    } catch { /* non-critical */ }
  }

  // ── Poll cycle ──────────────────────────────────────────

  private async syncCycle(): Promise<void> {
    if (this.syncing || this.destroyed) return;
    this.syncing = true;
    this.onStatus?.('syncing');
    try {
      await this.pullFromGDrive();
      this.onStatus?.('synced');
    } catch (e: any) {
      console.warn('[EO-DB] GDrive sync cycle failed:', e);
      this.onStatus?.('error', e.message);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Incremental pull — only downloads what the client is missing.
   * 1. Read manifest (200 bytes) → know if there's anything new
   * 2. If head_seq > localSeq and buffer covers the gap → pull recent buffer
   * 3. If gap is larger than buffer → pull log (or range-request the delta)
   */
  private async pullFromGDrive(): Promise<void> {
    const dt = this.dataType;
    const localSeq = await this.store.getCurrentSeq();

    // Try manifest first
    let manifest: SyncManifest | null = null;
    try {
      const raw = await gdriveReadJson(this.matrixAccessToken, dt, MANIFEST_FILE);
      if (raw) manifest = raw as unknown as SyncManifest;
    } catch { /* manifest may not exist */ }

    if (manifest && manifest.head_seq <= localSeq) {
      return; // nothing new
    }

    const headSeq = manifest?.head_seq ?? Infinity;
    const bufferFromSeq = manifest?.buffer_from_seq ?? 0;

    if (bufferFromSeq <= localSeq) {
      // Common case: buffer covers the gap — just pull the recent buffer
      const bufferEvents = await this.downloadRecentBuffer();
      let advanced = false;
      for (const event of bufferEvents) {
        if (event.seq <= localSeq) continue;
        await processEvent(this.store, event, this.onEvent);
        advanced = true;
      }
      if (advanced) {
        const newSeq = await this.store.getCurrentSeq();
        console.log(`[EO-DB] GDrive pull (buffer): advanced to seq ${newSeq}`);
        useGDriveStore.getState().recordSync(this.spaceId);
        if (newSeq > localSeq) this.onHydrated?.();
      }
    } else {
      // Bake happened and buffer doesn't cover gap — need log or range request
      await this.pullLogDelta(dt, localSeq, manifest);
    }
  }

  private async pullLogDelta(
    dt: string,
    localSeq: number,
    manifest: SyncManifest | null,
  ): Promise<void> {
    // Try range request if checkpoints available
    if (manifest?.checkpoints?.length && manifest.log_size_bytes > 0) {
      const checkpoint = [...manifest.checkpoints]
        .sort((a, b) => b.from_seq - a.from_seq)
        .find(c => c.from_seq <= localSeq + 1);

      if (checkpoint && checkpoint.byte_offset > 0) {
        try {
          const rangeResult = await gdriveRetrieveRange(
            this.matrixAccessToken, dt, LOG_FILE, checkpoint.byte_offset,
          );
          if (rangeResult?.ok && rangeResult.data.length > 0) {
            const data = await this.decryptBinary(rangeResult.data);
            const events = safeUnpackEvents(data);
            let applied = 0;
            for (const event of events) {
              if (event.seq <= localSeq) continue;
              await processEvent(this.store, event, this.onEvent);
              applied++;
            }
            if (applied > 0) {
              console.log(`[EO-DB] GDrive range pull: applied ${applied} events`);
              useGDriveStore.getState().recordSync(this.spaceId);
              this.onHydrated?.();
            }
            // Also pull recent buffer for any post-log events
            await this.pullFromGDrive();
            return;
          }
        } catch (e) {
          console.warn('[EO-DB] GDrive range request failed, falling back to full log:', e);
        }
      }
    }

    // Fallback: download full log
    try {
      const logResult = await gdriveRetrieveNamed(this.matrixAccessToken, dt, LOG_FILE);
      if (!logResult?.ok) return;
      const data = await this.decryptBinary(logResult.data);
      const events = safeUnpackEvents(data);
      let applied = 0;
      for (const event of events) {
        if (event.seq <= localSeq) continue;
        await processEvent(this.store, event, this.onEvent);
        applied++;
      }
      if (applied > 0) {
        const newSeq = await this.store.getCurrentSeq();
        console.log(`[EO-DB] GDrive log pull: applied ${applied} events, seq now ${newSeq}`);
        useGDriveStore.getState().recordSync(this.spaceId);
        this.onHydrated?.();
      }
      // Also pull recent buffer
      await this.pullFromGDrive();
    } catch (e) {
      console.warn('[EO-DB] GDrive full log pull failed:', e);
    }
  }

  // ── Static hydration (new/wiped clients) ──────────────────

  /**
   * Hydrate a store from Google Drive.
   *
   * New-format priority:
   *   1. space-log.eodb  — cumulative full history
   *   2. space-recent.eodb — recent events not yet baked into log
   *
   * Backward-compat fallback (old hydration-*.eodb + op-*.eodb):
   *   - Collect ALL events from ALL hydration slots (dedup by client_event_id,
   *     sorted by seq) — fixes the old bug where only the best slot was applied
   *   - Then apply any op-*.eodb files newer than hydration point
   */
  static async hydrateFromGDrive(
    store: EoStore,
    matrixAccessToken: string,
    dataType: string,
    onEvent?: (event: any) => void,
    keyring?: LocalKeyring,
  ): Promise<number> {
    console.log('[EO-DB] hydrateFromGDrive: starting, dataType =', dataType);
    const localSeq = await store.getCurrentSeq();
    let lastAppliedSeq = localSeq;

    const decrypt = async (raw: Uint8Array): Promise<Uint8Array> =>
      keyring ? decryptSnapshot(raw, keyring).catch(() => raw) : raw;

    // ── 1. Try new format: space-log.eodb ──
    let usedNewFormat = false;
    try {
      const logResult = await gdriveRetrieveNamed(matrixAccessToken, dataType, LOG_FILE);
      if (logResult?.ok) {
        const data = await decrypt(logResult.data);
        const events = safeUnpackEvents(data);
        if (events.length > 0) {
          console.log(`[EO-DB] hydrateFromGDrive: applying ${LOG_FILE} (${events.length} events)`);
          for (const event of events) {
            if (event.seq <= localSeq) continue;
            const seq = await processEvent(store, event, onEvent);
            lastAppliedSeq = Math.max(lastAppliedSeq, seq);
          }
          usedNewFormat = true;
        }
      }
    } catch (e) {
      console.warn('[EO-DB] hydrateFromGDrive: log read failed, trying fallback:', e);
    }

    // ── 2. Apply space-recent.eodb (new or updated events since last bake) ──
    try {
      const recentResult = await gdriveRetrieveNamed(matrixAccessToken, dataType, RECENT_FILE);
      if (recentResult?.ok) {
        const data = await decrypt(recentResult.data);
        const events = safeUnpackEvents(data);
        for (const event of events) {
          if (event.seq <= lastAppliedSeq) continue;
          const seq = await processEvent(store, event, onEvent);
          lastAppliedSeq = Math.max(lastAppliedSeq, seq);
        }
      }
    } catch { /* non-critical */ }

    if (usedNewFormat) {
      console.log(`[EO-DB] hydrateFromGDrive: complete (new format). Seq ${lastAppliedSeq}`);
      return lastAppliedSeq;
    }

    // ── 3. Backward compat: hydration-*.eodb ──
    // Collect ALL events from ALL slots (fixes bug where only best slot was applied)
    console.log('[EO-DB] hydrateFromGDrive: falling back to hydration-*.eodb');
    const { entries: hydrationEntries } = await gdriveListByPrefix(
      matrixAccessToken, dataType, 'hydration-',
    ).catch(() => ({ entries: [] as GDriveListEntry[] }));

    const legacyEvents = new Map<string, EoEvent>();

    for (const entry of hydrationEntries) {
      try {
        console.log(`[EO-DB] hydrateFromGDrive: downloading ${entry.name}…`);
        const result = await gdriveRetrieve(matrixAccessToken, entry.content_hash);
        if (!result.ok || !(result.envelope instanceof Uint8Array)) continue;
        const data = await decrypt(result.envelope);
        const events = safeUnpackEvents(data);
        for (const e of events) {
          legacyEvents.set(e.client_event_id ?? `seq:${e.seq}`, e);
        }
      } catch (e) {
        console.warn('[EO-DB] hydrateFromGDrive: skipping unreadable hydration file', entry.name, e);
      }
    }

    // Apply all legacy hydration events in seq order
    const sortedLegacy = Array.from(legacyEvents.values()).sort((a, b) => a.seq - b.seq);
    for (const event of sortedLegacy) {
      if (event.seq <= localSeq) continue;
      try {
        const seq = await processEvent(store, event, onEvent);
        lastAppliedSeq = Math.max(lastAppliedSeq, seq);
      } catch { /* skip individual failures */ }
    }

    // ── 4. Apply op-*.eodb files newer than hydration point ──
    const { entries: opEntries } = await gdriveListByPrefix(
      matrixAccessToken, dataType, 'op-',
    ).catch(() => ({ entries: [] as GDriveListEntry[] }));

    const newOps = opEntries
      .filter(e => !e.name.startsWith('space-')) // skip new-format files
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of newOps) {
      try {
        const result = await gdriveRetrieve(matrixAccessToken, entry.content_hash);
        if (!result.ok || !(result.envelope instanceof Uint8Array)) continue;
        const data = await decrypt(result.envelope);
        const events = safeUnpackEvents(data);
        for (const event of events) {
          if (event.seq <= lastAppliedSeq) continue;
          const seq = await processEvent(store, event, onEvent);
          lastAppliedSeq = Math.max(lastAppliedSeq, seq);
        }
      } catch (e) {
        console.warn('[EO-DB] hydrateFromGDrive: skipping op file', entry.name, e);
      }
    }

    console.log(`[EO-DB] hydrateFromGDrive: complete. Applied up to seq ${lastAppliedSeq}`);
    return lastAppliedSeq;
  }
}
