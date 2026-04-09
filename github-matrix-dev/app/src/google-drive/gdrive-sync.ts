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
import type { FieldShadowConfig } from './space-permissions';
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
  deriveSpaceFileGuid,
} from './gdrive-api';
import type { GDriveListEntry } from './gdrive-api';
import { processEvent } from '../db/fold';
import { readLogSince } from '../db/log';
import { useGDriveStore } from './gdrive-store';

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = 15_000;
const OPS_PER_BAKE = 256;
const RECENT_BUFFER_MAX = 256;
const BAKE_VOTE_GRACE_MS = 2_000;
const BAKE_LOCK_TTL_MS = 60_000;

// Legacy plaintext filenames — used as fallback before GUID-naming was introduced.
const LEGACY_LOG_FILE = 'space-log.eodb';
const LEGACY_RECENT_FILE = 'space-recent.eodb';
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

  // GUID-derived Drive filenames — set in start() before first use.
  // All three tiers (viewer / restricted / admin) are initialised here.
  private logFile: string = LEGACY_LOG_FILE;
  private recentFile: string = LEGACY_RECENT_FILE;
  private manifestFile: string = MANIFEST_FILE;
  private logPendingPrefix: string = LOG_PENDING_PREFIX;
  private restrictedLogFile: string = 'restricted-log.eodb';
  private restrictedRecentFile: string = 'restricted-recent.eodb';
  private adminLogFile: string = 'admin-log.eodb';
  private adminRecentFile: string = 'admin-recent.eodb';

  /**
   * The stable GUIDs for this space's Drive files.
   * Null until start() has been called (GUIDs are derived async).
   */
  fileGuids: { log: string; recent: string; manifest: string } | null = null;

  private store: EoStore;
  private spaceId: string;
  private spaceName: string;
  private userId: string;
  private sessionId: string;
  private googleAccessToken: string;
  private keyring: LocalKeyring;
  /** Matrix main room ID for this space. */
  private spaceRoomId: string | undefined;
  /** Field sensitivity map from the folded manifest — drives 3-tier event routing. */
  private manifestFields: Record<string, FieldShadowConfig> = {};

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
    googleAccessToken: string;
    /** Matrix main room ID for this space. */
    spaceRoomId?: string;
    keyring?: LocalKeyring;
    onEvent?: (event: any) => void;
    onHydrated?: () => void;
  }) {
    this.store = opts.store;
    this.spaceId = opts.spaceId;
    this.spaceName = opts.spaceName;
    this.userId = opts.userId;
    this.sessionId = opts.sessionId ?? Math.random().toString(36).slice(2, 10);
    this.googleAccessToken = opts.googleAccessToken;
    this.spaceRoomId = opts.spaceRoomId;
    this.keyring = opts.keyring || { keys: new Map() };
    this.onEvent = opts.onEvent;
    this.onHydrated = opts.onHydrated;
  }

  /** Update the space room ID (e.g., if room resolution completes after construction). */
  setSpaceRoomId(roomId: string): void {
    this.spaceRoomId = roomId;
  }

  setKeyring(keyring: LocalKeyring): void {
    this.keyring = keyring;
  }

  /** Update the field sensitivity map from a freshly-folded manifest. */
  setManifestFields(fields: Record<string, FieldShadowConfig>): void {
    this.manifestFields = fields;
  }

  /**
   * Classify an event into a log tier based on its op type and the field it touches.
   *   'admin'      — EVA policies, or events touching admin-sensitivity fields
   *   'restricted' — events touching restricted-sensitivity fields
   *   'viewer'     — everything else (public record data)
   */
  private classifyEventTier(event: EoEvent): 'viewer' | 'restricted' | 'admin' {
    if (event.op === 'EVA') return 'admin';
    for (const [fieldKey, config] of Object.entries(this.manifestFields)) {
      if (event.target === fieldKey || event.target.endsWith(`.${fieldKey}`)) {
        return config.sensitivity === 'admin' ? 'admin' : 'restricted';
      }
    }
    return 'viewer';
  }

  /**
   * Find the keyring entry whose scope ends with `{spaceId}.{tier}`.
   * Returns undefined if the user doesn't hold that tier key.
   */
  private resolveKeyIdForTier(tier: 'viewer' | 'restricted' | 'admin'): string | undefined {
    const scopeSuffix = `${this.spaceId}.${tier}`;
    for (const [keyId, entry] of this.keyring.keys) {
      if (entry.scope === scopeSuffix) return keyId;
    }
    return undefined;
  }

  private async encryptBinaryForTier(
    binary: Uint8Array,
    tier: 'viewer' | 'restricted' | 'admin',
  ): Promise<Uint8Array> {
    const keyId = this.resolveKeyIdForTier(tier);
    if (keyId) return encryptSnapshot(binary, this.keyring, keyId);
    // Fallback: try the generic snapshot key (pre-manifest-model spaces)
    const fallbackKeyId = resolveSnapshotKeyId(this.keyring);
    if (fallbackKeyId) return encryptSnapshot(binary, this.keyring, fallbackKeyId);
    return binary;
  }

  private get dataType(): string {
    return `eodb-${this.spaceId}`;
  }

  private async encryptBinary(binary: Uint8Array): Promise<Uint8Array> {
    return this.encryptBinaryForTier(binary, 'viewer');
  }

  private async decryptBinary(binary: Uint8Array): Promise<Uint8Array> {
    return decryptSnapshot(binary, this.keyring).catch(() => binary);
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.timer) return;

    // Derive stable GUIDs from spaceId so all space members use the same filenames.
    const [logGuid, recentGuid, manifestGuid, rLogGuid, rRecentGuid, aLogGuid, aRecentGuid] =
      await Promise.all([
        deriveSpaceFileGuid(this.spaceId, 'log'),
        deriveSpaceFileGuid(this.spaceId, 'recent'),
        deriveSpaceFileGuid(this.spaceId, 'manifest'),
        deriveSpaceFileGuid(this.spaceId, 'restricted-log'),
        deriveSpaceFileGuid(this.spaceId, 'restricted-recent'),
        deriveSpaceFileGuid(this.spaceId, 'admin-log'),
        deriveSpaceFileGuid(this.spaceId, 'admin-recent'),
      ]);
    this.logFile = `${logGuid}.eodb`;
    this.recentFile = `${recentGuid}.eodb`;
    this.manifestFile = `${manifestGuid}.json`;
    this.logPendingPrefix = `${logGuid}-pending-`;
    this.restrictedLogFile = `${rLogGuid}.eodb`;
    this.restrictedRecentFile = `${rRecentGuid}.eodb`;
    this.adminLogFile = `${aLogGuid}.eodb`;
    this.adminRecentFile = `${aRecentGuid}.eodb`;
    this.fileGuids = { log: logGuid, recent: recentGuid, manifest: manifestGuid };
    useGDriveStore.getState().setSpaceFileGuids(this.spaceId, this.fileGuids);

    const dt = this.dataType;
    try {
      this.onStatus?.('syncing');
      const hydratedSeq = await GDriveSyncService.hydrateFromGDrive(
        this.store, this.googleAccessToken, dt, this.onEvent, this.keyring,
        {
          log: this.logFile,
          recent: this.recentFile,
          restrictedLog: this.restrictedLogFile,
          restrictedRecent: this.restrictedRecentFile,
          adminLog: this.adminLogFile,
          adminRecent: this.adminRecentFile,
        },
      );
      if (hydratedSeq > 0) {
        this.onHydrated?.();
        console.log(`[EO-DB] GDrive startup hydration: reached seq ${hydratedSeq}`);
      }

      // If local store has data but GDrive has none, push everything up now.
      const localSeq = await this.store.getCurrentSeq();
      if (localSeq > 0) {
        let gdriveHasData = false;
        try {
          const manifest = await gdriveReadJson(this.googleAccessToken, dt, this.manifestFile);
          gdriveHasData = !!manifest && (manifest as unknown as SyncManifest).head_seq > 0;
        } catch { /* manifest may not exist */ }
        if (!gdriveHasData) {
          console.log('[EO-DB] GDrive empty but local has data — pushing full backup on start');
          await this.fullPushToGDrive();
        }
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

    await this.fullPushToGDrive();
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
   * Read tier-specific recent buffers, merge with own opsBuffer, write back.
   *
   * Events are classified by field sensitivity into three tiers:
   *   viewer     → space-recent.eodb       (viewer-key encrypted)
   *   restricted → restricted-recent.eodb  (restricted-key encrypted)
   *   admin      → admin-recent.eodb       (admin-key encrypted)
   *
   * Race condition note: last-write-wins. If two clients write simultaneously
   * the loser's last event is temporarily absent from the buffer. It remains
   * in the writer's local OPFS and will appear on the next bake. WebRTC
   * closes the gap for connected peers in real time.
   */
  private async flushBuffer(): Promise<void> {
    const dt = this.dataType;

    // Split local buffer by tier
    const viewerOps: EoEvent[] = [];
    const restrictedOps: EoEvent[] = [];
    const adminOps: EoEvent[] = [];
    for (const e of this.opsBuffer) {
      const tier = this.classifyEventTier(e);
      if (tier === 'restricted') restrictedOps.push(e);
      else if (tier === 'admin') adminOps.push(e);
      else viewerOps.push(e);
    }

    // Helper: merge remote + local events for a tier, write back
    const flushTier = async (
      local: EoEvent[],
      remoteFile: string,
      tier: 'viewer' | 'restricted' | 'admin',
    ): Promise<{ lastSeq: number; fromSeq: number }> => {
      let remote: EoEvent[] = [];
      try {
        const r = await gdriveRetrieveNamed(this.googleAccessToken, dt, remoteFile);
        if (r?.ok) remote = safeUnpackEvents(await this.decryptBinary(r.data));
      } catch { /* remote file may not exist yet */ }

      const merged = new Map<string, EoEvent>();
      for (const e of remote) merged.set(e.client_event_id ?? `${e.seq}`, e);
      for (const e of local) merged.set(e.client_event_id ?? `${e.seq}`, e);

      const sorted = Array.from(merged.values()).sort((a, b) => a.seq - b.seq);
      const trimmed = sorted.slice(-RECENT_BUFFER_MAX);

      if (trimmed.length > 0 || local.length > 0) {
        const file: EodbFile = {
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
        const encrypted = await this.encryptBinaryForTier(packEodb(file), tier);
        await gdriveStoreNamed(this.googleAccessToken, encrypted, dt, remoteFile);
      }

      return {
        lastSeq: trimmed.length > 0 ? trimmed[trimmed.length - 1].seq : 0,
        fromSeq: trimmed.length > 0 ? trimmed[0].seq : 0,
      };
    };

    const [viewerSeqs, , ] = await Promise.all([
      flushTier(viewerOps, this.recentFile, 'viewer'),
      restrictedOps.length > 0 ? flushTier(restrictedOps, this.restrictedRecentFile, 'restricted') : Promise.resolve({ lastSeq: 0, fromSeq: 0 }),
      adminOps.length > 0 ? flushTier(adminOps, this.adminRecentFile, 'admin') : Promise.resolve({ lastSeq: 0, fromSeq: 0 }),
    ]);

    const { lastSeq, fromSeq } = viewerSeqs;
    const allLastSeq = Math.max(
      lastSeq,
      ...this.opsBuffer.map(e => e.seq),
    );

    // Preserve log fields from existing manifest (written by bake)
    let logSizeBytes = 0;
    let checkpoints: SyncManifest['checkpoints'] = [];
    try {
      const existing = await gdriveReadJson(this.googleAccessToken, dt, this.manifestFile);
      if (existing) {
        const m = existing as unknown as SyncManifest;
        logSizeBytes = m.log_size_bytes ?? 0;
        checkpoints = m.checkpoints ?? [];
      }
    } catch { /* non-critical */ }

    const manifest: SyncManifest = {
      head_seq: allLastSeq,
      buffer_from_seq: fromSeq,
      buffer_to_seq: allLastSeq,
      log_size_bytes: logSizeBytes,
      checkpoints,
      updated_at: new Date().toISOString(),
    };
    await gdriveStoreJson(
      this.googleAccessToken, dt, this.manifestFile,
      manifest as unknown as Record<string, unknown>,
    );

    // Notify peers after write confirms
    if (allLastSeq > 0) {
      this.onOpSaved?.(allLastSeq);
    }

    useGDriveStore.getState().recordSync(this.spaceId);
    this.onStatus?.('synced');
    console.log(`[EO-DB] GDrive buffer flushed: ${this.opsBuffer.length} events, head_seq=${allLastSeq}`);
  }

  /**
   * Push the entire local event log to GDrive as the log file.
   *
   * Used by forceSave() ("Take Snapshot") and auto-triggered on start()
   * when the local store has data but GDrive is empty.
   */
  async fullPushToGDrive(): Promise<void> {
    if (this.destroyed) return;
    const dt = this.dataType;

    // Read all events from the local OPFS store
    const storedEvents = await readLogSince(this.store, 0);

    // Merge with any unsaved in-memory ops
    const merged = new Map<string, EoEvent>();
    for (const e of storedEvents) merged.set(e.client_event_id ?? `seq:${e.seq}`, e);
    for (const e of this.opsBuffer) merged.set(e.client_event_id ?? `seq:${e.seq}`, e);

    if (merged.size === 0) {
      console.log('[EO-DB] fullPushToGDrive: no events to push');
      return;
    }

    const events = Array.from(merged.values()).sort((a, b) => a.seq - b.seq);
    const fromSeq = events[0].seq;
    const toSeq = events[events.length - 1].seq;

    console.log(`[EO-DB] fullPushToGDrive: pushing ${events.length} events (seq ${fromSeq}→${toSeq})`);
    this.onStatus?.('syncing');

    // Pack and encrypt the full log
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

    await gdriveStoreNamed(this.googleAccessToken, encrypted, dt, this.logFile);
    console.log(`[EO-DB] fullPushToGDrive: wrote ${this.logFile} (${events.length} events)`);

    // Write empty recent buffer
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
    await gdriveStoreNamed(this.googleAccessToken, emptyEncrypted, dt, this.recentFile);

    // Update manifest
    const manifest: SyncManifest = {
      head_seq: toSeq,
      buffer_from_seq: toSeq,
      buffer_to_seq: toSeq,
      log_size_bytes: encrypted.length,
      checkpoints: [{ from_seq: fromSeq, byte_offset: 0 }],
      updated_at: new Date().toISOString(),
    };
    await gdriveStoreJson(
      this.googleAccessToken, dt, this.manifestFile,
      manifest as unknown as Record<string, unknown>,
    );

    this.opsBuffer = [];
    useGDriveStore.getState().recordSync(this.spaceId);
    this.onStatus?.('synced');
    console.log(`[EO-DB] fullPushToGDrive: complete — ${events.length} events at seq ${toSeq}`);
  }

  /**
   * Download all accessible recent buffers (viewer always; restricted/admin if keys held).
   * Merges and deduplicates events from all tiers.
   */
  private async downloadRecentBuffer(): Promise<EoEvent[]> {
    const dt = this.dataType;
    const tiers: Array<{ file: string; tier: 'viewer' | 'restricted' | 'admin' }> = [
      { file: this.recentFile, tier: 'viewer' },
    ];
    if (this.resolveKeyIdForTier('restricted')) {
      tiers.push({ file: this.restrictedRecentFile, tier: 'restricted' });
    }
    if (this.resolveKeyIdForTier('admin')) {
      tiers.push({ file: this.adminRecentFile, tier: 'admin' });
    }

    const merged = new Map<string, EoEvent>();
    for (const { file } of tiers) {
      try {
        const result = await gdriveRetrieveNamed(this.googleAccessToken, dt, file);
        if (!result?.ok) continue;
        const data = await this.decryptBinary(result.data);
        for (const e of safeUnpackEvents(data)) {
          merged.set(e.client_event_id ?? `${e.seq}`, e);
        }
      } catch { /* tier may not exist */ }
    }
    return Array.from(merged.values()).sort((a, b) => a.seq - b.seq);
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
      await gdriveStoreJson(this.googleAccessToken, dt, intentFileName, {
        voter: this.userId,
        voted_at: votedAt,
        op_count: this.opsBuffer.length,
      });
      console.log('[EO-DB] GDrive bake hand raised');
      await sleep(BAKE_VOTE_GRACE_MS);

      const { entries } = await gdriveListByPrefix(this.googleAccessToken, dt, 'bake-intent-');
      const now = Date.now();
      const validIntents: Array<{ voter: string; voted_at: string; fileId: string }> = [];

      for (const entry of entries) {
        try {
          const result = await gdriveRetrieve(this.googleAccessToken, entry.content_hash);
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
          if (myEntry) await gdriveDeleteFile(this.googleAccessToken, myEntry.data_id);
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
   * Write cumulative log files atomically across all three tiers.
   *
   * Each tier (viewer, restricted, admin) gets its own log and recent buffer:
   *   space-log.eodb       + space-recent.eodb       — viewer-key encrypted
   *   restricted-log.eodb  + restricted-recent.eodb  — restricted-key encrypted
   *   admin-log.eodb       + admin-recent.eodb        — admin-key encrypted
   *
   * Steps per tier:
   *   1. Download existing tier log (prior cumulative history)
   *   2. Merge with tier-specific recent buffer + own opsBuffer
   *   3. Write temp file, verify, overwrite tier log
   *   4. Clear tier recent buffer
   *   5. Update sync manifest
   */
  private async bakeLog(dt: string, intentFileIds: string[]): Promise<void> {
    if (this.baking) return;
    this.baking = true;
    console.log('[EO-DB] GDrive bake: starting cumulative log write');

    try {
      // Download all accessible logs (one pass — dedup across tiers below)
      const downloadLog = async (file: string): Promise<EoEvent[]> => {
        try {
          const r = await gdriveRetrieveNamed(this.googleAccessToken, dt, file);
          if (!r?.ok) return [];
          return safeUnpackEvents(await this.decryptBinary(r.data));
        } catch { return []; }
      };

      const [priorViewer, priorRestricted, priorAdmin] = await Promise.all([
        downloadLog(this.logFile),
        this.resolveKeyIdForTier('restricted') ? downloadLog(this.restrictedLogFile) : Promise.resolve([]),
        this.resolveKeyIdForTier('admin') ? downloadLog(this.adminLogFile) : Promise.resolve([]),
      ]);

      // Also include remote recent buffers
      const bufferEvents = await this.downloadRecentBuffer();

      // Merge everything — dedup by client_event_id
      const allMerged = new Map<string, EoEvent>();
      for (const e of priorViewer) allMerged.set(e.client_event_id ?? `seq:${e.seq}`, e);
      for (const e of priorRestricted) allMerged.set(e.client_event_id ?? `seq:${e.seq}`, e);
      for (const e of priorAdmin) allMerged.set(e.client_event_id ?? `seq:${e.seq}`, e);
      for (const e of bufferEvents) allMerged.set(e.client_event_id ?? `seq:${e.seq}`, e);
      for (const e of this.opsBuffer) allMerged.set(e.client_event_id ?? `seq:${e.seq}`, e);

      if (allMerged.size === 0) {
        console.log('[EO-DB] GDrive bake: nothing to bake');
        return;
      }

      const allEvents = Array.from(allMerged.values()).sort((a, b) => a.seq - b.seq);
      const fromSeq = allEvents[0].seq;
      const toSeq = allEvents[allEvents.length - 1].seq;

      // Split by tier
      const viewerEvents: EoEvent[] = [];
      const restrictedEvents: EoEvent[] = [];
      const adminEvents: EoEvent[] = [];
      for (const e of allEvents) {
        const tier = this.classifyEventTier(e);
        if (tier === 'restricted') restrictedEvents.push(e);
        else if (tier === 'admin') adminEvents.push(e);
        else viewerEvents.push(e);
      }

      // Helper: pack + encrypt + write a tier log
      const writeTierLog = async (
        events: EoEvent[],
        logFile: string,
        recentFile: string,
        tier: 'viewer' | 'restricted' | 'admin',
        priorCount: number,
      ): Promise<number> => {
        if (events.length === 0) return 0;
        const tierFrom = events[0].seq;
        const tierTo = events[events.length - 1].seq;
        const file: EodbFile = {
          version: 1,
          type: 'hydration',
          space_id: this.spaceId,
          space_name: this.spaceName,
          from_seq: tierFrom,
          to_seq: tierTo,
          created_by: this.userId,
          created_at: new Date().toISOString(),
          events,
          prev_snapshots: [],
        };
        const encrypted = await this.encryptBinaryForTier(packEodb(file), tier);

        // Temp-write then overwrite (atomic-ish)
        const tempFile = `${this.logPendingPrefix}${tier}-${this.userId}.eodb`;
        const tempResult = await gdriveStoreNamed(this.googleAccessToken, encrypted, dt, tempFile);
        if (!tempResult.ok) {
          console.warn(`[EO-DB] GDrive bake: temp write failed for ${tier} tier, skipping`);
          return 0;
        }
        await gdriveStoreNamed(this.googleAccessToken, encrypted, dt, logFile);
        console.log(`[EO-DB] GDrive bake: wrote ${logFile} (${events.length} events, seq ${tierFrom}→${tierTo})`);

        // Clear recent buffer for this tier
        const emptyFile: EodbFile = {
          version: 1, type: 'op',
          space_id: this.spaceId, space_name: this.spaceName,
          from_seq: tierTo, to_seq: tierTo,
          created_by: this.userId, created_at: new Date().toISOString(),
          events: [], prev_snapshots: [],
        };
        const emptyEncrypted = await this.encryptBinaryForTier(packEodb(emptyFile), tier);
        await gdriveStoreNamed(this.googleAccessToken, emptyEncrypted, dt, recentFile);

        return encrypted.length;
      };

      const [viewerLogSize] = await Promise.all([
        writeTierLog(viewerEvents, this.logFile, this.recentFile, 'viewer', priorViewer.length),
        restrictedEvents.length > 0
          ? writeTierLog(restrictedEvents, this.restrictedLogFile, this.restrictedRecentFile, 'restricted', priorRestricted.length)
          : Promise.resolve(0),
        adminEvents.length > 0
          ? writeTierLog(adminEvents, this.adminLogFile, this.adminRecentFile, 'admin', priorAdmin.length)
          : Promise.resolve(0),
      ]);

      // Update sync manifest (checkpoints based on viewer log)
      const newEventsOffset = priorViewer.length > 0 && viewerEvents.length > 0
        ? Math.floor(viewerLogSize * (priorViewer.length / viewerEvents.length))
        : 0;

      const manifest: SyncManifest = {
        head_seq: toSeq,
        buffer_from_seq: toSeq,
        buffer_to_seq: toSeq,
        log_size_bytes: viewerLogSize,
        checkpoints: [
          { from_seq: fromSeq, byte_offset: 0 },
          ...(newEventsOffset > 0 && viewerEvents.length > priorViewer.length
            ? [{ from_seq: viewerEvents[priorViewer.length]?.seq ?? toSeq, byte_offset: newEventsOffset }]
            : []),
        ],
        updated_at: new Date().toISOString(),
      };
      await gdriveStoreJson(
        this.googleAccessToken, dt, this.manifestFile,
        manifest as unknown as Record<string, unknown>,
      );

      // Delete temp files and intent files
      try {
        const { entries: tempEntries } = await gdriveListByPrefix(
          this.googleAccessToken, dt, this.logPendingPrefix,
        );
        for (const e of tempEntries) {
          await gdriveDeleteFile(this.googleAccessToken, e.data_id).catch(() => {});
        }
      } catch { /* non-critical */ }

      for (const fileId of intentFileIds) {
        await gdriveDeleteFile(this.googleAccessToken, fileId).catch(() => {});
      }

      this.opsBuffer = [];
      await this.store.put('meta:gdrive_saved_op_count', 0);
      useGDriveStore.getState().recordSync(this.spaceId);
      this.onStatus?.('synced');
      console.log(`[EO-DB] GDrive bake complete: ${allEvents.length} total events (viewer:${viewerEvents.length} restricted:${restrictedEvents.length} admin:${adminEvents.length})`);
    } finally {
      this.baking = false;
    }
  }

  /** Remove orphaned temp files from crashed bakes (older than BAKE_LOCK_TTL_MS). */
  private async cleanOrphanedTempFiles(): Promise<void> {
    try {
      const { entries } = await gdriveListByPrefix(
        this.googleAccessToken, this.dataType, this.logPendingPrefix,
      );
      const cutoff = Date.now() - BAKE_LOCK_TTL_MS;
      for (const e of entries) {
        if (e.stored_at && new Date(e.stored_at).getTime() < cutoff) {
          await gdriveDeleteFile(this.googleAccessToken, e.data_id).catch(() => {});
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
      const raw = await gdriveReadJson(this.googleAccessToken, dt, this.manifestFile);
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
            this.googleAccessToken, dt, this.logFile, checkpoint.byte_offset,
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
      const logResult = await gdriveRetrieveNamed(this.googleAccessToken, dt, this.logFile);
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
   * New-format priority (3-tier):
   *   1. space-log.eodb + restricted-log.eodb + admin-log.eodb  — cumulative history
   *      (restricted and admin tiers only downloaded if the keyring has the required key)
   *   2. space-recent.eodb + restricted-recent.eodb + admin-recent.eodb — recent buffer
   *
   * Backward-compat fallback (old hydration-*.eodb + op-*.eodb):
   *   - Collect ALL events from ALL hydration slots (dedup by client_event_id,
   *     sorted by seq) — fixes the old bug where only the best slot was applied
   *   - Then apply any op-*.eodb files newer than hydration point
   */
  static async hydrateFromGDrive(
    store: EoStore,
    googleAccessToken: string,
    dataType: string,
    onEvent?: (event: any) => void,
    keyring?: LocalKeyring,
    fileNames?: {
      log?: string;
      recent?: string;
      restrictedLog?: string;
      restrictedRecent?: string;
      adminLog?: string;
      adminRecent?: string;
    },
  ): Promise<number> {
    const logFile = fileNames?.log ?? LEGACY_LOG_FILE;
    const recentFile = fileNames?.recent ?? LEGACY_RECENT_FILE;
    const restrictedLogFile = fileNames?.restrictedLog;
    const restrictedRecentFile = fileNames?.restrictedRecent;
    const adminLogFile = fileNames?.adminLog;
    const adminRecentFile = fileNames?.adminRecent;

    console.log('[EO-DB] hydrateFromGDrive: starting, dataType =', dataType);
    const localSeq = await store.getCurrentSeq();
    let lastAppliedSeq = localSeq;

    const decrypt = async (raw: Uint8Array): Promise<Uint8Array> =>
      keyring ? decryptSnapshot(raw, keyring).catch(() => raw) : raw;

    /** Check if keyring has a key for the given tier scope suffix. */
    const hasTierKey = (tier: 'restricted' | 'admin'): boolean => {
      if (!keyring) return false;
      for (const entry of keyring.keys.values()) {
        if (entry.scope.endsWith(`.${tier}`)) return true;
      }
      return false;
    };

    // ── 1. Try new format: all 3 log tiers ──
    let usedNewFormat = false;
    const allLogEvents = new Map<string, EoEvent>();

    const tryDownloadLog = async (file: string): Promise<void> => {
      try {
        const result = await gdriveRetrieveNamed(googleAccessToken, dataType, file);
        if (!result?.ok) return;
        const data = await decrypt(result.data);
        for (const e of safeUnpackEvents(data)) {
          allLogEvents.set(e.client_event_id ?? `seq:${e.seq}`, e);
        }
      } catch { /* log may not exist */ }
    };

    await tryDownloadLog(logFile);
    if (hasTierKey('restricted') && restrictedLogFile) await tryDownloadLog(restrictedLogFile);
    if (hasTierKey('admin') && adminLogFile) await tryDownloadLog(adminLogFile);

    if (allLogEvents.size > 0) {
      const sorted = Array.from(allLogEvents.values()).sort((a, b) => a.seq - b.seq);
      console.log(`[EO-DB] hydrateFromGDrive: applying log tiers (${sorted.length} events)`);
      for (const event of sorted) {
        if (event.seq <= localSeq) continue;
        const seq = await processEvent(store, event, onEvent);
        lastAppliedSeq = Math.max(lastAppliedSeq, seq);
      }
      usedNewFormat = true;
    }

    // ── 2. Apply recent buffers (events since last bake) ──
    const allRecentEvents = new Map<string, EoEvent>();
    const tryDownloadRecent = async (file: string): Promise<void> => {
      try {
        const result = await gdriveRetrieveNamed(googleAccessToken, dataType, file);
        if (!result?.ok) return;
        const data = await decrypt(result.data);
        for (const e of safeUnpackEvents(data)) {
          allRecentEvents.set(e.client_event_id ?? `seq:${e.seq}`, e);
        }
      } catch { /* non-critical */ }
    };

    await tryDownloadRecent(recentFile);
    if (hasTierKey('restricted') && restrictedRecentFile) await tryDownloadRecent(restrictedRecentFile);
    if (hasTierKey('admin') && adminRecentFile) await tryDownloadRecent(adminRecentFile);

    const recentSorted = Array.from(allRecentEvents.values()).sort((a, b) => a.seq - b.seq);
    for (const event of recentSorted) {
      if (event.seq <= lastAppliedSeq) continue;
      const seq = await processEvent(store, event, onEvent);
      lastAppliedSeq = Math.max(lastAppliedSeq, seq);
    }

    if (usedNewFormat) {
      console.log(`[EO-DB] hydrateFromGDrive: complete (new format). Seq ${lastAppliedSeq}`);
      return lastAppliedSeq;
    }

    // ── 3. Backward compat: hydration-*.eodb ──
    // Collect ALL events from ALL slots (fixes bug where only best slot was applied)
    console.log('[EO-DB] hydrateFromGDrive: falling back to hydration-*.eodb');
    const { entries: hydrationEntries } = await gdriveListByPrefix(
      googleAccessToken, dataType, 'hydration-',
    ).catch(() => ({ entries: [] as GDriveListEntry[] }));

    const legacyEvents = new Map<string, EoEvent>();

    for (const entry of hydrationEntries) {
      try {
        console.log(`[EO-DB] hydrateFromGDrive: downloading ${entry.name}…`);
        const result = await gdriveRetrieve(googleAccessToken, entry.content_hash);
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
      googleAccessToken, dataType, 'op-',
    ).catch(() => ({ entries: [] as GDriveListEntry[] }));

    const newOps = opEntries
      .filter(e => !e.name.startsWith('space-') && !/^[0-9a-f-]{36}\.eodb$/.test(e.name)) // skip current-format files
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of newOps) {
      try {
        const result = await gdriveRetrieve(googleAccessToken, entry.content_hash);
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
