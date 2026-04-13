/**
 * Fold determinism harness — Phase 0 (with Phase A upgrade) of the EO///DB
 * scaling roadmap.
 *
 * Property-based tests (via fast-check) that pin down the invariants the
 * fold must satisfy before any of the parallel-execution phases (B–K) can
 * land. The harness is the gate: every later phase plugs its new fold
 * implementation into the `FoldRunner` contract below, and the same
 * properties must continue to hold.
 *
 * Properties verified:
 *
 *   1. Serial determinism — running the same input twice through
 *      processEvent produces byte-identical store contents.
 *
 *   2. Bulk determinism — running the same input twice through
 *      processEventsBulk produces byte-identical store contents. Phase A
 *      promoted this from projection-level to byte-identical: the bulk
 *      path now reserves seqs up-front via an AddressingHorizon (see
 *      fold-core.ts), so the Promise.all/per-target nextSeq race that
 *      previously made bulk byte-identity flaky is gone.
 *
 *   3. Serial ≡ Bulk projection equivalence — the canonical projection
 *      (state values, content hashes, trajectories, graph edges, helix
 *      declared sets) is identical between the serial and the
 *      wave-grouped bulk path. Seq numbers and log:* keys are excluded
 *      from the projection because the two paths legitimately assign
 *      different seqs (serial takes seqs in arrival order; bulk pre-
 *      allocates contiguous wave ranges), even when the "what does the
 *      database look like to a reader" view is identical.
 *
 *   4. DEF re-block — DEFs sprinkled mid-stream produce a final value at
 *      each field equal to that field's last DEF, and surrounding
 *      structure (e.g. CON edges placed between DEFs) survives intact.
 *      This is the property the Phase B mid-wave barrier must preserve
 *      when it starts splitting waves at DEF events.
 *
 * ─── Constraints on the generated input ───────────────────────────────
 *
 * The arbitrary produces inputs that respect TWO restrictions, so the
 * harness measures fold determinism in isolation:
 *
 *   (a) **Every literal target referenced by any event is explicitly
 *       INS'd first.** Phase A (constitutive site model) made bulk-mode
 *       auto-promotion race-free, so in principle this restriction could
 *       be relaxed. It is kept in Phase 0's harness because the serial
 *       path still routes auto-promotion through the original nested
 *       processEventCore path — lifting the restriction would start
 *       exercising BOTH paths' auto-promotion codepaths, which is a
 *       different property (serial ≡ bulk under auto-promotion) that
 *       Phase B will address explicitly.
 *
 *   (b) **The input is pre-sorted by helix level.** processEventsBulk
 *       re-groups events by helix level via sortByHelixLevel, which
 *       changes the per-target arrival order whenever a target receives
 *       events at multiple helix levels. The trajectory hash chain in
 *       fold-cache.ts is order-dependent, so unsorted input would
 *       legitimately produce different trajectory hashes between serial
 *       and bulk. Pre-sorting collapses the two paths' per-target
 *       orderings, so the fold's invariants can be tested directly.
 *
 * Determinism also requires that the wall clock isn't observed during the
 * fold. fold-cache.ts:76 (cadence classification) reads Date.now(); we
 * freeze it with vi.useFakeTimers so the two runs in each property check
 * see the same instant.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import {
  processEvent,
  processEventsBulk,
  processEventsBulkPooled,
  processEventsBulkIsolated,
  processEventsBulkWorker,
  processEventsBulkViaDispatcher,
} from '../fold';
import type { FoldRunner } from '../fold-core';
import {
  dispatchShardInProcess,
  type WorkerDispatchMessage,
  type WorkerResultMessage,
} from '../fold-worker-transport';
import type { EoStore, IteratorOpts } from '../encrypted-store';
import type { EoEventInput } from '../types';

// ─── In-memory test store ────────────────────────────────────────────────────

interface TestStoreHandle {
  store: EoStore;
  data: Map<string, unknown>;
}

/**
 * Same shape as the createTestStore() in fold.test.ts, but exposes the
 * underlying Map so the harness can compute a fingerprint over every key.
 */
