import { create } from 'zustand';
import type { EoStore } from '../db/encrypted-store';
import type { EoEvent, EoEventInput, EoState, HorizonResponse } from '../db/types';
import { processEvent } from '../db/fold';
import { horizonGet, type HorizonOpts } from '../db/horizon';
import { getState, getStateByPrefix } from '../db/state';
import { readLogSince } from '../db/log';

interface EoDbState {
  /** The encrypted store instance (set after login + key derivation) */
  store: EoStore | null;
  /** Recent events processed through the fold */
  recentEvents: EoEvent[];
  /** Current sequence number */
  lastSeq: number;
  /** Whether the store is initialized and ready */
  ready: boolean;

  /** Initialize the store with an encrypted store instance */
  init: (store: EoStore) => Promise<void>;

  /** Process an event through the fold */
  dispatch: (event: EoEventInput) => Promise<number>;

  /** Read the Horizon for a target */
  horizon: (target: string, opts?: HorizonOpts) => Promise<HorizonResponse | HorizonResponse[] | null>;

  /** Get projected state for a target */
  getState: (target: string) => Promise<EoState | null>;

  /** Get all states under a prefix */
  getStateByPrefix: (prefix: string) => Promise<EoState[]>;

  /** Tear down the store (logout) */
  teardown: () => void;
}

export const useEoStore = create<EoDbState>((set, get) => ({
  store: null,
  recentEvents: [],
  lastSeq: 0,
  ready: false,

  async init(store: EoStore) {
    const lastSeq = await store.getCurrentSeq();
    set({ store, lastSeq, ready: true, recentEvents: [] });
  },

  async dispatch(event: EoEventInput) {
    const { store } = get();
    if (!store) throw new Error('Store not initialized');

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

  teardown() {
    const { store } = get();
    if (store) store.close();
    set({ store: null, ready: false, recentEvents: [], lastSeq: 0 });
  },
}));
