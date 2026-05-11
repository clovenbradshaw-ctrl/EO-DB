import { create } from 'zustand';
import type { EoStore } from '../db/encrypted-store';
import { createMemoryStore, type MemoryStore } from '../db/memory-store';
import {
  replayFromLog,
  processEvent,
  processEventsBulk,
  processEventsBulkWithDispatcher,
} from '../db/fold';
import { createWorkerShardPool, type WorkerShardPool } from '../db/fold-worker-transport';
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
  saveInitCache,
  type FoldWorkerClient,
} from '../db/lazy-fold';
import type { EoEvent, EoEventInput, EoState, HorizonResponse } from '../db/types';
import type { SyncManager } from '../matrix/sync-manager';
import type { EodbBlobWriter } from '../storage/eodb-blob-writer';
import type { ResolvedPermissions } from '../permissions/types';
import type { ManifestState as UserManifest } from '../permissions/space-manifest';
import { eventHash } from '../db/hash';
import { pressureMonitor } from '../perf/pressure-monitor';

// ─── Shard worker pool (Phase G/H wiring) ──────────────────────────────────
//
// A single WorkerShardPool is lazily spawned on the first large bulk import
// and re-used for the lifetime of the module. The pool is store-agnostic —
// every ShardRequest carries its own snapshot over the wire, so the same
// workers can service back-to-back imports across space switches without
// ever being terminated. `teardown()` tears the pool down alongside the
// fold worker client for a clean shutdown.
//
// `MIN_EVENTS_FOR_WORKER` is the threshold below which the legacy
// `processEventsBulk` path (single-threaded, in-process) stays faster than
// spinning up / marshalling across the worker boundary. 500 events lands
// roughly at the break-even on a 4-core laptop — below that the snapshot
// serialization + structured-clone overhead dominates the actual fold work.
// Above it, the worker path wins as soon as `navigator.hardwareConcurrency`
// is ≥ 2.
const MIN_EVENTS_FOR_WORKER = 500;
const MAX_SHARDS = 8;

let cachedWorkerPool: WorkerShardPool | null = null;
let cachedPoolShardCount = 0;

/** Return the preferred shard/worker count for the host, or 0 if the
 *  worker path is unavailable (no `Worker` global, hardware says one core,
 *  or running under a test runtime without `navigator`). */
function preferredShardCount(): number {
  if (typeof Worker === 'undefined') return 0;
  const nav: Navigator | undefined =
    typeof navigator !== 'undefined' ? navigator : undefined;
  const hc = nav?.hardwareConcurrency;
  if (typeof hc !== 'number' || hc < 2) return 0;
  return Math.min(hc, MAX_SHARDS);
}

/** Lazy-spawn (and cache) the worker pool at `shardCount` workers. Returns
 *  null if the environment doesn't support workers. */
function getOrCreateWorkerPool(shardCount: number): WorkerShardPool | null {
  if (shardCount < 1) return null;
  if (cachedWorkerPool && cachedPoolShardCount === shardCount) {
    return cachedWorkerPool;
  }
  // If the cached pool exists at a different size, tear it down before
  // spawning a replacement. In practice `preferredShardCount()` is stable
  // across a session, so this branch is mostly defensive.
  if (cachedWorkerPool) {
    cachedWorkerPool.terminate();
    cachedWorkerPool = null;
    cachedPoolShardCount = 0;
  }
  try {
    // Vite's Worker plugin rewrites `new Worker(new URL(..., import.meta.url))`
    // into a bundle-aware URL at build time; under Vitest / Node, this will
    // throw synchronously and we fall through to the catch → serial path.
    const workerFactory = (): Worker =>
      new Worker(new URL('../workers/fold-shard.worker.ts', import.meta.url), {
        type: 'module',
      });
    const pool = createWorkerShardPool({ workerCount: shardCount, workerFactory });
    cachedWorkerPool = pool;
    cachedPoolShardCount = shardCount;
    return pool;
  } catch (e) {
    console.warn('[EO-DB] Failed to spawn shard worker pool, falling back to in-process bulk:', e);
    return null;
  }
}