function createTestStore(): TestStoreHandle {
  const data = new Map<string, unknown>();
  let seq = 0;

  const store: EoStore = {
    async get(key: string) {
      return data.has(key) ? data.get(key) : null;
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
    },
    async del(key: string) {
      data.delete(key);
    },
    async iterator(prefix: string, opts?: IteratorOpts) {
      const results: [string, unknown][] = [];
      for (const [key, value] of data.entries()) {
        if (key >= prefix && key <= prefix + '\uffff') {
          if (opts?.afterKey && key <= opts.afterKey) continue;
          results.push([key, value]);
        }
      }
      results.sort((a, b) => a[0].localeCompare(b[0]));
      if (opts?.limit !== undefined && results.length > opts.limit) {
        results.length = opts.limit;
      }
      return results;
    },
    async nextSeq() {
      seq += 1;
      data.set('meta:seq', seq);
      return seq;
    },
    async getCurrentSeq() {
      return seq;
    },
    close() {},
  };

  return { store, data };
}

// ─── Fingerprints ────────────────────────────────────────────────────────────

/** Recursively sort object keys so two equal objects encode to identical strings. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/**
 * Full byte-for-byte fingerprint over every key in the store. Used by the
 * "same input twice through the same runner" tests, where literal byte
 * equality is expected.
 */
function fullFingerprint(handle: TestStoreHandle): string {
  const keys = [...handle.data.keys()].sort();
  return keys.map((k) => `${k}=${stableStringify(handle.data.get(k))}`).join('\n');
}

/**
 * Canonical projection fingerprint — captures the "what does the database
 * look like to a reader" view, dropping seq-dependent and log-shaped data.
 *
 * Specifically:
 *   - state:* rows are kept, but `last_seq` is stripped (bulk and serial
 *     paths assign different seq numbers because of microtask interleaving
 *     in the bulk path's per-target sharding; the *content* at each target
 *     is what must agree)
 *   - graph:fwd:* and graph:rev:* edges are kept verbatim
 *   - helix:* rows are kept, with seq-dependent fields stripped (firstSeq,
 *     lastSeq), and the `declared` array is sorted because it carries set
 *     semantics — the order operators were first declared depends on the
 *     wave grouping, which differs between paths
 *   - log:*, idem:*, meta:seq, error:* are dropped (seq-shaped or
 *     volatile)
 */
