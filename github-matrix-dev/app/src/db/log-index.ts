/**
 * Layer 2 — In-memory op index + prefix trie + intersection cache.
 *
 * Built by one forward log scan. Updated O(1) per event. Never persisted —
 * always rebuilt from the log on startup (or from a fold-position checkpoint).
 *
 * Memory estimate (1M events):
 *   op index:    9 operators × ~444 KB each ≈ 4 MB
 *   trie:        10–50 MB depending on target path diversity
 *   seqToOffset: 1M × 8 bytes ≈ 8 MB
 */

import type { OPFSLog } from './log-opfs';
import { scanLog } from './log-opfs';
import type { LoggableOperator } from './types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IndexEntry {
  seqs: Uint32Array;     // sorted sequence numbers
  offsets: Uint32Array;  // parallel byte offsets for direct seek
  branches: Uint8Array;  // branch id per seq (0 = main)
}

export interface TrieNode {
  seqs: number[];        // mutable during build; frozen after buildIndex
  offsets: number[];
  children: Map<string, TrieNode>;
}

export interface LogIndex {
  opIndex: Map<LoggableOperator, IndexEntry>;
  trie: TrieNode;                               // root node
  intersectionCache: Map<string, Uint32Array>;  // "${op}:${prefix}" → sorted seqs
  seqToOffset: Map<number, number>;             // seq → byte offset
}

// ─── Internal mutable index used only during buildIndex ──────────────────────

interface MutableIndexEntry {
  seqs: number[];
  offsets: number[];
  branches: number[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTrieNode(): TrieNode {
  return { seqs: [], offsets: [], children: new Map() };
}

// ─── trieInsert ───────────────────────────────────────────────────────────────

/**
 * Insert a (seq, offset) pair at every node along the target path so that
 * trieQuery at any depth prefix returns correct results.
 *
 * e.g. target 'attorneys.alice' updates nodes:
 *   root → "attorneys" → "alice"
 * and also pushes to the root and "attorneys" nodes so
 * trieQuery(root, 'attorneys') returns seqs for all attorneys.* targets.
 */
export function trieInsert(
  root: TrieNode,
  target: string,
  seq: number,
  offset: number,
): void {
  let node = root;
  node.seqs.push(seq);
  node.offsets.push(offset);

  const segments = target.split('.');
  for (const seg of segments) {
    let child = node.children.get(seg);
    if (!child) {
      child = makeTrieNode();
      node.children.set(seg, child);
    }
    node = child;
    node.seqs.push(seq);
    node.offsets.push(offset);
  }
}

// ─── trieCollect ──────────────────────────────────────────────────────────────

/**
 * Collect all seq numbers in the subtree rooted at node.
 * Returns a sorted Uint32Array.
 */
export function trieCollect(node: TrieNode): Uint32Array {
  // The node already holds seqs for its entire subtree (pushed at every level
  // in trieInsert), so a simple sort of node.seqs is sufficient.
  const arr = new Uint32Array(node.seqs);
  arr.sort();
  return arr;
}

// ─── trieQuery ────────────────────────────────────────────────────────────────

/**
 * Return sorted seqs for all targets whose path starts with prefix.
 * prefix is dot-separated (e.g. 'attorneys' or 'attorneys.alice').
 */
export function trieQuery(root: TrieNode, prefix: string): Uint32Array {
  let node: TrieNode | undefined = root;
  for (const seg of prefix.split('.')) {
    node = node.children.get(seg);
    if (!node) return new Uint32Array(0);
  }
  return trieCollect(node);
}

// ─── mergeSorted ──────────────────────────────────────────────────────────────

/**
 * Two-pointer O(n+m) intersection of two sorted Uint32Arrays.
 * Returns a sorted Uint32Array containing values present in both.
 */
export function mergeSorted(a: Uint32Array, b: Uint32Array): Uint32Array {
  const result: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push(a[i]);
      i++;
      j++;
    } else if (a[i] < b[j]) {
      i++;
    } else {
      j++;
    }
  }
  return new Uint32Array(result);
}

// ─── invalidateIntersectionCache ──────────────────────────────────────────────

/**
 * Remove cache entries that could be stale after adding an event with the
 * given op and target prefix. Called by updateIndex after every new event.
 */
