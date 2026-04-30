import { describe, it, expect } from 'vitest';
import {
  zeroHLC,
  tickLocal,
  tickReceive,
  compareHLC,
  compareHLCWithReplica,
  tickFromDEF,
  withinWindow,
} from '../src/db/hlc.js';

describe('HLC', () => {
  describe('tickLocal', () => {
    it('advances wall_ms when clock moves forward', () => {
      const h = tickLocal({ wall_ms: 100, logical: 3 }, 200);
      expect(h).toEqual({ wall_ms: 200, logical: 0 });
    });
    it('increments logical when wall_ms is unchanged', () => {
      const h = tickLocal({ wall_ms: 200, logical: 0 }, 200);
      expect(h).toEqual({ wall_ms: 200, logical: 1 });
    });
    it('clamps to prev.wall_ms when clock goes backward', () => {
      const h = tickLocal({ wall_ms: 500, logical: 2 }, 100);
      expect(h).toEqual({ wall_ms: 500, logical: 3 });
    });
    it('is monotonic over a thousand ticks under a noisy clock', () => {
      let h = zeroHLC();
      let prev = h;
      let now = 1000;
      for (let i = 0; i < 1000; i++) {
        // simulate jittery wall clock: -5..+10ms
        now += Math.floor(Math.random() * 16) - 5;
        h = tickLocal(prev, now);
        expect(compareHLC(prev, h)).toBeLessThan(0);
        prev = h;
      }
    });
  });

  describe('tickReceive', () => {
    it('takes the max of all three sources', () => {
      const h = tickReceive(
        { wall_ms: 100, logical: 5 },
        { wall_ms: 300, logical: 2 },
        200,
      );
      expect(h.wall_ms).toBe(300);
      expect(h.logical).toBe(3); // incoming wins, increments incoming.logical
    });
    it('combines logicals when all three wall_ms agree', () => {
      const h = tickReceive(
        { wall_ms: 500, logical: 7 },
        { wall_ms: 500, logical: 4 },
        500,
      );
      expect(h).toEqual({ wall_ms: 500, logical: 8 });
    });
    it('resets logical when wall clock leads', () => {
      const h = tickReceive(
        { wall_ms: 100, logical: 5 },
        { wall_ms: 200, logical: 5 },
        500,
      );
      expect(h).toEqual({ wall_ms: 500, logical: 0 });
    });
  });

  describe('compareHLC', () => {
    it('orders by wall_ms first', () => {
      expect(compareHLC({ wall_ms: 1, logical: 99 }, { wall_ms: 2, logical: 0 })).toBeLessThan(0);
    });
    it('breaks ties on logical', () => {
      expect(compareHLC({ wall_ms: 5, logical: 1 }, { wall_ms: 5, logical: 2 })).toBeLessThan(0);
    });
    it('returns 0 for equal HLCs', () => {
      expect(compareHLC({ wall_ms: 5, logical: 1 }, { wall_ms: 5, logical: 1 })).toBe(0);
    });
  });

  describe('compareHLCWithReplica', () => {
    it('falls back to lexicographic replica_id on full HLC tie', () => {
      const h = { wall_ms: 5, logical: 1 };
      expect(compareHLCWithReplica(h, 'A', h, 'B')).toBeLessThan(0);
      expect(compareHLCWithReplica(h, 'B', h, 'A')).toBeGreaterThan(0);
      expect(compareHLCWithReplica(h, 'A', h, 'A')).toBe(0);
    });
  });

  describe('tickFromDEF', () => {
    it('increments logical only — deterministic across replicas', () => {
      const h = tickFromDEF({ wall_ms: 1000, logical: 5 });
      expect(h).toEqual({ wall_ms: 1000, logical: 6 });
    });
  });

  describe('withinWindow', () => {
    it('is true for nearby HLCs', () => {
      expect(withinWindow({ wall_ms: 100, logical: 0 }, { wall_ms: 150, logical: 0 }, 100)).toBe(true);
    });
    it('is false at the boundary', () => {
      expect(withinWindow({ wall_ms: 100, logical: 0 }, { wall_ms: 200, logical: 0 }, 100)).toBe(false);
    });
  });

  describe('total order is stable under randomized event sequences', () => {
    it('sorts deterministically across 1000 events with replica tiebreakers', () => {
      const events: Array<{ hlc: { wall_ms: number; logical: number }; rep: string }> = [];
      const rng = mulberry32(0x5eed);
      for (let i = 0; i < 1000; i++) {
        events.push({
          hlc: { wall_ms: Math.floor(rng() * 1000), logical: Math.floor(rng() * 10) },
          rep: ['A', 'B', 'C'][Math.floor(rng() * 3)],
        });
      }
      const a = [...events].sort((x, y) => compareHLCWithReplica(x.hlc, x.rep, y.hlc, y.rep));
      const b = [...events].reverse().sort((x, y) => compareHLCWithReplica(x.hlc, x.rep, y.hlc, y.rep));
      expect(a).toEqual(b);
      // No two adjacent entries violate the order.
      for (let i = 1; i < a.length; i++) {
        expect(compareHLCWithReplica(a[i - 1].hlc, a[i - 1].rep, a[i].hlc, a[i].rep)).toBeLessThanOrEqual(0);
      }
    });
  });
});

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
