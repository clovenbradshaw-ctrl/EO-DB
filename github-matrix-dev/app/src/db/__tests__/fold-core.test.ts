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
  SeqReservoir,
  HELIX_LEVEL,
  MAX_PROMOTION_DEPTH,
  OPERATOR_PROCESSING_CLASS,
  StoreHelixStateTracker,
  checkAndPromote,
  sortByHelixLevel,
  splitWaveIntoSteps,
  isHelixValid,
  mergeOperand,
  isFormulaOperand,
  deepEqual,
  requiresGpuFlush,
} from '../fold-core';
import type { HelixStateTracker, PromotionCallbacks, WaveStep } from '../fold-core';
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

// ─── SeqReservoir ───────────────────────────────────────────────────────

describe('SeqReservoir', () => {
  it('reserves a contiguous range from store.nextSeq', async () => {
    const store = createStubStore();
    const reservoir = new SeqReservoir(store);
    await reservoir.reserve(5);

    expect(reservoir.totalReserved).toBe(5);
    expect(reservoir.remaining).toBe(5);

    const taken = [reservoir.take(), reservoir.take(), reservoir.take(), reservoir.take(), reservoir.take()];
    expect(taken).toEqual([1, 2, 3, 4, 5]);
    expect(reservoir.remaining).toBe(0);
  });

  it('picks up wherever store.nextSeq last left off', async () => {
    const store = createStubStore(10);
    const reservoir = new SeqReservoir(store);
    await reservoir.reserve(3);
    expect(reservoir.take()).toBe(11);
    expect(reservoir.take()).toBe(12);
    expect(reservoir.take()).toBe(13);
  });

  it('supports reserving additional seqs later in the same reservoir', async () => {
    const store = createStubStore();
    const reservoir = new SeqReservoir(store);
    await reservoir.reserve(2);
    expect(reservoir.take()).toBe(1);
    expect(reservoir.take()).toBe(2);

    await reservoir.reserve(2);
    expect(reservoir.remaining).toBe(2);
    expect(reservoir.take()).toBe(3);
    expect(reservoir.take()).toBe(4);
  });

  it('throws when take() is called beyond the reserved range', async () => {
    const store = createStubStore();
    const reservoir = new SeqReservoir(store);
    await reservoir.reserve(2);
    reservoir.take();
    reservoir.take();
    expect(() => reservoir.take()).toThrow(/exhausted/i);
  });

  it('never hands out the same seq twice under strictly sequential use', async () => {
    // Property-style check: build a reservoir with 1_000 seqs and confirm
    // every taken value is unique and in order.
    const store = createStubStore();
    const reservoir = new SeqReservoir(store);
    await reservoir.reserve(1_000);

    const seen = new Set<number>();
    let prev = -1;
    for (let i = 0; i < 1_000; i++) {
      const s = reservoir.take();
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

// ─── StoreHelixStateTracker ─────────────────────────────────────────────────

describe('StoreHelixStateTracker', () => {
  describe('getPosition', () => {
    it('returns null for a target with no declared operators', async () => {
      const store = createStubStore();
      const tracker = new StoreHelixStateTracker(store);
      expect(await tracker.getPosition('tgt')).toBeNull();
    });

    it('returns the HelixPosition written by recordOperator', async () => {
      const store = createStubStore();
      const tracker = new StoreHelixStateTracker(store);
      await tracker.recordOperator('tgt', 'INS', 7);
      const pos = await tracker.getPosition('tgt');
      expect(pos).not.toBeNull();
      expect(pos!.declared).toEqual(['INS']);
      expect(pos!.firstSeq.INS).toBe(7);
      expect(pos!.lastSeq.INS).toBe(7);
      expect(pos!.count.INS).toBe(1);
    });
  });

  describe('recordOperator', () => {
    it('creates a fresh HelixPosition on first fire', async () => {
      const store = createStubStore();
      const tracker = new StoreHelixStateTracker(store);
      await tracker.recordOperator('tgt', 'INS', 1);
      expect(await tracker.getPosition('tgt')).toEqual({
        declared: ['INS'],
        firstSeq: { INS: 1 },
        lastSeq: { INS: 1 },
        count: { INS: 1 },
      });
    });

    it('appends new ops to `declared` without duplicating existing ones', async () => {
      const store = createStubStore();
      const tracker = new StoreHelixStateTracker(store);
      await tracker.recordOperator('tgt', 'INS', 1);
      await tracker.recordOperator('tgt', 'DEF', 2);
      await tracker.recordOperator('tgt', 'INS', 3); // second INS on same target
      const pos = (await tracker.getPosition('tgt'))!;
      expect(pos.declared).toEqual(['INS', 'DEF']);
    });

    it('sets firstSeq only on first fire, updates lastSeq every time', async () => {
      const store = createStubStore();
      const tracker = new StoreHelixStateTracker(store);
      await tracker.recordOperator('tgt', 'INS', 5);
      await tracker.recordOperator('tgt', 'INS', 9);
      await tracker.recordOperator('tgt', 'INS', 11);
      const pos = (await tracker.getPosition('tgt'))!;
      expect(pos.firstSeq.INS).toBe(5);
      expect(pos.lastSeq.INS).toBe(11);
      expect(pos.count.INS).toBe(3);
    });

    it('tracks per-operator counts independently', async () => {
      const store = createStubStore();
      const tracker = new StoreHelixStateTracker(store);
      await tracker.recordOperator('tgt', 'INS', 1);
      await tracker.recordOperator('tgt', 'DEF', 2);
      await tracker.recordOperator('tgt', 'DEF', 3);
      await tracker.recordOperator('tgt', 'SEG', 4);
      const pos = (await tracker.getPosition('tgt'))!;
      expect(pos.count).toEqual({ INS: 1, DEF: 2, SEG: 1 });
      expect(pos.firstSeq).toEqual({ INS: 1, DEF: 2, SEG: 4 });
      expect(pos.lastSeq).toEqual({ INS: 1, DEF: 3, SEG: 4 });
    });

    it('writes to the `helix:${target}` key', async () => {
      const store = createStubStore();
      const tracker = new StoreHelixStateTracker(store);
      await tracker.recordOperator('alpha', 'INS', 1);
      await tracker.recordOperator('beta', 'INS', 2);
      expect(await store.get('helix:alpha')).not.toBeNull();
      expect(await store.get('helix:beta')).not.toBeNull();
      expect(await store.get('helix:gamma')).toBeNull();
    });
  });

  describe('isValid', () => {
    it('delegates to the module-level isHelixValid', () => {
      const store = createStubStore();
      const tracker = new StoreHelixStateTracker(store);
      const pos: HelixPosition = { declared: ['INS'], firstSeq: {}, lastSeq: {}, count: {} };
      // Spot-check — full rules are covered above.
      expect(tracker.isValid('DEF', pos)).toBe(isHelixValid('DEF', pos));
      expect(tracker.isValid('DEF', null)).toBe(isHelixValid('DEF', null));
      expect(tracker.isValid('INS', pos)).toBe(false);
    });
  });
});

// ─── checkAndPromote ────────────────────────────────────────────────────────

describe('checkAndPromote', () => {
  // Recording-callback helper: captures every emitSynthetic + emitBlocked call
  // so assertions can inspect what promotion decided to do.
  function recordingCallbacks(tracker: HelixStateTracker): {
    callbacks: PromotionCallbacks;
    synthetic: { input: EoEventInput; depth: number }[];
    blocked: string[];
  } {
    const synthetic: { input: EoEventInput; depth: number }[] = [];
    const blocked: string[] = [];
    const callbacks: PromotionCallbacks = {
      emitSynthetic: async (input, depth) => {
        synthetic.push({ input, depth });
        // Simulate a real emitSynthetic: the synthetic event updates the
        // helix position on its target so subsequent checks see it as done.
        if (input.op === 'INS') {
          await tracker.recordOperator(input.target, 'INS', 1000 + synthetic.length);
        }
      },
      emitBlocked: async (target) => {
        blocked.push(target);
      },
    };
    return { callbacks, synthetic, blocked };
  }

  function mk(op: EoEventInput['op'], target = 'tgt', extra: Partial<EoEventInput> = {}): EoEventInput {
    return {
      op,
      target,
      operand: {},
      agent: 'system:test',
      ts: '2025-01-01T00:00:00.000Z',
      acquired_ts: '2025-01-01T00:00:00.000Z',
      ...extra,
    };
  }

  it('short-circuits for NUL / SIG / REC / INS', async () => {
    const tracker = new StoreHelixStateTracker(createStubStore());
    const { callbacks, synthetic, blocked } = recordingCallbacks(tracker);
    for (const op of ['NUL', 'SIG', 'REC', 'INS'] as EoEventInput['op'][]) {
      await checkAndPromote(tracker, mk(op, 'x'), callbacks, 0);
    }
    expect(synthetic).toEqual([]);
    expect(blocked).toEqual([]);
  });

  it('emits a synthetic INS when the target lacks INS', async () => {
    const tracker = new StoreHelixStateTracker(createStubStore());
    const { callbacks, synthetic, blocked } = recordingCallbacks(tracker);
    await checkAndPromote(tracker, mk('DEF', 'tgt'), callbacks, 0);
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0].input.op).toBe('INS');
    expect(synthetic[0].input.target).toBe('tgt');
    expect(synthetic[0].input.agent).toBe('system:helix');
    expect(synthetic[0].input.meta).toMatchObject({ auto_promoted: true });
    expect(synthetic[0].depth).toBe(1); // called at depth + 1
    expect(blocked).toEqual([]);
  });

  it('does not promote when the target is already INSed', async () => {
    const tracker = new StoreHelixStateTracker(createStubStore());
    await tracker.recordOperator('tgt', 'INS', 1);
    const { callbacks, synthetic, blocked } = recordingCallbacks(tracker);
    await checkAndPromote(tracker, mk('DEF', 'tgt'), callbacks, 0);
    expect(synthetic).toEqual([]);
    expect(blocked).toEqual([]);
  });

  it('emits synthetic INS for CON destination targets that lack INS', async () => {
    const tracker = new StoreHelixStateTracker(createStubStore());
    await tracker.recordOperator('src', 'INS', 1); // source already INSed
    const { callbacks, synthetic } = recordingCallbacks(tracker);
    const conEvent = mk('CON', 'src', {
      operand: { added: ['dest1', { dest: 'dest2' }, 'dest3'] },
    });
    await checkAndPromote(tracker, conEvent, callbacks, 0);
    expect(synthetic.map((s) => s.input.target)).toEqual(['dest1', 'dest2', 'dest3']);
    expect(synthetic.every((s) => s.input.op === 'INS')).toBe(true);
  });

  it('does not re-promote CON destinations that are already INSed', async () => {
    const tracker = new StoreHelixStateTracker(createStubStore());
    await tracker.recordOperator('src', 'INS', 1);
    await tracker.recordOperator('dest1', 'INS', 2);
    const { callbacks, synthetic } = recordingCallbacks(tracker);
    const conEvent = mk('CON', 'src', { operand: { added: ['dest1', 'dest2'] } });
    await checkAndPromote(tracker, conEvent, callbacks, 0);
    // dest1 was already INSed, dest2 needs a synthetic
    expect(synthetic.map((s) => s.input.target)).toEqual(['dest2']);
  });

  it('emits emitBlocked (not emitSynthetic) when depth has reached the cap', async () => {
    const tracker = new StoreHelixStateTracker(createStubStore());
    const { callbacks, synthetic, blocked } = recordingCallbacks(tracker);
    await checkAndPromote(tracker, mk('DEF', 'tgt'), callbacks, MAX_PROMOTION_DEPTH);
    expect(synthetic).toEqual([]);
    expect(blocked).toEqual(['tgt']);
  });

  it('MAX_PROMOTION_DEPTH is the expected cap (5)', () => {
    expect(MAX_PROMOTION_DEPTH).toBe(5);
  });

  it('passes depth+1 to emitSynthetic so nested promotions observe the cap', async () => {
    const tracker = new StoreHelixStateTracker(createStubStore());
    const { callbacks, synthetic } = recordingCallbacks(tracker);
    await checkAndPromote(tracker, mk('DEF', 'tgt'), callbacks, 3);
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0].depth).toBe(4);
  });

  it('refreshes the declared set between required-op emissions', async () => {
    // If an emitSynthetic for one required op ends up declaring a sibling op
    // on the same target, the sibling should not be re-emitted. We exercise
    // this with a single required op today — the refresh protects future
    // multi-op promotion paths.
    const tracker = new StoreHelixStateTracker(createStubStore());
    let syntheticCount = 0;
    const callbacks: PromotionCallbacks = {
      emitSynthetic: async (input) => {
        syntheticCount++;
        await tracker.recordOperator(input.target, 'INS', 100);
      },
      emitBlocked: async () => {},
    };
    await checkAndPromote(tracker, mk('DEF', 'tgt'), callbacks, 0);
    // One missing required op → one synthetic. The refresh ensures the
    // declared set immediately reflects it if promoteToHelix were later
    // extended to require multiple ops.
    expect(syntheticCount).toBe(1);
    const pos = await tracker.getPosition('tgt');
    expect(pos?.declared).toContain('INS');
  });
});

// ─── OPERATOR_PROCESSING_CLASS ───────────────────────────────────────────────

describe('OPERATOR_PROCESSING_CLASS', () => {
  const ALL_OPS: LoggableOperator[] = ['NUL', 'SIG', 'INS', 'SEG', 'CON', 'SYN', 'DEF', 'EVA', 'REC'];

  it('has an entry for every loggable operator', () => {
    for (const op of ALL_OPS) {
      expect(OPERATOR_PROCESSING_CLASS[op]).toBeDefined();
    }
    expect(Object.keys(OPERATOR_PROCESSING_CLASS).sort()).toEqual([...ALL_OPS].sort());
  });

  it('routes the identity triad (NUL/SIG/INS) and CPU-side structure ops to the CPU layer', () => {
    expect(OPERATOR_PROCESSING_CLASS.NUL.layer).toBe('cpu');
    expect(OPERATOR_PROCESSING_CLASS.SIG.layer).toBe('cpu');
    expect(OPERATOR_PROCESSING_CLASS.INS.layer).toBe('cpu');
    expect(OPERATOR_PROCESSING_CLASS.SEG.layer).toBe('cpu');
    expect(OPERATOR_PROCESSING_CLASS.DEF.layer).toBe('cpu');
  });

  it('routes CON to the CPU↔GPU boundary layer (CSR-shared)', () => {
    expect(OPERATOR_PROCESSING_CLASS.CON.layer).toBe('boundary');
    expect(OPERATOR_PROCESSING_CLASS.CON.memory).toBe('csr-shared');
  });

  it('routes SYN to the adaptive layer (CPU vs GPU reduction)', () => {
    expect(OPERATOR_PROCESSING_CLASS.SYN.layer).toBe('adaptive');
    expect(OPERATOR_PROCESSING_CLASS.SYN.memory).toBe('reduction');
  });

  it('routes EVA and REC to the GPU layer', () => {
    expect(OPERATOR_PROCESSING_CLASS.EVA.layer).toBe('gpu');
    expect(OPERATOR_PROCESSING_CLASS.REC.layer).toBe('gpu');
  });

  it('marks DEF as the only flush-gpu boundary', () => {
    const flushOps = ALL_OPS.filter((op) => OPERATOR_PROCESSING_CLASS[op].sync === 'flush-gpu');
    expect(flushOps).toEqual(['DEF']);
  });

  it('does not declare any push-state operators yet (reserved)', () => {
    const pushOps = ALL_OPS.filter((op) => OPERATOR_PROCESSING_CLASS[op].sync === 'push-state');
    expect(pushOps).toEqual([]);
  });
});

describe('requiresGpuFlush', () => {
  it('returns true only for DEF', () => {
    expect(requiresGpuFlush('DEF')).toBe(true);
    for (const op of ['NUL', 'SIG', 'INS', 'SEG', 'CON', 'SYN', 'EVA', 'REC'] as LoggableOperator[]) {
      expect(requiresGpuFlush(op)).toBe(false);
    }
  });
});

// ─── splitWaveIntoSteps (Phase B — Barrier extraction) ──────────────────────

describe('splitWaveIntoSteps', () => {
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

  it('returns an empty array for an empty wave', () => {
    const steps = splitWaveIntoSteps({ level: 1, events: [] });
    expect(steps).toEqual([]);
  });

  it('produces a single non-barrier step for a wave with no flush-gpu ops', () => {
    const events = [mk('INS', 'a'), mk('INS', 'b'), mk('INS', 'c')];
    const steps = splitWaveIntoSteps({ level: 1, events });
    expect(steps).toHaveLength(1);
    expect(steps[0].barrier).toBe(false);
    expect(steps[0].events).toEqual(events);
  });

  it('produces a single barrier step for a wave with one DEF', () => {
    const events = [mk('DEF', 'a.f')];
    const steps = splitWaveIntoSteps({ level: 4, events });
    expect(steps).toHaveLength(1);
    expect(steps[0].barrier).toBe(true);
    expect(steps[0].events).toEqual(events);
  });

  it('does NOT coalesce consecutive DEFs into one step', () => {
    // Rule pin: each flush-gpu op lives in its own single-event step. A
    // wave of two DEFs produces two barrier steps, not one. The "skip
    // redundant drain" optimization belongs inside drainGpuInFlight, not
    // in the splitter.
    const d1 = mk('DEF', 'a.f');
    const d2 = mk('DEF', 'b.f');
    const steps = splitWaveIntoSteps({ level: 4, events: [d1, d2] });
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ events: [d1], barrier: true });
    expect(steps[1]).toEqual({ events: [d2], barrier: true });
  });

  it('alternates non-barrier and barrier steps for interleaved non-flush / flush events', () => {
    const i1 = mk('INS', 'a');
    const d1 = mk('DEF', 'a.f');
    const i2 = mk('INS', 'b');
    const d2 = mk('DEF', 'b.f');
    const i3 = mk('INS', 'c');
    const steps = splitWaveIntoSteps({
      level: 99, // doesn't matter — splitter is level-agnostic
      events: [i1, d1, i2, d2, i3],
    });
    expect(steps).toHaveLength(5);
    expect(steps[0]).toEqual({ events: [i1], barrier: false });
    expect(steps[1]).toEqual({ events: [d1], barrier: true });
    expect(steps[2]).toEqual({ events: [i2], barrier: false });
    expect(steps[3]).toEqual({ events: [d2], barrier: true });
    expect(steps[4]).toEqual({ events: [i3], barrier: false });
  });

  it('groups consecutive non-flush events into a single step around a DEF', () => {
    const c1 = mk('CON', 'a.f');
    const c2 = mk('CON', 'a.g');
    const d = mk('DEF', 'a.f');
    const c3 = mk('CON', 'b.f');
    const c4 = mk('CON', 'b.g');
    const steps = splitWaveIntoSteps({ level: 2, events: [c1, c2, d, c3, c4] });
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ events: [c1, c2], barrier: false });
    expect(steps[1]).toEqual({ events: [d], barrier: true });
    expect(steps[2]).toEqual({ events: [c3, c4], barrier: false });
  });

  it('handles a trailing non-flush event after a flush event', () => {
    const c1 = mk('CON', 'a');
    const d = mk('DEF', 'a.f');
    const c2 = mk('CON', 'b');
    const steps = splitWaveIntoSteps({ level: 2, events: [c1, d, c2] });
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ events: [c1], barrier: false });
    expect(steps[1]).toEqual({ events: [d], barrier: true });
    expect(steps[2]).toEqual({ events: [c2], barrier: false });
  });

  it('preserves total event order: flattened steps equal the input events', () => {
    // Every input event appears in exactly one step, and the concatenation
    // of step.events across all steps equals the original input list.
    const events = [
      mk('INS', 'a'),
      mk('CON', 'a.f'),
      mk('DEF', 'a.f'),
      mk('DEF', 'a.g'),
      mk('SYN', 'a'),
      mk('DEF', 'b.f'),
      mk('EVA', 'c.f'),
    ];
    const steps = splitWaveIntoSteps({ level: 99, events });
    const flattened = steps.flatMap((s: WaveStep) => s.events);
    expect(flattened).toEqual(events);

    // Every barrier step has exactly one event whose op returns true from
    // requiresGpuFlush, and every non-barrier step contains only
    // non-flush events.
    for (const step of steps) {
      if (step.barrier) {
        expect(step.events).toHaveLength(1);
        expect(requiresGpuFlush(step.events[0].op as LoggableOperator)).toBe(true);
      } else {
        for (const e of step.events) {
          expect(requiresGpuFlush(e.op as LoggableOperator)).toBe(false);
        }
      }
    }
  });
});