/** Terminate and drop the cached worker pool. Called from `teardown`. */
function terminateCachedWorkerPool(): void {
  if (cachedWorkerPool) {
    cachedWorkerPool.terminate();
    cachedWorkerPool = null;
    cachedPoolShardCount = 0;
  }
}

// ─── Fold-quiescent gate ──────────────────────────────────────────────
//
// A snapshot written mid-fold claims a `seq` it hasn't earned: the
// kv map captured in `entries` lags behind the events still in flight,
// and on next boot the OPFS log replay re-applies events that the fold
// engine already half-applied. The fold dedup makes this idempotent for
// correctness, but the audit trail is broken and the snapshot misreports
// its own coverage. (V10 of HELIX-AUDIT-2026-05-11.md.)
//
// `batchImport` increments `foldsInFlight` on entry and decrements in
// `finally`. `flushToOpfs` awaits quiescence before writing — the wait
// loops because a new fold can start in the gap between resolver firing
// and the loop check (textbook condition-variable pattern), but in
// practice flushes fire from visibility-change / post-hydrate so the
// race is unusual.
let foldsInFlight = 0;
const foldQuiescentWaiters: Array<() => void> = [];

function enterFold(): void {
  foldsInFlight++;
}

function exitFold(): void {
  foldsInFlight = Math.max(0, foldsInFlight - 1);
  if (foldsInFlight === 0 && foldQuiescentWaiters.length > 0) {
    const drained = foldQuiescentWaiters.splice(0);
    for (const w of drained) {
      try { w(); } catch { /* never let one waiter break the next */ }
    }
  }
}

async function awaitFoldQuiescent(): Promise<void> {
  while (foldsInFlight > 0) {
    await new Promise<void>((resolve) => foldQuiescentWaiters.push(resolve));
  }
}

interface EoDbState {
  /** The in-memory store (set after space init) */
  store: EoStore | null;
  /** The fold worker client for OPFS persistence */
  workerClient: FoldWorkerClient | null;
  /** The sync manager for sending events to Matrix */
  syncManager: SyncManager | null;
  /** Proactive encrypted-blob writer for the n8n eo-blob webhook */
  eodbBlobWriter: EodbBlobWriter | null;
  /** Recent events processed through the fold */
  recentEvents: EoEvent[];
  /** Current sequence number */
  lastSeq: number;
  /** Whether the store is initialized and ready */
  ready: boolean;
  /** Resolved permissions for the current user in the current space */
  resolvedPermissions: ResolvedPermissions | null;
  /** Permission manifest for the current user (null if not loaded) */
  userManifest: UserManifest | null;
  /** Currently active user type (selected via header switcher) */
  activeUserType: string | null;

  /**
   * Initialize the store from a fold worker client.
   * Creates a fresh MemoryStore, replays the OPFS log into it, then
   * enables OPFS persistence for future writes.
   *
   * Pass `workerHeadSeq` (the worker's `position.seq` at the moment `ready`
   * was posted) to enable the "nothing changed since the snapshot" fast path —
   * when it equals the kv-snapshot's seq, init skips scanLog, readLogSince,
   * and the snapshot re-save entirely.
   */
  init: (workerClient: FoldWorkerClient, workerHeadSeq?: number) => Promise<void>;

  /**
   * Initialize a local-only store backed by a fold worker for the
   * given space name (default "local"). No Matrix session needed.
   */
  initLocal: (dbName?: string) => Promise<void>;

  setSyncManager: (syncManager: SyncManager) => void;
  setEodbBlobWriter: (writer: EodbBlobWriter | null) => void;
  setPermissions: (permissions: ResolvedPermissions | null) => void;
  setUserManifest: (manifest: UserManifest | null) => void;
  /**
   * Set the active persona. When `persist` is false (admin "preview as"),
   * the selection is NOT written to localStorage, so on refresh the user
   * falls back to their real assigned persona.
   */
  setActiveUserType: (typeId: string | null, persist?: boolean) => void;

