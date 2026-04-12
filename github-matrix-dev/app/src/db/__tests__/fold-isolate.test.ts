/**
 * Unit tests for Phase F fold-isolate.ts — isolated-store primitives.
 *
 * Pins the contract for the store isolation protocol:
 *
 *   1. createTrackedStore produces an isolated clone (writes don't affect source).
 *   2. Mutations are recorded in order.
 *   3. snapshotStore captures all entries.
 *   4. applyMutations replays mutations to a target store.
 *   5. nextSeq throws on isolated stores (seqs are pre-assigned).
 */

import { describe, it, expect } from 'vitest';
import {
  createTrackedStore,
  snapshotStore,
  applyMutations,
} from '../fold-isolate';
import type { EoStore, IteratorOpts } from '../encrypted-store';

// ─── Minimal in-memory store for tests ──────────────────────────────────────

function createTestStore(initial?: Map<string, unknown>): {
  store: EoStore;
  data: Map<string, unknown>;
} {
  const data = new Map(initial ?? []);
  let seq = (data.get('meta:seq') as number) || 0;

  const store: EoStore = {
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
    async nextSeq() { seq++; data.set('meta:seq', seq); return seq; },
    async getCurrentSeq() { return seq; },
    close() {},
  };

  return { store, data };
}

// ─── createTrackedStore ─────────────────────────────────────────────────────

describe('createTrackedStore', () => {
  it('reads from the snapshot data', async () => {
    const snapshot = new Map<string, unknown>([
      ['state:x', { value: 42 }],
      ['state:y', { value: 'hello' }],
    ]);
    const tracked = createTrackedStore(snapshot, 0);

    expect(await tracked.store.get('state:x')).toEqual({ value: 42 });
    expect(await tracked.store.get('state:y')).toEqual({ value: 'hello' });
    expect(await tracked.store.get('state:z')).toBeNull();
  });

  it('writes are visible to subsequent reads', async () => {
    const tracked = createTrackedStore(new Map(), 0);

    await tracked.store.put('state:a', { value: 1 });
    expect(await tracked.store.get('state:a')).toEqual({ value: 1 });
  });

  it('writes do NOT affect the source snapshot', async () => {
    const snapshot = new Map<string, unknown>([['state:x', { value: 1 }]]);
    const tracked = createTrackedStore(snapshot, 0);

    await tracked.store.put('state:x', { value: 999 });
    await tracked.store.put('state:new', { value: 'added' });

    // Source snapshot is unchanged
    expect(snapshot.get('state:x')).toEqual({ value: 1 });
    expect(snapshot.has('state:new')).toBe(false);
  });

  it('records put mutations in order', async () => {
    const tracked = createTrackedStore(new Map(), 0);

    await tracked.store.put('a', 1);
    await tracked.store.put('b', 2);
    await tracked.store.put('a', 3);

    expect(tracked.mutations).toEqual([
      { op: 'put', key: 'a', value: 1 },
      { op: 'put', key: 'b', value: 2 },
      { op: 'put', key: 'a', value: 3 },
    ]);
  });

  it('records del mutations', async () => {
    const snapshot = new Map<string, unknown>([['x', 42]]);
    const tracked = createTrackedStore(snapshot, 0);

    await tracked.store.del('x');

    expect(tracked.mutations).toEqual([{ op: 'del', key: 'x' }]);
    expect(await tracked.store.get('x')).toBeNull();
  });

  it('nextSeq throws — seqs are pre-assigned by the coordinator', async () => {
    const tracked = createTrackedStore(new Map(), 5);

    await expect(tracked.store.nextSeq()).rejects.toThrow(
      'Isolated shard store must not call nextSeq',
    );
  });

  it('getCurrentSeq returns the seq passed at construction', async () => {
    const tracked = createTrackedStore(new Map(), 42);
    expect(await tracked.store.getCurrentSeq()).toBe(42);
  });

  it('iterator works on the cloned data', async () => {
    const snapshot = new Map<string, unknown>([
      ['state:a', 1],
      ['state:b', 2],
      ['state:c', 3],
      ['other:x', 99],
    ]);
    const tracked = createTrackedStore(snapshot, 0);

    const results = await tracked.store.iterator('state:');
    expect(results).toEqual([
      ['state:a', 1],
      ['state:b', 2],
      ['state:c', 3],
    ]);
  });

  it('iterator reflects writes to the clone', async () => {
    const tracked = createTrackedStore(new Map(), 0);

    await tracked.store.put('state:a', 1);
    await tracked.store.put('state:b', 2);

    const results = await tracked.store.iterator('state:');
    expect(results).toEqual([
      ['state:a', 1],
      ['state:b', 2],
    ]);
  });
});

