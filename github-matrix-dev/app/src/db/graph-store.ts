/**
 * CSR (Compressed Sparse Row) graph store for efficient traversal.
 *
 * Converts the adjacency-list graph (graph.ts) into a compact CSR format
 * suitable for CPU BFS, connected components, and GPU upload.
 *
 * Memory: 100K nodes × 10 edges avg ≈ 6 MB.
 *         1M  nodes × 10 edges avg ≈ 60 MB.
 */

import type { EoStore } from './encrypted-store';
import type { CardBuffer } from './card-encoder';
import { fnv1a } from './card-encoder';

// ─── Types ──────────────────────────────────────────────────────────────

export interface CSRGraph {
  nodeCount: number;
  edgeCount: number;
  /** Length = nodeCount + 1. offsets[i]..offsets[i+1] is the edge range for node i. */
  offsets: Uint32Array;
  /** Length = edgeCount. Packed neighbor indices (into the same node array). */
  edges: Uint32Array;
  /** targetHash → dense node index. */
  hashToIndex: Map<number, number>;
  /** Dense node index → targetHash. */
  indexToHash: Uint32Array;
}

/** Pending edge mutations accumulated between CSR rebuilds. */
export interface PendingEdges {
  added: Map<string, Set<string>>;   // "sourceHash" → Set<"destHash"> (string keys for map compat)
  removed: Map<string, Set<string>>;
  count: number;
}

// ─── Build ──────────────────────────────────────────────────────────────

/**
 * Build a CSR graph from the adjacency list in IDB + the entity set from CardBuffer.
 *
 * 1. Enumerate all entities from CardBuffer → dense index mapping.
 * 2. Read all forward edges from graph:fwd:* via store.iterator.
 * 3. Two-pass: count degrees, then fill edge array.
 */
export async function buildCSR(store: EoStore, cardBuffer: CardBuffer): Promise<CSRGraph> {
  // 1. Build entity index from CardBuffer
  const allCards = cardBuffer.toArray();
  const nodeCount = allCards.length;
  const hashToIndex = new Map<number, number>();
  const indexToHash = new Uint32Array(nodeCount);

  for (let i = 0; i < nodeCount; i++) {
    const h = allCards[i].targetHash;
    hashToIndex.set(h, i);
    indexToHash[i] = h;
  }

  // 2. Read all forward edges
  const edgeEntries = await store.iterator('graph:fwd:');
  const rawEdges: [number, number][] = [];

  for (const [, edge] of edgeEntries) {
    const srcHash = fnv1a(edge.source);
    const dstHash = fnv1a(edge.dest);
    const srcIdx = hashToIndex.get(srcHash);
    const dstIdx = hashToIndex.get(dstHash);
    if (srcIdx !== undefined && dstIdx !== undefined) {
      rawEdges.push([srcIdx, dstIdx]);
    }
  }

  // 3. Two-pass CSR construction
  const offsets = new Uint32Array(nodeCount + 1);

  // Pass 1: count out-degree per node
  for (const [src] of rawEdges) {
    offsets[src + 1]++;
  }

  // Prefix sum
  for (let i = 1; i <= nodeCount; i++) {
    offsets[i] += offsets[i - 1];
  }

  const edgeCount = offsets[nodeCount];
  const edges = new Uint32Array(edgeCount);
  const cursor = new Uint32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) cursor[i] = offsets[i];

  // Pass 2: fill edge array
  for (const [src, dst] of rawEdges) {
    edges[cursor[src]++] = dst;
  }

  return { nodeCount, edgeCount, offsets, edges, hashToIndex, indexToHash };
}

// ─── BFS ────────────────────────────────────────────────────────────────

/**
 * CPU BFS from a start node. Returns the set of reachable targetHashes
 * within maxDepth hops. At 100K nodes, 3 hops, ~1000 reachable: <1ms.
 */
export function bfs(graph: CSRGraph, startHash: number, maxDepth: number): Set<number> {
  const startIdx = graph.hashToIndex.get(startHash);
  if (startIdx === undefined) return new Set();

  const visited = new Uint8Array(graph.nodeCount);
  visited[startIdx] = 1;
  let frontier = [startIdx];
  const result = new Set<number>();
  result.add(startHash);

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const node of frontier) {
      const start = graph.offsets[node];
      const end = graph.offsets[node + 1];
      for (let e = start; e < end; e++) {
        const neighbor = graph.edges[e];
        if (!visited[neighbor]) {
          visited[neighbor] = 1;
          next.push(neighbor);
          result.add(graph.indexToHash[neighbor]);
        }
      }
    }
    frontier = next;
  }

  return result;
}