function projectionFingerprint(handle: TestStoreHandle): string {
  const lines: string[] = [];
  const keys = [...handle.data.keys()].sort();
  for (const key of keys) {
    if (key.startsWith('log:')) continue;
    if (key.startsWith('idem:')) continue;
    if (key === 'meta:seq') continue;
    if (key.startsWith('error:')) continue;

    const raw = handle.data.get(key);

    if (key.startsWith('state:')) {
      const s = raw as Record<string, unknown> | null;
      if (!s) continue;
      const stripped: Record<string, unknown> = { ...s };
      delete stripped.last_seq;
      lines.push(`${key}=${stableStringify(stripped)}`);
      continue;
    }

    if (key.startsWith('helix:')) {
      const h = raw as Record<string, unknown> | null;
      if (!h) continue;
      const declared = Array.isArray(h.declared)
        ? [...(h.declared as string[])].sort()
        : h.declared;
      const stripped: Record<string, unknown> = {
        declared,
        count: h.count,
      };
      lines.push(`${key}=${stableStringify(stripped)}`);
      continue;
    }

    if (key.startsWith('graph:fwd:') || key.startsWith('graph:rev:')) {
      const e = raw as Record<string, unknown> | null;
      if (!e) continue;
      const stripped: Record<string, unknown> = { ...e };
      // The CON handler stores `seq: event.seq` on each edge; that
      // differs between serial and bulk because of microtask
      // interleaving. The edge's source/dest/edge_type are the
      // semantic content.
      delete stripped.seq;
      lines.push(`${key}=${stableStringify(stripped)}`);
      continue;
    }

    lines.push(`${key}=${stableStringify(raw)}`);
  }
  return lines.join('\n');
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const TARGETS = ['app.t.r0', 'app.t.r1', 'app.t.r2', 'app.t.r3'] as const;
const FIELDS = ['fldA', 'fldB', 'fldC'] as const;
const AGENT = '@harness:example.com';

/** Helix level mirror — kept local because fold.ts does not export it. */
const HELIX_LEVEL: Record<string, number> = {
  NUL: 0,
  SIG: 0,
  INS: 1,
  SEG: 2,
  CON: 2,
  SYN: 3,
  DEF: 4,
  EVA: 5,
};

/**
 * Operators the seed arbitrary will emit. INS is added by buildSequence.
 *
 * NUL and SIG (helix level 0) are deliberately excluded for the same
 * reason described in the file header: SIG creates state ahead of any
 * pre-emitted INS, which then throws "Target already instantiated" out
 * of processEventCore's pre-check. handleSIG should arguably register
 * itself as ephemeral state that doesn't trip the INS pre-check, but
 * that's a fold-semantics question for Phase A's Constitutive Site
 * Model, not a determinism question.
 */
type GenOp = 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA';

interface EventSeed {
  op: GenOp;
  targetIdx: number;
  fieldIdx: number;
  destIdx: number;
  scalarValue: string | number | boolean;
  segTag: string;
}

const eventSeedArb: fc.Arbitrary<EventSeed> = fc.record({
  op: fc.constantFrom<GenOp>('SEG', 'CON', 'SYN', 'DEF', 'EVA'),
  targetIdx: fc.integer({ min: 0, max: TARGETS.length - 1 }),
  fieldIdx: fc.integer({ min: 0, max: FIELDS.length - 1 }),
  destIdx: fc.integer({ min: 0, max: TARGETS.length - 1 }),
  scalarValue: fc.oneof(
    fc.string({ minLength: 1, maxLength: 6 }),
    fc.integer({ min: 0, max: 1000 }),
    fc.boolean(),
  ),
  segTag: fc.string({ minLength: 1, maxLength: 6 }),
});

/** A partially-built event with its target known but ts/cid not yet assigned. */
interface PartialEvent {
  op: EoEventInput['op'];
  target: string;
  operand: unknown;
}

/**
 * Convert a list of seeds into a well-ordered EoEventInput[]. The output
 * satisfies the two harness restrictions documented in the file header:
 *
 *   1. Every literal target referenced by any event is explicitly INS'd
 *      first, so the fold's auto-promotion path never fires. The bare
 *      record (e.g. app.t.r0), each field path that any event addresses
 *      (e.g. app.t.r0.fldA), and CON destinations all get pre-INS.
 *
 *   2. The combined list is stably sorted by helix level, so that bulk's
 *      helix-wave regrouping is a no-op relative to serial's arrival order
 *      and the per-target trajectory hash chain matches between paths.
 *
 * Timestamps and client_event_ids are assigned AFTER the helix sort, by
 * the events' final positions in the output list. This keeps `eventHash`
 * out of the picture (every event already has a client_event_id) and
 * keeps fold-cache.ts's intervalsSorted monotonic.
 */
function buildSequence(seeds: EventSeed[]): EoEventInput[] {
  const partials: PartialEvent[] = [];
  const insted = new Set<string>();

  const ensureINS = (target: string) => {
    if (insted.has(target)) return;
    insted.add(target);
    partials.push({
      op: 'INS',
      target,
      operand: { name: target },
    });
  };

  for (const s of seeds) {
    const record = TARGETS[s.targetIdx];
    const field = FIELDS[s.fieldIdx];
    const fieldPath = `${record}.${field}`;

    switch (s.op) {
      case 'SEG':
        ensureINS(fieldPath);
        partials.push({ op: 'SEG', target: fieldPath, operand: s.segTag });
        break;

      case 'CON':
        ensureINS(fieldPath);
        ensureINS(TARGETS[s.destIdx]);
        partials.push({
          op: 'CON',
          target: fieldPath,
          operand: { added: [TARGETS[s.destIdx]] },
        });
        break;

      case 'SYN':
        ensureINS(record);
        // No-op SYN — operand has no `merge` field, so handleSYN does
        // nothing (the helix declared set still gets SYN added).
        partials.push({ op: 'SYN', target: record, operand: {} });
        break;

      case 'DEF':
        ensureINS(fieldPath);
        partials.push({
          op: 'DEF',
          target: fieldPath,
          operand: s.scalarValue,
        });
        break;

      case 'EVA':
        ensureINS(fieldPath);
        partials.push({
          op: 'EVA',
          target: fieldPath,
          operand: { strategy: 'latest' },
        });
        break;
    }
  }

  // Stable sort by helix level so serial arrival order matches bulk's
  // wave-grouping. Array.prototype.sort is stable in V8 (and per spec
  // since ES2019), so events at the same level retain insertion order.
  const sorted = partials
    .map((p, i) => ({ p, i }))
    .sort((a, b) => HELIX_LEVEL[a.p.op] - HELIX_LEVEL[b.p.op] || a.i - b.i)
    .map(({ p }) => p);

  // Assign monotonic ts and unique client_event_id by final position.
  const tsAt = (i: number) => {
    const hours = Math.floor(i / 3600);
    const mins = Math.floor((i % 3600) / 60);
    const secs = i % 60;
    return `2025-01-01T${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.000Z`;
  };

  return sorted.map((p, i) => {
    const ts = tsAt(i);
    return {
      op: p.op,
      target: p.target,
      operand: p.operand,
      agent: AGENT,
      ts,
      acquired_ts: ts,
      client_event_id: `cid-${i}`,
    };
  });
}

const sequenceArb: fc.Arbitrary<EoEventInput[]> = fc
  .array(eventSeedArb, { minLength: 1, maxLength: 16 })
  .map(buildSequence);

// ─── Fold runners ────────────────────────────────────────────────────────────
//
// FoldRunner is now exported from fold-core.ts (Phase D). Every runner below
// satisfies the same contract: (store, events) → Promise<void>. The Phase 0
// harness re-instantiates every property against every runner.

const runSerial: FoldRunner = async (store, events) => {
  for (const event of events) {
    await processEvent(store, event);
  }
};

const runBulk: FoldRunner = async (store, events) => {
  await processEventsBulk(store, events);
};

/**
 * Chunked bulk runner — Phase D. Splits the input into N roughly-equal
 * chunks (preserving arrival order) and feeds each chunk to
 * processEventsBulk sequentially. Proves that "incremental bulk import
 * of event batches produces the same projection as a single bulk import."
 *
 * This exercises the real-world scenario where events arrive in batches
 * (e.g. Airtable sync pages, Matrix room pagination) and each batch is
 * folded independently.
 *
 * CHUNK_COUNT is 3 — enough to exercise the boundary: first chunk
 * establishes helix state, second chunk encounters existing targets,
 * third chunk exercises the steady-state hot path.
 */
const CHUNK_COUNT = 3;

const runChunkedBulk: FoldRunner = async (store, events) => {
  if (events.length === 0) return;
  const chunkSize = Math.max(1, Math.ceil(events.length / CHUNK_COUNT));
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    await processEventsBulk(store, chunk);
  }
};