// ─── snapshotStore ──────────────────────────────────────────────────────────

describe('snapshotStore', () => {
  it('captures all entries from the store', async () => {
    const { store } = createTestStore(new Map([
      ['state:x', { value: 1 }],
      ['graph:fwd:x:y', { edge: true }],
      ['helix:x', { declared: ['INS'] }],
    ]));

    const snapshot = await snapshotStore(store);

    expect(snapshot.get('state:x')).toEqual({ value: 1 });
    expect(snapshot.get('graph:fwd:x:y')).toEqual({ edge: true });
    expect(snapshot.get('helix:x')).toEqual({ declared: ['INS'] });
  });

  it('includes meta:seq', async () => {
    const { store } = createTestStore();
    await store.nextSeq(); // seq = 1
    await store.nextSeq(); // seq = 2

    const snapshot = await snapshotStore(store);
    expect(snapshot.get('meta:seq')).toBe(2);
  });

  it('returns empty map for empty store', async () => {
    const { store } = createTestStore();
    const snapshot = await snapshotStore(store);
    // Only meta:seq should be present
    expect(snapshot.size).toBeLessThanOrEqual(1);
  });
});

// ─── applyMutations ─────────────────────────────────────────────────────────

describe('applyMutations', () => {
  it('applies put mutations to the store', async () => {
    const { store, data } = createTestStore();

    await applyMutations(store, [
      { op: 'put', key: 'state:a', value: 1 },
      { op: 'put', key: 'state:b', value: 2 },
    ]);

    expect(data.get('state:a')).toBe(1);
    expect(data.get('state:b')).toBe(2);
  });

  it('applies del mutations to the store', async () => {
    const { store, data } = createTestStore(new Map([['state:x', 42]]));

    await applyMutations(store, [{ op: 'del', key: 'state:x' }]);

    expect(data.has('state:x')).toBe(false);
  });

  it('applies mutations in order', async () => {
    const { store, data } = createTestStore();

    await applyMutations(store, [
      { op: 'put', key: 'state:a', value: 1 },
      { op: 'put', key: 'state:a', value: 2 },
      { op: 'put', key: 'state:a', value: 3 },
    ]);

    expect(data.get('state:a')).toBe(3);
  });

  it('is a no-op for empty mutation list', async () => {
    const { store, data } = createTestStore(new Map([['x', 1]]));

    await applyMutations(store, []);

    expect(data.get('x')).toBe(1);
  });
});

// ─── Isolation round-trip ───────────────────────────────────────────────────

describe('isolation round-trip', () => {
  it('clone → mutate → merge produces correct final state', async () => {
    const { store, data } = createTestStore(new Map([
      ['state:a', { value: 'original' }],
      ['state:b', { value: 'untouched' }],
    ]));

    // Snapshot
    const snapshot = await snapshotStore(store);

    // Clone and mutate
    const tracked = createTrackedStore(snapshot, 0);
    await tracked.store.put('state:a', { value: 'modified' });
    await tracked.store.put('state:c', { value: 'new' });

    // Main store should still have original values
    expect(data.get('state:a')).toEqual({ value: 'original' });
    expect(data.has('state:c')).toBe(false);

    // Merge
    await applyMutations(store, tracked.mutations);

    // Now main store has the merged state
    expect(data.get('state:a')).toEqual({ value: 'modified' });
    expect(data.get('state:b')).toEqual({ value: 'untouched' });
    expect(data.get('state:c')).toEqual({ value: 'new' });
  });

  it('multiple clones merging back do not conflict on disjoint keys', async () => {
    const { store, data } = createTestStore();
    const snapshot = await snapshotStore(store);

    // Shard A writes keys prefixed with 'a'
    const shardA = createTrackedStore(snapshot, 0);
    await shardA.store.put('state:a1', 1);
    await shardA.store.put('state:a2', 2);

    // Shard B writes keys prefixed with 'b'
    const shardB = createTrackedStore(snapshot, 0);
    await shardB.store.put('state:b1', 10);
    await shardB.store.put('state:b2', 20);

    // Merge both
    await applyMutations(store, shardA.mutations);
    await applyMutations(store, shardB.mutations);

    expect(data.get('state:a1')).toBe(1);
    expect(data.get('state:a2')).toBe(2);
    expect(data.get('state:b1')).toBe(10);
    expect(data.get('state:b2')).toBe(20);
  });
});
