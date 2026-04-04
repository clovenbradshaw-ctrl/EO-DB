/**
 * Sync manager — orchestrates snapshot persistence, offline queue, and deduplication.
 *
 * Data is persisted as delta snapshots in Matrix media — each snapshot
 * contains only the events since the last one, plus up to 25 previous
 * snapshot URIs for fast chain traversal. Below 500 log entries the
 * hydration state lives in room data only.
 *
 * Offline queue is append-only via atomic read-modify-write through the
 * queue mutex. Events that fail to send are retried individually on reconnect;
 * idempotency hashing on the receiver side handles duplicates naturally.
 *
 * Write path: every write folds into local state before touching the network.
 * The UI sees the change immediately; Matrix is the replication layer, not
 * the write-ahead log.
 */

import type { EoDb } from '../db/level.js';
import { getCurrentSeq, encode, decode } from '../db/level.js';
import type { EoEventInput } from '../db/types.js';
import type { LocalKeyring } from '../db/crypto-types.js';
import { processEvent } from '../db/fold.js';
import { eventHash } from '../db/hash.js';
import type { Feed } from '../db/feed.js';
import type { IMatrixClient, IMatrixEvent, RoomDataSnapshot, ImportMeta } from './types.js';
import { EO_EVENT_TYPE, EO_IMPORT_TYPE, matrixEventToEo, getDataRoom } from './event-bridge.js';
import { readLogSince } from '../db/log.js';
import {
  findLatestSnapshot,
  maybeCreateSnapshot,
  createDeltaSnapshot,
  uploadDeltaSnapshot,
  setSnapshotStateEvent,
  restoreFromDeltaChain,
  createImportSnapshot,
  uploadImportSnapshot,
  IMPORT_CHUNK_SIZE,
} from './snapshot.js';
import { SendBuffer } from './send-buffer.js';

// ─── Async Mutex (inline to avoid circular deps) ──────────────────────────

class QueueMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

/** Mutex protecting the offline queue from concurrent read-modify-write. */
const queueMutex = new QueueMutex();

/**
 * Kill-switch for all Matrix uploads (snapshots, event sends, queue flushes).
 * Login and local fold still work — only outbound writes to Matrix are disabled.
 * Set to false when the new storage backend is ready.
 */
const MATRIX_UPLOAD_DISABLED = false;

// ─── Meta key helpers ──────────────────────────────────────────────────────