/**
 * Shard-pool runner — Phase E. Partitions targets into N fixed shards via
 * deterministic hashing and processes each shard's targets sequentially,
 * with shards running concurrently. Wave-level synchronization ensures all
 * shards complete wave N before any shard starts wave N+1, which resolves
 * the cross-shard CON dependency that blocked the naive shard runner in
 * Phase D:
 *
 *   - All INS events (wave level 1) complete before any CON (wave level 2)
 *   - The pre-pass generates synthetic INS for CON destinations
 *   - The shared store makes cross-shard reverse-edge writes visible
 *
 * SHARD_COUNT is 3 — same as CHUNK_COUNT — enough to exercise multi-shard
 * boundaries while keeping test runtime reasonable. With 4 targets in the
 * arbitrary, 3 shards guarantees at least one shard has >1 target (proving
 * intra-shard sequential dispatch) and at least one shard may be empty
 * (proving empty-shard tolerance).
 */
const SHARD_COUNT = 3;

const runShardPool: FoldRunner = async (store, events) => {
  await processEventsBulkPooled(store, events, SHARD_COUNT);
};

/**
 * Isolated-pool runner — Phase F. Same shard partitioning as Phase E,
 * but each shard processes events against its own **isolated store clone**.
 * Mutations are merged back to the main store after each wave step.
 *
 * This is the execution model that real Web Workers will use: each worker
 * has its own memory space, and the coordinator merges results. Passing
 * all 4 determinism properties proves that the isolation + merge protocol
 * produces identical results to the shared-store model.
 *
 * The key cross-shard concern — CON reverse edges — is safe because they
 * are additive inserts (no read-modify-write). Wave synchronization
 * guarantees all INS events complete before any CON, so checkExists on
 * CON destinations always succeeds against the snapshot.
 */
