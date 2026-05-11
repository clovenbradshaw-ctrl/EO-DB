/**
 * Sync manager — orchestrates block-chain hydration, offline queue, and
 * deduplication.
 *
 * SyncManager handles Matrix timeline event transport (com.eo-db.event)
 * and block-chain hydration. All persistence is Matrix-native: the live
 * timeline is the tail, sealed history lives as encrypted `.eodb` blocks
 * on `mxc://`, and a single `m.eo.head` room state event names the
 * latest block.
 *
 * Offline queue is append-only via atomic read-modify-write through the
 * queue mutex. Events that fail to send are retried individually on
 * reconnect; idempotency hashing on the receiver side handles duplicates
 * naturally.
 */

import { openDB } from 'idb';
import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput } from '../db/types';
import type { LocalKeyring } from '../db/crypto-types';
import { processEvent } from '../db/fold';
import { eventHash } from '../db/hash';
import { AsyncMutex } from '../db/mutex';
import { EO_EVENT_TYPE, getDataRoom, matrixEventToEo, sendEoEvent } from './event-bridge';
import { hydrateFromBlocks } from '../sync/block-hydration';
import { isTransientError } from './connection-resilience';

/** Mutex protecting the offline queue from concurrent read-modify-write. */
const queueMutex = new AsyncMutex();

// ─── IndexedDB offline queue persistence ─────────────────────────────────────
// The in-memory EoStore does not persist arbitrary key-value pairs across page
// reloads (only log events go to OPFS). We use IDB directly so queued offline
// events survive refreshes.

const IDB_QUEUE_NAME = 'eo-offline-queue';
const IDB_QUEUE_VERSION = 1;
const IDB_QUEUE_STORE = 'queue';

type QueueEntry = { event: EoEventInput; attempts: number };

async function openQueueDb() {
  return openDB(IDB_QUEUE_NAME, IDB_QUEUE_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(IDB_QUEUE_STORE)) {
        db.createObjectStore(IDB_QUEUE_STORE);
      }
    },
  });
}

async function loadQueueFromIdb(roomId: string): Promise<QueueEntry[]> {
  try {
    const db = await openQueueDb();
    return (await db.get(IDB_QUEUE_STORE, roomId)) ?? [];
  } catch {
    return [];
  }
}

async function saveQueueToIdb(roomId: string, queue: QueueEntry[]): Promise<void> {
  try {
    const db = await openQueueDb();
    await db.put(IDB_QUEUE_STORE, queue, roomId);
  } catch (e) {
    console.warn('[EO-DB] Failed to persist offline queue to IDB:', e);
  }
}

/**
 * Delete the entire offline-queue IndexedDB. Called on logout so a new
 * session does not inherit queued writes from the prior account.
 * Best-effort — failures here don't block the logout flow.
 */
export async function eraseOfflineQueueDb(): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(IDB_QUEUE_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve(); // some other tab holds it; best-effort
    });
  } catch (e) {
    console.warn('[EO-DB] Failed to erase offline queue IDB on logout:', e);
  }
}

// ─── Hydration timeout helper ─────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[EO-DB] ${label} timed out after ${ms} ms`)), ms),
    ),
  ]);
}

export interface RoomDataSnapshot {
  roomId: string;
  roomAlias: string;
  name: string | null;
  topic: string | null;
  memberCount: number;
  members: Array<{ userId: string; displayName: string | null; membership: string }>;
  encryptionEnabled: boolean;
  encryptionAlgorithm: string | null;
  timelineLength: number;
  timeline: Array<{
    eventId: string;
    type: string;
    sender: string;
    ts: number;
    content: any;
  }>;
  stateEvents: Array<{
    type: string;
    stateKey: string;
    sender: string;
    content: any;
  }>;
  roomVersion: string | null;
  joinRule: string | null;
  historyVisibility: string | null;
}

export class SyncManager {
  private client: MatrixClient;
  private roomId: string;
  private store: EoStore;
  private onEvent?: (event: any) => void;
  private keyring: LocalKeyring;
  /** Additional room IDs to listen to (restricted, governance). */
  private additionalRoomIds: string[] = [];

  /** Bound listener reference for cleanup. */
  private handleTimelineEvent: ((event: MatrixEvent) => void) | null = null;

