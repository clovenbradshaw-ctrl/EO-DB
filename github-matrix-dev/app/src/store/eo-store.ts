import { create } from 'zustand';
import type { EoStore } from '../db/encrypted-store';
import type { EoEvent, EoEventInput, EoState, HorizonResponse } from '../db/types';
import { processEvent } from '../db/fold';
import { horizonGet, type HorizonOpts } from '../db/horizon';
import { getState, getStateByPrefix } from '../db/state';
import { readLogSince } from '../db/log';
import type { SyncManager } from '../matrix/sync-manager';
import type { ResolvedPermissions } from '../permissions/types';

interface EoDbState {
  /** The encrypted store instance (set after login + key derivation) */
  store: EoStore | null;
  /** The sync manager for sending events to Matrix */
  syncManager: SyncManager | null;
  /** Recent events processed through the fold */
  recentEvents: EoEvent[];
  /** Current sequence number */
  lastSeq: number;
  /** Whether the store is initialized and ready */
  ready: boolean;
  /** Resolved permissions for the current user in the current space */
  resolvedPermissions: ResolvedPermissions | null;

  /** Initialize the store with an encrypted store instance */
  init: (store: EoStore) => Promise<void>;

  /** Set the sync manager after it's initialized */
  setSyncManager: (syncManager: SyncManager) => void;

  /** Set resolved permissions for the current space */
  setPermissions: (permissions: ResolvedPermissions | null) => void;

  /** Process an event through the fold and sync to Matrix */
  dispatch: (event: EoEventInput) => Promise<number>;

  /** Read the Horizon for a target */
  horizon: (target: string, opts?: HorizonOpts) => Promise<HorizonResponse | HorizonResponse[] | null>;

  /** Get projected state for a target */
  getState: (target: string) => Promise<EoState | null>;

  /** Get all states under a prefix */
  getStateByPrefix: (prefix: string) => Promise<EoState[]>;

  /** Take a manual delta snapshot and record its URI in a NUL event */
  manualSnapshot: () => Promise<{ mxc: string; seq: number }>;

  /** Tear down the store (logout) */
  teardown: () => void;
}

export const useEoStore = create<EoDbState>((set, get) => ({
  store: null,
  syncManager: null,
  recentEvents: [],
  lastSeq: 0,
  ready: false,
  resolvedPermissions: null,

  async init(store: EoStore) {
    const lastSeq = await store.getCurrentSeq();
    set({ store, lastSeq, ready: true, recentEvents: [] });
  },

  setSyncManager(syncManager: SyncManager) {
    set({ syncManager });
  },

  setPermissions(permissions: ResolvedPermissions | null) {
    set({ resolvedPermissions: permissions });
  },

  async dispatch(event: EoEventInput) {
    const { store, syncManager } = get();
    if (!store) throw new Error('Store not initialized');

    // If sync manager is available, route through it (fold + send to Matrix)
    if (syncManager) {
      const seq = await syncManager.processLocalEvent(event);
      return seq;
    }

    // Fallback: fold locally only (no Matrix sync)
    const seq = await processEvent(store, event, (fullEvent) => {
      set((state) => ({
        recentEvents: [...state.recentEvents.slice(-99), fullEvent],
        lastSeq: fullEvent.seq,
      }));
    });

    return seq;
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

  async manualSnapshot() {
    const { syncManager } = get();
    if (!syncManager) throw new Error('Sync manager not initialized — connect to Matrix first');
    return syncManager.manualSnapshot();
  },

  teardown() {
    const { store } = get();
    if (store) store.close();
    set({ store: null, syncManager: null, ready: false, recentEvents: [], lastSeq: 0, resolvedPermissions: null });
  },
}));