const runIsolatedPool: FoldRunner = async (store, events) => {
  await processEventsBulkIsolated(store, events, SHARD_COUNT);
};

/**
 * Full-snapshot isolated-pool runner — Phase H guard. Identical to
 * `runIsolatedPool` except that every shard receives the **unfiltered**
 * snapshot via `processEventsBulkViaDispatcher`'s `useFullSnapshot`
 * escape hatch. Production paths always use the filtered snapshot
 * (`filterSnapshotForShard`) for wire efficiency; this runner exists so
 * the property suite can prove the filter is lossless:
 *
 *   projectionFingerprint(selective) === projectionFingerprint(full)
 *
 * If `filterSnapshotForShard` ever drops a key that the shard body
 * actually reads — an rdep cascade target, a derived entity's
 * co-constituent, a graph:fwd endpoint — this runner diverges from
 * `runIsolatedPool` and the harness catches the regression. Without
 * this runner, a filter regression could manifest only as a subtle
 * cascadeUpward skip and slip past the property check.
 */
const runFullSnapshotPool: FoldRunner = async (store, events) => {
  await processEventsBulkViaDispatcher(
    store, events, SHARD_COUNT, dispatchShardInProcess,
    undefined, undefined, { useFullSnapshot: true },
  );
};

/**
 * Mock Worker implementing the Phase G postMessage protocol on the
 * current thread. Used by the worker-transport runner to exercise the
 * full dispatch / postMessage / response-merge round-trip without
 * spinning up a real DedicatedWorkerGlobalScope (which Vitest's Node
 * test environment does not provide natively).
 *
 * The mock:
 *
 *   - Buffers message/error listeners exactly like a real Worker.
 *   - On `postMessage(request)`, runs `dispatchShardInProcess` on a
 *     microtask queue and dispatches the result back as a MessageEvent.
 *   - Round-trips through `structuredClone` so the test surfaces any
 *     non-serializable value the coordinator or shard may have tried
 *     to put on the wire. This is the same serialization boundary a
 *     real Worker would enforce.
 *   - Honors `terminate()` by flipping a flag — further dispatches
 *     never fire.
 *
 * Passing all 4 determinism properties against this runner proves the
 * Phase G transport is correct independent of the Worker runtime: a
 * real browser Worker can only go wrong where this mock does, modulo
 * structured-clone limits that structuredClone() already enforces.
 */
class MockShardWorker implements Partial<Worker> {
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private terminated = false;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown): void {
    if (this.terminated) return;
    const msg = structuredClone(message) as WorkerDispatchMessage;
    if (!msg || msg.type !== 'dispatch') return;

    // Kick off async dispatch on a microtask so the coordinator's
    // listener registration has a chance to complete before the reply.
    void (async () => {
      try {
        const response = await dispatchShardInProcess(msg.request);
        if (this.terminated) return;
        const cloned = structuredClone({
          type: 'result', id: msg.id, response,
        } as WorkerResultMessage);
        this.deliver('message', new MessageEvent('message', { data: cloned }));
      } catch (err) {
        if (this.terminated) return;
        const error = err instanceof Error ? err.message : String(err);
        const cloned = structuredClone({ type: 'error', id: msg.id, error } as WorkerResultMessage);
        this.deliver('message', new MessageEvent('message', { data: cloned }));
      }
    })();
  }

  terminate(): void {
    this.terminated = true;
    this.listeners.clear();
  }

  private deliver(type: string, event: Event): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const l of set) {
      if (typeof l === 'function') l(event);
      else l.handleEvent(event);
    }
  }
}

