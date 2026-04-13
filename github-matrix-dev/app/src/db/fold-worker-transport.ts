/**
 * fold-worker-transport.ts — Phase G: Real Web Worker transport.
 *
 * Takes the proven isolation + merge protocol from Phase F and lifts shard
 * dispatch out of the coordinator onto a pluggable transport: the shard body
 * becomes `ShardRequest → ShardResponse`, and any implementation of that
 * contract is a valid transport.
 *
 * Two implementations ship today:
 *
 *   1. `dispatchShardInProcess` — runs the shard's work on the current
 *      thread by constructing a TrackedStore from the snapshot, calling
 *      processEventCoreWithSeq, and returning the tracked mutation log.
 *      Used by tests (where Worker semantics are awkward to fake under
 *      Vitest) and by the existing `processEventsBulkIsolated` entry point,
 *      which now delegates to this function. Phase F's determinism harness
 *      already proves this path produces byte-identical results to the
 *      shared-store baseline.
 *
 *   2. `createWorkerShardDispatcher` — a Worker-pool-backed dispatcher.
 *      Each shard's ShardRequest is posted to a dedicated worker via
 *      postMessage; the worker runs `dispatchShardInProcess` on its own
 *      thread and posts the ShardResponse back. The coordinator merges
 *      responses into the main store exactly as the in-process path does.
 *      This is what turns Phase E + F's shard work into real multi-core
 *      parallelism.
 *
 * Serialization. ShardRequest / ShardResponse are both plain JSON-shaped
 * objects — Map entries are materialized as `[string, unknown][]`, and
 * mutations are plain records. The structured-clone algorithm that backs
 * postMessage handles these without any manual marshaling.
 *
 * Protocol invariants (the same ones Phase F proved with Promise.all):
 *
 *   - Seqs are pre-assigned by the coordinator's SeqReservoir. A shard
 *     receives `{event, seq}` pairs and MUST NOT allocate new seqs.
 *   - The coordinator snapshots the main store before dispatch; every
 *     shard sees the same baseline.
 *   - Shards only write to their partitioned target key space, except for
 *     CON reverse edges (destination-keyed) which are additive.
 *   - After all shards return, the coordinator applies every shard's
 *     mutation log to the main store and re-runs refreshGraphMetrics on
 *     every CON destination (because each shard saw only its own reverse
 *     edges, so the per-destination degree count was partial).
 */

import type { EoStore } from './encrypted-store';
import type { EoEventInput, EoEvent } from './types';
import type { StoreMutation } from './fold-isolate';
import {
  StoreAddressingHorizon,
  StoreDeclaredHorizon,
  StoreNulHorizon,
} from './addressing-horizon';
import { createTrackedStore } from './fold-isolate';

// ─── Wire types ─────────────────────────────────────────────────────────────

/**
 * A pre-assigned (event, seq) pair. Seqs come from the coordinator's
 * SeqReservoir; the shard must use them verbatim, never allocate its own.
 */
export interface PlannedEvent {
  event: EoEventInput;
  seq: number;
}

/**
 * Wire message the coordinator sends to a shard for one wave-step.
 *
 *   - `snapshot` is the entire main-store state at the moment of dispatch,
 *     materialized as `[key, value]` entries. The shard reconstructs an
 *     isolated EoStore from this via createTrackedStore.
 *
 *   - `currentSeq` is what the shard's `store.getCurrentSeq()` returns.
 *     (The shard never calls nextSeq — see fold-isolate.ts.)
 *
 *   - `targetsToPlanned` is the (target → planned events) mapping the
 *     coordinator built from the wave-step. The shard iterates
 *     `shardTargets` and processes each target's events in order.
 *
 *   - `shardTargets` is the ordered list of targets this shard owns,
 *     already partitioned by targetShardIndex and sorted.
 */
export interface ShardRequest {
  snapshot: [string, unknown][];
  currentSeq: number;
  shardTargets: string[];
  targetsToPlanned: [string, PlannedEvent[]][];
}

/**
 * Wire message the shard returns to the coordinator.
 *
 *   - `mutations` is the full ordered mutation log from the shard's
 *     TrackedStore. The coordinator applies these to the main store,
 *     in receive order, to merge the shard's work.
 *
 *   - `shardLastSeq` is the highest seq processed in the shard. The
 *     coordinator takes the max across shards to advance its own
 *     `lastSeq` high-water mark.
 *
 *   - `processedCount` is how many events the shard processed — used
 *     by the coordinator to drive `onProgress`.
 */
