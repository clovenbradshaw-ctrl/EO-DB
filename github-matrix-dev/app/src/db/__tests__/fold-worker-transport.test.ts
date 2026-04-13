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

import { describe, it, expect } from 'vitest';
import {
  filterSnapshotForShard,
  snapshotStoreWithEdgeIndex,
  type StoreSnapshotBundle,
} from '../fold-worker-transport';
import type { EoStore, IteratorOpts } from '../encrypted-store';

function makeBundle(entries: [string, unknown][]): StoreSnapshotBundle {
  const edgesFrom = new Map<string, Set<string>>();
  const FWD = 'graph:fwd:';
  for (const [key] of entries) {
    if (!key.startsWith(FWD)) continue;
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
  }
  return { entries, edgesFrom };
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
});
