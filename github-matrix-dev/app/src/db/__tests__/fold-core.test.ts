/**
 * fold-core — unit tests for the Phase A constitutive primitives.
 *
 * Narrow, deterministic tests over the pure pieces of fold-core. The
 * whole-system byte-identical property is covered by
 * fold-determinism.test.ts; this file exercises the primitives in
 * isolation so a regression in any one of them fails with a pointed
 * error message instead of a multi-layer property-test failure.
 */

import { describe, it, expect } from 'vitest';
import {
  AddressingHorizon,
  HELIX_LEVEL,
  sortByHelixLevel,
  isHelixValid,
  mergeOperand,
  isFormulaOperand,
  deepEqual,
} from '../fold-core';
import type { EoStore, IteratorOpts } from '../encrypted-store';
import type { EoEventInput, HelixPosition, LoggableOperator } from '../types';

// ─── Store fixture ───────────────────────────────────────────────────────────

function createStubStore(initialSeq = 0): EoStore {
  const data = new Map<string, unknown>();
  let seq = initialSeq;
  return {
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async put(key, value) { data.set(key, value); },
    async del(key) { data.delete(key); },
    async iterator(prefix: string, opts?: IteratorOpts) {
      const results: [string, unknown][] = [];
      for (const [key, value] of data.entries()) {
        if (key.startsWith(prefix)) {
          if (opts?.afterKey && key <= opts.afterKey) continue;
          results.push([key, value]);
        }
      }
      results.sort((a, b) => a[0].localeCompare(b[0]));
      if (opts?.limit !== undefined) results.length = Math.min(results.length, opts.limit);
      return results;
    },
    async nextSeq() { seq += 1; return seq; },
    async getCurrentSeq() { return seq; },
    close() {},
  };
}

// ─── AddressingHorizon ───────────────────────────────────────────────────────

describe('AddressingHorizon', () => {
  it('reserves a contiguous range from store.nextSeq', async () => {
    const store = createStubStore();
    const horizon = new AddressingHorizon(store);
    await horizon.reserve(5);

    expect(horizon.totalReserved).toBe(5);
    expect(horizon.remaining).toBe(5);

    const taken = [horizon.take(), horizon.take(), horizon.take(), horizon.take(), horizon.take()];
    expect(taken).toEqual([1, 2, 3, 4, 5]);
    expect(horizon.remaining).toBe(0);
  });

  it('picks up wherever store.nextSeq last left off', async () => {
    const store = createStubStore(10);
    const horizon = new AddressingHorizon(store);
    await horizon.reserve(3);
    expect(horizon.take()).toBe(11);
    expect(horizon.take()).toBe(12);
    expect(horizon.take()).toBe(13);
  });

  it('supports reserving additional seqs later in the same horizon', async () => {
    const store = createStubStore();
    const horizon = new AddressingHorizon(store);
    await horizon.reserve(2);
    expect(horizon.take()).toBe(1);
    expect(horizon.take()).toBe(2);

    await horizon.reserve(2);
    expect(horizon.remaining).toBe(2);
    expect(horizon.take()).toBe(3);
    expect(horizon.take()).toBe(4);
  });

  it('throws when take() is called beyond the reserved range', async () => {
    const store = createStubStore();
    const horizon = new AddressingHorizon(store);
    await horizon.reserve(2);
    horizon.take();
    horizon.take();
    expect(() => horizon.take()).toThrow(/exhausted/i);
  });

  it('never hands out the same seq twice under strictly sequential use', async () => {
    // Property-style check: build a horizon with 1_000 seqs and confirm
    // every taken value is unique and in order.
    const store = createStubStore();
    const horizon = new AddressingHorizon(store);
    await horizon.reserve(1_000);

    const seen = new Set<number>();
    let prev = -1;
    for (let i = 0; i < 1_000; i++) {
      const s = horizon.take();
      expect(s).toBeGreaterThan(prev);
      expect(seen.has(s)).toBe(false);
      seen.add(s);
      prev = s;
    }
    expect(seen.size).toBe(1_000);
  });
});

// ─── sortByHelixLevel ────────────────────────────────────────────────────────

