/**
 * Unit tests for branch-navigation — the pure divergence-navigation helpers
 * used by the Branch Explorer scrubber.
 */

import { describe, it, expect } from 'vitest';
import {
  tAtTs,
  mergeDivergencePoints,
  sortDivergencePoints,
  findNextDivergence,
  findPrevDivergence,
  findNearestDivergence,
} from '../branch-navigation';
import type { DivergencePoint, WorldType } from '../../../types/branch';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function mk(ts: string, field: string, worlds: WorldType[] = ['canonical']): DivergencePoint {
  return { ts, field_path: field, worlds_diverge: worlds };
}

const WINDOW = {
  minMs: Date.parse('2025-06-01T00:00:00.000Z'),
  maxMs: Date.parse('2025-06-01T00:10:00.000Z'),
};

// ─── tAtTs ──────────────────────────────────────────────────────────────────

describe('tAtTs', () => {
  it('returns 0 at the window start', () => {
    expect(tAtTs(WINDOW, '2025-06-01T00:00:00.000Z')).toBe(0);
  });

  it('returns 1 at the window end', () => {
    expect(tAtTs(WINDOW, '2025-06-01T00:10:00.000Z')).toBe(1);
  });

  it('returns 0.5 at the window midpoint', () => {
    expect(tAtTs(WINDOW, '2025-06-01T00:05:00.000Z')).toBeCloseTo(0.5);
  });

  it('clamps to 0 for timestamps before the window', () => {
    expect(tAtTs(WINDOW, '2025-01-01T00:00:00.000Z')).toBe(0);
  });

  it('clamps to 1 for timestamps after the window', () => {
    expect(tAtTs(WINDOW, '2099-01-01T00:00:00.000Z')).toBe(1);
  });

  it('returns 0 for an invalid timestamp', () => {
    expect(tAtTs(WINDOW, 'not-a-date')).toBe(0);
  });

  it('returns 0 for a zero-width window', () => {
    expect(tAtTs({ minMs: 1000, maxMs: 1000 }, '2025-06-01T00:00:00.000Z')).toBe(0);
  });
});

// ─── mergeDivergencePoints ──────────────────────────────────────────────────

describe('mergeDivergencePoints', () => {
  it('merges two entries that share (ts, field_path)', () => {
    const merged = mergeDivergencePoints([
      mk('2025-06-01T00:01:00.000Z', 'status', ['canonical']),
      mk('2025-06-01T00:01:00.000Z', 'status', ['never-merged']),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].worlds_diverge.sort()).toEqual(['canonical', 'never-merged']);
  });

  it('leaves distinct (ts, field_path) entries as-is', () => {
    const merged = mergeDivergencePoints([
      mk('2025-06-01T00:01:00.000Z', 'status', ['canonical']),
      mk('2025-06-01T00:01:00.000Z', 'owner', ['canonical']),
      mk('2025-06-01T00:02:00.000Z', 'status', ['canonical']),
    ]);
    expect(merged).toHaveLength(3);
  });

  it('does not duplicate a world that appears in both inputs', () => {
    const merged = mergeDivergencePoints([
      mk('2025-06-01T00:01:00.000Z', 'status', ['canonical']),
      mk('2025-06-01T00:01:00.000Z', 'status', ['canonical']),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].worlds_diverge).toEqual(['canonical']);
  });

  it('preserves input order for the first occurrence of each key', () => {
    const merged = mergeDivergencePoints([
      mk('2025-06-01T00:02:00.000Z', 'b', ['canonical']),
      mk('2025-06-01T00:01:00.000Z', 'a', ['never-merged']),
      mk('2025-06-01T00:02:00.000Z', 'b', ['always-merged']),
    ]);
    expect(merged.map((p) => p.field_path)).toEqual(['b', 'a']);
  });
});

// ─── sortDivergencePoints ───────────────────────────────────────────────────

describe('sortDivergencePoints', () => {
  it('sorts primarily by timestamp ascending', () => {
    const sorted = sortDivergencePoints([
      mk('2025-06-01T00:03:00.000Z', 'a'),
      mk('2025-06-01T00:01:00.000Z', 'a'),
      mk('2025-06-01T00:02:00.000Z', 'a'),
    ]);
    expect(sorted.map((p) => p.ts)).toEqual([
      '2025-06-01T00:01:00.000Z',
      '2025-06-01T00:02:00.000Z',
      '2025-06-01T00:03:00.000Z',
    ]);
  });

  it('breaks ts ties by field_path ascending for determinism', () => {
    const sorted = sortDivergencePoints([
      mk('2025-06-01T00:01:00.000Z', 'zebra'),
      mk('2025-06-01T00:01:00.000Z', 'alpha'),
      mk('2025-06-01T00:01:00.000Z', 'mango'),
    ]);
    expect(sorted.map((p) => p.field_path)).toEqual(['alpha', 'mango', 'zebra']);
  });

  it('does not mutate the input array', () => {
    const input = [
      mk('2025-06-01T00:03:00.000Z', 'a'),
      mk('2025-06-01T00:01:00.000Z', 'a'),
    ];
    const snapshot = [...input];
    sortDivergencePoints(input);
    expect(input).toEqual(snapshot);
  });
});

