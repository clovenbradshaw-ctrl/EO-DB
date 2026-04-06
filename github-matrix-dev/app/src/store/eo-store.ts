import { create } from 'zustand';
import type { EoStore } from '../db/encrypted-store';
import { createLocalStore } from '../db/encrypted-store';
import { createIdb } from '../db/idb';
import type { EoEvent, EoEventInput, EoState, HorizonResponse } from '../db/types';
import { processEvent, processEventsBulk } from '../db/fold';
import { horizonGet, type HorizonOpts } from '../db/horizon';
import { getState, getStateByPrefix, getStateByPrefixPage, type StatePage } from '../db/state';
import { readLogSince } from '../db/log';
import { backfillFoldCaches } from '../db/fold-cache';
import type { SyncManager } from '../matrix/sync-manager';
import type { FilenSyncService } from '../filen/filen-sync';
import type { ResolvedPermissions } from '../permissions/types';

interface EoDbState {
  /** The encrypted store instance (set after login + key derivation) */
  store: EoStore | null;
  /** The sync manager for sending events to Matrix (currently disabled) */
  syncManager: SyncManager | null;
  /** The Filen sync service for backup/restore */
  filenSync: FilenSyncService | null;
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

  /** Initialize the store with an encrypted store instance */
  init: (store: EoStore) => Promise<void>;

  /** Initialize a local-only (unencrypted) store — no Matrix session needed */
  initLocal: (dbName?: string) => Promise<void>;

  /** Set the sync manager after it's initialized */
  setSyncManager: (syncManager: SyncManager) => void;

  /** Set the Filen sync service */
  setFilenSync: (filenSync: FilenSyncService) => void;

  /** Set resolved permissions for the current space */
  setPermissions: (permissions: ResolvedPermissions | null) => void;

  /** Set the active user type (persisted to localStorage) */
  setActiveUserType: (typeId: string | null) => void;

  /** Process an event through the fold */
  dispatch: (event: EoEventInput) => Promise<number>;

  /** Import a batch of events — fold locally */
  batchImport: (events: EoEventInput[], onProgress?: (current: number, total: number) => void) => Promise<number>;

  /** Read the Horizon for a target */
  horizon: (target: string, opts?: HorizonOpts) => Promise<HorizonResponse | HorizonResponse[] | null>;

  /** Get projected state for a target */
  getState: (target: string) => Promise<EoState | null>;

  /** Get all states under a prefix */
  getStateByPrefix: (prefix: string) => Promise<EoState[]>;

  /**
   * Cursor-paginated variant — returns a page of rows plus a cursor for the
   * next page. Prefer this over `getStateByPrefix` for list views that may
   * grow large.
   */
  getStateByPrefixPage: (prefix: string, limit: number, afterTarget?: string) => Promise<StatePage>;

  /** Take a manual snapshot via Filen */
  manualSnapshot: () => Promise<{ mxc: string; seq: number }>;

  /** Tear down the store (logout) */
  teardown: () => void;
}

export const useEoStore = create<EoDbState>((set, get) => ({
  store: null,
  syncManager: null,
  filenSync: null,
  recentEvents: [],
  lastSeq: 0,
  ready: false,
  resolvedPermissions: null,
  activeUserType: null,

  async init(store: EoStore) {
    // Set the store immediately so the UI can start reading from it.
    // Keep ready=true if we already were ready (e.g. cached store re-init)
    // to avoid a loading flash — the data is local, so it's always accessible.
    const wasReady = get().ready;
    if (wasReady) {
      set({ store });
    } else {
      set({ store, ready: false, recentEvents: [], lastSeq: 0 });
    }

    const lastSeq = await store.getCurrentSeq();

    // Hydrate recentEvents from the persistent log so Log/Graph views
    // display existing data immediately (not just newly-arrived events).
    let hydrated: EoEvent[] = [];
    try {
      const all = await readLogSince(store, 0);
      hydrated = all.slice(-100);
    } catch {
      // Log read may fail on a brand-new store — that's fine
    }

    // One-time backfill of the incremental fold cache for stores created
    // before it existed. No-op on brand-new stores and on already-backfilled ones.
    try {
      await backfillFoldCaches(store);
    } catch (e) {
      console.warn('[EO-DB] fold cache backfill failed:', e);
    }

    set({ store, lastSeq, ready: true, recentEvents: hydrated });
  },

  async initLocal(dbName = 'local') {
    set({ ready: false, recentEvents: [], lastSeq: 0 });
    const idb = await createIdb(dbName);
    const store = createLocalStore(idb);
    const lastSeq = await store.getCurrentSeq();

    let hydrated: EoEvent[] = [];
    try {
      const all = await readLogSince(store, 0);
      hydrated = all.slice(-100);
    } catch {
      // Brand-new store — nothing to hydrate
    }

    try {
      await backfillFoldCaches(store);
    } catch (e) {
      console.warn('[EO-DB] fold cache backfill failed:', e);
    }

    set({ store, lastSeq, ready: true, recentEvents: hydrated });
  },

  setSyncManager(syncManager: SyncManager) {
    set({ syncManager });
  },

  setFilenSync(filenSync: FilenSyncService) {
    set({ filenSync });
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

    // If Matrix sync is active, route through SyncManager (folds locally + sends to room)
    if (syncManager) {
      const seq = await syncManager.processLocalEvent(event);
      return seq;
    }

    // Otherwise fold locally only — Filen sync picks up new events on its 30s timer
    const seq = await processEvent(store, event, (fullEvent) => {
      set((state) => ({
        recentEvents: [...state.recentEvents.slice(-99), fullEvent],
        lastSeq: fullEvent.seq,
      }));
    });

    return seq;
  },

  async batchImport(events: EoEventInput[], onProgress?: (current: number, total: number) => void) {
    const { store } = get();
    if (!store) throw new Error('Store not initialized');

    let lastSeq = 0;
    lastSeq = await processEventsBulk(store, events, onProgress, (fullEvent) => {
      set((state) => ({
        recentEvents: [...state.recentEvents.slice(-99), fullEvent],
        lastSeq: fullEvent.seq,
      }));
    });

    // Upload to Filen immediately after import (don't wait for 30s timer)
    const { filenSync } = get();
    if (filenSync) {
      filenSync.forceSave().catch((e) =>
        console.warn('[EO-DB] Filen upload after import failed:', e),
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
    const { store, filenSync } = get();
    if (!store) throw new Error('Store not initialized');
    if (filenSync) {
      const result = await filenSync.createManualSnapshot();
      return { mxc: 'filen', seq: result.seq };
    }
    const seq = await store.getCurrentSeq();
    return { mxc: 'local', seq };
  },

  teardown() {
    const { store } = get();
    if (store) store.close();
    set({ store: null, syncManager: null, filenSync: null, ready: false, recentEvents: [], lastSeq: 0, resolvedPermissions: null, activeUserType: null });
  },
}));