  /** Reconnection listener references for cleanup. */
  private onlineHandler: (() => void) | null = null;
  private syncStateHandler: ((state: string, prevState: string | null) => void) | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Late room arrival listener — cleaned up in destroy(). */
  private lateRoomHandler: ((room: any) => void) | null = null;

  /** Timeout for late room arrival — prevents indefinite waiting. */
  private lateRoomTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Whether this manager has been destroyed. */
  private destroyed = false;

  /** Optional callback when events are dropped after exhausting retries. */
  onEventDropped?: (count: number, reason: string) => void;

  constructor(
    client: MatrixClient,
    roomId: string,
    store: EoStore,
    onEvent?: (event: any) => void,
    keyring?: LocalKeyring,
  ) {
    this.client = client;
    this.roomId = roomId;
    this.store = store;
    this.onEvent = onEvent;
    this.keyring = keyring || { keys: new Map() };
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
   * Typically called when a user is kicked from a restricted room.
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
    if (this.handleTimelineEvent) {
      this.client.off('Room.timeline' as any, this.handleTimelineEvent);
      this.handleTimelineEvent = null;
    }
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
    if (this.syncStateHandler) {
      this.client.off('sync' as any, this.syncStateHandler);
      this.syncStateHandler = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.lateRoomHandler) {
      this.client.off('Room' as any, this.lateRoomHandler);
      this.lateRoomHandler = null;
    }
    if (this.lateRoomTimeout) {
      clearTimeout(this.lateRoomTimeout);
      this.lateRoomTimeout = null;
    }
  }

