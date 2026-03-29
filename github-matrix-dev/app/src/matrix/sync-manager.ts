/**
 * Sync manager — orchestrates incremental snapshots, offline queue, and deduplication.
 *
 * Data flow:
 *   1. On fresh device (seq === 0): hydrate from snapshot chain in Matrix media.
 *      Any gaps (pruned snapshots) are filled by replaying events from the room timeline.
 *   2. Real-time: incoming room events are deduplicated and folded.
 *   3. Local events fold immediately, then send to the room async.
 *   4. Snapshots are incremental — each one stores only the events since the last snapshot.
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput } from '../db/types';
import { processEvent } from '../db/fold';
import { EO_EVENT_TYPE, matrixEventToEo, sendEoEvent } from './event-bridge';
import {
  findAllSnapshots,
  applySnapshotChain,
  maybeCreateSnapshot,
  createSnapshot,
  uploadSnapshot,
} from './snapshot';

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
   * On a fresh device (seq === 0), hydrates from the snapshot chain
   * stored in Matrix media, filling any gaps from the room timeline.
   */
  async initialize(): Promise<void> {
    const currentSeq = await this.store.getCurrentSeq();

    if (currentSeq === 0) {
      await this.hydrateFromSnapshots();
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
   * Hydrate the local store from the snapshot chain in Matrix media.
   *
   * Applies all available snapshots in order. If any were pruned
   * (download 404s), their event ranges are filled by paginating
   * the room timeline — slower, but always correct.
   */
  private async hydrateFromSnapshots(): Promise<void> {
    const refs = await findAllSnapshots(this.client, this.roomId);
    if (refs.length === 0) return;

    // Apply the snapshot chain, collecting any gaps
    const { seq, gaps } = await applySnapshotChain(
      this.client,
      this.store,
      refs,
      async (store, event) => processEvent(store, event, this.onEvent),
    );

    // Fill gaps from room timeline (events whose snapshots were pruned)
    for (const gap of gaps) {
      await this.fillGapFromTimeline(gap.from, gap.to);
    }

    if (seq > 0) {
      await this.store.put('meta:snapshot_seq', seq);
    }
  }

  /**
   * Fill a gap in the snapshot chain by paginating the room timeline
   * and replaying events in the (from, to] range through the fold.
   */
  private async fillGapFromTimeline(from: number, to: number): Promise<void> {
    const room = this.client.getRoom(this.roomId);
    if (!room) return;

    const timeline = room.getLiveTimeline();
    let canPaginate = true;

    // Paginate until we've covered the gap
    while (canPaginate) {
      for (const event of timeline.getEvents()) {
        if (event.getType() !== EO_EVENT_TYPE) continue;
        const eoEvent = matrixEventToEo(event);
        // We don't have a seq on incoming Matrix events directly,
        // but processEvent assigns one via the fold. The idempotency
        // check (client_event_id) prevents double-processing.
        await processEvent(this.store, eoEvent, this.onEvent);
      }

      try {
        canPaginate = await this.client.paginateEventTimeline(timeline, {
          backwards: true,
          limit: 100,
        });
      } catch {
        break;
      }
    }
  }

  /**
   * Force-save an incremental snapshot to Matrix media right now.
   * Called on beforeunload / logout so data is always persisted.
   */
  async saveSnapshot(): Promise<void> {
    const seq = await this.store.getCurrentSeq();
    const lastSnapshotSeq: number = (await this.store.get('meta:snapshot_seq')) ?? 0;
    if (seq === 0 || seq === lastSnapshotSeq) return; // nothing new to snapshot
    const snapshot = await createSnapshot(this.store, this.client.getUserId()!);
    await uploadSnapshot(this.client, this.roomId, snapshot);
    await this.store.put('meta:snapshot_seq', seq);
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

    // Auto-snapshot to Matrix media every 1000 events
    await maybeCreateSnapshot(this.client, this.roomId, this.store, this.client.getUserId()!);

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