export interface ShardResponse {
  mutations: StoreMutation[];
  shardLastSeq: number;
  processedCount: number;
}

/**
 * The shard-dispatch contract. Every transport — in-process, Worker,
 * or a hypothetical network-transport — implements this signature.
 *
 * Invariant: calling the same dispatcher twice with the same request
 * must produce a ShardResponse whose mutations apply-merge to the same
 * final store state. (Byte-identical mutation logs are NOT required —
 * two implementations may legitimately produce different internal
 * iteration orders as long as the merged result is the same.)
 */
export type ShardDispatcher = (req: ShardRequest) => Promise<ShardResponse>;

// ─── In-process dispatcher ─────────────────────────────────────────────────

/**
 * Run a shard's work on the current thread. This is the reference
 * implementation: it's what the Phase F harness already proved correct.
 *
 * The body is intentionally identical to the inner mapper of
 * `processEventsBulkIsolated` pre-Phase-G — by pulling it out as a named
 * function, we make the contract the coordinator and the Worker share.
 *
 * `onEvent` is only meaningful on the in-process path (postMessage can
 * not round-trip a function). Workers always receive `undefined`.
 */
export async function dispatchShardInProcess(
  req: ShardRequest,
  onEvent?: (event: EoEvent) => void,
): Promise<ShardResponse> {
  if (req.shardTargets.length === 0) {
    return { mutations: [], shardLastSeq: 0, processedCount: 0 };
  }

  // Defer the fold.ts import to break a module cycle:
  // fold-worker-transport ← fold ← fold-worker-transport (via the
  // forthcoming processEventsBulkWorker entry point). Dynamic import
  // at call time resolves after both modules have finished loading.
  const { processEventCoreWithSeq } = await import('./fold');

  // Reconstruct the isolated store from the snapshot payload.
  const snapshot = new Map<string, unknown>(req.snapshot);
  const tracked = createTrackedStore(snapshot, req.currentSeq);

  // Shard-local horizon instances backed by the clone. They read/write
  // through the TrackedStore, so every mutation they make is captured
  // in the tracked mutation log and merged back at the coordinator.
  const shardAddressing = new StoreAddressingHorizon(tracked.store);
  const shardDeclared = new StoreDeclaredHorizon(tracked.store);
  const shardNulHorizon = new StoreNulHorizon(tracked.store);

  // Recover target → planned events from the wire shape (array of
  // tuples, not a Map, because Maps don't survive structured clone
  // in a form we want to rely on).
  const byTarget = new Map<string, PlannedEvent[]>(req.targetsToPlanned);

  let shardLastSeq = 0;
  let processedCount = 0;

  for (const target of req.shardTargets) {
    const targetEvents = byTarget.get(target);
    if (!targetEvents) continue;
    for (const { event, seq } of targetEvents) {
      await processEventCoreWithSeq(
        tracked.store, event, seq,
        shardAddressing, shardDeclared, shardNulHorizon,
        onEvent,
      );
      if (seq > shardLastSeq) shardLastSeq = seq;
      processedCount++;
    }
  }

  return { mutations: tracked.mutations, shardLastSeq, processedCount };
}

// ─── Worker-pool dispatcher ────────────────────────────────────────────────

/**
 * Messages the coordinator posts to a Worker. `id` is a correlation key
 * so a pooled worker can handle multiple concurrent shards without the
 * coordinator having to thread its own promise state through postMessage
 * ordering. Today one worker handles one shard at a time, so `id` is a
 * trivial monotonic counter, but the protocol is prepared for pipelining.
 */
export interface WorkerDispatchMessage {
  type: 'dispatch';
  id: number;
  request: ShardRequest;
}

/**
 * Messages the Worker posts back to the coordinator. On success,
 * `response` carries the ShardResponse. On failure, `error` carries
 * the thrown error's message (the coordinator re-throws a local Error
 * so stack traces don't get lost in transit).
 */
export type WorkerResultMessage =
  | { type: 'result'; id: number; response: ShardResponse }
  | { type: 'error'; id: number; error: string };

