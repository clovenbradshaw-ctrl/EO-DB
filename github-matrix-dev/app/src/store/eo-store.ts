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
  saveKvSnapshot,
  loadKvSnapshot,
  type FoldWorkerClient,
} from '../db/lazy-fold';
import type { EoEvent, EoEventInput, EoState, HorizonResponse } from '../db/types';
import type { SyncManager } from '../matrix/sync-manager';
import type { GDriveSyncService } from '../google-drive/gdrive-sync';
import type { ResolvedPermissions } from '../permissions/types';
import type { ManifestState as UserManifest } from '../google-drive/space-permissions';
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
  /** Drive-backed permission manifest for the current user (null if not loaded) */
  userManifest: UserManifest | null;
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
  setUserManifest: (manifest: UserManifest | null) => void;
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
  userManifest: null,
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

    // ── Try restoring from OPFS kv snapshot for fast page-load ───────────────
    // On the first load there's no snapshot yet; fall back to full log replay.
    let snapshotSeq = 0;
    let memStore: ReturnType<typeof createMemoryStore>;
    try {
      const snapshot = await loadKvSnapshot(workerClient);
      if (snapshot) {
        memStore = createMemoryStore({ initialKv: snapshot.entries, initialSeq: snapshot.seq });
        snapshotSeq = snapshot.seq;
      } else {
        memStore = createMemoryStore();
      }
    } catch {
      memStore = createMemoryStore();
    }

    // Replay only events that arrived after the snapshot was written.
    try {
      const events = await scanLog(workerClient, snapshotSeq);
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

    // Hydrate recentEvents — cap at the last 2 000 events to avoid loading
    // a large array into Zustand state on init.  LogView loads older pages on demand.
    const RECENT_EVENT_LIMIT = 2_000;
    let hydrated: EoEvent[] = [];
    try {
      const fromSeq = Math.max(0, lastSeq - RECENT_EVENT_LIMIT);
      hydrated = await readLogSince(memStore, fromSeq);
    } catch {
      // Brand-new store — nothing to hydrate.
    }

    set({ store: memStore, workerClient, lastSeq, ready: true, recentEvents: hydrated });

    // ── Persist an updated snapshot for the next page refresh ────────────────
    // Fire-and-forget: snapshot save happens after ready=true so the UI
    // is unblocked immediately. Failures are non-fatal (full replay as fallback).
    saveKvSnapshot(workerClient, memStore.getKvEntries(), lastSeq).catch((e) =>
      console.warn('[EO-DB] kv snapshot save failed:', e),
    );
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

  setUserManifest(manifest: UserManifest | null) {
    set({ userManifest: manifest });
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

    // If a SyncManager (not PeerSync) is active, route through it so it can
    // broadcast to the Matrix room timeline. PeerSync handles sync via
    // to-device messages on its own schedule — dispatch locally for PeerSync.
    if (syncManager && 'processLocalEvent' in syncManager) {
      const seq = await (syncManager as any).processLocalEvent(event);
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
        recentEvents: [...state.recentEvents, fullEvent],
        lastSeq: fullEvent.seq,
      }));
      // Broadcast to peers first (encrypted, via Matrix to-device)
      const sm = get().syncManager;
      if (sm && 'broadcastLocalEvent' in sm) {
        (sm as any).broadcastLocalEvent(fullEvent).catch((e: unknown) =>
          console.warn('[EO-DB] broadcastLocalEvent failed:', e)
        );
      }
      // Then persist to Google Drive
      get().gdriveSync?.saveOp(fullEvent).catch(e => console.warn('[EO-DB] saveOp failed:', e));
    });

    get().onDispatch?.(populatedEvent);
    return seq;
  },

  async batchImport(events: EoEventInput[], onProgress?: (current: number, total: number) => void) {
    const { store } = get();
    if (!store) throw new Error('Store not initialized');

    // Batch Zustand updates to avoid flooding React with one set() per event.
    // With 3000+ imports, per-event set() triggers 3000+ re-render cycles on every
    // lastSeq subscriber (TableView, HolonNav, Layout), freezing the browser and
    // preventing the nav from settling to the correct final state.
    const BATCH_SIZE = 50;
    const imported: EoEvent[] = [];
    let pendingBatch: EoEvent[] = [];

    const flushBatch = () => {
      if (pendingBatch.length === 0) return;
      const toFlush = pendingBatch;
      pendingBatch = [];
      set((state) => ({
        recentEvents: [...state.recentEvents, ...toFlush].slice(-100),
        lastSeq: toFlush[toFlush.length - 1].seq,
      }));
    };

    const lastSeq = await processEventsBulk(store, events, onProgress, (fullEvent) => {
      imported.push(fullEvent);
      pendingBatch.push(fullEvent);
      if (pendingBatch.length >= BATCH_SIZE) flushBatch();
    });

    // Drain any remaining events and do one final set() so HolonNav gets a clean
    // lastSeq update after all events are committed — fixing nav auto-update.
    flushBatch();
    set((state) => ({ lastSeq: Math.max(state.lastSeq, lastSeq) }));

    const { gdriveSync } = get();
    if (gdriveSync && imported.length > 0) {
      // Write the full log immediately so the log file is up-to-date on Drive
      // (not just the recent buffer). This ensures a reload from a cleared OPFS
      // always finds the imported data in the log file.
      gdriveSync.fullPushToGDrive().catch((e) =>
        console.warn('[EO-DB] Google Drive full push after import failed:', e),
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
      userManifest: null,
      activeUserType: null,
      onDispatch: null,
    });
  },
}));