async function getMeta<T>(db: EoDb, key: string): Promise<T | null> {
  try {
    return decode(await db.get(key)) as T;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

async function setMeta(db: EoDb, key: string, value: any): Promise<void> {
  await db.put(key, encode(value));
}

// ─── SyncManager ───────────────────────────────────────────────────────────

export class SyncManager {
  private client: IMatrixClient;
  private roomId: string;
  private db: EoDb;
  private feed?: Feed;
  private keyring: LocalKeyring;

  /** Additional room IDs to listen to (restricted, governance). */
  private additionalRoomIds: string[] = [];

  /** Bound listener reference for cleanup. */
  private handleTimelineEvent: ((event: IMatrixEvent) => void) | null = null;

  /** Whether this manager has been destroyed. */
  private destroyed = false;

  /** Timestamp (ms) until which sends should be skipped due to rate limiting. */
  private rateLimitedUntil: number = 0;

  /** Optional callback for sync status changes (confirmed, queued, rate-limited). */
  onSyncStatus?: (status: 'confirmed' | 'queued' | 'rate-limited') => void;

  /** Coalescing buffer — batches outbound events into periodic snapshot uploads. */
  private sendBuffer: SendBuffer;

  constructor(
    client: IMatrixClient,
    roomId: string,
    db: EoDb,
    feed?: Feed,
    keyring?: LocalKeyring,
  ) {
    this.client = client;
    this.roomId = roomId;
    this.db = db;
    this.feed = feed;
    this.keyring = keyring || { keys: new Map() };

    // Wire up the send buffer with delegate callbacks
    this.sendBuffer = new SendBuffer({
      uploadBufferedEvents: () => this.flushSendBuffer(),
      isUploadDisabled: () => MATRIX_UPLOAD_DISABLED,
      getRateLimitedUntil: () => this.rateLimitedUntil,
    });
  }

  /** Allow updating keyring after construction (e.g., after key heal). */
  setKeyring(keyring: LocalKeyring): void {
    this.keyring = keyring;
  }

  /**
   * Add additional rooms to listen to (restricted, governance).
   * Events from these rooms are merged into the same fold.
   */
  addRooms(roomIds: string[]): void {
    for (const id of roomIds) {
      if (id && !this.additionalRoomIds.includes(id) && id !== this.roomId) {
        this.additionalRoomIds.push(id);
      }
    }
  }

  /**
   * Remove a room from the multi-room topology.
   */
  removeRoom(roomId: string): void {
    this.additionalRoomIds = this.additionalRoomIds.filter(id => id !== roomId);
  }

  /** Get all room IDs this sync manager is listening to. */
  getRoomIds(): string[] {
    return [this.roomId, ...this.additionalRoomIds];
  }

  /**
   * Remove the timeline listener and mark this manager as inactive.
   * Must be called before switching spaces to prevent stale event injection.
   */
  destroy(): void {
    this.destroyed = true;
    // Flush any buffered events before tearing down
    this.sendBuffer.flush().catch(() => {});
    this.sendBuffer.destroy();
    if (this.handleTimelineEvent) {
      this.client.off('Room.timeline', this.handleTimelineEvent);
      this.handleTimelineEvent = null;
    }
  }

  /**
   * Initialize sync — call after login and store setup.
   *
   * Sequence:
   * 1. Check current seq
   * 2. If fresh (seq === 0), hydrate from latest snapshot in Matrix media
   * 3. Replay EO events already in room timeline (covers gaps)
   * 4. Attach live listener for new events
   * 5. Flush any queued offline events
   */
  async initialize(): Promise<void> {
    const currentSeq = await getCurrentSeq(this.db);

    // On a fresh device, restore from the latest Matrix media snapshot
    if (currentSeq === 0) {
      await this.hydrateFromSnapshot();
    }

    // Replay EO events already in the room timeline (from initial sync).
    // The fold engine deduplicates via client_event_id so replaying events
    // already covered by the snapshot is harmless.
    await this.replayTimelineEvents();

    // Listen for new room events in real-time (main + additional rooms)
    this.handleTimelineEvent = (event: IMatrixEvent) => {
      if (this.destroyed) return;
      const eventRoomId = event.getRoomId();
      if (eventRoomId !== this.roomId && !this.additionalRoomIds.includes(eventRoomId!)) return;
      const eventType = event.getType();
      if (eventType === EO_IMPORT_TYPE) {
        // Batch import event — unpack and fold each sub-event
        this.processIncomingBatchEvent(event);
        return;
      }
      if (eventType !== EO_EVENT_TYPE) return;
      this.processIncomingEvent(event);
    };
    this.client.on('Room.timeline', this.handleTimelineEvent);

    // Flush any unsynced local events
    await this.flushUnsyncedEvents();
  }

  /**
   * Hydrate the local store from the latest snapshot in room state.
   */
  private async hydrateFromSnapshot(): Promise<void> {
    const snap = await findLatestSnapshot(this.client, this.roomId);
    if (!snap) return;
    const restoredSeq = await restoreFromDeltaChain(
      this.client, this.db, snap.mxc, this.feed, this.keyring,
    );
    await setMeta(this.db, 'meta:snapshot_seq', restoredSeq);
  }

  /**
   * Replay EO events already present in the room timeline.
   *
   * After the initial Matrix sync, the room object contains timeline events
   * from the sync response. Walk them here so a fresh device without a
   * snapshot can still recover data from the room timeline.
   *
   * When the local DB is empty (seq === 0, e.g. after IDB wipe), the live
   * timeline may also be empty due to initialSyncLimit: 0. In that case,
   * paginate backwards to fetch historical events from the server.
   */
  private async replayTimelineEvents(): Promise<void> {
    const room = this.client.getRoom(this.roomId);
    if (!room) return;

    const timeline = room.getLiveTimeline();

    // If the local DB is still empty after snapshot hydration, paginate
    // backwards to fetch events that initialSyncLimit: 0 excluded.
    const currentSeq = await getCurrentSeq(this.db);
    if (currentSeq === 0) {
      const MAX_PAGES = 20; // safety bound — at 100 events/page = 2000 events max
      for (let page = 0; page < MAX_PAGES; page++) {
        if (this.destroyed) return;
        try {
          const hasMore = await this.client.paginateEventTimeline(timeline, {
            backwards: true,
            limit: 100,
          });
          if (!hasMore) break;
        } catch {
          break;
        }
      }
    }

    const events = timeline.getEvents();
    let replayed = 0;
    for (const event of events) {
      if (this.destroyed) return;
      const evType = event.getType();
      if (evType === EO_IMPORT_TYPE) {
        await this.processIncomingBatchEvent(event);
        replayed++;
      } else if (evType === EO_EVENT_TYPE) {
        await this.processIncomingEvent(event);
        replayed++;
      }
    }

    if (replayed > 0) {
      console.info('[EO-DB] Replayed', replayed, 'events from room timeline');
    }
  }

  /**
   * Flush the send buffer — upload all un-snapshotted events as a single
   * binary snapshot to Matrix media.
   *
   * This is the delegate callback invoked by SendBuffer on timer/size flush.
   * Returns true on success, false if the upload failed (triggers retry).
   */
  private async flushSendBuffer(): Promise<boolean> {
    try {
      const currentSeq = await getCurrentSeq(this.db);
      const lastSnapshotSeq = (await getMeta<number>(this.db, 'meta:snapshot_seq')) || 0;

      if (currentSeq <= lastSnapshotSeq) {
        // Nothing new to upload — another path already snapshotted
        return true;
      }

      await this.processImportBatch(lastSnapshotSeq, currentSeq, {
        source: 'send-buffer',
        record_count: currentSeq - lastSnapshotSeq,
      });

      this.onSyncStatus?.('confirmed');
      return true;
    } catch (err) {
      const retryDelay = SyncManager.getRetryDelay(err);
      if (retryDelay !== null) {
        this.rateLimitedUntil = Date.now() + retryDelay;
        this.onSyncStatus?.('rate-limited');
      } else {
        this.onSyncStatus?.('queued');
      }
      return false;
    }
  }

  /** Expose send buffer status for diagnostics. */
  getSendBufferStatus(): { buffered: number; flushing: boolean } {
    return this.sendBuffer.getStatus();
  }

  /** Force-flush the send buffer immediately (e.g., on page unload). */
  async flushSendBufferNow(): Promise<void> {
    await this.sendBuffer.flush();
  }

  /**
   * Force-save a delta snapshot to Matrix media right now.
   * Called on page unload / visibility hidden so data is always persisted.
   */
  async saveSnapshot(): Promise<void> {
    if (MATRIX_UPLOAD_DISABLED) return;

    // Flush the send buffer first so all buffered events get included
    await this.sendBuffer.flush();

    const seq = await getCurrentSeq(this.db);
    const lastSnapshotSeq = (await getMeta<number>(this.db, 'meta:snapshot_seq')) || 0;
    if (seq === 0 || seq === lastSnapshotSeq) return;

    const delta = await createDeltaSnapshot(this.db, this.client.getUserId()!);
    const mxc = await uploadDeltaSnapshot(this.client, this.roomId, delta, this.keyring);
    await setMeta(this.db, 'meta:snapshot_seq', seq);
    await setMeta(this.db, 'meta:snapshot_mxc', mxc);
    const prevMxcs: string[] = (await getMeta<string[]>(this.db, 'meta:snapshot_prev_mxcs')) || [];
    await setMeta(this.db, 'meta:snapshot_prev_mxcs', [mxc, ...prevMxcs].slice(0, 25));
  }

  /**
   * Manual delta snapshot — captures log events since the last snapshot,
   * uploads to Matrix media, and records the mxc URI in a NUL log event.
   */
  async manualSnapshot(): Promise<{ mxc: string; seq: number }> {
    if (MATRIX_UPLOAD_DISABLED) {
      throw new Error('Matrix uploads are currently disabled');
    }

    const currentSeq = await getCurrentSeq(this.db);
    const lastSnapshotSeq = (await getMeta<number>(this.db, 'meta:snapshot_seq')) || 0;

    if (currentSeq === lastSnapshotSeq) {
      throw new Error('No new events since last snapshot');
    }

    const delta = await createDeltaSnapshot(this.db, this.client.getUserId()!);
    const mxc = await uploadDeltaSnapshot(this.client, this.roomId, delta, this.keyring);

    // Record the mxc URI in a NUL event so the snapshot is discoverable from the log
    await this.processLocalEvent({
      op: 'NUL',
      target: 'system.snapshot',
      operand: {
        mxc,
        type: 'delta',
        from_seq: delta.from_seq,
        to_seq: delta.to_seq,
        prev_mxcs: delta.prev_mxcs,
        event_count: delta.events.length,
      },
    });

    await setMeta(this.db, 'meta:snapshot_seq', currentSeq);
    await setMeta(this.db, 'meta:snapshot_mxc', mxc);
    const prevMxcs: string[] = (await getMeta<string[]>(this.db, 'meta:snapshot_prev_mxcs')) || [];
    await setMeta(this.db, 'meta:snapshot_prev_mxcs', [mxc, ...prevMxcs].slice(0, 25));

    await setSnapshotStateEvent(this.client, this.roomId, mxc, currentSeq);

    return { mxc, seq: currentSeq };
  }

  /**
   * Process a grounded import batch.
   *
   * Called by GroundedSink after all events have been folded locally.
   * Reads the new events from the log (between fromSeq and toSeq),
   * packages them into an import snapshot, and uploads to Matrix media.
   *
   * The room receives exactly ONE timeline event referencing the binary.
   * No individual sendEoEvent() calls — that's the entire point.
   *
   * For very large imports (>IMPORT_CHUNK_SIZE), splits into multiple
   * snapshot chunks to bound memory pressure.
   */
  async processImportBatch(
    fromSeq: number,
    toSeq: number,
    importMeta?: ImportMeta,
  ): Promise<{ mxc: string; from_seq: number; to_seq: number; event_count: number }> {
    if (MATRIX_UPLOAD_DISABLED) {
      return { mxc: '', from_seq: fromSeq, to_seq: toSeq, event_count: 0 };
    }

    const userId = this.client.getUserId()!;

    // Read all new events from the log
    const allEvents = await readLogSince(this.db, fromSeq);

    if (allEvents.length === 0) {
      throw new Error('No events to ground — import produced no new log entries');
    }

    // Get current prev_mxcs chain for snapshot linkage
    let prevMxcs: string[] = (await getMeta<string[]>(this.db, 'meta:snapshot_prev_mxcs')) || [];
    let lastMxc = '';

    // Chunk if necessary to bound memory on very large imports
    for (let offset = 0; offset < allEvents.length; offset += IMPORT_CHUNK_SIZE) {
      const chunk = allEvents.slice(offset, offset + IMPORT_CHUNK_SIZE);
      const chunkFromSeq = offset === 0 ? fromSeq : chunk[0].seq - 1;
      const chunkToSeq = chunk[chunk.length - 1].seq;

      const snapshot = createImportSnapshot(
        chunk,
        chunkFromSeq,
        chunkToSeq,
        userId,
        importMeta,
      );

      // Link to previous snapshots in the chain
      snapshot.prev_mxcs = prevMxcs.slice(0, 25);

      lastMxc = await uploadImportSnapshot(this.client, this.roomId, snapshot, this.keyring);

      // Update chain for next chunk (or for future snapshots)
      prevMxcs = [lastMxc, ...prevMxcs].slice(0, 25);
    }

    // Update local snapshot metadata
    await setMeta(this.db, 'meta:snapshot_seq', toSeq);
    await setMeta(this.db, 'meta:snapshot_mxc', lastMxc);
    await setMeta(this.db, 'meta:snapshot_prev_mxcs', prevMxcs);

    return {
      mxc: lastMxc,
      from_seq: fromSeq,
      to_seq: toSeq,
      event_count: allEvents.length,
    };
  }

  /**
   * Return a snapshot of the raw Matrix room data for debugging/inspection.
   */
  getRoomData(): RoomDataSnapshot | null {
    const room = this.client.getRoom(this.roomId);
    if (!room) return null;

    const stateEvents: RoomDataSnapshot['stateEvents'] = [];
    const currentState = room.currentState;
    for (const evMap of Object.values(currentState.events as any)) {
      const entries = evMap instanceof Map ? evMap.values() : Object.values(evMap as any);
      for (const ev of entries) {
        const matrixEv = ev as IMatrixEvent;
        stateEvents.push({
          type: matrixEv.getType(),
          stateKey: matrixEv.getStateKey?.() ?? '',
          sender: matrixEv.getSender() ?? '',
          content: matrixEv.getContent(),
        });
      }
    }

    const members = room.getJoinedMembers().map((m) => ({
      userId: m.userId,
      displayName: m.name || null,
      membership: m.membership || 'join',
    }));

    const timeline = room.getLiveTimeline().getEvents().slice(-100).map((ev) => ({
      eventId: ev.getId() ?? '',
      type: ev.getType(),
      sender: ev.getSender() ?? '',
      ts: ev.getTs(),
      content: ev.getContent(),
    }));

    const encryptionEvent = currentState.getStateEvents('m.room.encryption', '');
    const joinRuleEvent = currentState.getStateEvents('m.room.join_rules', '');
    const historyEvent = currentState.getStateEvents('m.room.history_visibility', '');
    const createEvent = currentState.getStateEvents('m.room.create', '');

    return {
      roomId: this.roomId,
      roomAlias: getDataRoom(),
      name: room.name || null,
      topic: currentState.getStateEvents('m.room.topic', '')?.getContent()?.topic ?? null,
      memberCount: members.length,
      members,
      encryptionEnabled: !!encryptionEvent,
      encryptionAlgorithm: encryptionEvent?.getContent()?.algorithm ?? null,
      timelineLength: room.getLiveTimeline().getEvents().length,
      timeline,
      stateEvents,
      roomVersion: createEvent?.getContent()?.room_version ?? null,
      joinRule: joinRuleEvent?.getContent()?.join_rule ?? null,
      historyVisibility: historyEvent?.getContent()?.history_visibility ?? null,
    };
  }

  /**
   * Process a locally created event.
   *
   * 1. Generate content-addressable client_event_id via hash
   * 2. Fold immediately (instant UI update — no round-trip)
   * 3. Send to Matrix room async (may fail if offline)
   * 4. If send fails, queue for later — mutex-protected
   * 5. Auto-snapshot every 500 log entries
   */
  async processLocalEvent(
    event: Omit<EoEventInput, 'client_event_id' | 'agent' | 'ts' | 'acquired_ts'>,
  ): Promise<number> {
    const ts = new Date().toISOString();
    const agent = this.client.getUserId()!;

    // Derive deterministic ID from content — same event from two offline
    // devices will produce the same hash and dedup on fold.
    const clientEventId = eventHash({
      op: event.op,
      target: event.target,
      operand: event.operand,
      agent,
      ts,
      acquired_ts: ts,
    } as EoEventInput);

    const localEvent: EoEventInput = {
      ...event,
      client_event_id: clientEventId,
      agent,
      ts,
      acquired_ts: ts,
    };

    // Fold immediately — UI sees the change instantly
    const seq = await processEvent(this.db, localEvent, this.feed);

    // Buffer for batched upload instead of sending individually.
    // The send buffer coalesces events and flushes as a single snapshot
    // upload every 10s (or at 500 events), avoiding 429 rate limits.
    this.sendBuffer.enqueue(localEvent);

    return seq;
  }

  /**
   * Import a batch of events — fold locally, send to Matrix as a single message.
   *
   * This avoids the 429 rate-limit storm that occurs when sending 50+ events
   * individually. Events are folded one-by-one locally (for progress tracking)
   * but sent to Matrix as a single batch event.
   *
   * @param events Array of event inputs (without client_event_id/agent/ts)
   * @param onProgress Called after each event is folded locally
   * @returns The final seq number
   */
  async processBatchImport(
    events: Array<Omit<EoEventInput, 'client_event_id' | 'agent' | 'ts' | 'acquired_ts'>>,
    onProgress?: (current: number, total: number) => void,
  ): Promise<number> {
    const agent = this.client.getUserId()!;
    const preparedEvents: EoEventInput[] = [];
    let lastSeq = 0;

    // Fold each event locally for instant UI updates
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const ts = event.ts as string || new Date().toISOString();
      const clientEventId = eventHash({
        op: event.op,
        target: event.target,
        operand: event.operand,
        agent,
        ts,
        acquired_ts: ts,
      } as EoEventInput);

      const localEvent: EoEventInput = {
        ...event,
        client_event_id: clientEventId,
        agent,
        ts,
        acquired_ts: ts,
      };

      lastSeq = await processEvent(this.db, localEvent, this.feed);
      preparedEvents.push(localEvent);
      onProgress?.(i + 1, events.length);
    }

    // Buffer all events for batched upload. The send buffer will flush
    // them as a single snapshot upload within 10s (or immediately if
    // the buffer hits 500 events). No individual sends, no 429 storms.
    for (const event of preparedEvents) {
      this.sendBuffer.enqueue(event);
    }

    return lastSeq;
  }

  /**
   * Process an incoming room event — dedup by client_event_id, then fold.
   */
  private async processIncomingEvent(matrixEvent: IMatrixEvent): Promise<void> {
    const eoEvent = matrixEventToEo(matrixEvent);

    // Skip space-level config events — space discovery uses Matrix state events
    if (eoEvent.target.startsWith('space')) return;

    // Fast path: check idempotency before entering the fold mutex
    if (eoEvent.client_event_id) {
      const existing = await getMeta(this.db, `idem:${eoEvent.client_event_id}`);
      if (existing != null) return;
    }

    await processEvent(this.db, eoEvent, this.feed);
  }

  /**
   * Process an incoming batch import event — unpack the events array and fold each one.
   */
  private async processIncomingBatchEvent(matrixEvent: IMatrixEvent): Promise<void> {
    const content = matrixEvent.getContent();
    const sender = matrixEvent.getSender()!;
    const batchTs = new Date(matrixEvent.getTs()).toISOString();

    if (!Array.isArray(content.events)) return;

    for (const sub of content.events) {
      if (this.destroyed) return;
      const eoEvent: EoEventInput = {
        op: sub.op,
        target: sub.target,
        operand: sub.operand,
        agent: sender,
        ts: sub.ts || batchTs,
        acquired_ts: batchTs,
        client_event_id: sub.client_event_id,
        meta: sub.meta,
      };

      if (eoEvent.target.startsWith('space')) continue;

      if (eoEvent.client_event_id) {
        const existing = await getMeta(this.db, `idem:${eoEvent.client_event_id}`);
        if (existing != null) continue;
      }

      await processEvent(this.db, eoEvent, this.feed);
    }
  }

  /**
   * Append an event to the offline queue atomically.
   * The mutex ensures two concurrent send-failures don't race on the queue.
   */
  private async enqueueOfflineEvent(event: EoEventInput): Promise<void> {
    await queueMutex.run(async () => {
      const queue: Array<{ event: EoEventInput; attempts: number }> =
        (await getMeta<Array<{ event: EoEventInput; attempts: number }>>(this.db, 'meta:offline_queue')) || [];
      queue.push({ event, attempts: 0 });
      await setMeta(this.db, 'meta:offline_queue', queue);
    });
  }

  /** Max retry attempts before dropping a permanently-failing queued event. */
  private static readonly MAX_QUEUE_ATTEMPTS = 5;

  /**
   * Extract retry delay from a Matrix 429 response, or null if not rate-limited.
   *
   * The matrix-js-sdk MatrixError shape varies across bundled versions —
   * check multiple paths to be resilient against minification/wrapping.
   */
  private static getRetryDelay(error: unknown): number | null {
    if (!error) return null;
    const e = error as any;

    // Check all possible indicators of a 429 rate-limit
    const isRateLimit =
      e.httpStatus === 429 ||
      e.statusCode === 429 ||
      e.errcode === 'M_LIMIT_EXCEEDED' ||
      e.data?.errcode === 'M_LIMIT_EXCEEDED' ||
      (e.message && /429|too many|rate.?limit|M_LIMIT_EXCEEDED/i.test(String(e.message))) ||
      (e.name && /MatrixError/i.test(String(e.name)) && /429|limit/i.test(String(e.message)));

    if (!isRateLimit) return null;

    // Prefer server-provided retry_after_ms
    const retryAfter = e.data?.retry_after_ms ?? e.retry_after_ms;
    return typeof retryAfter === 'number' && retryAfter > 0
      ? retryAfter + 100
      : 2000;
  }

  /**
   * Flush queued offline events to the room.
   *
   * Instead of sending each event individually (which causes 429s), this
   * batches ALL un-snapshotted events into a single media store upload via
   * processImportBatch(). The room receives ONE timeline event instead of N.
   *
   * All queued events were already folded locally when created — they're in
   * the log. processImportBatch reads them from the log, packages into a
   * binary snapshot, uploads to Matrix media, and maintains the prev_mxcs
   * breadcrumb chain.
   *
   * The receiver deduplicates via content hash, so re-sending events
   * already received (e.g., via peer sync or auto-snapshot) is harmless.
   */
  private async flushUnsyncedEvents(): Promise<void> {
    if (MATRIX_UPLOAD_DISABLED) return;

    await queueMutex.run(async () => {
      const raw: any[] = (await getMeta<any[]>(this.db, 'meta:offline_queue')) || [];
      if (raw.length === 0) return;

      // Normalise legacy entries (plain EoEventInput) into { event, attempts }
      const queue = raw.map((entry: any) =>
        entry.event ? entry as { event: EoEventInput; attempts: number }
                     : { event: entry as EoEventInput, attempts: 0 },
      );

      // Track attempt count for the batch (use max across entries)
      const batchAttempts = Math.max(...queue.map(e => e.attempts));

      try {
        const currentSeq = await getCurrentSeq(this.db);
        const lastSnapshotSeq = (await getMeta<number>(this.db, 'meta:snapshot_seq')) || 0;

        if (currentSeq > lastSnapshotSeq) {
          // Batch all un-snapshotted events into a single media store upload.
          // This covers the queued events plus any other local events that
          // haven't been snapshotted yet — one upload instead of N sends.
          await this.processImportBatch(lastSnapshotSeq, currentSeq, {
            source: 'offline-queue',
            record_count: queue.length,
          });
        }
        // else: auto-snapshot already covered these events — nothing to upload

        // All events are now in the snapshot chain — clear the queue
        await setMeta(this.db, 'meta:offline_queue', []);
        this.onSyncStatus?.('confirmed');
      } catch (err) {
        const retryDelay = SyncManager.getRetryDelay(err);
        if (retryDelay !== null) {
          // Rate-limited — keep queue intact, retry after backoff
          this.rateLimitedUntil = Date.now() + retryDelay;
          if (!this.destroyed) {
            setTimeout(() => { if (!this.destroyed) this.flushUnsyncedEvents(); }, retryDelay);
          }
          this.onSyncStatus?.('rate-limited');
        } else {
          // Non-rate-limit error — increment attempts on all entries
          const nextAttempts = batchAttempts + 1;
          if (nextAttempts >= SyncManager.MAX_QUEUE_ATTEMPTS) {
            console.warn(
              '[EO-DB] Dropping', queue.length, 'queued events after', nextAttempts, 'failed batch attempts',
            );
            await setMeta(this.db, 'meta:offline_queue', []);
          } else {
            const bumped = queue.map(e => ({ ...e, attempts: nextAttempts }));
            await setMeta(this.db, 'meta:offline_queue', bumped);
          }
          this.onSyncStatus?.('queued');
        }
      }
    });
  }
}
