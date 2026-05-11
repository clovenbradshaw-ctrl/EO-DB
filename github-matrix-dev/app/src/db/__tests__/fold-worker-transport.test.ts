/**
 * Phase H selective-seed unit tests for fold-worker-transport.ts.
 *
 * Pins the filter contract so the shard wire payload stays correct even
 * when later refactors tweak the namespace map:
 *
 *   • `log:*` and `error:*` are dropped unconditionally.
 *   • `state:`, `helix:`, `eva:`, `derived:` pass when the target
 *     component is in the shard's relevant set.
 *   • `graph:fwd:<source>:*` keys pass when the source is relevant.
 *   • `graph:rev:<dest>:*`   keys pass when the dest is relevant.
 *   • `rdep:<constituent>:*` keys pass when the constituent is relevant.
 *   • `idem:`, `meta:`, and any other / unknown prefix pass through.
 *   • relevantTargets is the 1-hop closure of (shardTargets ∪ conDests)
 *     over outgoing edges — so an EVA on a shard's target that reads
 *     dependencies via graph:fwd finds their state in the snapshot.
 *
 * The fold-determinism harness already exercises the end-to-end pipeline
 * through `processEventsBulkIsolated` / `processEventsBulkWorker`; these
 * tests guard the filter in isolation so failures point at the rule, not
 * the runner.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  filterSnapshotForShard,
  snapshotStoreWithEdgeIndex,
  createWorkerShardPool,
  type StoreSnapshotBundle,
  type ShardRequest,
  type WorkerDispatchMessage,
  type WorkerResultMessage,
} from '../fold-worker-transport';
import { SHARDING_HASH_VERSION } from '../fold-pool';
import type { EoStore, IteratorOpts } from '../encrypted-store';

function makeBundle(entries: [string, unknown][]): StoreSnapshotBundle {
  const edgesFrom = new Map<string, Set<string>>();
  const rdepFrom = new Map<string, Set<string>>();
  const constituentsOf = new Map<string, Set<string>>();
  const FWD = 'graph:fwd:';
  const RDEP = 'rdep:';
  const DERIVED = 'derived:';
  for (const [key, value] of entries) {
    if (key.startsWith(FWD)) {
      const rest = key.slice(FWD.length);
      const sep = rest.indexOf(':');
      if (sep < 0) continue;
      const source = rest.slice(0, sep);
      const dest = rest.slice(sep + 1);
      let set = edgesFrom.get(source);
      if (!set) {
        set = new Set();
        edgesFrom.set(source, set);
      }
      set.add(dest);
    } else if (key.startsWith(RDEP)) {
      const rest = key.slice(RDEP.length);
      const sep = rest.indexOf(':');
      if (sep < 0) continue;
      const constituent = rest.slice(0, sep);
      const derived = rest.slice(sep + 1);
      let set = rdepFrom.get(constituent);
      if (!set) {
        set = new Set();
        rdepFrom.set(constituent, set);
      }
      set.add(derived);
    } else if (key.startsWith(DERIVED)) {
      const derived = key.slice(DERIVED.length);
      const v = value as { constituents?: unknown } | null;
      const constituents = v?.constituents;
      if (Array.isArray(constituents)) {
        const set = new Set<string>();
        for (const c of constituents) {
          if (typeof c === 'string') set.add(c);
        }
        if (set.size > 0) constituentsOf.set(derived, set);
      }
    }
  }
  return {
    shardingHashVersion: SHARDING_HASH_VERSION,
    entries,
    edgesFrom,
    rdepFrom,
    constituentsOf,
  };
}

function keys(pairs: [string, unknown][]): string[] {
  return pairs.map(([k]) => k).sort();
}

// ─── filterSnapshotForShard ─────────────────────────────────────────────────

describe('filterSnapshotForShard', () => {
  it('drops log: and error: unconditionally', () => {
    const bundle = makeBundle([
      ['state:a', { v: 1 }],
      ['log:000000000001', { seq: 1 }],
      ['log:000000000002', { seq: 2 }],
      ['error:000000000003', { seq: 3 }],
      ['idem:hash-1', 1],
    ]);
    const out = filterSnapshotForShard(bundle, ['a'], []);
    expect(keys(out)).toEqual(['idem:hash-1', 'state:a']);
  });

  it('filters state/helix/eva/derived by target component', () => {
    const bundle = makeBundle([
      ['state:a', { v: 1 }],
      ['state:b', { v: 2 }],
      ['helix:a', { level: 1 }],
      ['helix:b', { level: 1 }],
      ['eva:a', { target: 'a' }],
      ['eva:c', { target: 'c' }],
      ['derived:b', { target: 'b' }],
      ['derived:d', { target: 'd' }],
    ]);
    const out = filterSnapshotForShard(bundle, ['a'], []);
    expect(keys(out)).toEqual(['eva:a', 'helix:a', 'state:a']);
  });

  it('filters graph:fwd by source and graph:rev by dest', () => {
    const bundle = makeBundle([
      ['graph:fwd:a:x', { source: 'a', dest: 'x' }],
      ['graph:fwd:b:y', { source: 'b', dest: 'y' }],
      ['graph:rev:x:a', { source: 'a', dest: 'x' }],
      ['graph:rev:y:b', { source: 'b', dest: 'y' }],
    ]);
    // Shard owns "a", CON adds a destination "y".
    // Expanded relevant: {a, y, x} (x pulled in by 1-hop closure from a).
    // graph:fwd:a:x → kept (source a relevant)
    // graph:fwd:b:y → dropped (source b not relevant)
    // graph:rev:x:a → kept (dest x relevant)
    // graph:rev:y:b → kept (dest y relevant)
    const out = filterSnapshotForShard(bundle, ['a'], ['y']);
    expect(keys(out)).toEqual([
      'graph:fwd:a:x',
      'graph:rev:x:a',
      'graph:rev:y:b',
    ]);
  });

  it('filters rdep: by constituent component', () => {
    const bundle = makeBundle([
      ['rdep:a:derived1', 'derived1'],
      ['rdep:b:derived1', 'derived1'],
      ['rdep:c:derived2', 'derived2'],
    ]);
    const out = filterSnapshotForShard(bundle, ['a', 'c'], []);
    expect(keys(out)).toEqual(['rdep:a:derived1', 'rdep:c:derived2']);
  });

  it('passes idem/meta/card/chunk/proto/unknown prefixes unconditionally', () => {
    const bundle = makeBundle([
      ['idem:h1', 1],
      ['idem:h2', 2],
      ['meta:seq', 42],
      ['chunk:000000', { cards: [] }],
      ['card:meta', { nextChunkId: 1 }],
      ['proto:current', { protos: [] }],
      ['customPrefix:foo', 'bar'],
      ['keyWithoutColon', 'baz'],
      ['state:a', { v: 1 }],
    ]);
    const out = filterSnapshotForShard(bundle, ['a'], []);
    expect(keys(out)).toEqual([
      'card:meta',
      'chunk:000000',
      'customPrefix:foo',
      'idem:h1',
      'idem:h2',
      'keyWithoutColon',
      'meta:seq',
      'proto:current',
      'state:a',
    ]);
  });

  it('expands relevantTargets via 1-hop edge closure so EVA dependencies stay in-snapshot', () => {
    // a → x (existing edge). Shard owns "a". evaluateFormula on a would
    // read state:x as a dependency. Selective seed must include it.
    const bundle = makeBundle([
      ['state:a', { v: 1 }],
      ['state:x', { v: 'dep' }],
      ['state:y', { v: 'unrelated' }],
      ['graph:fwd:a:x', { source: 'a', dest: 'x' }],
    ]);
    const out = filterSnapshotForShard(bundle, ['a'], []);
    expect(keys(out)).toEqual([
      'graph:fwd:a:x',
      'state:a',
      'state:x',
    ]);
  });

  it('returns an empty array (plus unconditional passes) when no targets match', () => {
    const bundle = makeBundle([
      ['state:a', { v: 1 }],
      ['state:b', { v: 2 }],
      ['idem:h', 99],
      ['meta:seq', 1],
    ]);
    const out = filterSnapshotForShard(bundle, [], []);
    expect(keys(out)).toEqual(['idem:h', 'meta:seq']);
  });

  it('expands relevantTargets via rdep reverse-closure so cascadeUpward finds derived rows', () => {
    // Shard owns constituent "a". Derived "D" has constituents {a, b}.
    // cascadeUpward reads rdep:a:D → derived:D.constituents → state:a, state:b,
    // then setState/recordOperator/updateFoldCache on D. All of those keys must
    // survive the filter even though D and b are not in shardTargets/conDests.
    const bundle = makeBundle([
      ['state:a', { v: 1 }],
      ['state:b', { v: 2 }],
      ['state:D', { v: 'derived' }],
      ['helix:D', { level: 2 }],
      ['derived:D', { target: 'D', constituents: ['a', 'b'] }],
      ['rdep:a:D', 'D'],
      ['rdep:b:D', 'D'],
      // Unrelated derived entity whose constituents are not shard-owned
      // and that has no rdep path back to a — must stay dropped.
      ['derived:E', { target: 'E', constituents: ['x', 'y'] }],
      ['state:x', { v: 'x' }],
      ['rdep:x:E', 'E'],
    ]);
    const out = filterSnapshotForShard(bundle, ['a'], []);
    expect(keys(out)).toEqual([
      'derived:D',
      'helix:D',
      'rdep:a:D',
      'rdep:b:D',
      'state:D',
      'state:a',
      'state:b',
    ]);
  });

  it('closes rdep reverse-closure transitively across chained derivations', () => {
    // a is a constituent of D1. D1 is itself a constituent of D2.
    // Cascade chains a → D1 → D2 via rdep; every row along the chain
    // must be in the shard's snapshot.
    const bundle = makeBundle([
      ['state:a', { v: 1 }],
      ['state:b', { v: 2 }],
      ['state:D1', { v: 'd1' }],
      ['state:D2', { v: 'd2' }],
      ['derived:D1', { target: 'D1', constituents: ['a', 'b'] }],
      ['derived:D2', { target: 'D2', constituents: ['D1'] }],
      ['rdep:a:D1', 'D1'],
      ['rdep:b:D1', 'D1'],
      ['rdep:D1:D2', 'D2'],
    ]);
    const out = filterSnapshotForShard(bundle, ['a'], []);
    expect(keys(out)).toEqual([
      'derived:D1',
      'derived:D2',
      'rdep:D1:D2',
      'rdep:a:D1',
      'rdep:b:D1',
      'state:D1',
      'state:D2',
      'state:a',
      'state:b',
    ]);
  });

  it('does not duplicate entries when shardTargets and conDestinations overlap', () => {
    const bundle = makeBundle([
      ['state:a', { v: 1 }],
      ['helix:a', { level: 1 }],
    ]);
    // Same target appears in both sets — the filter must still emit one entry each.
    const out = filterSnapshotForShard(bundle, ['a'], ['a']);
    expect(keys(out)).toEqual(['helix:a', 'state:a']);
  });
});

// ─── snapshotStoreWithEdgeIndex ─────────────────────────────────────────────

describe('snapshotStoreWithEdgeIndex', () => {
  function createTestStore(initial: [string, unknown][]): EoStore {
    const data = new Map<string, unknown>(initial);
    let seq = 0;
    return {
      async get(key) { return data.has(key) ? data.get(key) : null; },
      async put(key, value) { data.set(key, value); },
      async del(key) { data.delete(key); },
      async iterator(prefix: string, opts?: IteratorOpts) {
        const results: [string, unknown][] = [];
        for (const [k, v] of data.entries()) {
          if (k >= prefix && k <= prefix + '\uffff') {
            if (opts?.afterKey && k <= opts.afterKey) continue;
            results.push([k, v]);
          }
        }
        results.sort((a, b) => a[0].localeCompare(b[0]));
        if (opts?.limit !== undefined && results.length > opts.limit) {
          results.length = opts.limit;
        }
        return results;
      },
      async nextSeq() { seq++; return seq; },
      async getCurrentSeq() { return seq; },
      close() {},
    };
  }

  it('captures every entry and appends meta:seq', async () => {
    const store = createTestStore([
      ['state:a', { v: 1 }],
      ['graph:fwd:a:b', { source: 'a', dest: 'b' }],
    ]);
    const bundle = await snapshotStoreWithEdgeIndex(store);
    expect(keys(bundle.entries)).toContain('meta:seq');
    expect(keys(bundle.entries)).toContain('state:a');
    expect(keys(bundle.entries)).toContain('graph:fwd:a:b');
  });

  it('builds the outgoing-edge index from graph:fwd keys', async () => {
    const store = createTestStore([
      ['graph:fwd:a:x', {}],
      ['graph:fwd:a:y', {}],
      ['graph:fwd:b:z', {}],
      ['graph:rev:x:a', {}], // rev keys must not leak into the fwd index
    ]);
    const bundle = await snapshotStoreWithEdgeIndex(store);
    expect([...bundle.edgesFrom.get('a')!].sort()).toEqual(['x', 'y']);
    expect([...bundle.edgesFrom.get('b')!]).toEqual(['z']);
    expect(bundle.edgesFrom.has('x')).toBe(false);
  });

  it('builds the rdep and derived-constituents indices for rdep reverse-closure', async () => {
    const store = createTestStore([
      ['rdep:a:D1', 'D1'],
      ['rdep:b:D1', 'D1'],
      ['rdep:c:D2', 'D2'],
      ['derived:D1', { target: 'D1', constituents: ['a', 'b'] }],
      ['derived:D2', { target: 'D2', constituents: ['c'] }],
    ]);
    const bundle = await snapshotStoreWithEdgeIndex(store);
    expect([...bundle.rdepFrom.get('a')!]).toEqual(['D1']);
    expect([...bundle.rdepFrom.get('b')!]).toEqual(['D1']);
    expect([...bundle.rdepFrom.get('c')!]).toEqual(['D2']);
    expect([...bundle.constituentsOf.get('D1')!].sort()).toEqual(['a', 'b']);
    expect([...bundle.constituentsOf.get('D2')!]).toEqual(['c']);
  });
});

// ─── createWorkerShardPool — slot respawn on worker crash (V7) ─────────────

/**
 * Minimal Worker stand-in that records its events + supports a synthetic
 * `dispatchError` to simulate a runtime crash. Real Web Workers fire
 * `error` events asynchronously when a worker throws unhandled; we mimic
 * that contract with `addEventListener('error', ...)`.
 */
