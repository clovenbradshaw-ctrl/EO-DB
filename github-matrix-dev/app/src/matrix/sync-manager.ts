/**
 * Sync manager — orchestrates snapshot persistence, offline queue, and deduplication.
 *
 * Data is persisted as encrypted binary snapshots in Matrix media.
 * On a fresh device, the latest snapshot is downloaded and applied.
 * Snapshots are auto-saved every 1000 events and on explicit saveSnapshot() calls.
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput } from '../db/types';
import { processEvent } from '../db/fold';
import { EO_EVENT_TYPE, matrixEventToEo, sendEoEvent } from './event-bridge';
import { findLatestSnapshot, applySnapshot, maybeCreateSnapshot, createSnapshot, uploadSnapshot } from './snapshot';

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