export function invalidateIntersectionCache(
  index: LogIndex,
  op?: string,
  prefix?: string,
): void {
  if (!op && !prefix) {
    index.intersectionCache.clear();
    return;
  }
  for (const key of index.intersectionCache.keys()) {
    if ((op && key.startsWith(op + ':')) || (prefix && key.includes(prefix))) {
      index.intersectionCache.delete(key);
    }
  }
}

// ─── getIntersection ─────────────────────────────────────────────────────────

/**
 * Return seqs that have both the given op and a target under the given prefix.
 * Results are cached; cache is invalidated by updateIndex.
 */
export function getIntersection(
  index: LogIndex,
  op: LoggableOperator,
  prefix: string,
): Uint32Array {
  const cacheKey = `${op}:${prefix}`;
  const cached = index.intersectionCache.get(cacheKey);
  if (cached) return cached;

  const opEntry = index.opIndex.get(op);
  const opSeqs = opEntry?.seqs ?? new Uint32Array(0);
  const prefixSeqs = trieQuery(index.trie, prefix);

  const result = mergeSorted(opSeqs, prefixSeqs);
  index.intersectionCache.set(cacheKey, result);
  return result;
}

// ─── updateIndex ──────────────────────────────────────────────────────────────

/**
 * O(1) incremental update after appending a single event.
 * Extends the mutable arrays in the op index and trie, then invalidates
 * any stale intersection cache entries.
 */
export function updateIndex(
  index: LogIndex,
  event: { op: LoggableOperator; target: string; seq: number },
  byteOffset: number,
  branchId = 0,
): void {
  // Op index — append by converting to mutable form temporarily.
  // We keep a parallel mutable shadow by extending the typed arrays.
  let entry = index.opIndex.get(event.op);
  if (!entry) {
    entry = {
      seqs: new Uint32Array(0),
      offsets: new Uint32Array(0),
      branches: new Uint8Array(0),
    };
    index.opIndex.set(event.op, entry);
  }

  // Grow the typed arrays by 1 (amortized cost acceptable for live updates).
  const newSeqs = new Uint32Array(entry.seqs.length + 1);
  newSeqs.set(entry.seqs);
  newSeqs[entry.seqs.length] = event.seq;

  const newOffsets = new Uint32Array(entry.offsets.length + 1);
  newOffsets.set(entry.offsets);
  newOffsets[entry.offsets.length] = byteOffset;

  const newBranches = new Uint8Array(entry.branches.length + 1);
  newBranches.set(entry.branches);
  newBranches[entry.branches.length] = branchId;

  entry.seqs = newSeqs;
  entry.offsets = newOffsets;
  entry.branches = newBranches;
  index.opIndex.set(event.op, entry);

  // Trie — insert into the live (mutable) trie.
  trieInsert(index.trie, event.target, event.seq, byteOffset);

  // seqToOffset map
  index.seqToOffset.set(event.seq, byteOffset);

  // Invalidate stale intersection cache entries for this op and target prefix.
  invalidateIntersectionCache(index, event.op, event.target);
}

// ─── buildIndex ───────────────────────────────────────────────────────────────

/**
 * Build a complete LogIndex from one forward scan of the log.
 * This is synchronous because scanLog() uses the SyncAccessHandle.
 */
export function buildIndex(log: OPFSLog): LogIndex {
  const mutableOp = new Map<LoggableOperator, MutableIndexEntry>();
  const root = makeTrieNode();
  const seqToOffset = new Map<number, number>();

  for (const { event, byteOffset } of scanLog(log)) {
    // Op index
    let m = mutableOp.get(event.op);
    if (!m) {
      m = { seqs: [], offsets: [], branches: [] };
      mutableOp.set(event.op, m);
    }
    m.seqs.push(event.seq);
    m.offsets.push(byteOffset);
    m.branches.push(0);

    // Trie
    trieInsert(root, event.target, event.seq, byteOffset);

    // seqToOffset
    seqToOffset.set(event.seq, byteOffset);
  }

  // Freeze mutable arrays into typed arrays.
  const opIndex = new Map<LoggableOperator, IndexEntry>();
  for (const [op, m] of mutableOp) {
    opIndex.set(op, {
      seqs: new Uint32Array(m.seqs),
      offsets: new Uint32Array(m.offsets),
      branches: new Uint8Array(m.branches),
    });
  }

  return {
    opIndex,
    trie: root,
    intersectionCache: new Map(),
    seqToOffset,
  };
}