  /**
   * Poll for the room object to become available in the Matrix SDK store.
   * On a fresh device the SDK may not have populated the room yet when
   * initialize() runs — exponential backoff gives the initial sync time
   * to complete (~6 s max: 200 + 400 + 800 + 1600 + 3200 ms).
   */
  private async waitForRoom(maxAttempts = 5): Promise<any | null> {
    let delay = 200;
    for (let i = 0; i < maxAttempts; i++) {
      const room = this.client.getRoom(this.roomId);
      if (room) return room;
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
    console.warn('[EO-DB] Room', this.roomId, 'not available after polling — registering late arrival listener');
    // Register a one-shot listener so we can hydrate/replay when the room
    // eventually appears from the sync stream. Timeout after 60s to avoid
    // indefinite waiting if the room is genuinely unreachable.
    const handler = (arrivedRoom: any) => {
      if (this.destroyed) return;
      if (arrivedRoom.roomId !== this.roomId) return;
      this.client.off('Room' as any, handler);
      this.lateRoomHandler = null;
      if (this.lateRoomTimeout) {
        clearTimeout(this.lateRoomTimeout);
        this.lateRoomTimeout = null;
      }
      this.lateInitialize();
    };
    this.lateRoomHandler = handler;
    this.client.on('Room' as any, handler);

    // Safety timeout — give up after 60 seconds
    this.lateRoomTimeout = setTimeout(() => {
      if (this.destroyed) return;
      this.client.off('Room' as any, handler);
      this.lateRoomHandler = null;
      this.lateRoomTimeout = null;
      console.warn('[EO-DB] Room', this.roomId, 'did not arrive within 60s timeout');
    }, 60_000);

    return null;
  }

  /**
   * Called when a room arrives late (after initial polling timed out).
   * Performs hydration + replay that was skipped during initialize().
   */
  private async lateInitialize(): Promise<void> {
    if (this.destroyed) return;
    try {
      const currentSeq = await this.store.getCurrentSeq();
      if (currentSeq === 0) {
        try {
          await withTimeout(this.hydrateFromBlockChain(), 60_000, 'Late block-chain hydration');
        } catch (e) {
          console.warn('[EO-DB] Late block-chain hydration failed:', e);
        }
      }
      await this.replayTimelineEvents();
      await this.flushUnsyncedEvents();
      console.log('[EO-DB] Late room initialization completed for', this.roomId);
    } catch (e) {
      console.warn('[EO-DB] Late room initialization failed:', e);
    }
  }

  /**
   * Initialize sync — call after login and store setup.
   *
   * Attaches the live timeline listener immediately, then kicks off snapshot
   * hydration, timeline replay, and offline-queue flush concurrently. There
   * is no preferred source: whichever lane (live events, Matrix media
   * snapshot, room-timeline replay) returns events first appends them; later
   * arrivals deduplicate against the fold engine's client_event_id index.
   */
  async initialize(): Promise<void> {
    // Wait for the room to be available in the SDK store before listening
    await this.waitForRoom();

    // Listen for new room events in real-time FIRST so events arriving while
    // hydration is in flight are captured. The fold engine deduplicates via
    // client_event_id, so concurrent appends from snapshot hydration,
    // timeline replay, and live events all converge on the same state.
    this.handleTimelineEvent = (event: MatrixEvent) => {
      if (this.destroyed) return;
      const eventRoomId = event.getRoomId();
      if (!eventRoomId) return; // guard null from getRoomId()
      if (eventRoomId !== this.roomId && !this.additionalRoomIds.includes(eventRoomId)) return;
      if (event.getType() !== EO_EVENT_TYPE) return;
      this.processIncomingEvent(event);
    };
    this.client.on('Room.timeline' as any, this.handleTimelineEvent);

    // Auto-flush offline queue when connectivity returns
    this.onlineHandler = () => { this.debouncedFlush(); };
    window.addEventListener('online', this.onlineHandler);

    this.syncStateHandler = (state: string, prevState: string | null) => {
      if (state === 'SYNCING' && (prevState === 'CATCHUP' || prevState === 'ERROR')) {
        this.debouncedFlush();
      }
    };
    this.client.on('sync' as any, this.syncStateHandler);

    // Race the hydration sources in parallel — no source is preferred.
    const currentSeq = await this.store.getCurrentSeq();
    const hydrationLanes: Promise<unknown>[] = [];

    // Lane 1: Block-chain hydration. On a fresh device this walks the
    // m.eo.head → block chain → tail and folds every event. The fold
    // engine deduplicates by client_event_id, so running concurrently
    // with live timeline events is safe.
    if (currentSeq === 0) {
      hydrationLanes.push(
        withTimeout(this.hydrateFromBlockChain(), 60_000, 'Block-chain hydration')
          .catch(e => console.warn('[EO-DB] Block-chain hydration failed:', e)),
      );
    } else {
      // Returning device — block hydration not needed, but still replay
      // any timeline events newer than what's in the local store.
      hydrationLanes.push(
        this.replayTimelineEvents().catch(e =>
          console.warn('[EO-DB] Timeline replay failed:', e),
        ),
      );
    }

    // Lane 2: Restore + flush the offline queue from the previous session.
    hydrationLanes.push(
      this.restoreQueueFromIdb()
        .then(() => this.flushUnsyncedEvents())
        .catch(e => console.warn('[EO-DB] Offline queue restore/flush failed:', e)),
    );

    // Don't await — the live listener is already capturing new events. Lanes
    // continue in the background; callers shouldn't gate UI on any one of
    // them returning first.
    void Promise.allSettled(hydrationLanes);
  }

  /**
   * Debounced flush — prevents hammering on rapid online/offline toggling.
   * Collapses multiple reconnection signals within 2 s into a single flush.
   */
  private debouncedFlush(): void {
    if (this.destroyed) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushUnsyncedEvents().catch((err) => {
        console.warn('[EO-DB] Reconnection flush failed:', err);
      });
    }, 2_000);
  }

  /**
   * Hydrate the local store from the Matrix-native block chain.
   *
   * Reads `m.eo.head` (one state-event lookup), walks the block chain
   * backwards via `prior_block_event_id`, downloads + decrypts every
   * block in parallel, and folds the resulting events into the store.
   * Finishes by walking the live timeline forward from `tail_cutoff_event_id`.
   */
  private async hydrateFromBlockChain(): Promise<void> {
    await hydrateFromBlocks(this.client, this.roomId, this.store, this.onEvent);
  }

  /**
   * Durability hook called by the host shell on tab-hide / beforeunload /
   * logout. Block sealing runs on size/idle triggers from the compactor;
   * we intentionally do NOT force a seal during page-close because a
   * partially-uploaded block on tab kill would leave the head pointer
   * out of sync. The local OPFS kv-snapshot path (via
   * `useEoStore.flushToOpfs()`) handles same-device durability.
   */
  async saveSnapshot(): Promise<void> {
    return;
  }

  /**
   * Replay EO events already present in the room timeline.
   *
   * After the initial Matrix sync, the room object contains timeline events
   * that were fetched as part of the sync response. These are NOT emitted
   * through the Room.timeline listener (which only fires for new events).
   * Walk them here so a fresh device without a snapshot can still recover
   * data from the room timeline.
   *
   * The fold engine deduplicates via client_event_id, so replaying events
   * already covered by a snapshot is a no-op.
   */
  private async replayTimelineEvents(): Promise<void> {
    const room = this.client.getRoom(this.roomId);
    if (!room) return;

    const timeline = room.getLiveTimeline().getEvents();
    for (const event of timeline) {
      if (this.destroyed) return;
      if (event.getType() !== EO_EVENT_TYPE) continue;
      await this.processIncomingEvent(event);
    }
  }

  /**
   * Return a snapshot of the raw Matrix room data for debugging/inspection.
   */
  getRoomData(): RoomDataSnapshot | null {
    const room = this.client.getRoom(this.roomId);
    if (!room) return null;

    const stateEvents: RoomDataSnapshot['stateEvents'] = [];
    const currentState = room.currentState;
    for (const evMap of Object.values(currentState.events as Map<string, Map<string, MatrixEvent>> | Record<string, Record<string, MatrixEvent>>)) {
      const entries = evMap instanceof Map ? evMap.values() : Object.values(evMap);
      for (const ev of entries) {
        stateEvents.push({
          type: ev.getType(),
          stateKey: ev.getStateKey() ?? '',
          sender: ev.getSender() ?? '',
          content: ev.getContent(),
        });
      }
    }

    const members = room.getJoinedMembers().map((m: any) => ({
      userId: m.userId,
      displayName: m.name || null,
      membership: m.membership,
    }));

    const timeline = room.getLiveTimeline().getEvents().slice(-100).map((ev: MatrixEvent) => ({
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
      topic: (currentState.getStateEvents('m.room.topic', '') as any)?.getContent()?.topic ?? null,
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
   * 1. Generate content-addressable client_event_id via hash
   * 2. Fold immediately (instant UI update)
   * 3. Send to Matrix room async (may fail if offline)
   * 4. If send fails, queue for later — the queue is protected by a mutex
   *    so concurrent failures don't clobber each other.
   */
  async processLocalEvent(
    event: Omit<EoEventInput, 'client_event_id' | 'agent' | 'ts'>,
  ): Promise<number> {
    const ts = new Date().toISOString();
    const agent = this.client.getUserId()!;

    // Derive deterministic ID from content — same event from two devices
    // offline will produce the same hash and dedup on fold.
    const clientEventId = await eventHash({
      op: event.op,
      target: event.target,
      operand: event.operand,
      agent,
      ts,
    });

    const localEvent: EoEventInput = {
      ...event,
      client_event_id: clientEventId,
      agent,
      ts,
    };

    // Fold immediately
    const seq = await processEvent(this.store, localEvent, this.onEvent);

    // Send to room (best-effort)
    try {
      await sendEoEvent(this.client, this.roomId, localEvent);
    } catch {
      // Offline — queue for later sync (mutex-protected append)
      await this.enqueueOfflineEvent(localEvent);
    }

    return seq;
  }

  /**
   * Process an incoming room event — dedup by client_event_id, then fold.
   *
   * The fold engine's idempotency check (via content hash) handles the case
   * where we already folded this event locally. Events without a
   * client_event_id get one derived from their content in processEvent().
   */
  private async processIncomingEvent(matrixEvent: MatrixEvent): Promise<void> {
    const eoEvent = matrixEventToEo(matrixEvent);

    // Skip space-level config events — space discovery uses Matrix state events
    // and the root IDB, not per-space IDBs. Writing other spaces' events here
    // just pollutes the store.
    if (eoEvent.target.startsWith('space')) return;

    // Fast path: if we have a client_event_id, check locally before entering
    // the fold mutex. This avoids queueing behind the mutex for events we
    // already processed.
    if (eoEvent.client_event_id) {
      const existing = await this.store.get(`idem:${eoEvent.client_event_id}`);
      if (existing != null) return;
    }

    // The fold engine will also check idempotency inside the mutex,
    // and will derive a content hash if client_event_id is missing.
    await processEvent(this.store, eoEvent, this.onEvent);
  }

  /**
   * On init, merge any IDB-persisted offline queue from a previous session into
   * the in-memory store queue, then clear IDB (will be re-saved on next flush).
   */
  private async restoreQueueFromIdb(): Promise<void> {
    const saved = await loadQueueFromIdb(this.roomId);
    if (saved.length === 0) return;
    await queueMutex.run(async () => {
      const existing: QueueEntry[] =
        (await this.store.get('meta:offline_queue')) || [];
      // Merge, avoiding duplicates by client_event_id
      const seenIds = new Set(existing.map(e => e.event.client_event_id));
      const merged = [...existing];
      for (const entry of saved) {
        if (!entry.event.client_event_id || !seenIds.has(entry.event.client_event_id)) {
          merged.push(entry);
          if (entry.event.client_event_id) seenIds.add(entry.event.client_event_id);
        }
      }
      await this.store.put('meta:offline_queue', merged);
    });
    // Clear IDB — will be re-populated by the next enqueue or flush
    await saveQueueToIdb(this.roomId, []);
  }

  /**
   * Append an event to the offline queue atomically.
   * The mutex ensures two concurrent send-failures don't race on the queue.
   */
  private async enqueueOfflineEvent(event: EoEventInput): Promise<void> {
    await queueMutex.run(async () => {
      const queue: Array<{ event: EoEventInput; attempts: number }> =
        (await this.store.get('meta:offline_queue')) || [];
      queue.push({ event, attempts: 0 });
      await this.store.put('meta:offline_queue', queue);
      await saveQueueToIdb(this.roomId, queue);
    });
  }

  /** Max retry attempts before dropping a permanently-failing queued event. */
  private static readonly MAX_QUEUE_ATTEMPTS = 5;

  /**
   * Flush queued offline events to the room.
   *
   * Tries every event independently — a failure on event #2 does NOT
   * prevent event #3 from being attempted. Successfully sent events are
   * removed from the queue; failed ones stay for the next flush cycle
   * up to MAX_QUEUE_ATTEMPTS, after which they are dropped.
   *
   * Backwards-compatible: legacy queue entries (raw EoEventInput without
   * an `attempts` field) are auto-wrapped on read.
   *
   * The receiver deduplicates via content hash, so re-sending an event
   * that was already received (e.g., via peer sync) is harmless.
   */
  private async flushUnsyncedEvents(): Promise<void> {
    await queueMutex.run(async () => {
      const raw: any[] = (await this.store.get('meta:offline_queue')) || [];
      if (raw.length === 0) return;

      // Normalise legacy entries (plain EoEventInput) into { event, attempts }
      const queue = raw.map((entry: any) =>
        entry.event ? entry as { event: EoEventInput; attempts: number }
                     : { event: entry as EoEventInput, attempts: 0 },
      );

      const remaining: Array<{ event: EoEventInput; attempts: number }> = [];
      let dropped = 0;

      // Send up to FLUSH_BATCH_SIZE events concurrently for faster drain.
      // Each batch completes (with success or failure recorded) before
      // the next starts, which keeps memory usage bounded.
      const FLUSH_BATCH_SIZE = 20;
      for (let i = 0; i < queue.length; i += FLUSH_BATCH_SIZE) {
        const batch = queue.slice(i, i + FLUSH_BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(entry => sendEoEvent(this.client, this.roomId, entry.event)),
        );
        for (let j = 0; j < batch.length; j++) {
          const result = results[j];
          const entry = batch[j];
          if (result.status === 'fulfilled') continue; // sent OK
          const err = result.reason;
          if (!isTransientError(err)) {
            console.warn(
              '[EO-DB] Dropping queued event due to permanent error:',
              entry.event.client_event_id,
              (err as any)?.httpStatus ?? (err as any)?.message,
            );
            dropped++;
          } else {
            const attempts = entry.attempts + 1;
            if (attempts < SyncManager.MAX_QUEUE_ATTEMPTS) {
              remaining.push({ event: entry.event, attempts });
            } else {
              console.warn(
                '[EO-DB] Dropping queued event after', attempts, 'failed attempts:',
                entry.event.client_event_id,
              );
              dropped++;
            }
          }
        }
      }

      if (dropped > 0) {
        this.onEventDropped?.(dropped, `${dropped} events failed permanently or exceeded retry limit`);
      }
      await this.store.put('meta:offline_queue', remaining);
      await saveQueueToIdb(this.roomId, remaining);
    });
  }
}
