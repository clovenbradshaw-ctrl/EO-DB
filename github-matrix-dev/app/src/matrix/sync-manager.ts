/**
 * Sync manager — orchestrates chunked snapshot persistence, offline queue,
 * multi-user sync, and deduplication.
 *
 * Local writes go to IndexedDB (encrypted) immediately, then append a NUL
 * snapshot chunk to the Matrix media store. Other users on the same server
 * pull chunks to sync and heal gaps.
 *
 * Data flow:
 *   local write → IndexedDB (instant) → media store chunk (append)
 *   remote sync → pull chunks from all users → apply deltas to IndexedDB
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput } from '../db/types';
import { processEvent } from '../db/fold';
import { EO_EVENT_TYPE, matrixEventToEo, sendEoEvent } from './event-bridge';
import { appendChunk, hydrateFromChunks } from './snapshot';

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
   * On a fresh device (or any device with gaps), hydrates by pulling all
   * chunks from all users in the room and applying them in seq order.
   */
  async initialize(): Promise<void> {
    // Hydrate from all available chunks (from all users)
    await hydrateFromChunks(this.client, this.store, this.roomId);

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
   * Force-save a snapshot chunk to Matrix media right now.
   * Called on beforeunload / logout so unsaved changes are persisted.
   */
  async saveSnapshot(): Promise<void> {
    const seq = await this.store.getCurrentSeq();
    if (seq === 0) return;
    await appendChunk(this.client, this.roomId, this.store, this.client.getUserId()!);
  }

  /**
   * Pull chunks from other users to heal any gaps.
   * Call periodically or when a new user comes online.
   */
  async heal(): Promise<number> {
    return hydrateFromChunks(this.client, this.store, this.roomId);
  }

  /**
   * Process a locally created event.
   * 1. Generate client_event_id
   * 2. Fold immediately (instant UI update in IndexedDB)
   * 3. Append chunk to media store (persist for sync)
   * 4. Send to Matrix room async (real-time broadcast)
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

    // Fold immediately into local IndexedDB
    const seq = await processEvent(this.store, localEvent, this.onEvent);

    // Append chunk to media store for other users to sync
    try {
      await appendChunk(this.client, this.roomId, this.store, this.client.getUserId()!);
    } catch {
      // Offline — chunk will be appended on next successful write or saveSnapshot
    }

    // Send to room for real-time broadcast (best-effort)
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

    // If we flushed events, append a chunk to persist what was queued
    if (remaining.length < queue.length) {
      try {
        await appendChunk(this.client, this.roomId, this.store, this.client.getUserId()!);
      } catch {
        // will be caught on next sync cycle
      }
    }
  }
}
