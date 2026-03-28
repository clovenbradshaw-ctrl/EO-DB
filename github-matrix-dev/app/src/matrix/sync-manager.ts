/**
 * Sync manager — orchestrates room sync, offline queue, and deduplication.
 *
 * Three sync paths in priority order:
 * 1. Snapshot hydration (new device or stale cache)
 * 2. Room history (primary sync — paginate timeline)
 * 3. Peer sync (gap filling via to-device messaging)
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput } from '../db/types';
import { processEvent } from '../db/fold';
import { EO_EVENT_TYPE, matrixEventToEo, sendEoEvent } from './event-bridge';
import { findLatestSnapshot, applySnapshot } from './snapshot';

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
   * On a fresh device (seq === 0), tries snapshot hydration first for speed,
   * then replays any events after the snapshot from room history.
   */
  async initialize(): Promise<void> {
    const currentSeq = await this.store.getCurrentSeq();

    // On a fresh device, try snapshot hydration first
    if (currentSeq === 0) {
      try {
        const snap = await findLatestSnapshot(this.client, this.roomId);
        if (snap) {
          await applySnapshot(this.client, this.store, snap.mxc);
        }
      } catch {
        // Snapshot hydration failed — fall through to full history sync
      }
    }

    // Sync room history (replays all events, or just post-snapshot events via dedup)
    await this.syncRoomHistory();

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
   * Process a locally created event.
   * 1. Generate client_event_id
   * 2. Fold immediately (instant UI update)
   * 3. Send to Matrix room async (may fail if offline)
   */
  async processLocalEvent(
    event: Omit<EoEventInput, 'client_event_id' | 'agent' | 'ts'>,
  ): Promise<number> {
    const clientEventId = crypto.randomUUID();
    const localEvent: EoEventInput = {
      ...event,
      client_event_id: clientEventId,
      agent: this.client.getUserId()!,
      ts: new Date().toISOString(),
    };

    // Fold immediately
    const seq = await processEvent(this.store, localEvent, this.onEvent);

    // Send to room (best-effort)
    try {
      await sendEoEvent(this.client, this.roomId, localEvent);
    } catch {
      // Offline — store for later sync
      const queue = (await this.store.get('meta:offline_queue')) || [];
      queue.push(localEvent);
      await this.store.put('meta:offline_queue', queue);
    }

    return seq;
  }

  /**
   * Process an incoming room event — dedup by client_event_id, then fold.
   */
  private async processIncomingEvent(matrixEvent: MatrixEvent): Promise<void> {
    const eoEvent = matrixEventToEo(matrixEvent);

    // Dedup: if we already processed this event locally, skip
    if (eoEvent.client_event_id) {
      const existing = await this.store.get(`idem:${eoEvent.client_event_id}`);
      if (existing != null) return;
    }

    await processEvent(this.store, eoEvent, this.onEvent);
  }

  /**
   * Paginate room history from last known sync token.
   * On a fresh device (empty IndexedDB), paginates backwards through the
   * full room timeline so all events are replayed into the local store.
   */
  private async syncRoomHistory(): Promise<void> {
    const room = this.client.getRoom(this.roomId);
    if (!room) return;

    // Paginate backwards until we have the full timeline
    const timeline = room.getLiveTimeline();
    let canPaginate = true;
    while (canPaginate) {
      try {
        canPaginate = await this.client.paginateEventTimeline(timeline, {
          backwards: true,
          limit: 100,
        });
      } catch {
        // pagination failed (e.g. rate limit) — process what we have
        break;
      }
    }

    // Now process all events in chronological order
    const events = timeline.getEvents();
    for (const event of events) {
      if (event.getType() !== EO_EVENT_TYPE) continue;
      await this.processIncomingEvent(event);
    }
  }

  /**
   * Flush queued offline events to the room.
   */
  private async flushUnsyncedEvents(): Promise<void> {
    const queue: EoEventInput[] = (await this.store.get('meta:offline_queue')) || [];
    if (queue.length === 0) return;

    const remaining: EoEventInput[] = [];
    for (const event of queue) {
      try {
        await sendEoEvent(this.client, this.roomId, event);
      } catch {
        remaining.push(event);
        break; // still offline
      }
    }

    await this.store.put('meta:offline_queue', remaining);
  }
}
