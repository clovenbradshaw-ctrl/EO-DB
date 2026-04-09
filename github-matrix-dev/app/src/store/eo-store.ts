import { create } from 'zustand';
import type { EoStore } from '../db/encrypted-store';
import { createMemoryStore } from '../db/memory-store';
import { replayFromLog, processEvent, processEventsBulk } from '../db/fold';
import { horizonGet, type HorizonOpts } from '../db/horizon';
import { getState, getStateByPrefix, getStateByPrefixPage, type StatePage } from '../db/state';
import { readLogSince } from '../db/log';
import {
  createFoldWorkerClient,
  initFoldWorker,
  appendRaw,
  scanLog,
  type FoldWorkerClient,
} from '../db/lazy-fold';
import type { EoEvent, EoEventInput, EoState, HorizonResponse } from '../db/types';
import type { SyncManager } from '../matrix/sync-manager';
import type { GDriveSyncService } from '../google-drive/gdrive-sync';
import type { ResolvedPermissions } from '../permissions/types';
import { eventHash } from '../db/hash';

interface EoDbState {
  /** The in-memory store (set after space init) */
  store: EoStore | null;
  /** The fold worker client for OPFS persistence */
  workerClient: FoldWorkerClient | null;
  /** The sync manager for sending events to Matrix */
  syncManager: SyncManager | null;
  /** The Google Drive sync service for backup */
  gdriveSync: GDriveSyncService | null;
  /** Recent events processed through the fold */
  recentEvents: EoEvent[];
  /** Current sequence number */
  lastSeq: number;
  /** Whether the store is initialized and ready */
  ready: boolean;
  /** Resolved permissions for the current user in the current space */
  resolvedPermissions: ResolvedPermissions | null;
  /** Currently active user type (selected via header switcher) */
  activeUserType: string | null;

  /**
   * Initialize the store from a fold worker client.
   * Creates a fresh MemoryStore, replays the OPFS log into it, then
   * enables OPFS persistence for future writes.
   */
  init: (workerClient: FoldWorkerClient) => Promise<void>;

  /**
   * Initialize a local-only store backed by a fold worker for the
   * given space name (default "local"). No Matrix session needed.
   */
  initLocal: (dbName?: string) => Promise<void>;

  setSyncManager: (syncManager: SyncManager) => void;
  setGDriveSync: (gdriveSync: GDriveSyncService) => void;
  setPermissions: (permissions: ResolvedPermissions | null) => void;
  setActiveUserType: (typeId: string | null) => void;

  dispatch: (event: EoEventInput) => Promise<number>;
  batchImport: (events: EoEventInput[], onProgress?: (current: number, total: number) => void) => Promise<number>;
  horizon: (target: string, opts?: HorizonOpts) => Promise<HorizonResponse | HorizonResponse[] | null>;
  getState: (target: string) => Promise<EoState | null>;
  getStateByPrefix: (prefix: string) => Promise<EoState[]>;
  getStateByPrefixPage: (prefix: string, limit: number, afterTarget?: string) => Promise<StatePage>;
  manualSnapshot: () => Promise<{ mxc: string; seq: number }>;
  teardown: () => void;

  onDispatch: ((event: EoEventInput) => void) | null;
  setOnDispatch: (fn: ((event: EoEventInput) => void) | null) => void;
}