function makeFakeWorker() {
  const messageListeners = new Set<(ev: MessageEvent<WorkerResultMessage>) => void>();
  const errorListeners = new Set<(ev: ErrorEvent) => void>();
  let terminated = false;
  let respondAutomatically = true;
  const posts: WorkerDispatchMessage[] = [];

  return {
    posts,
    get terminated() { return terminated; },
    setRespondAutomatically(v: boolean) { respondAutomatically = v; },
    addEventListener(kind: string, listener: (ev: any) => void) {
      if (kind === 'message') messageListeners.add(listener);
      else if (kind === 'error') errorListeners.add(listener);
    },
    removeEventListener(kind: string, listener: (ev: any) => void) {
      if (kind === 'message') messageListeners.delete(listener);
      else if (kind === 'error') errorListeners.delete(listener);
    },
    postMessage(msg: WorkerDispatchMessage) {
      posts.push(msg);
      if (!respondAutomatically) return;
      // Asynchronously deliver a success response.
      queueMicrotask(() => {
        const reply: WorkerResultMessage = {
          type: 'result',
          id: msg.id,
          response: {
            mutations: [],
            shardLastSeq: 0,
            processedCount: 0,
            emittedEvents: [],
          },
        };
        for (const l of messageListeners) l({ data: reply } as MessageEvent<WorkerResultMessage>);
      });
    },
    terminate() { terminated = true; },
    /** Simulate an unhandled error from inside the worker. */
    dispatchError(message = 'simulated crash') {
      const ev = { message } as ErrorEvent;
      for (const l of errorListeners) l(ev);
    },
  };
}

