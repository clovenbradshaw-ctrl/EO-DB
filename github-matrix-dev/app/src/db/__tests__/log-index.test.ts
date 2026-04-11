/**
 * Tests for db/log-index.ts
 */

import { describe, it, expect } from 'vitest';
import {
  buildIndex,
  updateIndex,
  trieQuery,
  getIntersection,
  mergeSorted,
  trieInsert,
} from '../log-index';
import { appendEvent } from '../log-opfs';
import type { EoEvent } from '../types';
import { createMemoryLog } from './_memory-log';

function makeEvent(
  seq: number,
  op: EoEvent['op'],
  target: string,
  operand: unknown = null,
): EoEvent {
  return {
    seq,
    op,
    target,
    operand,
    agent: 'test',
    ts: new Date().toISOString(),
    acquired_ts: new Date().toISOString(),
  };
}

// ─── mergeSorted ─────────────────────────────────────────────────────────────

describe('mergeSorted', () => {
  it('returns intersection of two sorted arrays', () => {
    const a = new Uint32Array([1, 3, 5, 7]);
    const b = new Uint32Array([3, 5, 9]);
    expect([...mergeSorted(a, b)]).toEqual([3, 5]);
  });

  it('returns empty when no overlap', () => {
    expect([...mergeSorted(new Uint32Array([1, 2]), new Uint32Array([3, 4]))]).toEqual([]);
  });

  it('handles empty inputs', () => {
    expect([...mergeSorted(new Uint32Array(0), new Uint32Array([1]))]).toEqual([]);
    expect([...mergeSorted(new Uint32Array([1]), new Uint32Array(0))]).toEqual([]);
  });

  it('handles identical arrays', () => {
    const a = new Uint32Array([2, 4, 6]);
    expect([...mergeSorted(a, a)]).toEqual([2, 4, 6]);
  });
});

// ─── buildIndex ──────────────────────────────────────────────────────────────

describe('buildIndex', () => {
  it('opIndex DEF.seqs is sorted after scanning log', () => {
    const log = createMemoryLog();
    appendEvent(log, makeEvent(1, 'DEF', 'attorneys.alice', 42));
    appendEvent(log, makeEvent(2, 'INS', 'attorneys.bob'));
    appendEvent(log, makeEvent(3, 'DEF', 'attorneys.bob', 99));

    const index = buildIndex(log);
    const defSeqs = [...(index.opIndex.get('DEF')?.seqs ?? [])];
    expect(defSeqs).toEqual([1, 3]);
  });

  it('seqToOffset maps all events', () => {
    const log = createMemoryLog();
    appendEvent(log, makeEvent(1, 'INS', 'x'));
    appendEvent(log, makeEvent(2, 'DEF', 'x', 1));
    const index = buildIndex(log);
    expect(index.seqToOffset.has(1)).toBe(true);
    expect(index.seqToOffset.has(2)).toBe(true);
  });

  it('empty log produces empty index', () => {
    const log = createMemoryLog();
    const index = buildIndex(log);
    expect(index.opIndex.size).toBe(0);
    expect(index.seqToOffset.size).toBe(0);
  });
});

// ─── trieQuery ────────────────────────────────────────────────────────────────

describe('trieQuery', () => {
  it("returns seqs for all targets under 'attorneys.*'", () => {
    const log = createMemoryLog();
    appendEvent(log, makeEvent(1, 'INS', 'attorneys.alice'));
    appendEvent(log, makeEvent(2, 'INS', 'attorneys.bob'));
    appendEvent(log, makeEvent(3, 'INS', 'judges.carol'));

    const index = buildIndex(log);
    const seqs = [...trieQuery(index.trie, 'attorneys')];
    expect(seqs).toContain(1);
    expect(seqs).toContain(2);
    expect(seqs).not.toContain(3);
  });

  it('returns empty for a prefix that does not exist', () => {
    const log = createMemoryLog();
    appendEvent(log, makeEvent(1, 'INS', 'a.b'));
    const index = buildIndex(log);
    expect([...trieQuery(index.trie, 'z')]).toEqual([]);
  });

  it('exact target prefix returns only that target', () => {
    const log = createMemoryLog();
    appendEvent(log, makeEvent(1, 'DEF', 'attorneys.alice', 1));
    appendEvent(log, makeEvent(2, 'DEF', 'attorneys.alice.details', 2));
    appendEvent(log, makeEvent(3, 'DEF', 'attorneys.bob', 3));

    const index = buildIndex(log);
    const seqs = [...trieQuery(index.trie, 'attorneys.alice')];
    expect(seqs).toContain(1);
    expect(seqs).toContain(2); // child of attorneys.alice
    expect(seqs).not.toContain(3);
  });
});

// ─── getIntersection ─────────────────────────────────────────────────────────

describe('getIntersection', () => {
  it("returns DEF seqs under 'attorneys.*'", () => {
    const log = createMemoryLog();
    appendEvent(log, makeEvent(1, 'INS', 'attorneys.alice'));
    appendEvent(log, makeEvent(2, 'DEF', 'attorneys.alice', 'v1'));
    appendEvent(log, makeEvent(3, 'DEF', 'judges.bob', 'v2'));

    const index = buildIndex(log);
    const seqs = [...getIntersection(index, 'DEF', 'attorneys')];
    expect(seqs).toContain(2);
    expect(seqs).not.toContain(1); // INS, not DEF
    expect(seqs).not.toContain(3); // wrong prefix
  });

  it('caches the result on second call', () => {
    const log = createMemoryLog();
    appendEvent(log, makeEvent(1, 'DEF', 'x.y', 1));
    const index = buildIndex(log);

    const r1 = getIntersection(index, 'DEF', 'x');
    const r2 = getIntersection(index, 'DEF', 'x');
    expect(r1).toBe(r2); // same reference → cached
  });
});

// ─── updateIndex ─────────────────────────────────────────────────────────────

describe('updateIndex', () => {
  it('adds new event to op index and trie', () => {
    const log = createMemoryLog();
    appendEvent(log, makeEvent(1, 'INS', 'a.b'));
    const index = buildIndex(log);

    const ev2 = makeEvent(2, 'DEF', 'a.b', 99);
    appendEvent(log, ev2);
    updateIndex(index, ev2, index.seqToOffset.get(1)! + 100, 0);

    const defEntry = index.opIndex.get('DEF');
    expect(defEntry).toBeDefined();
    expect([...(defEntry!.seqs)]).toContain(2);
  });

  it('invalidates intersection cache after update', () => {
    const log = createMemoryLog();
    appendEvent(log, makeEvent(1, 'DEF', 'attorneys.alice', 1));
    const index = buildIndex(log);

    // Warm the cache
    const before = getIntersection(index, 'DEF', 'attorneys');
    expect(before.length).toBe(1);

    // Add a new event and update index
    const ev2 = makeEvent(2, 'DEF', 'attorneys.bob', 2);
    const { byteOffset } = appendEvent(log, ev2);
    updateIndex(index, ev2, byteOffset, 0);

    // Cache should be invalidated; new call returns updated result
    const after = getIntersection(index, 'DEF', 'attorneys');
    expect(after.length).toBe(2);
    expect(after).not.toBe(before); // new reference
  });

  it('updates seqToOffset', () => {
    const log = createMemoryLog();
    const index = buildIndex(log);
    const ev = makeEvent(5, 'INS', 'z');
    appendEvent(log, ev);
    updateIndex(index, ev, 999, 0);
    expect(index.seqToOffset.get(5)).toBe(999);
  });
});
