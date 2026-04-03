/**
 * Sync manager — Filen-first architecture.
 *
 * Events are folded locally (instant UI), then batched to Filen every 30
 * seconds. A single lightweight Matrix room message notifies other devices
 * to fetch the update from Filen. No individual events are sent to Matrix.
 *
 * Flow:
 *   User action → fold locally → queue for batch
 *   Every 30s   → upload current.eodb to Filen → post ONE room notification
 *   Other device → sees notification → downloads from Filen → folds
 *
 * This eliminates the 429 rate-limit spam that happened when sending each
 * event as an individual Matrix message.
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput } from '../db/types';
import type { LocalKeyring } from '../db/crypto-types';
import { processEvent } from '../db/fold';
import { eventHash } from '../db/hash';
import { AsyncMutex } from '../db/mutex';
import {
  EO_FILEN_SYNC_TYPE,
  sendFilenSyncNotification,
  getDataRoom,
} from './event-bridge';
import { FilenSyncService, unpackEodb } from '../filen/filen-sync';
import { useFilenStore } from '../filen/filen-store';
import { filenDownloadFile, filenListFolder } from '../filen/filen-api';

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

  /** Whether this manager has been destroyed. */
  private destroyed = false;

  /** Filen sync service — handles batched uploads. */
  private filenSync: FilenSyncService | null = null;

  /** Space info for Filen sync notifications. */
  private spaceId = '';
  private spaceFolderUuid = '';

  /** Debounce timer for Filen fetch after receiving room notification. */
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;

  /** UI sync status callback (drives the sync toast). */
  onSyncStatus?: (status: 'confirmed' | 'queued' | 'rate-limited') => void;

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
   * Attach the Filen sync service for batched uploads.
   * Must be called after login and space selection.
   */
  setFilenSync(filenSync: FilenSyncService, spaceId: string, spaceFolderUuid: string): void {
    this.filenSync = filenSync;
    this.spaceId = spaceId;
    this.spaceFolderUuid = spaceFolderUuid;
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
    if (this.fetchTimer) {
      clearTimeout(this.fetchTimer);
      this.fetchTimer = null;
    }
    if (this.filenSync) {
      this.filenSync.stop();
      this.filenSync = null;
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
    console.warn('[EO-DB] Room', this.roomId, 'not available after polling — continuing with live listener only');
    return null;
  }

  /**
   * Initialize sync — call after login and store setup.
   *
   * On a fresh device (seq === 0), hydrates from Filen (preferred) or
   * falls back to Matrix snapshots.
   */
  async initialize(): Promise<void> {
    // Wait for the room to be available in the SDK store before hydrating
    await this.waitForRoom();

    const currentSeq = await this.store.getCurrentSeq();

    // On a fresh device, restore from Filen first (preferred), then Matrix fallback
    if (currentSeq === 0) {
      await this.hydrateFromFilen();
    }

    // Listen for Filen sync notifications from other devices.
    // When another device uploads to Filen, it posts a single notification.
    // We detect that and download the update.
    this.handleTimelineEvent = (event: MatrixEvent) => {
      if (this.destroyed) return;
      const eventRoomId = event.getRoomId();
      if (!eventRoomId) return;
      if (eventRoomId !== this.roomId && !this.additionalRoomIds.includes(eventRoomId)) return;

      if (event.getType() === EO_FILEN_SYNC_TYPE) {
        // Another device uploaded to Filen — debounce-fetch the update
        const sender = event.getSender();
        if (sender === this.client.getUserId()) return; // ignore our own notifications
        this.debouncedFetchFromFilen();
      }
    };
    this.client.on('Room.timeline' as any, this.handleTimelineEvent);

    // Start Filen sync service (30-second batch timer)
    if (this.filenSync) {
      this.filenSync.start();
    }
  }

  /**
   * Debounced Filen fetch — collapses multiple notifications into one download.
   * If several devices post notifications close together, we only download once.
   */
  private debouncedFetchFromFilen(): void {
    if (this.destroyed) return;
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.fetchTimer = setTimeout(() => {
      this.fetchTimer = null;
      this.fetchFromFilen().catch(err => {
        console.warn('[EO-DB] Failed to fetch from Filen after notification:', err);
      });
    }, 3_000); // 3s debounce — gives the upload time to fully complete
  }

  /**
   * Download and apply the latest current.eodb from Filen.
   * Called when we receive a sync notification from another device.
   */
  private async fetchFromFilen(): Promise<void> {
    const { auth, masterKeys } = useFilenStore.getState();
    if (!auth || !this.spaceFolderUuid) return;

    try {
      const items = await filenListFolder(auth.apiKey, this.spaceFolderUuid, masterKeys);
      const currentFile = items.find(i => i.type === 'file' && i.name === 'current.eodb');
      if (!currentFile?.key) return;

      const data = await filenDownloadFile(
        auth.apiKey, currentFile.uuid, currentFile.key,
        currentFile.region, currentFile.bucket,
      );
      const eodb = unpackEodb(data);
      const localSeq = await this.store.getCurrentSeq();

      let applied = 0;
      for (const event of eodb.events) {
        if (event.seq <= localSeq) continue;
        await processEvent(this.store, event, this.onEvent);
        applied++;
      }

      if (applied > 0) {
        console.log(`[EO-DB] Applied ${applied} events from Filen (remote sync)`);
      }
    } catch (e) {
      console.warn('[EO-DB] Filen fetch failed:', e);
    }
  }

  /**
   * Hydrate the local store from Filen snapshots.
   * Falls back gracefully if Filen is not connected or has no data.
   */
  private async hydrateFromFilen(): Promise<void> {
    const { connected } = useFilenStore.getState();
    if (!connected || !this.spaceFolderUuid) {
      console.log('[EO-DB] Filen not connected, skipping Filen hydration');
      return;
    }

    try {
      const restoredSeq = await FilenSyncService.hydrateFromFilen(
        this.store, this.spaceFolderUuid, this.onEvent,
      );
      if (restoredSeq > 0) {
        console.log(`[EO-DB] Hydrated from Filen up to seq ${restoredSeq}`);
        await this.store.put('meta:filen_synced_seq', restoredSeq);
      }
    } catch (e) {
      console.warn('[EO-DB] Filen hydration failed, will start fresh:', e);
    }
  }

  /**
   * Process a locally created event.
   *
   * 1. Generate content-addressable client_event_id via hash
   * 2. Fold immediately (instant UI update)
   * 3. That's it — Filen sync service picks it up on the next 30s cycle
   *
   * NO individual Matrix message is sent. The Filen sync service handles
   * batching and posting one notification to the room.
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

    // Fold immediately — instant UI update, no network round-trip
    const seq = await processEvent(this.store, localEvent, this.onEvent);

    // Filen sync service will batch this up and upload on its 30s cycle.
    // No Matrix message sent here — that's the whole point of the redesign.

    return seq;
  }

  /**
   * Process a batch import (e.g., CSV file with 93 rows).
   *
   * Folds all events locally, then triggers an immediate Filen sync
   * instead of sending 93 individual Matrix messages (which caused 429s).
   */
  async processBatchImport(
    events: EoEventInput[],
    onProgress?: (current: number, total: number) => void,
  ): Promise<number> {
    const agent = this.client.getUserId()!;
    let lastSeq = 0;

    for (let i = 0; i < events.length; i++) {
      const ts = events[i].ts || new Date().toISOString();
      const clientEventId = events[i].client_event_id || await eventHash({
        op: events[i].op,
        target: events[i].target,
        operand: events[i].operand,
        agent: events[i].agent || agent,
        ts,
      });

      const localEvent: EoEventInput = {
        ...events[i],
        client_event_id: clientEventId,
        agent: events[i].agent || agent,
        ts,
      };

      lastSeq = await processEvent(this.store, localEvent, this.onEvent);
      onProgress?.(i + 1, events.length);
    }

    // Trigger immediate Filen sync for the whole batch
    if (this.filenSync) {
      try {
        await this.filenSync.forceSave();
        // Post ONE notification to the room
        await this.postFilenNotification(lastSeq, events.length);
      } catch (e) {
        console.warn('[EO-DB] Immediate batch sync to Filen failed — will retry on next cycle:', e);
      }
    }

    return lastSeq;
  }

  /**
   * Post a single Filen sync notification to the Matrix room.
   * This tells other devices "new data is available on Filen, go fetch it."
   */
  async postFilenNotification(seq: number, eventCount: number): Promise<void> {
    try {
      await sendFilenSyncNotification(this.client, this.roomId, {
        seq,
        event_count: eventCount,
        space_id: this.spaceId,
        ts: new Date().toISOString(),
      });
    } catch (e) {
      // Non-critical — other devices will eventually poll or see the next notification
      console.warn('[EO-DB] Failed to post Filen sync notification:', e);
    }
  }

  /**
   * Force-save to Filen right now (called on beforeunload / logout).
   */
  async saveSnapshot(): Promise<void> {
    if (this.filenSync) {
      try {
        await this.filenSync.forceSave();
        const seq = await this.store.getCurrentSeq();
        if (seq > 0) {
          await this.postFilenNotification(seq, 0);
        }
      } catch (e) {
        console.warn('[EO-DB] Save to Filen on unload failed:', e);
      }
    }
  }

  /**
   * Manual snapshot — triggers a full Filen snapshot immediately.
   */
  async manualSnapshot(): Promise<{ seq: number }> {
    const currentSeq = await this.store.getCurrentSeq();
    if (this.filenSync) {
      await this.filenSync.forceSave();
      await this.postFilenNotification(currentSeq, 0);
    }
    return { seq: currentSeq };
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
}