describe('sortByHelixLevel', () => {
  function mk(op: EoEventInput['op'], target = 'tgt'): EoEventInput {
    return {
      op,
      target,
      operand: {},
      agent: '@harness:example.com',
      ts: '2025-01-01T00:00:00.000Z',
      acquired_ts: '2025-01-01T00:00:00.000Z',
    };
  }

  it('groups events in ascending helix level order', () => {
    const events: EoEventInput[] = [
      mk('DEF'), mk('INS'), mk('EVA'), mk('CON'), mk('SYN'), mk('SEG'),
    ];
    const waves = sortByHelixLevel(events);
    const levels = waves.map((w) => w.level);
    expect(levels).toEqual([1, 2, 3, 4, 5]);
    // SEG and CON share level 2 — both end up in a single wave
    const level2 = waves.find((w) => w.level === 2)!;
    expect(level2.events.map((e) => e.op)).toEqual(['CON', 'SEG']);
  });

  it('preserves arrival order within a level (stable)', () => {
    const events: EoEventInput[] = [
      mk('DEF', 'a'), mk('DEF', 'b'), mk('DEF', 'c'),
    ];
    const [wave] = sortByHelixLevel(events);
    expect(wave.events.map((e) => e.target)).toEqual(['a', 'b', 'c']);
  });

  it('drops REC (system-generated, no helix level)', () => {
    const events: EoEventInput[] = [mk('INS'), mk('REC'), mk('DEF')];
    const waves = sortByHelixLevel(events);
    const opsSeen = waves.flatMap((w) => w.events.map((e) => e.op));
    expect(opsSeen).toEqual(['INS', 'DEF']);
  });

  it('HELIX_LEVEL has the expected canonical assignment', () => {
    expect(HELIX_LEVEL.NUL).toBe(0);
    expect(HELIX_LEVEL.SIG).toBe(0);
    expect(HELIX_LEVEL.INS).toBe(1);
    expect(HELIX_LEVEL.SEG).toBe(2);
    expect(HELIX_LEVEL.CON).toBe(2);
    expect(HELIX_LEVEL.SYN).toBe(3);
    expect(HELIX_LEVEL.DEF).toBe(4);
    expect(HELIX_LEVEL.EVA).toBe(5);
    expect(HELIX_LEVEL.REC).toBeUndefined();
  });
});

// ─── isHelixValid ────────────────────────────────────────────────────────────

describe('isHelixValid', () => {
  function pos(declared: LoggableOperator[]): HelixPosition {
    return { declared, firstSeq: {}, lastSeq: {}, count: {} };
  }

  it('NUL/SIG/REC are always valid', () => {
    for (const op of ['NUL', 'SIG', 'REC'] as LoggableOperator[]) {
      expect(isHelixValid(op, null)).toBe(true);
      expect(isHelixValid(op, pos([]))).toBe(true);
      expect(isHelixValid(op, pos(['INS']))).toBe(true);
    }
  });

  it('INS is valid only if the target is not yet INSed', () => {
    expect(isHelixValid('INS', null)).toBe(true);
    expect(isHelixValid('INS', pos([]))).toBe(true);
    expect(isHelixValid('INS', pos(['INS']))).toBe(false);
    expect(isHelixValid('INS', pos(['INS', 'DEF']))).toBe(false);
  });

  it('SEG/CON/SYN/DEF/EVA require INS to have fired', () => {
    for (const op of ['SEG', 'CON', 'SYN', 'DEF', 'EVA'] as LoggableOperator[]) {
      expect(isHelixValid(op, null)).toBe(false);
      expect(isHelixValid(op, pos([]))).toBe(false);
      expect(isHelixValid(op, pos(['INS']))).toBe(true);
      expect(isHelixValid(op, pos(['INS', 'DEF']))).toBe(true);
    }
  });
});

// ─── mergeOperand ────────────────────────────────────────────────────────────

describe('mergeOperand', () => {
  it('shallow-merges two plain objects', () => {
    expect(mergeOperand({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('returns incoming when existing is null/undefined', () => {
    expect(mergeOperand(null, { a: 1 })).toEqual({ a: 1 });
    expect(mergeOperand(undefined, 'hello')).toBe('hello');
  });

  it('replaces existing when incoming is a scalar or array', () => {
    expect(mergeOperand({ a: 1 }, 'replaced')).toBe('replaced');
    expect(mergeOperand({ a: 1 }, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('replaces existing when existing is an array (arrays are atomic)', () => {
    expect(mergeOperand([1, 2], { a: 1 })).toEqual({ a: 1 });
  });
});

// ─── isFormulaOperand ────────────────────────────────────────────────────────

describe('isFormulaOperand', () => {
  // Note: the function returns a short-circuited &&-expression, not a
  // strict boolean, so we check truthiness rather than strict equality
  // to `true`/`false`.
  it('detects objects with a `formula` key', () => {
    expect(isFormulaOperand({ formula: 'SUM(x)' })).toBeTruthy();
    expect(isFormulaOperand({ formula: null })).toBeTruthy();
  });

  it('rejects non-objects, null, and objects without the key', () => {
    expect(isFormulaOperand(null)).toBeFalsy();
    expect(isFormulaOperand(undefined)).toBeFalsy();
    expect(isFormulaOperand('SUM(x)')).toBeFalsy();
    expect(isFormulaOperand({ other: 'SUM(x)' })).toBeFalsy();
  });
});

// ─── deepEqual ───────────────────────────────────────────────────────────────

describe('deepEqual', () => {
  it('handles primitives', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual(1, '1')).toBe(false);
  });

  it('handles null and undefined', () => {
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });

  it('handles arrays', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2, 3], [1, 3, 2])).toBe(false);
    expect(deepEqual([], [])).toBe(true);
  });

  it('handles nested objects', () => {
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('distinguishes arrays and objects', () => {
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });
});