// ─── findNextDivergence ─────────────────────────────────────────────────────

describe('findNextDivergence', () => {
  const points = [
    mk('2025-06-01T00:01:00.000Z', 'a'),
    mk('2025-06-01T00:03:00.000Z', 'b'),
    mk('2025-06-01T00:05:00.000Z', 'c'),
  ];

  it('returns the first point strictly after currentTs', () => {
    const next = findNextDivergence(points, '2025-06-01T00:02:00.000Z');
    expect(next?.ts).toBe('2025-06-01T00:03:00.000Z');
  });

  it('returns null when currentTs is at or past the last point', () => {
    expect(findNextDivergence(points, '2025-06-01T00:05:00.000Z')).toBeNull();
    expect(findNextDivergence(points, '2025-06-01T00:06:00.000Z')).toBeNull();
  });

  it('is strict — a point at exactly currentTs does NOT count as "next"', () => {
    expect(findNextDivergence(points, '2025-06-01T00:01:00.000Z')?.ts).toBe(
      '2025-06-01T00:03:00.000Z',
    );
  });

  it('works with unsorted input', () => {
    const shuffled = [points[2], points[0], points[1]];
    expect(findNextDivergence(shuffled, '2025-06-01T00:02:00.000Z')?.ts).toBe(
      '2025-06-01T00:03:00.000Z',
    );
  });

  it('returns null on an empty list', () => {
    expect(findNextDivergence([], '2025-06-01T00:02:00.000Z')).toBeNull();
  });
});

// ─── findPrevDivergence ─────────────────────────────────────────────────────

describe('findPrevDivergence', () => {
  const points = [
    mk('2025-06-01T00:01:00.000Z', 'a'),
    mk('2025-06-01T00:03:00.000Z', 'b'),
    mk('2025-06-01T00:05:00.000Z', 'c'),
  ];

  it('returns the last point strictly before currentTs', () => {
    const prev = findPrevDivergence(points, '2025-06-01T00:04:00.000Z');
    expect(prev?.ts).toBe('2025-06-01T00:03:00.000Z');
  });

  it('returns null when currentTs is at or before the first point', () => {
    expect(findPrevDivergence(points, '2025-06-01T00:01:00.000Z')).toBeNull();
    expect(findPrevDivergence(points, '2025-06-01T00:00:30.000Z')).toBeNull();
  });

  it('is strict — a point at exactly currentTs does NOT count as "prev"', () => {
    expect(findPrevDivergence(points, '2025-06-01T00:03:00.000Z')?.ts).toBe(
      '2025-06-01T00:01:00.000Z',
    );
  });

  it('returns the very last point when currentTs is far in the future', () => {
    expect(findPrevDivergence(points, '2099-01-01T00:00:00.000Z')?.ts).toBe(
      '2025-06-01T00:05:00.000Z',
    );
  });

  it('returns null on an empty list', () => {
    expect(findPrevDivergence([], '2025-06-01T00:02:00.000Z')).toBeNull();
  });
});

// ─── findNearestDivergence ──────────────────────────────────────────────────

describe('findNearestDivergence', () => {
  const points = [
    mk('2025-06-01T00:01:00.000Z', 'a'),
    mk('2025-06-01T00:03:00.000Z', 'b'),
    mk('2025-06-01T00:05:00.000Z', 'c'),
  ];

  it('returns the point at the exact currentTs', () => {
    expect(findNearestDivergence(points, '2025-06-01T00:03:00.000Z')?.ts).toBe(
      '2025-06-01T00:03:00.000Z',
    );
  });

  it('returns the closest point when currentTs is between two', () => {
    // 00:01:40 → nearer to 00:01:00 than to 00:03:00
    expect(findNearestDivergence(points, '2025-06-01T00:01:40.000Z')?.ts).toBe(
      '2025-06-01T00:01:00.000Z',
    );
    // 00:02:30 → nearer to 00:03:00 than to 00:01:00
    expect(findNearestDivergence(points, '2025-06-01T00:02:30.000Z')?.ts).toBe(
      '2025-06-01T00:03:00.000Z',
    );
  });

  it('breaks ties by preferring the earlier point', () => {
    // 00:02:00 is equidistant from 00:01:00 and 00:03:00 (60s each)
    expect(findNearestDivergence(points, '2025-06-01T00:02:00.000Z')?.ts).toBe(
      '2025-06-01T00:01:00.000Z',
    );
  });

  it('returns null on an empty list', () => {
    expect(findNearestDivergence([], '2025-06-01T00:02:00.000Z')).toBeNull();
  });

  it('returns null for an invalid currentTs', () => {
    expect(findNearestDivergence(points, 'not-a-date')).toBeNull();
  });
});