/**
 * BFS returning node indices instead of hashes (useful for GPU comparison).
 */
export function bfsIndices(graph: CSRGraph, startIdx: number, maxDepth: number): Uint32Array {
  const visited = new Uint8Array(graph.nodeCount);
  visited[startIdx] = 1;
  let frontier = [startIdx];
  const result = [startIdx];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const node of frontier) {
      const start = graph.offsets[node];
      const end = graph.offsets[node + 1];
      for (let e = start; e < end; e++) {
        const neighbor = graph.edges[e];
        if (!visited[neighbor]) {
          visited[neighbor] = 1;
          next.push(neighbor);
          result.push(neighbor);
        }
      }
    }
    frontier = next;
  }

  return new Uint32Array(result);
}

// ─── Connected Components (Union-Find) ──────────────────────────────────

/**
 * Find connected components using union-find with path compression
 * and union by rank. Returns targetHash → componentId mapping.
 */
export function connectedComponents(graph: CSRGraph): Map<number, number> {
  const n = graph.nodeCount;
  const parent = new Uint32Array(n);
  const rank = new Uint8Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path halving
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) { parent[ra] = rb; }
    else if (rank[ra] > rank[rb]) { parent[rb] = ra; }
    else { parent[rb] = ra; rank[ra]++; }
  }

  // Process all edges
  for (let node = 0; node < n; node++) {
    const start = graph.offsets[node];
    const end = graph.offsets[node + 1];
    for (let e = start; e < end; e++) {
      union(node, graph.edges[e]);
    }
  }

  // Build result map with canonical component IDs
  const componentMap = new Map<number, number>();
  const componentIds = new Map<number, number>();
  let nextComponentId = 0;

  for (let i = 0; i < n; i++) {
    const root = find(i);
    let cid = componentIds.get(root);
    if (cid === undefined) {
      cid = nextComponentId++;
      componentIds.set(root, cid);
    }
    componentMap.set(graph.indexToHash[i], cid);
  }

  return componentMap;
}

// ─── Pending Edges (Incremental Updates) ─────────────────────────────────

const REBUILD_THRESHOLD = 1000;

export function createPendingEdges(): PendingEdges {
  return { added: new Map(), removed: new Map(), count: 0 };
}

export function addPendingEdge(pending: PendingEdges, srcHash: number, dstHash: number): void {
  const key = String(srcHash);
  const val = String(dstHash);
  // Cancel out a pending removal
  const removedSet = pending.removed.get(key);
  if (removedSet?.has(val)) {
    removedSet.delete(val);
    if (removedSet.size === 0) pending.removed.delete(key);
    pending.count--;
    return;
  }
  let addedSet = pending.added.get(key);
  if (!addedSet) { addedSet = new Set(); pending.added.set(key, addedSet); }
  if (!addedSet.has(val)) {
    addedSet.add(val);
    pending.count++;
  }
}

export function removePendingEdge(pending: PendingEdges, srcHash: number, dstHash: number): void {
  const key = String(srcHash);
  const val = String(dstHash);
  // Cancel out a pending addition
  const addedSet = pending.added.get(key);
  if (addedSet?.has(val)) {
    addedSet.delete(val);
    if (addedSet.size === 0) pending.added.delete(key);
    pending.count--;
    return;
  }
  let removedSet = pending.removed.get(key);
  if (!removedSet) { removedSet = new Set(); pending.removed.set(key, removedSet); }
  if (!removedSet.has(val)) {
    removedSet.add(val);
    pending.count++;
  }
}

export function shouldRebuild(pending: PendingEdges): boolean {
  return pending.count >= REBUILD_THRESHOLD;
}

/**
 * BFS that overlays pending edge mutations on the CSR graph.
 * Used between CSR rebuilds for small incremental changes.
 */
