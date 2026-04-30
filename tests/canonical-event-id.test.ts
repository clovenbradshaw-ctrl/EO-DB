import { describe, it, expect } from 'vitest';
import { canonicalEventId, eventHash } from '../src/db/hash.js';
import type { EoEventInput, HLC } from '../src/db/types.js';

const AGENT = '@alice:example.com';
const TS = '2025-06-01T00:00:00.000Z';

function ev(overrides: Partial<EoEventInput> = {}): EoEventInput {
  return {
    op: 'EVA',
    target: 'customer.1.email',
    operand: 'a@x.com',
    agent: AGENT,
    ts: TS,
    acquired_ts: TS,
    ...overrides,
  };
}

describe('canonicalEventId', () => {
  describe('legacy / no-HLC path', () => {
    it('matches eventHash byte-for-byte when no HLC is present', () => {
      const e = ev();
      expect(canonicalEventId(e)).toBe(eventHash(e));
    });
    it('still matches eventHash for events that carry replica_id but no HLC', () => {
      const e = { ...ev(), replica_id: 'A' };
      // No HLC → legacy path: replica_id is ignored for backward compatibility.
      expect(canonicalEventId(e)).toBe(eventHash(e));
    });
  });

  describe('HLC path', () => {
    const HLC_A: HLC = { wall_ms: 1717200000000, logical: 0 };

    it('produces a stable id for the same canonical inputs', () => {
      const e1 = { ...ev(), replica_id: 'A', hlc: HLC_A };
      const e2 = { ...ev(), replica_id: 'A', hlc: { ...HLC_A } };
      expect(canonicalEventId(e1)).toBe(canonicalEventId(e2));
    });

    it('differs when replica_id differs (concurrent writes from different replicas)', () => {
      const a = { ...ev(), replica_id: 'A', hlc: HLC_A };
      const b = { ...ev(), replica_id: 'B', hlc: HLC_A };
      expect(canonicalEventId(a)).not.toBe(canonicalEventId(b));
    });

    it('differs when HLC differs', () => {
      const a = { ...ev(), replica_id: 'A', hlc: HLC_A };
      const b = { ...ev(), replica_id: 'A', hlc: { wall_ms: HLC_A.wall_ms, logical: 1 } };
      expect(canonicalEventId(a)).not.toBe(canonicalEventId(b));
    });

    it('is independent of ts and acquired_ts (informational fields)', () => {
      const a = { ...ev({ ts: TS, acquired_ts: TS }), replica_id: 'A', hlc: HLC_A };
      const b = {
        ...ev({ ts: '2099-12-31T23:59:59.000Z', acquired_ts: '2099-12-31T23:59:59.000Z' }),
        replica_id: 'A',
        hlc: HLC_A,
      };
      expect(canonicalEventId(a)).toBe(canonicalEventId(b));
    });

    it('is independent of caused_by (causal links are not identity)', () => {
      const a = { ...ev(), replica_id: 'A', hlc: HLC_A, caused_by: ['ev:x', 'ev:y'] };
      const b = { ...ev(), replica_id: 'A', hlc: HLC_A, caused_by: ['ev:y', 'ev:x'] };
      const c = { ...ev(), replica_id: 'A', hlc: HLC_A };
      expect(canonicalEventId(a)).toBe(canonicalEventId(b));
      expect(canonicalEventId(a)).toBe(canonicalEventId(c));
    });

    it('depends on operand structure (deep order independent)', () => {
      const a = {
        ...ev({ operand: { a: 1, b: { c: 2, d: 3 } } }),
        replica_id: 'A',
        hlc: HLC_A,
      };
      const b = {
        ...ev({ operand: { b: { d: 3, c: 2 }, a: 1 } }),
        replica_id: 'A',
        hlc: HLC_A,
      };
      expect(canonicalEventId(a)).toBe(canonicalEventId(b));
    });

    it('agrees across 1000 randomized events with the same canonical inputs', () => {
      const rng = mulberry32(0xc0ffee);
      for (let i = 0; i < 1000; i++) {
        const operand = {
          x: rng(),
          y: { z: rng(), w: rng() },
          arr: [rng(), rng(), rng()],
        };
        const hlc: HLC = { wall_ms: Math.floor(rng() * 1e12), logical: Math.floor(rng() * 1000) };
        const a = { ...ev({ operand }), replica_id: 'R1', hlc };
        const b = { ...ev({ operand: structuredClone(operand) }), replica_id: 'R1', hlc: { ...hlc } };
        expect(canonicalEventId(a)).toBe(canonicalEventId(b));
      }
    });

    it('includes `resolves` and `rule_id` for EVA-from-DEF events', () => {
      const base = { ...ev(), replica_id: 'A', hlc: HLC_A };
      const resolved = { ...base, resolves: 'ev:def-1', rule_id: 'ev:rule-1' };
      const otherRule = { ...base, resolves: 'ev:def-1', rule_id: 'ev:rule-2' };
      expect(canonicalEventId(base)).not.toBe(canonicalEventId(resolved));
      expect(canonicalEventId(resolved)).not.toBe(canonicalEventId(otherRule));
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