/**
 * Worker-transport runner — Phase G. Runs the fold via
 * `processEventsBulkWorker` against a pool of MockShardWorker instances
 * that execute `dispatchShardInProcess` behind the real postMessage
 * protocol. This is the final link that closes the shard scaling story:
 * the coordinator, the ShardRequest/Response wire shape, the pool-pick
 * round-robin, and the response merge all get exercised end-to-end on
 * every property in the harness.
 *
 * A real browser Worker substitutes transparently: the only difference
 * is that the dispatch runs on a separate OS thread. The protocol and
 * the merged result are identical.
 */
const runWorkerTransport: FoldRunner = async (store, events) => {
  const workerFactory = (): Worker => new MockShardWorker() as unknown as Worker;
  await processEventsBulkWorker(store, events, SHARD_COUNT, workerFactory);
};

// ─── Runner registry ─────────────────────────────────────────────────────────
//
// Named runners used by the parameterized test suite. New runners added
// in future phases (GPU) go here and the full property battery auto-applies.
//
// NOTE on shard runners. Phase E (shard-pool) proved partitioning is
// deterministic with shared stores. Phase F (isolated-pool) proved the
// isolation + merge protocol is correct: each shard operates on its own
// store clone, and mutations are merged back without conflicts. Phase G
// (worker-transport) proves the protocol survives the postMessage
// serialization boundary — same isolation + merge, but shards ride a
// real Worker transport instead of Promise.all on the coordinator thread.

interface NamedRunner {
  name: string;
  runner: FoldRunner;
}