export function bfsWithPending(
  graph: CSRGraph,
  pending: PendingEdges,
  startHash: number,
  maxDepth: number,
): Set<number> {
  const startIdx = graph.hashToIndex.get(startHash);
  if (startIdx === undefined) return new Set();

  const visited = new Set<number>();
  visited.add(startIdx);
  let frontier = [startIdx];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const node of frontier) {
      const nodeHash = graph.indexToHash[node];
      const removedForNode = pending.removed.get(String(nodeHash));

      // CSR edges
      const start = graph.offsets[node];
      const end = graph.offsets[node + 1];
      for (let e = start; e < end; e++) {
        const neighbor = graph.edges[e];
        const neighborHash = graph.indexToHash[neighbor];
        // Skip if this edge was removed
        if (removedForNode?.has(String(neighborHash))) continue;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }

      // Pending added edges
      const addedForNode = pending.added.get(String(nodeHash));
      if (addedForNode) {
        for (const dstStr of addedForNode) {
          const dstHash = Number(dstStr);
          const dstIdx = graph.hashToIndex.get(dstHash);
          if (dstIdx !== undefined && !visited.has(dstIdx)) {
            visited.add(dstIdx);
            next.push(dstIdx);
          }
        }
      }
    }
    frontier = next;
  }

  // Convert indices to hashes
  const result = new Set<number>();
  for (const idx of visited) {
    result.add(graph.indexToHash[idx]);
  }
  return result;
}

// ─── Serialization ──────────────────────────────────────────────────────

/**
 * Serialize CSR graph to a single Uint8Array for .eodb frame storage.
 *
 * Layout:
 *   [4 bytes] nodeCount (uint32 LE)
 *   [4 bytes] edgeCount (uint32 LE)
 *   [nodeCount * 4] indexToHash (uint32[] LE)
 *   [(nodeCount+1) * 4] offsets (uint32[] LE)
 *   [edgeCount * 4] edges (uint32[] LE)
 */
export function serializeCSR(graph: CSRGraph): Uint8Array {
  const headerSize = 8;
  const hashSize = graph.nodeCount * 4;
  const offsetsSize = (graph.nodeCount + 1) * 4;
  const edgesSize = graph.edgeCount * 4;
  const totalSize = headerSize + hashSize + offsetsSize + edgesSize;

  const buf = new Uint8Array(totalSize);
  const dv = new DataView(buf.buffer);

  let off = 0;
  dv.setUint32(off, graph.nodeCount, true); off += 4;
  dv.setUint32(off, graph.edgeCount, true); off += 4;

  // indexToHash
  for (let i = 0; i < graph.nodeCount; i++) {
    dv.setUint32(off, graph.indexToHash[i], true); off += 4;
  }

  // offsets
  for (let i = 0; i <= graph.nodeCount; i++) {
    dv.setUint32(off, graph.offsets[i], true); off += 4;
  }

  // edges
  for (let i = 0; i < graph.edgeCount; i++) {
    dv.setUint32(off, graph.edges[i], true); off += 4;
  }

  return buf;
}

/**
 * Deserialize CSR graph from a Uint8Array produced by serializeCSR.
 */
export function deserializeCSR(data: Uint8Array): CSRGraph {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  let off = 0;
  const nodeCount = dv.getUint32(off, true); off += 4;
  const edgeCount = dv.getUint32(off, true); off += 4;

  const indexToHash = new Uint32Array(nodeCount);
  const hashToIndex = new Map<number, number>();
  for (let i = 0; i < nodeCount; i++) {
    const h = dv.getUint32(off, true); off += 4;
    indexToHash[i] = h;
    hashToIndex.set(h, i);
  }

  const offsets = new Uint32Array(nodeCount + 1);
  for (let i = 0; i <= nodeCount; i++) {
    offsets[i] = dv.getUint32(off, true); off += 4;
  }

  const edges = new Uint32Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) {
    edges[i] = dv.getUint32(off, true); off += 4;
  }

  return { nodeCount, edgeCount, offsets, edges, hashToIndex, indexToHash };
}

/**
 * Create an empty CSR graph (no nodes, no edges).
 */
export function emptyCSR(): CSRGraph {
  return {
    nodeCount: 0,
    edgeCount: 0,
    offsets: new Uint32Array(1),
    edges: new Uint32Array(0),
    hashToIndex: new Map(),
    indexToHash: new Uint32Array(0),
  };
}