/**
 * A pool of Web Workers bound to the shard-dispatch contract. The
 * coordinator acquires a worker per shard (round-robin when shardCount
 * exceeds workerCount), posts the ShardRequest, and awaits the reply.
 *
 * The dispatcher returned by this function satisfies the ShardDispatcher
 * contract — callers pass it to processEventsBulkViaDispatcher exactly
 * like they would `dispatchShardInProcess`.
 *
 * Lifecycle: the caller owns the pool. Call `terminate()` when done to
 * stop the workers and release their OS threads. Terminating while a
 * dispatch is in flight rejects the outstanding promise.
 */
export interface WorkerShardPool {
  dispatcher: ShardDispatcher;
  terminate(): void;
}

/**
 * Build a pool of `workerCount` Web Workers from a factory function, and
 * wrap them in a ShardDispatcher.
 *
 * `workerFactory` is caller-supplied because the way a Worker is constructed
 * depends on the bundler: Vite wants `new Worker(new URL('./fold-shard.worker.ts', import.meta.url), { type: 'module' })`,
 * a pre-built bundle might want `new Worker('/worker.js', { type: 'module' })`,
 * and tests want to mock the whole thing. The transport stays bundler-
 * and runtime-agnostic by not hard-coding the Worker URL.
 *
 * Concurrency model: each dispatch picks the next-free worker (round-robin
 * with an in-flight guard). If shardCount > workerCount, additional
 * shards queue until a worker frees up — the coordinator's outer
 * `Promise.all(shards.map(dispatcher))` gives us this for free because
 * the dispatcher awaits `busyUntil[idx]` before posting.
 */
export function createWorkerShardPool(options: {
  workerCount: number;
  workerFactory: () => Worker;
}): WorkerShardPool {
  const { workerCount, workerFactory } = options;
  if (workerCount < 1) {
    throw new Error(`createWorkerShardPool: workerCount must be >= 1 (got ${workerCount})`);
  }

  const workers: Worker[] = [];
  // busyUntil[i] resolves when worker i becomes available. Initially all
  // workers are free, so busyUntil[i] starts as an immediately-resolved
  // Promise; each dispatch chains a new promise onto the slot.
  const busyUntil: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(workerFactory());
    busyUntil.push(Promise.resolve());
  }

  let nextWorker = 0;
  let nextId = 1;
  let terminated = false;

  const dispatcher: ShardDispatcher = async (req: ShardRequest): Promise<ShardResponse> => {
    if (terminated) {
      throw new Error('WorkerShardPool: dispatch called after terminate()');
    }

    // Round-robin: pick the next worker slot, then wait for its current
    // in-flight dispatch (if any) to finish before posting.
    const idx = nextWorker;
    nextWorker = (nextWorker + 1) % workerCount;

    const prior = busyUntil[idx];
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => { release = resolve; });
    busyUntil[idx] = prior.then(() => mine);
    await prior;

    const worker = workers[idx];
    const id = nextId++;

    try {
      return await new Promise<ShardResponse>((resolve, reject) => {
        const onMessage = (ev: MessageEvent<WorkerResultMessage>) => {
          const msg = ev.data;
          if (!msg || msg.id !== id) return; // not ours (pool reuse)
          worker.removeEventListener('message', onMessage as EventListener);
          worker.removeEventListener('error', onError as EventListener);
          if (msg.type === 'result') resolve(msg.response);
          else reject(new Error(`fold-shard.worker: ${msg.error}`));
        };
        const onError = (ev: ErrorEvent) => {
          worker.removeEventListener('message', onMessage as EventListener);
          worker.removeEventListener('error', onError as EventListener);
          reject(new Error(`fold-shard.worker (runtime): ${ev.message}`));
        };
        worker.addEventListener('message', onMessage as EventListener);
        worker.addEventListener('error', onError as EventListener);
        const msg: WorkerDispatchMessage = { type: 'dispatch', id, request: req };
        worker.postMessage(msg);
      });
    } finally {
      release();
    }
  };

  const terminate = (): void => {
    if (terminated) return;
    terminated = true;
    for (const w of workers) w.terminate();
  };

  return { dispatcher, terminate };
}

// ─── Coordinator: build a ShardRequest from wave-step inputs ───────────────

