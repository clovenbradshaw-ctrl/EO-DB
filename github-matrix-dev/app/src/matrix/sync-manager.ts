/**
 * Sync manager — orchestrates snapshot persistence, offline queue, and deduplication.
 *
 * Data is persisted as encrypted binary snapshots in Matrix media.
 * On a fresh device, the latest snapshot is downloaded and applied.
 * Snapshots are auto-saved every 1000 events and on explicit saveSnapshot() calls.
 *
 * Offline queue is append-only via atomic read-modify-write through the
 * queue mutex. Events that fail to send are retried individually on reconnect;
 * idempotency hashing on the receiver side handles duplicates naturally.
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput } from '../db/types';
import { processEvent } from '../db/fold';
import { eventHash } from '../db/hash';
import { AsyncMutex } from '../db/mutex';
import { EO_EVENT_TYPE, getDataRoom, matrixEventToEo, sendEoEvent } from './event-bridge';
import { findLatestSnapshot, applySnapshot, maybeCreateSnapshot, createSnapshot, uploadSnapshot, createDeltaSnapshot, uploadDeltaSnapshot } from './snapshot';

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

  constructor(
    client: MatrixClient,
    roomId: string,
    store: EoStore,
    onEvent?: (event: any) => void,
  ) {
    this.client = client;
    this.roomId = roomId;
    this.store = store;
    this.onEvent = onEvent;
  }

  /**
   * Initialize sync — call after login and store setup.
   *
   * On a fresh device (seq === 0), hydrates from the latest snapshot stored
   * in Matrix media. This is the primary data recovery path.
   */
  async initialize(): Promise<void> {
    const currentSeq = await this.store.getCurrentSeq();

    // On a fresh device, restore from the latest Matrix media snapshot
    if (currentSeq === 0) {
      await this.hydrateFromSnapshot();
    }

    // Listen for new room events in real-time
    this.client.on('Room.timeline' as any, (event: MatrixEvent) => {
      if (event.getRoomId() !== this.roomId) return;
      if (event.getType() !== EO_EVENT_TYPE) return;
      this.processIncomingEvent(event);
    });

    // Flush any unsynced local events
    await this.flushUnsyncedEvents();
  }

  /**
   * Hydrate the local store from the latest snapshot in Matrix media.
   */
  private async hydrateFromSnapshot(): Promise<void> {
    const snap = await findLatestSnapshot(this.client, this.roomId);
    if (!snap) return;
    const restoredSeq = await applySnapshot(this.client, this.store, snap.mxc);
    await this.store.put('meta:snapshot_seq', restoredSeq);
  }

  /**
   * Force-save a snapshot to Matrix media right now.
   * Called on beforeunload / logout so data is always persisted.
   */
  async saveSnapshot(): Promise<void> {
    const seq = await this.store.getCurrentSeq();
    if (seq === 0) return; // nothing to snapshot
    const snapshot = await createSnapshot(this.store, this.client.getUserId()!);
    await uploadSnapshot(this.client, this.roomId, snapshot);
    await this.store.put('meta:snapshot_seq', seq);
  }

  /**
   * Manual delta snapshot — captures log events since the last snapshot,
   * uploads to Matrix media, and records the mxc URI in a NUL log event.
   *
   * This creates a reconstructable chain: each NUL snapshot event points
   * to its delta blob, and each delta references the previous one via prev_mxc.
   */
  async manualSnapshot(): Promise<{ mxc: string; seq: number }> {
    const currentSeq = await this.store.getCurrentSeq();
    const lastSnapshotSeq: number = (await this.store.get('meta:snapshot_seq')) || 0;

    if (currentSeq === lastSnapshotSeq) {
      throw new Error('No new events since last snapshot');
    }

    // 1. Create delta snapshot (events since last snapshot)
    const delta = await createDeltaSnapshot(this.store, this.client.getUserId()!);

    // 2. Upload to Matrix media
    const mxc = await uploadDeltaSnapshot(this.client, delta);

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
        prev_mxc: delta.prev_mxc,
        event_count: delta.events.length,
      },
      acquired_ts: new Date().toISOString(),
    });

    // 4. Update snapshot bookkeeping
    await this.store.put('meta:snapshot_seq', currentSeq);
    await this.store.put('meta:snapshot_mxc', mxc);

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

    // Auto-snapshot to Matrix media every 1000 events
    await maybeCreateSnapshot(this.client, this.roomId, this.store, this.client.getUserId()!);

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
      const queue: EoEventInput[] = (await this.store.get('meta:offline_queue')) || [];
      queue.push(event);
      await this.store.put('meta:offline_queue', queue);
    });
  }

  /**
   * Flush queued offline events to the room.
   *
   * Tries every event independently — a failure on event #2 does NOT
   * prevent event #3 from being attempted. Successfully sent events are
   * removed from the queue; failed ones stay for the next flush cycle.
   *
   * The receiver deduplicates via content hash, so re-sending an event
   * that was already received (e.g., via peer sync) is harmless.
   */
  private async flushUnsyncedEvents(): Promise<void> {
    await queueMutex.run(async () => {
      const queue: EoEventInput[] = (await this.store.get('meta:offline_queue')) || [];
      if (queue.length === 0) return;

      const remaining: EoEventInput[] = [];
      for (const event of queue) {
        try {
          await sendEoEvent(this.client, this.roomId, event);
        } catch {
          remaining.push(event);
          // Don't break — try the rest. Individual event failures
          // (e.g., size limit) shouldn't block other events.
          // If we're fully offline, they'll all fail fast anyway.
        }
      }

      await this.store.put('meta:offline_queue', remaining);
    });
  }
}
