/**
 * Sync manager — orchestrates snapshot persistence, offline queue, and deduplication.
 *
 * SyncManager handles Matrix timeline event transport (com.eo-db.event) and
 * snapshot persistence in Matrix media. Google Drive handles async backup.
 *
 * Data is persisted as delta snapshots in Matrix media — each snapshot
 * contains only the events since the last one, plus up to 25 previous
 * snapshot URIs for fast chain traversal. Below 500 log entries the
 * hydration state lives in room data only.
 *
 * Offline queue is append-only via atomic read-modify-write through the
 * queue mutex. Events that fail to send are retried individually on reconnect;
 * idempotency hashing on the receiver side handles duplicates naturally.
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput } from '../db/types';
import type { LocalKeyring } from '../db/crypto-types';
import { processEvent } from '../db/fold';
import { eventHash } from '../db/hash';
import { AsyncMutex } from '../db/mutex';
import { EO_EVENT_TYPE, getDataRoom, matrixEventToEo, sendEoEvent } from './event-bridge';
import { findLatestSnapshot, maybeCreateSnapshot, createDeltaSnapshot, uploadDeltaSnapshot, setSnapshotStateEvent, restoreFromDeltaChain } from './snapshot';
import { isTransientError } from './connection-resilience';

/** Mutex protecting the offline queue from concurrent read-modify-write. */
const queueMutex = new AsyncMutex();

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
          await this.hydrateFromSnapshot();
        } catch (e) {
          console.warn('[EO-DB] Late snapshot hydration failed:', e);
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
   * On a fresh device (seq === 0), hydrates from the latest snapshot stored
   * in Matrix media, then replays any EO events already present in the room
   * timeline (from the initial sync) that the snapshot didn't covered.
   */
  async initialize(): Promise<void> {
    // Wait for the room to be available in the SDK store before hydrating
    await this.waitForRoom();

    const currentSeq = await this.store.getCurrentSeq();

    // On a fresh device, restore from the latest Matrix media snapshot.
    // Non-fatal: a missing or corrupt snapshot shouldn't block sync —
    // timeline replay will still pick up events from the room.
    if (currentSeq === 0) {
      try {
        await this.hydrateFromSnapshot();
      } catch (e) {
        console.warn('[EO-DB] Snapshot hydration failed, continuing with timeline replay:', e);
      }
    }

    // Replay EO events already in the room timeline (from initial sync).
    // The snapshot may not exist or may be stale — the room timeline is the
    // source of truth. The fold engine deduplicates via client_event_id so
    // replaying events already covered by the snapshot is harmless.
    await this.replayTimelineEvents();

    // Flush unsynced events BEFORE attaching the live listener — if flush
    // fails, no dangling listener is left behind for the caller to clean up.
    await this.flushUnsyncedEvents();

    // Listen for new room events in real-time (main + additional rooms).
    // Attached last so a failure in any earlier step doesn't leak a listener.
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
   * Hydrate the local store from the latest snapshot in room state.
   *
   * Reads the latest URI from room state (O(1)), downloads the blob,
   * and applies it. The blob's `prev_mxcs` array allows jumping backwards
   * through history if the client needs to walk further.
   */
  private async hydrateFromSnapshot(): Promise<void> {
    const snap = await findLatestSnapshot(this.client, this.roomId);
    if (!snap) return;
    const restoredSeq = await restoreFromDeltaChain(
      this.client, this.store, snap.mxc, this.onEvent, this.keyring,
    );
    await this.store.put('meta:snapshot_seq', restoredSeq);
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
   * Force-save a delta snapshot to Matrix media right now.
   * Called on beforeunload / logout so data is always persisted.
   */
  async saveSnapshot(): Promise<void> {
    // Matrix media snapshot saves are disabled — Filen is the primary store.
    return;

    const room = this.client.getRoom(this.roomId);
    if (!room) {
      console.warn('[EO-DB] Cannot save snapshot — room not available');
      return;
    }

    const seq = await this.store.getCurrentSeq();
    const lastSnapshotSeq: number = (await this.store.get('meta:snapshot_seq')) || 0;
    if (seq === 0 || seq === lastSnapshotSeq) return; // nothing new to snapshot
    const delta = await createDeltaSnapshot(this.store, this.client.getUserId()!);
    const mxc = await uploadDeltaSnapshot(this.client, this.roomId, delta, this.keyring);
    await this.store.put('meta:snapshot_seq', seq);
    await this.store.put('meta:snapshot_mxc', mxc);
    const prevMxcs: string[] = (await this.store.get('meta:snapshot_prev_mxcs')) || [];
    await this.store.put('meta:snapshot_prev_mxcs', [mxc, ...prevMxcs].slice(0, 25));
  }

  /**
   * Manual delta snapshot — captures log events since the last snapshot,
   * uploads to Matrix media, and records the mxc URI in a NUL log event.
   *
   * Each delta carries up to 25 previous snapshot URIs so hydrating
   * devices can jump back in large strides.
   */
  async manualSnapshot(): Promise<{ mxc: string; seq: number }> {
    // Matrix media snapshot saves are disabled — Filen is the primary store.
    throw new Error('Matrix media snapshots are disabled — use Filen backup instead');

    const currentSeq = await this.store.getCurrentSeq();
    const lastSnapshotSeq: number = (await this.store.get('meta:snapshot_seq')) || 0;

    if (currentSeq === lastSnapshotSeq) {
      throw new Error('No new events since last snapshot');
    }

    // 1. Create delta snapshot (events since last snapshot)
    const delta = await createDeltaSnapshot(this.store, this.client.getUserId()!);

    // 2. Upload to Matrix media (encrypted if keyring has keys)
    const mxc = await uploadDeltaSnapshot(this.client, this.roomId, delta, this.keyring);

    // 3. Record the mxc URI in a NUL event — this makes the snapshot
    //    discoverable from the event log itself
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
      acquired_ts: new Date().toISOString(),
    });

    // 4. Update snapshot bookkeeping
    await this.store.put('meta:snapshot_seq', currentSeq);
    await this.store.put('meta:snapshot_mxc', mxc);
    const prevMxcs: string[] = (await this.store.get('meta:snapshot_prev_mxcs')) || [];
    await this.store.put('meta:snapshot_prev_mxcs', [mxc, ...prevMxcs].slice(0, 25));

    // Room state already updated by uploadDeltaSnapshot (with key_id)
    return { mxc, seq: currentSeq };
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

    // Auto-snapshot to Matrix media every 500 log entries
    await maybeCreateSnapshot(this.client, this.roomId, this.store, this.client.getUserId()!, this.keyring);

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
   * Append an event to the offline queue atomically.
   * The mutex ensures two concurrent send-failures don't race on the queue.
   */
  private async enqueueOfflineEvent(event: EoEventInput): Promise<void> {
    await queueMutex.run(async () => {
      const queue: Array<{ event: EoEventInput; attempts: number }> =
        (await this.store.get('meta:offline_queue')) || [];
      queue.push({ event, attempts: 0 });
      await this.store.put('meta:offline_queue', queue);
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
      for (const entry of queue) {
        try {
          await sendEoEvent(this.client, this.roomId, entry.event);
        } catch (err) {
          if (!isTransientError(err)) {
            // Permanent failure (4xx) — drop immediately
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
          // Don't break — try the rest. Individual event failures
          // (e.g., size limit) shouldn't block other events.
          // If we're fully offline, they'll all fail fast anyway.
        }
      }

      if (dropped > 0) {
        this.onEventDropped?.(dropped, `${dropped} events failed permanently or exceeded retry limit`);
      }
      await this.store.put('meta:offline_queue', remaining);
    });
  }
}
