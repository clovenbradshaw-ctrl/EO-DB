/**
 * Regression tests for import-target-id.
 *
 * The bug this guards against: ImportView used to build generic-row targets
 * with `crypto.randomUUID().slice(0, 8)` — 32 bits of entropy, which
 * birthday-collides at ~100% for a 1M-row CSV and surfaces as
 * "Target already instantiated" from the shard worker's helix pre-check.
 *
 * The fix was to include the row index in the ID; these tests pin that
 * invariant so the foot-gun can't be reintroduced by a helpful refactor
 * that "simplifies" the ID back to a random-only scheme.
 */

import { describe, it, expect } from 'vitest';
import {
  generateGenericRowTargetId,
  genericRowIdWidth,
} from '../import-target-id';

describe('genericRowIdWidth', () => {
  it('returns at least 6 even for small batches', () => {
    expect(genericRowIdWidth(0)).toBe(6);
    expect(genericRowIdWidth(1)).toBe(6);
    expect(genericRowIdWidth(100)).toBe(6);
  });

  it('grows to accommodate the largest row index', () => {
    expect(genericRowIdWidth(1_000_000)).toBe(6);    // indices 0..999_999 (6 digits)
    expect(genericRowIdWidth(10_000_000)).toBe(7);   // indices 0..9_999_999 (7 digits)
    expect(genericRowIdWidth(100_000_000)).toBe(8);  // indices 0..99_999_999 (8 digits)
  });

  it('tolerates pathological inputs', () => {
    expect(genericRowIdWidth(-5)).toBe(6);
    expect(genericRowIdWidth(Number.NaN)).toBe(6);
  });
});

describe('generateGenericRowTargetId', () => {
  it('produces the documented shape', () => {
    const id = generateGenericRowTargetId(42, 6, 'abcdef0123456789');
    expect(id).toBe('rec_000042_abcdef012345');
  });

  it('pads the index to the requested width', () => {
    expect(generateGenericRowTargetId(0, 6, 'aaaaaaaaaaaa')).toBe('rec_000000_aaaaaaaaaaaa');
    expect(generateGenericRowTargetId(7, 7, 'bbbbbbbbbbbb')).toBe('rec_0000007_bbbbbbbbbbbb');
  });

  it('truncates the random suffix to 12 chars even when more is supplied', () => {
    const id = generateGenericRowTargetId(0, 6, 'ffffffffffffffffffff');
    // rec_000000_<12 chars>
    expect(id).toMatch(/^rec_000000_[0-9a-f]{12}$/);
    expect(id.length).toBe('rec_000000_'.length + 12);
  });
});

describe('no-collision property for large imports', () => {
  /**
   * The critical property: across an N-row import, every generated target
   * ID is unique. The index suffix guarantees this by construction,
   * regardless of the random source (even a constant suffix must produce
   * unique IDs, because the index differs).
   *
   * Runs at 100k rows rather than 1M to keep the test under a second —
   * the invariant is structural (index differs ⇒ ID differs), so scale
   * beyond 100k only exercises the same property longer.
   */
  it('100k generic rows produce 100k unique target IDs', () => {
    const n = 100_000;
    const width = genericRowIdWidth(n);
    const ids = new Set<string>();
    for (let i = 0; i < n; i++) {
      ids.add(generateGenericRowTargetId(i, width, 'cafebabecafebabe'));
    }
    expect(ids.size).toBe(n);
  });

  /**
   * Simulates the adversarial case the original bug fell into: the
   * random suffix collides, but the row index saves the ID. This
   * specifically proves the index is load-bearing — strip the index
   * and the test would fail immediately.
   */
  it('identical random suffix across all rows still yields unique IDs', () => {
    const n = 10_000;
    const width = genericRowIdWidth(n);
    const ids = new Set<string>();
    const fixedSuffix = '0123456789ab';
    for (let i = 0; i < n; i++) {
      ids.add(generateGenericRowTargetId(i, width, fixedSuffix));
    }
    expect(ids.size).toBe(n);
  });

  /**
   * And the inverse: identical row index across many generations with
   * varying random suffixes produces (within entropy limits) unique IDs.
   * This proves the random suffix provides inter-import headroom.
   */
  it('same row index with varying random suffix yields distinct IDs', () => {
    const n = 1_000;
    const width = 6;
    const ids = new Set<string>();
    for (let k = 0; k < n; k++) {
      // 12 hex chars = 48 bits — collision probability for 1000 draws is
      // ~1000^2 / 2^49 ≈ 2^-29 ≈ 2e-9. Vanishingly unlikely.
      const suffix = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
      ids.add(generateGenericRowTargetId(0, width, suffix));
    }
    expect(ids.size).toBe(n);
  });
});