/**
 * Serialize an EoStore into the snapshot payload shape. Exists so the
 * coordinator has a single call that produces the exact shape
 * dispatchShardInProcess (and the Worker) expect.
 *
 * Note: this is functionally equivalent to `snapshotStore()` in
 * fold-isolate.ts, but returns the wire-shaped `[key, value][]` directly
 * (Map → array) so the coordinator doesn't allocate a Map it immediately
 * throws away.
 *
 * This builder ships the ENTIRE store to every shard. `snapshotStoreWithEdgeIndex`
 * + `filterSnapshotForShard` are the selective-seed variants used by
 * `processEventsBulkViaDispatcher`; this function is retained for callers
 * that want the full snapshot (e.g. tests that deliberately exercise the
 * whole-store path or inspect the full entries list directly).
 */
export async function snapshotStoreAsEntries(store: EoStore): Promise<[string, unknown][]> {
  const entries = await store.iterator('');
  const seq = await store.getCurrentSeq();
  entries.push(['meta:seq', seq]);
  return entries;
}

// ─── Selective seeding (Phase H) ───────────────────────────────────────────
//
// `snapshotStoreAsEntries` ships every entry to every shard, so a 100-target
// store with 8 shards puts ~800× the store size on the wire. The shard body
// (dispatchShardInProcess → processEventCoreWithSeq → executeOperator) only
// reaches for a bounded slice of that data, so most of the payload is dead
// weight that still has to pay structured-clone cost at the worker boundary.
//
// `snapshotStoreWithEdgeIndex` + `filterSnapshotForShard` reduce each shard's
// wire payload to the keys that shard can actually observe. The filter
// rules are derived from the read sites reachable from processEventCoreWithSeq
// (see audit in fold.ts; handleINS/SEG/CON/SYN/DEF/EVA/SIG/NUL +
// touchAddressingForEvent + declareForEvent + recordNulForEvent +
// StoreHelixStateTracker.recordOperator + updateFoldCache):
//
//   Pruned unconditionally (write-only from the shard's perspective):
//     • log:*    appendToLog writes; horizon/invariant-scanner read later
//                against the merged main store, never during shard fold
//     • error:*  written on operator throw; never read in-shard
//
//   Filtered by per-shard `relevantTargets`:
//     • state:<t>, helix:<t>, eva:<t>, derived:<t>
//     • graph:fwd:<source>:<dest>   (keep when source ∈ relevantTargets)
//     • graph:rev:<dest>:<source>   (keep when dest   ∈ relevantTargets)
//     • rdep:<constituent>:<derived> (keep when constituent ∈ relevantTargets)
//
//   Passed through unconditionally (small or opaque; shard may read them):
//     • idem:*   checked by processEventCoreWithSeq for every event
//     • meta:*   seq metadata, tiny
//     • card:*, chunk:*, proto:* and any unknown prefix
//                opaque to the fold; the card-encoder module-level
//                singleton may be null in a worker anyway, but we pass
//                the entries through so in-process dispatch stays a
//                no-op superset of the worker view
//
// `relevantTargets` for a shard is:
//     shardTargets ∪ conDestinations ∪ existingEdgeNeighbors(shardTargets)
//
// The first two terms are known at shard-planning time; the third covers
// handleCON's deferred-EVA activation path, which invokes evaluateFormula
// on the source's FULL dependency set (= every existing graph:fwd edge
// destination), and handleCON/refreshGraphMetrics which reads incident
// edges. Pre-indexing those once per wave-step keeps per-shard filter
// work linear in the snapshot size, not quadratic.

/**
 * A wave-step snapshot plus the outgoing-edge index that
 * `filterSnapshotForShard` needs to expand each shard's relevant-targets
 * set. Built once per wave-step; the same bundle drives every shard's
 * per-shard filter.
 */
export interface StoreSnapshotBundle {
  /** All store entries (the same payload snapshotStoreAsEntries returns). */
  entries: [string, unknown][];
  /**
   * Source target → set of destination targets, derived from
   * `graph:fwd:<source>:<dest>` keys in `entries`. Used to expand
   * `relevantTargets` to include existing edge endpoints that
   * evaluateFormula / refreshGraphMetrics would read during CON/EVA.
   */
  edgesFrom: Map<string, Set<string>>;
}

/**
 * Snapshot the store and index outgoing edges in one pass. Same cost as
 * `snapshotStoreAsEntries` plus an O(E) scan of the graph:fwd prefix
 * already present in the entries.
 */