type FakeWorker = ReturnType<typeof makeFakeWorker>;

function makeShardRequest(): ShardRequest {
  return {
    shardingHashVersion: SHARDING_HASH_VERSION,
    snapshot: [],
    currentSeq: 0,
    shardTargets: ['a'],
    targetsToPlanned: [],
  };
}

describe('createWorkerShardPool slot respawn', () => {
  it('replaces a dead worker via workerFactory and routes subsequent dispatches to the replacement', async () => {
    const workers: FakeWorker[] = [];
    const workerFactory = vi.fn(() => {
      const w = makeFakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    });

    const pool = createWorkerShardPool({ workerCount: 1, workerFactory });
    expect(workerFactory).toHaveBeenCalledTimes(1);

    // First dispatch goes to worker[0] and succeeds.
    const r1 = await pool.dispatcher(makeShardRequest());
    expect(r1.processedCount).toBe(0);
    expect(workers[0].posts.length).toBe(1);

    // Simulate the worker crashing. The pool-level error listener should
    // terminate it and ask the factory for a replacement.
    workers[0].dispatchError();
    expect(workers[0].terminated).toBe(true);
    expect(workerFactory).toHaveBeenCalledTimes(2);

    // Subsequent dispatch must go to the fresh worker, not the dead one.
    const r2 = await pool.dispatcher(makeShardRequest());
    expect(r2.processedCount).toBe(0);
    expect(workers[1].posts.length).toBe(1);
    // The dead worker received no new posts after its crash.
    expect(workers[0].posts.length).toBe(1);

    pool.terminate();
    expect(workers[1].terminated).toBe(true);
  });

  it('preserves round-robin across slots after a single-slot respawn', async () => {
    const workers: FakeWorker[] = [];
    const workerFactory = vi.fn(() => {
      const w = makeFakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    });

    const pool = createWorkerShardPool({ workerCount: 2, workerFactory });
    expect(workers.length).toBe(2);

    // Warm-up: one dispatch per slot.
    await pool.dispatcher(makeShardRequest());
    await pool.dispatcher(makeShardRequest());
    expect(workers[0].posts.length).toBe(1);
    expect(workers[1].posts.length).toBe(1);

    // Crash slot 0. Slot 1 stays alive.
    workers[0].dispatchError();
    expect(workers.length).toBe(3); // factory called once more for the respawn
    expect(workers[1].terminated).toBe(false);

    // Two more dispatches. Round-robin starts at slot 0 (next after the
    // previous cycle's slot 1). First lands on the fresh slot-0 worker
    // (workers[2]), second on the still-alive workers[1].
    await pool.dispatcher(makeShardRequest());
    await pool.dispatcher(makeShardRequest());
    expect(workers[2].posts.length).toBe(1);
    expect(workers[1].posts.length).toBe(2);

    pool.terminate();
  });
});