  dispatch: (event: EoEventInput) => Promise<number>;
  batchImport: (events: EoEventInput[], onProgress?: (current: number, total: number) => void) => Promise<number>;
  horizon: (target: string, opts?: HorizonOpts) => Promise<HorizonResponse | HorizonResponse[] | null>;
  getState: (target: string) => Promise<EoState | null>;
  getStateByPrefix: (prefix: string) => Promise<EoState[]>;
  getStateByPrefixPage: (prefix: string, limit: number, afterTarget?: string) => Promise<StatePage>;
  manualSnapshot: () => Promise<{ seq: number }>;
  /**
   * Persist the current kv map + recent-tail to OPFS.
   * `hydratedHead`, when provided, records the block-chain event id this
   * snapshot already covers. The boot path reads it back to skip a
   * redundant chain walk even when localStorage is empty (e.g. cleared
   * by browser, cross-device export). See block-hydration's
   * `getPersistedHydratedHead`. (V9 of HELIX-AUDIT-2026-05-11.md.)
   */
  flushToOpfs: (hydratedHead?: string | null) => Promise<void>;
  /**
   * Hydration cursor recorded inside the last loaded kv-snapshot. Null
   * means either no snapshot, an older v2 snapshot without the field,
   * or a snapshot explicitly written without a chain cursor. (V9.)
   */
  snapshotHydratedHead: string | null;
  teardown: () => void;

  onDispatch: ((event: EoEventInput) => void) | null;
  setOnDispatch: (fn: ((event: EoEventInput) => void) | null) => void;
}