export async function snapshotStoreWithEdgeIndex(store: EoStore): Promise<StoreSnapshotBundle> {
  const entries = await store.iterator('');
  const seq = await store.getCurrentSeq();
  entries.push(['meta:seq', seq]);

  const edgesFrom = new Map<string, Set<string>>();
  const FWD = 'graph:fwd:';
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i][0];
    if (!key.startsWith(FWD)) continue;
    const rest = key.slice(FWD.length);
    const sep = rest.indexOf(':');
    if (sep < 0) continue;
    const source = rest.slice(0, sep);
    const dest = rest.slice(sep + 1);
    let set = edgesFrom.get(source);
    if (!set) {
      set = new Set<string>();
      edgesFrom.set(source, set);
    }
    set.add(dest);
  }

  return { entries, edgesFrom };
}

/**
 * Produce the per-shard snapshot entries — the wire payload for one shard.
 *
 * `shardTargets` is the set of targets this shard owns; `conDestinations`
 * is the set of destinations referenced by CON events scheduled on this
 * shard (the coordinator already computes this for post-merge graph-metric
 * reconciliation — we reuse it here).
 *
 * Returns a new entries array filtered according to the rules in the
 * module header comment. Callers pass this array as `ShardRequest.snapshot`.
 */
export function filterSnapshotForShard(
  bundle: StoreSnapshotBundle,
  shardTargets: Iterable<string>,
  conDestinations: Iterable<string>,
): [string, unknown][] {
  const relevantTargets = new Set<string>();
  for (const t of shardTargets) relevantTargets.add(t);
  for (const t of conDestinations) relevantTargets.add(t);
  // 1-hop closure over existing outgoing edges — see module header.
  // Snapshotted copy so later mutations to `shardTargets` can't re-enter.
  const sourceTargets = [...relevantTargets];
  for (const t of sourceTargets) {
    const dests = bundle.edgesFrom.get(t);
    if (!dests) continue;
    for (const d of dests) relevantTargets.add(d);
  }

  const kept: [string, unknown][] = [];
  for (const entry of bundle.entries) {
    const key = entry[0];

    // log:*, error:* — never read during shard fold; drop unconditionally.
    if (key.startsWith('log:') || key.startsWith('error:')) continue;

    // Per-target single-component keys: state:<t>, helix:<t>, eva:<t>, derived:<t>
    if (
      key.startsWith('state:') ||
      key.startsWith('helix:') ||
      key.startsWith('eva:') ||
      key.startsWith('derived:')
    ) {
      const target = key.slice(key.indexOf(':') + 1);
      if (relevantTargets.has(target)) kept.push(entry);
      continue;
    }

    // graph:fwd:<source>:<dest> — keep when source is relevant.
    // graph:rev:<dest>:<source> — keep when dest is relevant.
    if (key.startsWith('graph:fwd:')) {
      const rest = key.slice('graph:fwd:'.length);
      const sep = rest.indexOf(':');
      const primary = sep < 0 ? rest : rest.slice(0, sep);
      if (relevantTargets.has(primary)) kept.push(entry);
      continue;
    }
    if (key.startsWith('graph:rev:')) {
      const rest = key.slice('graph:rev:'.length);
      const sep = rest.indexOf(':');
      const primary = sep < 0 ? rest : rest.slice(0, sep);
      if (relevantTargets.has(primary)) kept.push(entry);
      continue;
    }

    // rdep:<constituent>:<derived> — only read by recomputeDependents
    // on the merged store, but kept for symmetry with the full snapshot
    // when `constituent` is relevant (otherwise the shard never touches it).
    if (key.startsWith('rdep:')) {
      const rest = key.slice('rdep:'.length);
      const sep = rest.indexOf(':');
      const primary = sep < 0 ? rest : rest.slice(0, sep);
      if (relevantTargets.has(primary)) kept.push(entry);
      continue;
    }

    // Anything else (idem:, meta:, card:, chunk:, proto:, unknown) passes
    // through. These are either universally read (idem, meta) or opaque
    // to the shard body (card-encoder persistence — the writer singleton
    // in a Worker is independent of the coordinator's anyway).
    kept.push(entry);
  }
  return kept;
}

// Re-export EoStore so callers can build stores without importing both modules.
export type { EoStore } from './encrypted-store';
