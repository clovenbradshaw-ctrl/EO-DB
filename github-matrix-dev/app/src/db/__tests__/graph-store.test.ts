/**
 * Graph store tests — CSR construction, BFS, connected components,
 * serialization round-trip, and pending edge overlay.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildCSR,
  bfs,
  bfsIndices,
  connectedComponents,
  serializeCSR,
  deserializeCSR,
  emptyCSR,
  createPendingEdges,
  addPendingEdge,
  removePendingEdge,
  bfsWithPending,
  shouldRebuild,
  type CSRGraph,
} from '../graph-store';
import { fnv1a, CardBuffer } from '../card-encoder';
import type { EoStore } from '../encrypted-store';
import type { Card } from '../card-encoder';

// ─── Test helpers ────────────────────────────────────────────────────────

function createTestStore(): EoStore {
  const data = new Map<string, any>();
  let seq = 0;
  return {
    async get(key: string) { return data.has(key) ? data.get(key) : null; },
    async put(key: string, value: any) { data.set(key, value); },
    async del(key: string) { data.delete(key); },
    async iterator(prefix: string) {
      const results: [string, any][] = [];
      for (const [key, value] of data.entries()) {
        if (key >= prefix && key <= prefix + '\uffff') results.push([key, value]);
      }
      results.sort((a, b) => a[0].localeCompare(b[0]));
      return results;
    },
    async nextSeq() { return ++seq; },
    async getCurrentSeq() { return seq; },
    close() {},
  } as EoStore;
}

function makeCard(target: string, overrides?: Partial<Card>): Card {
  return {
    targetHash: fnv1a(target),
    temporalSeq: 1,
    lastTimestamp: 1000,
    dominantCell: 0,
    recentCell: 0,
    helixReach: 0,
    cellSpread: 1,
    eventCount: 1,
    graphDegree: 0,
    ...overrides,
  };
}

function addEdgeToStore(store: EoStore, source: string, dest: string, seq: number = 1) {
  const edge = { source, dest, seq };
  return Promise.all([
    store.put(`graph:fwd:${source}:${dest}`, edge),
    store.put(`graph:rev:${dest}:${source}`, edge),
  ]);
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('graph-store', () => {
  let store: EoStore;

  beforeEach(() => {
    store = createTestStore();
  });

  describe('emptyCSR', () => {
    it('returns a valid empty graph', () => {
      const g = emptyCSR();
      expect(g.nodeCount).toBe(0);
      expect(g.edgeCount).toBe(0);
      expect(g.offsets.length).toBe(1);
      expect(g.offsets[0]).toBe(0);
      expect(g.edges.length).toBe(0);
    });
  });

  describe('buildCSR', () => {
    it('builds CSR from entities and edges', async () => {
      const buf = new CardBuffer();
      buf.upsert(makeCard('A'));
      buf.upsert(makeCard('B'));
      buf.upsert(makeCard('C'));

      await addEdgeToStore(store, 'A', 'B');
      await addEdgeToStore(store, 'A', 'C');
      await addEdgeToStore(store, 'B', 'C');

      const g = await buildCSR(store, buf);

      expect(g.nodeCount).toBe(3);
      expect(g.edgeCount).toBe(3);
      expect(g.offsets.length).toBe(4);

      // Verify all nodes indexed
      expect(g.hashToIndex.has(fnv1a('A'))).toBe(true);
      expect(g.hashToIndex.has(fnv1a('B'))).toBe(true);
      expect(g.hashToIndex.has(fnv1a('C'))).toBe(true);
    });

    it('skips edges referencing unknown entities', async () => {
      const buf = new CardBuffer();
      buf.upsert(makeCard('A'));
      buf.upsert(makeCard('B'));

      // Edge to C which is not in the CardBuffer
      await addEdgeToStore(store, 'A', 'B');
      await addEdgeToStore(store, 'A', 'C');

      const g = await buildCSR(store, buf);
      expect(g.edgeCount).toBe(1); // Only A→B
    });

    it('handles empty graph', async () => {
      const buf = new CardBuffer();
      buf.upsert(makeCard('A'));

      const g = await buildCSR(store, buf);
      expect(g.nodeCount).toBe(1);
      expect(g.edgeCount).toBe(0);
    });
  });

  describe('bfs', () => {
    let graph: CSRGraph;

    beforeEach(async () => {
      // Build a small graph: A → B → C → D, A → D
      const buf = new CardBuffer();
      buf.upsert(makeCard('A'));
      buf.upsert(makeCard('B'));
      buf.upsert(makeCard('C'));
      buf.upsert(makeCard('D'));

      await addEdgeToStore(store, 'A', 'B');
      await addEdgeToStore(store, 'B', 'C');
      await addEdgeToStore(store, 'C', 'D');
      await addEdgeToStore(store, 'A', 'D');

      graph = await buildCSR(store, buf);
    });

    it('depth 0 returns only start node', () => {
      const result = bfs(graph, fnv1a('A'), 0);
      expect(result.size).toBe(1);
      expect(result.has(fnv1a('A'))).toBe(true);
    });

    it('depth 1 returns direct neighbors', () => {
      const result = bfs(graph, fnv1a('A'), 1);
      expect(result.has(fnv1a('A'))).toBe(true);
      expect(result.has(fnv1a('B'))).toBe(true);
      expect(result.has(fnv1a('D'))).toBe(true);
      // C is 2 hops away
      expect(result.has(fnv1a('C'))).toBe(false);
    });

    it('depth 2 reaches all nodes from A', () => {
      const result = bfs(graph, fnv1a('A'), 2);
      expect(result.size).toBe(4);
    });

    it('returns empty set for unknown start', () => {
      const result = bfs(graph, fnv1a('UNKNOWN'), 3);
      expect(result.size).toBe(0);
    });
  });

  describe('bfsIndices', () => {
    it('returns indices matching bfs hashes', async () => {
      const buf = new CardBuffer();
      buf.upsert(makeCard('X'));
      buf.upsert(makeCard('Y'));
      buf.upsert(makeCard('Z'));

      await addEdgeToStore(store, 'X', 'Y');
      await addEdgeToStore(store, 'Y', 'Z');

      const graph = await buildCSR(store, buf);
      const startIdx = graph.hashToIndex.get(fnv1a('X'))!;
      const indices = bfsIndices(graph, startIdx, 2);

      // All 3 nodes reachable
      expect(indices.length).toBe(3);

      // Convert to hashes and compare with bfs()
      const hashResult = bfs(graph, fnv1a('X'), 2);
      for (const idx of indices) {
        expect(hashResult.has(graph.indexToHash[idx])).toBe(true);
      }
    });
  });

  describe('connectedComponents', () => {
    it('finds separate components', async () => {
      const buf = new CardBuffer();
      buf.upsert(makeCard('A'));
      buf.upsert(makeCard('B'));
      buf.upsert(makeCard('C'));
      buf.upsert(makeCard('D'));

      // Component 1: A ↔ B
      await addEdgeToStore(store, 'A', 'B');
      await addEdgeToStore(store, 'B', 'A');
      // Component 2: C ↔ D
      await addEdgeToStore(store, 'C', 'D');
      await addEdgeToStore(store, 'D', 'C');

      const graph = await buildCSR(store, buf);
      const components = connectedComponents(graph);

      expect(components.size).toBe(4);
      // A and B same component
      expect(components.get(fnv1a('A'))).toBe(components.get(fnv1a('B')));
      // C and D same component
      expect(components.get(fnv1a('C'))).toBe(components.get(fnv1a('D')));
      // Different components
      expect(components.get(fnv1a('A'))).not.toBe(components.get(fnv1a('C')));
    });

    it('single connected component', async () => {
      const buf = new CardBuffer();
      buf.upsert(makeCard('A'));
      buf.upsert(makeCard('B'));
      buf.upsert(makeCard('C'));

      await addEdgeToStore(store, 'A', 'B');
      await addEdgeToStore(store, 'B', 'C');

      const graph = await buildCSR(store, buf);
      const components = connectedComponents(graph);

      const ids = new Set(components.values());
      expect(ids.size).toBe(1);
    });

    it('isolated nodes are separate components', async () => {
      const buf = new CardBuffer();
      buf.upsert(makeCard('A'));
      buf.upsert(makeCard('B'));
      buf.upsert(makeCard('C'));

      // No edges
      const graph = await buildCSR(store, buf);
      const components = connectedComponents(graph);

      const ids = new Set(components.values());
      expect(ids.size).toBe(3);
    });
  });

  describe('serialization', () => {
    it('round-trips CSR through serialize/deserialize', async () => {
      const buf = new CardBuffer();
      buf.upsert(makeCard('A'));
      buf.upsert(makeCard('B'));
      buf.upsert(makeCard('C'));

      await addEdgeToStore(store, 'A', 'B');
      await addEdgeToStore(store, 'B', 'C');
      await addEdgeToStore(store, 'A', 'C');

      const original = await buildCSR(store, buf);
      const serialized = serializeCSR(original);
      const restored = deserializeCSR(serialized);

      expect(restored.nodeCount).toBe(original.nodeCount);
      expect(restored.edgeCount).toBe(original.edgeCount);
      expect(Array.from(restored.offsets)).toEqual(Array.from(original.offsets));
      expect(Array.from(restored.edges)).toEqual(Array.from(original.edges));
      expect(Array.from(restored.indexToHash)).toEqual(Array.from(original.indexToHash));

      // Verify BFS produces same results after round-trip
      const bfsOrig = bfs(original, fnv1a('A'), 3);
      const bfsRestored = bfs(restored, fnv1a('A'), 3);
      expect(bfsRestored).toEqual(bfsOrig);
    });

    it('round-trips empty graph', () => {
      const empty = emptyCSR();
      const serialized = serializeCSR(empty);
      const restored = deserializeCSR(serialized);

      expect(restored.nodeCount).toBe(0);
      expect(restored.edgeCount).toBe(0);
    });
  });

  describe('pending edges', () => {
    it('addPendingEdge and removePendingEdge cancel out', () => {
      const pending = createPendingEdges();
      addPendingEdge(pending, 100, 200);
      expect(pending.count).toBe(1);

      removePendingEdge(pending, 100, 200);
      expect(pending.count).toBe(0);
    });

    it('removePendingEdge then addPendingEdge cancel out', () => {
      const pending = createPendingEdges();
      removePendingEdge(pending, 100, 200);
      expect(pending.count).toBe(1);

      addPendingEdge(pending, 100, 200);
      expect(pending.count).toBe(0);
    });

    it('shouldRebuild triggers at threshold', () => {
      const pending = createPendingEdges();
      for (let i = 0; i < 999; i++) {
        addPendingEdge(pending, i, i + 1);
      }
      expect(shouldRebuild(pending)).toBe(false);
      addPendingEdge(pending, 9999, 10000);
      expect(shouldRebuild(pending)).toBe(true);
    });

    it('bfsWithPending includes added edges', async () => {
      const buf = new CardBuffer();
      buf.upsert(makeCard('A'));
      buf.upsert(makeCard('B'));
      buf.upsert(makeCard('C'));

      await addEdgeToStore(store, 'A', 'B');
      const graph = await buildCSR(store, buf);

      // Without pending: A reaches B but not C
      const before = bfs(graph, fnv1a('A'), 1);
      expect(before.has(fnv1a('B'))).toBe(true);
      expect(before.has(fnv1a('C'))).toBe(false);

      // Add pending edge A → C
      const pending = createPendingEdges();
      addPendingEdge(pending, fnv1a('A'), fnv1a('C'));

      const after = bfsWithPending(graph, pending, fnv1a('A'), 1);
      expect(after.has(fnv1a('B'))).toBe(true);
      expect(after.has(fnv1a('C'))).toBe(true);
    });

    it('bfsWithPending excludes removed edges', async () => {
      const buf = new CardBuffer();
      buf.upsert(makeCard('A'));
      buf.upsert(makeCard('B'));

      await addEdgeToStore(store, 'A', 'B');
      const graph = await buildCSR(store, buf);

      // Remove edge A → B
      const pending = createPendingEdges();
      removePendingEdge(pending, fnv1a('A'), fnv1a('B'));

      const result = bfsWithPending(graph, pending, fnv1a('A'), 1);
      expect(result.has(fnv1a('A'))).toBe(true);
      expect(result.has(fnv1a('B'))).toBe(false);
    });
  });
});