export const useEoStore = create<EoDbState>((set, get) => ({
  store: null,
  workerClient: null,
  syncManager: null,
  eodbBlobWriter: null,
  recentEvents: [],
  lastSeq: 0,
  ready: false,
  resolvedPermissions: null,
  userManifest: null,
  activeUserType: null,
  onDispatch: null,
  snapshotHydratedHead: null,

  async init(workerClient: FoldWorkerClient, workerHeadSeq?: number) {
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
    let cachedTail: EoEvent[] = [];
    let snapshotHit = false;
    let snapshotHydratedHead: string | null = null;
    let memStore: ReturnType<typeof createMemoryStore>;
    try {
      const snapshot = await loadKvSnapshot(workerClient);
      if (snapshot) {
        memStore = createMemoryStore({ initialKv: snapshot.entries, initialSeq: snapshot.seq });
        snapshotSeq = snapshot.seq;
        cachedTail = snapshot.recentTail;
        snapshotHydratedHead = snapshot.hydratedHead ?? null;
        snapshotHit = true;
      } else {
        memStore = createMemoryStore();
      }
    } catch {
      memStore = createMemoryStore();
    }

    // ── Fast path: worker says the log hasn't advanced past the snapshot ─────
    // When `workerHeadSeq === snapshotSeq` the log has literally no events the
    // snapshot doesn't already include, so scanLog would return [] anyway —
    // skip it to avoid the extra worker roundtrip. This is the "refresh when
    // nothing has changed" path: no replay, no readLogSince, no snapshot resave.
    const nothingNew =
      snapshotHit &&
      workerHeadSeq !== undefined &&
      workerHeadSeq === snapshotSeq;

    let replayedEvents: EoEvent[] = [];
    let replayFailed = false;
    if (!nothingNew) {
      // Replay only events that arrived after the snapshot was written.
      try {
        replayedEvents = await scanLog(workerClient, snapshotSeq);
        if (replayedEvents.length > 0) {
          await replayFromLog(memStore, replayedEvents);
        }
      } catch (e) {
        console.warn('[EO-DB] OPFS log replay failed:', e);
        replayFailed = true;
      }
    }

    // From here on, every log: write also persists to OPFS. Returning the
    // appendRaw promise lets MemoryStore track the queue so flushToOpfs
    // can drain pending writes before snapshotting (otherwise a 30k-event
    // burst can leave the kv-snapshot ahead of the OPFS log).
    memStore.enablePersistence((event) => {
      return appendRaw(workerClient, event).catch((e) => {
        console.warn('[EO-DB] appendRaw failed:', e);
      });
    });

    const lastSeq = await memStore.getCurrentSeq();

    // Hydrate recentEvents — cap at the last 2 000 events to avoid loading
    // a large array into Zustand state on init.  LogView loads older pages on demand.
    const RECENT_EVENT_LIMIT = 2_000;
    let hydrated: EoEvent[] = [];
    if (nothingNew && cachedTail.length > 0) {
      // Nothing changed since the snapshot was written, and the tail was
      // persisted alongside it — use it directly and skip the O(n) scan of
      // the memory store's log: entries.
      hydrated = cachedTail;
    } else if (!replayFailed && (snapshotHit || replayedEvents.length > 0)) {
      // We already have every event needed: cachedTail covers everything up to
      // snapshotSeq, replayedEvents covers the rest. Concatenating is
      // equivalent to readLogSince(memStore, lastSeq - LIMIT) but skips an
      // O(n) scan of the memory store's log: entries — the dominant cost on
      // the refresh path for spaces with large event histories.
      const combined = cachedTail.length > 0
        ? [...cachedTail, ...replayedEvents]
        : replayedEvents;
      hydrated = combined.length > RECENT_EVENT_LIMIT
        ? combined.slice(-RECENT_EVENT_LIMIT)
        : combined;
    } else {
      // Fallback: snapshot miss with replay failure, or truly brand-new store.
      // Scan the memStore for whatever's there.
      try {
        const fromSeq = Math.max(0, lastSeq - RECENT_EVENT_LIMIT);
        hydrated = await readLogSince(memStore, fromSeq);
      } catch {
        // Brand-new store — nothing to hydrate.
      }
    }

    set({ store: memStore, workerClient, lastSeq, ready: true, recentEvents: hydrated, snapshotHydratedHead });

    // ── Persist an updated snapshot for the next page refresh ────────────────
    // Skip the resave when nothing changed — the on-disk snapshot is already
    // current and re-writing it would waste the full msgpack-pack of the kv
    // map on every refresh. In the delta-replay path, persist the new state
    // (fire-and-forget) so the UI is unblocked immediately, and also ask the
    // worker to refresh its init-cache so buildIndex can be skipped next time.
    if (!nothingNew) {
      // Carry forward the snapshot's hydration cursor (V9). The chain
      // hasn't been re-walked here — the OPFS log delta replay only adds
      // raw events — so the prior snapshot's chain coverage is still
      // accurate.
      saveKvSnapshot(workerClient, memStore.getKvEntries(), hydrated, lastSeq, snapshotHydratedHead).catch((e) =>
        console.warn('[EO-DB] kv snapshot save failed:', e),
      );
      saveInitCache(workerClient).catch((e) =>
        console.warn('[EO-DB] init-cache save failed:', e),
      );
    }
  },

  async initLocal(dbName = 'local') {
    const workerClient = createFoldWorkerClient();
    // Feed fold-cost telemetry to the PressureMonitor (Phase 1 observe-only).
    workerClient.onTelemetry = ({ avgMicrosPerEvent }) => {
      pressureMonitor.reportFoldMicros(avgMicrosPerEvent);
    };
    const { headSeq } = await initFoldWorker(workerClient, dbName);
    await get().init(workerClient, headSeq);
  },

  setOnDispatch(fn: ((event: EoEventInput) => void) | null) {
    set({ onDispatch: fn });
  },

  setSyncManager(syncManager: SyncManager) {
    set({ syncManager });
  },

  setEodbBlobWriter(writer: EodbBlobWriter | null) {
    const existing = get().eodbBlobWriter;
    if (existing && existing !== writer) {
      existing.stop();
    }
    set({ eodbBlobWriter: writer });
  },

  setPermissions(permissions: ResolvedPermissions | null) {
    set({ resolvedPermissions: permissions });
  },

  setUserManifest(manifest: UserManifest | null) {
    set({ userManifest: manifest });
  },

  setActiveUserType(typeId: string | null, persist: boolean = true) {
    set({ activeUserType: typeId });
    if (!persist) return;
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
      // Broadcast to peers (encrypted, via Matrix to-device)
      const sm = get().syncManager;
      if (sm && 'broadcastLocalEvent' in sm) {
        (sm as any).broadcastLocalEvent(fullEvent).catch((e: unknown) =>
          console.warn('[EO-DB] broadcastLocalEvent failed:', e)
        );
      }
    });

    get().onDispatch?.(populatedEvent);
    return seq;
  },

  async batchImport(events: EoEventInput[], onProgress?: (current: number, total: number) => void) {
    // Bracket the fold so concurrent `flushToOpfs` calls wait for
    // quiescence — see the comment on `foldsInFlight` above. The whole
    // body runs inside the gate: chunk loop, store emits, and the final
    // straggler emit all complete before quiescence is signalled.
    enterFold();
    try {
    const { store } = get();
    if (!store) throw new Error('Store not initialized');

    // Memory-safe large-import strategy.
    //
    // A naive single-shot call into processEventsBulk with 1M events OOMs
    // the browser:
    //   - every event is allocated up-front by the caller
    //   - the fold's wave-reservation and sort each duplicate the event list
    //   - the worker path structured-clones a full snapshot per wave-step
    //   - an accumulator of all folded events doubled peak memory for the
    //     dubious benefit of checking `.length > 0` at the end
    //
    // Three things fix this:
    //
    //   1. We chunk the input. CHUNK_SIZE is the quantum passed to
    //      processEventsBulk{,WithDispatcher}. Each chunk's internal
    //      allocations are collectable as soon as the call returns, so
    //      peak memory is O(chunk) not O(total).
    //
    //   2. We don't accumulate folded events. Previously `imported` grew
    //      to a 1M-entry array just so we could gate a full post-import push
    //      on whether anything was imported. Replaced with a boolean.
    //
    //   3. We throttle progress and recent-events updates. React doesn't
    //      need 20,000 re-renders to show a progress bar — ~30/second is
    //      plenty, and `requestAnimationFrame`-paced updates align with
    //      the browser paint cycle for free.
    const CHUNK_SIZE = 10_000;
    const RECENTS_WINDOW = 100;
    const PROGRESS_THROTTLE_MS = 33; // ~30 Hz

    let anyImported = false;
    // Rolling window of the most-recent folded events. Bounded to
    // RECENTS_WINDOW so it never grows past 100 entries regardless of
    // import size — the Zustand `recentEvents` selector only ever surfaces
    // the last 100 events anyway, so buffering more is waste.
    const recentsTail: EoEvent[] = [];
    let maxFoldedSeq = 0;
    let lastProgressAt = 0;
    let lastReportedCurrent = 0;

    const onFoldedEvent = (fullEvent: EoEvent): void => {
      anyImported = true;
      recentsTail.push(fullEvent);
      if (recentsTail.length > RECENTS_WINDOW) {
        recentsTail.shift();
      }
      if (fullEvent.seq > maxFoldedSeq) maxFoldedSeq = fullEvent.seq;
    };

    // Emit a single Zustand update combining the current recents tail
    // with the latest seq. Called at chunk boundaries (not per event) so
    // React only re-renders subscribers once per ~10k-event chunk — two
    // orders of magnitude fewer renders than the previous 50-event batch.
    const emitStoreUpdate = (finalSeq: number) => {
      const snapshot = recentsTail.slice();
      set((state) => ({
        recentEvents: [...state.recentEvents, ...snapshot].slice(-RECENTS_WINDOW),
        lastSeq: Math.max(state.lastSeq, finalSeq),
      }));
      // Start the next chunk with a clean recents buffer so the update
      // after it doesn't re-publish events already added to the store.
      recentsTail.length = 0;
    };

    const throttledProgress = onProgress
      ? (current: number, total: number) => {
          const now = Date.now();
          if (
            current === total ||
            current - lastReportedCurrent >= 1000 ||
            now - lastProgressAt >= PROGRESS_THROTTLE_MS
          ) {
            lastProgressAt = now;
            lastReportedCurrent = current;
            onProgress(current, total);
          }
        }
      : undefined;

    // Route to the shard-pool worker path above the threshold. Phase E–H
    // shipped the shard-pool + worker transport; this is the wiring that
    // actually exercises it. Below the threshold, or when the host can't
    // spawn workers (Node / Vitest, single-core, no `Worker`), the legacy
    // in-process bulk path is faster because it skips snapshot serialization
    // and the structured-clone round-trip per wave-step.
    const shardCount = preferredShardCount();
    const useWorkerPath = events.length >= MIN_EVENTS_FOR_WORKER && shardCount >= 2;
    const pool = useWorkerPath ? getOrCreateWorkerPool(shardCount) : null;

    let lastSeq = 0;
    const totalEvents = events.length;
    let eventsProcessed = 0;

    // Chunk loop. Each chunk is folded as its own bulk pass — the
    // determinism harness's `chunked-bulk` runner proves this produces
    // identical projections to a single-shot bulk fold. Between chunks we
    // yield to the event loop so the UI can paint and the JS engine can
    // run GC on the just-released chunk allocations.
    for (let offset = 0; offset < totalEvents; offset += CHUNK_SIZE) {
      const chunk = events.slice(offset, offset + CHUNK_SIZE);

      const chunkProgress = throttledProgress
        ? (current: number, _total: number) => {
            throttledProgress(eventsProcessed + current, totalEvents);
          }
        : undefined;

      let chunkLastSeq: number;
      if (pool) {
        chunkLastSeq = await processEventsBulkWithDispatcher(
          store, chunk, shardCount, pool.dispatcher, chunkProgress, onFoldedEvent,
        );
      } else {
        chunkLastSeq = await processEventsBulk(store, chunk, chunkProgress, onFoldedEvent);
      }

      lastSeq = Math.max(lastSeq, chunkLastSeq);
      eventsProcessed += chunk.length;

      // One store update per chunk — picks up the rolling recents window
      // and the current lastSeq. HolonNav / Layout re-render at chunk
      // cadence, not per event.
      emitStoreUpdate(lastSeq);

      // Let the UI paint and let the JS engine reclaim per-chunk allocations
      // (the snapshot, the wave groupings, the mutation logs) before the
      // next chunk starts. Without this yield, 1M-row imports hold the main
      // thread for the entire fold and the browser kills the tab for
      // unresponsiveness.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    // Final update: in the single-chunk case, emitStoreUpdate already ran
    // inside the loop. Call once more with maxFoldedSeq to guarantee any
    // straggler events picked up by onFoldedEvent after the last chunk's
    // update are reflected in recentEvents.
    if (anyImported) emitStoreUpdate(Math.max(lastSeq, maxFoldedSeq));
    onProgress?.(totalEvents, totalEvents);

    return lastSeq;
    } finally { exitFold(); }
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
    const { store, workerClient, recentEvents, snapshotHydratedHead } = get();
    if (!store) throw new Error('Store not initialized');

    // Persist the current in-memory KV state to OPFS.
    const lastSeq = await store.getCurrentSeq();
    const memStore = store as MemoryStore;
    if (workerClient && typeof memStore.getKvEntries === 'function') {
      try {
        await saveKvSnapshot(workerClient, memStore.getKvEntries(), recentEvents, lastSeq, snapshotHydratedHead);
      } catch (e) {
        console.warn('[EO-DB] manualSnapshot: kv snapshot save failed:', e);
      }
      // Bake the worker's init-cache alongside so the next page refresh can
      // skip buildIndex() when the log hasn't moved since this snapshot.
      saveInitCache(workerClient).catch((e) =>
        console.warn('[EO-DB] manualSnapshot: init-cache save failed:', e),
      );
    }

    return { seq: lastSeq };
  },

  async flushToOpfs(hydratedHead?: string | null) {
    // Wait for any in-flight batchImport to drain before capturing the
    // kv-snapshot. Without this, a snapshot written mid-fold reports a
    // `seq` whose corresponding kv entries are still being mutated by
    // the fold engine. The on-disk dedup keeps subsequent loads
    // correct, but the snapshot's claim of coverage becomes a lie.
    // (V10 of HELIX-AUDIT-2026-05-11.md.)
    await awaitFoldQuiescent();
    const { store, workerClient, recentEvents, snapshotHydratedHead } = get();
    if (!store) throw new Error('Store not initialized');
    const memStore = store as MemoryStore;
    // Drain any in-flight appendRaw writes BEFORE capturing the kv-snapshot.
    // Without this barrier, a hydration that just ran 30k processEvent calls
    // can leave the worker's OPFS log behind the kv map; a hard reload then
    // restores a snapshot whose log: entries don't actually exist on disk.
    if (typeof memStore.awaitPersistence === 'function') {
      await memStore.awaitPersistence();
    }
    const lastSeq = await store.getCurrentSeq();
    if (workerClient && typeof memStore.getKvEntries === 'function') {
      // If the caller didn't tell us "this snapshot now covers chain head X",
      // carry forward whatever cursor the last snapshot already claimed.
      // Persisting the cursor inside the snapshot makes it atomic with the
      // kv map, so a missing localStorage entry no longer means
      // "re-walk the entire chain". (V9.)
      const head = hydratedHead === undefined ? snapshotHydratedHead : hydratedHead;
      await saveKvSnapshot(workerClient, memStore.getKvEntries(), recentEvents, lastSeq, head);
      if (head !== snapshotHydratedHead) {
        set({ snapshotHydratedHead: head });
      }
      saveInitCache(workerClient).catch((e) =>
        console.warn('[EO-DB] flushToOpfs: init-cache save failed:', e),
      );
    }
  },

  teardown() {
    const { store, workerClient, eodbBlobWriter } = get();
    if (eodbBlobWriter) eodbBlobWriter.stop();
    if (store) store.close();
    if (workerClient) workerClient.worker.terminate();
    // Drop the shard-worker pool alongside the fold worker so teardown is
    // a clean shutdown with no lingering OS threads.
    terminateCachedWorkerPool();
    set({
      store: null,
      workerClient: null,
      syncManager: null,
      eodbBlobWriter: null,
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

/**
 * Throttled per-event listener for bulk-import paths that fold events
 * directly through `processEvent` (e.g. Airtable hydration / update sync,
 * which iterate records one at a time rather than calling `batchImport`).
 *
 * Without this, the events land in the MemoryStore + OPFS log, but the
 * Zustand `recentEvents` / `lastSeq` state is never bumped — so subscribers
 * like TableView (which re-fetches on `lastSeq` change, see TableView.tsx
 * deps array) never refresh and the import appears to vanish until the next
 * page reload.
 *
 * Returns `{ onEvent, finalize }`. Pass `onEvent` as the per-event hook to
 * the import flow, and call `finalize()` after the import settles to flush
 * any pending update so the UI sees the final state immediately.
 *
 * Updates are throttled to ~10 Hz and the recents tail is capped at 100
 * events (mirroring `batchImport`'s RECENTS_WINDOW) so a 30k-event Airtable
 * hydration causes at most a few hundred Zustand updates rather than 30k.
 */
export function createImportProgressListener(): {
  onEvent: (event: EoEvent) => void;
  finalize: () => void;
} {
  const RECENTS_WINDOW = 100;
  const FLUSH_MS = 100;
  let recentsTail: EoEvent[] = [];
  let maxSeq = 0;
  let dirty = false;
  let pending: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
    if (!dirty) return;
    const snapshot = recentsTail;
    const seq = maxSeq;
    recentsTail = [];
    dirty = false;
    useEoStore.setState((state) => ({
      recentEvents: [...state.recentEvents, ...snapshot].slice(-RECENTS_WINDOW),
      lastSeq: Math.max(state.lastSeq, seq),
    }));
  };

  const onEvent = (event: EoEvent): void => {
    recentsTail.push(event);
    if (recentsTail.length > RECENTS_WINDOW) recentsTail.shift();
    if (event.seq > maxSeq) maxSeq = event.seq;
    dirty = true;
    if (pending === null) {
      pending = setTimeout(flush, FLUSH_MS);
    }
  };

  return { onEvent, finalize: flush };
}