export const useEoStore = create<EoDbState>((set, get) => ({
  store: null,
  workerClient: null,
  syncManager: null,
  gdriveSync: null,
  recentEvents: [],
  lastSeq: 0,
  ready: false,
  resolvedPermissions: null,
  activeUserType: null,
  onDispatch: null,

  async init(workerClient: FoldWorkerClient) {
    const wasReady = get().ready;
    const prevClient = get().workerClient;
    const isSameWorker = prevClient === workerClient;

    if (wasReady && isSameWorker) {
      // Re-init of same worker — nothing to replay.
      set({ workerClient });
      return;
    }

    // Different worker (space switch) — build a fresh memory store.
    if (wasReady) {
      set({ store: null, workerClient, recentEvents: [], lastSeq: 0, ready: false });
    } else {
      set({ store: null, workerClient, ready: false, recentEvents: [], lastSeq: 0 });
    }

    // Create a fresh in-memory store (no persistence hook yet).
    const memStore = createMemoryStore();

    // Replay the entire OPFS log into the memory store.
    try {
      const events = await scanLog(workerClient, 0);
      if (events.length > 0) {
        await replayFromLog(memStore, events);
      }
    } catch (e) {
      console.warn('[EO-DB] OPFS log replay failed:', e);
    }

    // From here on, every log: write also persists to OPFS.
    memStore.enablePersistence((event) => {
      appendRaw(workerClient, event).catch((e) =>
        console.warn('[EO-DB] appendRaw failed:', e),
      );
    });

    const lastSeq = await memStore.getCurrentSeq();

    // Hydrate recentEvents from the in-memory log.
    let hydrated: EoEvent[] = [];
    try {
      const all = await readLogSince(memStore, 0);
      hydrated = all.slice(-100);
    } catch {
      // Brand-new store — nothing to hydrate.
    }

    set({ store: memStore, workerClient, lastSeq, ready: true, recentEvents: hydrated });
  },

  async initLocal(dbName = 'local') {
    const workerClient = createFoldWorkerClient();
    await initFoldWorker(workerClient, dbName);
    await get().init(workerClient);
  },

  setOnDispatch(fn: ((event: EoEventInput) => void) | null) {
    set({ onDispatch: fn });
  },

  setSyncManager(syncManager: SyncManager) {
    set({ syncManager });
  },

  setGDriveSync(gdriveSync: GDriveSyncService) {
    set({ gdriveSync });
  },

  setPermissions(permissions: ResolvedPermissions | null) {
    set({ resolvedPermissions: permissions });
  },

  setActiveUserType(typeId: string | null) {
    set({ activeUserType: typeId });
    try {
      if (typeId) {
        localStorage.setItem('eo-active-user-type', typeId);
      } else {
        localStorage.removeItem('eo-active-user-type');
      }
    } catch { /* quota exceeded — silently drop */ }
  },

  async dispatch(event: EoEventInput) {
    const { store, syncManager } = get();
    if (!store) throw new Error('Store not initialized');

    // If Matrix sync is active, route through SyncManager.
    if (syncManager) {
      const seq = await syncManager.processLocalEvent(event);
      return seq;
    }

    // Pre-populate client_event_id for server deduplication.
    const now = new Date().toISOString();
    let populatedEvent: EoEventInput = event;
    if (!populatedEvent.client_event_id) {
      const id = await eventHash({
        op: populatedEvent.op,
        target: populatedEvent.target,
        operand: populatedEvent.operand,
        agent: populatedEvent.agent || '@local:localhost',
        ts: populatedEvent.ts || now,
      });
      populatedEvent = { ...populatedEvent, client_event_id: id };
    }

    // Fold into the MemoryStore (persistence hook writes each log: entry to OPFS).
    const seq = await processEvent(store, populatedEvent, (fullEvent) => {
      set((state) => ({
        recentEvents: [...state.recentEvents.slice(-99), fullEvent],
        lastSeq: fullEvent.seq,
      }));
    });

    get().onDispatch?.(populatedEvent);
    return seq;
  },

  async batchImport(events: EoEventInput[], onProgress?: (current: number, total: number) => void) {
    const { store } = get();
    if (!store) throw new Error('Store not initialized');

    const lastSeq = await processEventsBulk(store, events, onProgress, (fullEvent) => {
      set((state) => ({
        recentEvents: [...state.recentEvents.slice(-99), fullEvent],
        lastSeq: fullEvent.seq,
      }));
    });

    const { gdriveSync } = get();
    if (gdriveSync) {
      gdriveSync.forceSave().catch((e) =>
        console.warn('[EO-DB] Google Drive upload after import failed:', e),
      );
    }

    return lastSeq;
  },

  async horizon(target: string, opts?: HorizonOpts) {
    const { store } = get();
    if (!store) throw new Error('Store not initialized');
    return horizonGet(store, target, opts);
  },

  async getState(target: string) {
    const { store } = get();
    if (!store) throw new Error('Store not initialized');
    return getState(store, target);
  },

  async getStateByPrefix(prefix: string) {
    const { store } = get();
    if (!store) throw new Error('Store not initialized');
    return getStateByPrefix(store, prefix);
  },

  async getStateByPrefixPage(prefix: string, limit: number, afterTarget?: string) {
    const { store } = get();
    if (!store) throw new Error('Store not initialized');
    return getStateByPrefixPage(store, prefix, limit, afterTarget);
  },

  async manualSnapshot() {
    const { store, gdriveSync } = get();
    if (!store) throw new Error('Store not initialized');
    if (gdriveSync) {
      await gdriveSync.forceSave();
    }
    const seq = await store.getCurrentSeq();
    return { mxc: 'gdrive', seq };
  },

  teardown() {
    const { store, workerClient } = get();
    if (store) store.close();
    if (workerClient) workerClient.worker.terminate();
    set({
      store: null,
      workerClient: null,
      syncManager: null,
      gdriveSync: null,
      ready: false,
      recentEvents: [],
      lastSeq: 0,
      resolvedPermissions: null,
      activeUserType: null,
      onDispatch: null,
    });
  },
}));