const ALL_RUNNERS: NamedRunner[] = [
  { name: 'serial',             runner: runSerial },
  { name: 'bulk',               runner: runBulk },
  { name: 'chunked-bulk',       runner: runChunkedBulk },
  { name: 'shard-pool',         runner: runShardPool },
  { name: 'isolated-pool',      runner: runIsolatedPool },
  { name: 'full-snapshot-pool', runner: runFullSnapshotPool },
  { name: 'worker-transport',   runner: runWorkerTransport },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Fold determinism harness (Phase 0 + Phase F runners)', () => {
  beforeEach(() => {
    // Freeze Date.now() so fold-cache.ts cadence classification is
    // deterministic across the two runs in each property check.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Property 1: Self-determinism ──────────────────────────────────────
  //
  // Each runner must produce byte-identical store contents when given the
  // same input twice. This is the foundational property: if a runner is
  // not self-deterministic, nothing else about it can be trusted.

  for (const { name, runner } of ALL_RUNNERS) {
    it(`[${name}] self-determinism: same input twice → byte-identical`, async () => {
      await fc.assert(
        fc.asyncProperty(sequenceArb, async (events) => {
          const a = createTestStore();
          const b = createTestStore();
          await runner(a.store, events);
          await runner(b.store, events);
          expect(fullFingerprint(a)).toBe(fullFingerprint(b));
        }),
        { numRuns: 15 },
      );
    });
  }

  // ─── Property 2: Projection equivalence ────────────────────────────────
  //
  // Every runner must produce the same projection as the serial baseline.
  // "Projection" strips seq-dependent fields (different runners legitimately
  // assign different seqs) and compares the "what does the database look
  // like to a reader" view.

  for (const { name, runner } of ALL_RUNNERS) {
    if (name === 'serial') continue; // serial is the baseline
    it(`[${name}] projection equivalence: ${name} fold ≡ serial fold`, async () => {
      await fc.assert(
        fc.asyncProperty(sequenceArb, async (events) => {
          const baseline = createTestStore();
          const candidate = createTestStore();
          await runSerial(baseline.store, events);
          await runner(candidate.store, events);
          expect(projectionFingerprint(candidate)).toBe(projectionFingerprint(baseline));
        }),
        { numRuns: 15 },
      );
    });
  }

  it('DEF re-block: final value at a field equals the last DEF on that field', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.string({ minLength: 1, maxLength: 6 }),
            fc.integer({ min: 0, max: 1000 }),
            fc.boolean(),
          ),
          { minLength: 1, maxLength: 8 },
        ),
        async (defValues) => {
          const target = TARGETS[0];
          const field = FIELDS[0];
          const events: EoEventInput[] = [
            {
              op: 'INS',
              target,
              operand: { seed: 0 },
              agent: AGENT,
              ts: '2025-01-01T00:00:00.000Z',
              acquired_ts: '2025-01-01T00:00:00.000Z',
              client_event_id: 'rb-ins',
            },
          ];
          defValues.forEach((v, i) => {
            const ts = `2025-01-01T00:01:${String(i).padStart(2, '0')}.000Z`;
            events.push({
              op: 'DEF',
              target: `${target}.${field}`,
              operand: v,
              agent: AGENT,
              ts,
              acquired_ts: ts,
              client_event_id: `rb-def-${i}`,
            });
          });

          const handle = createTestStore();
          await runBulk(handle.store, events);

          const finalState = handle.data.get(`state:${target}.${field}`) as
            | { value: unknown }
            | undefined;
          expect(finalState).toBeTruthy();
          expect(finalState!.value).toStrictEqual(defValues[defValues.length - 1]);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('DEF re-block: structure surrounding interleaved DEFs survives', async () => {
    // Concrete regression: INS → DEF(a) → CON → DEF(b) → DEF(c) on the
    // same field gives final value c, AND the CON edge is intact. This is
    // the Phase B mid-wave-barrier scenario in miniature.
    const events: EoEventInput[] = [
      {
        op: 'INS',
        target: TARGETS[0],
        operand: { name: 'first' },
        agent: AGENT,
        ts: '2025-01-01T00:00:00.000Z',
        acquired_ts: '2025-01-01T00:00:00.000Z',
        client_event_id: 'rs-a',
      },
      {
        op: 'INS',
        target: TARGETS[1],
        operand: { name: 'second' },
        agent: AGENT,
        ts: '2025-01-01T00:00:01.000Z',
        acquired_ts: '2025-01-01T00:00:01.000Z',
        client_event_id: 'rs-b',
      },
      {
        op: 'DEF',
        target: `${TARGETS[0]}.${FIELDS[0]}`,
        operand: 'a',
        agent: AGENT,
        ts: '2025-01-01T00:00:02.000Z',
        acquired_ts: '2025-01-01T00:00:02.000Z',
        client_event_id: 'rs-c',
      },
      {
        op: 'CON',
        target: `${TARGETS[0]}.${FIELDS[1]}`,
        operand: { added: [TARGETS[1]] },
        agent: AGENT,
        ts: '2025-01-01T00:00:03.000Z',
        acquired_ts: '2025-01-01T00:00:03.000Z',
        client_event_id: 'rs-d',
      },
      {
        op: 'DEF',
        target: `${TARGETS[0]}.${FIELDS[0]}`,
        operand: 'b',
        agent: AGENT,
        ts: '2025-01-01T00:00:04.000Z',
        acquired_ts: '2025-01-01T00:00:04.000Z',
        client_event_id: 'rs-e',
      },
      {
        op: 'DEF',
        target: `${TARGETS[0]}.${FIELDS[0]}`,
        operand: 'c',
        agent: AGENT,
        ts: '2025-01-01T00:00:05.000Z',
        acquired_ts: '2025-01-01T00:00:05.000Z',
        client_event_id: 'rs-f',
      },
    ];

    const handle = createTestStore();
    await runBulk(handle.store, events);

    const fld = handle.data.get(`state:${TARGETS[0]}.${FIELDS[0]}`) as
      | { value: unknown }
      | undefined;
    expect(fld?.value).toBe('c');

    const fwdEdge = handle.data.get(
      `graph:fwd:${TARGETS[0]}.${FIELDS[1]}:${TARGETS[1]}`,
    );
    expect(fwdEdge).toBeTruthy();
  });
});
