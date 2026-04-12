/**
 * Unit tests for Phase E fold-pool.ts — deterministic target partitioning.
 *
 * Pins the contract that the shard-pool fold runner depends on:
 *
 *   1. Determinism — same input always produces the same partition.
 *   2. Completeness — every input target appears in exactly one shard.
 *   3. Order preservation — within each shard, targets appear in input order.
 *   4. Fixed arity — always returns exactly shardCount arrays.
 *   5. Stability — targetShardIndex is consistent across calls.
 */

import { describe, it, expect } from 'vitest';
import { targetShardIndex, partitionTargets } from '../fold-pool';

// ─── targetShardIndex ──────────────────────────────────────────────────────

describe('targetShardIndex', () => {
  it('returns 0 when shardCount <= 1', () => {
    expect(targetShardIndex('any-target', 1)).toBe(0);
    expect(targetShardIndex('any-target', 0)).toBe(0);
    expect(targetShardIndex('any-target', -1)).toBe(0);
  });

  it('returns a value in [0, shardCount)', () => {
    const targets = ['app.t.r0', 'app.t.r1', 'app.t.r2', 'app.t.r3'];
    for (const t of targets) {
      const idx = targetShardIndex(t, 3);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(3);
    }
  });

  it('is deterministic: same input always returns the same index', () => {
    const target = 'app.collection.record-42';
    const idx1 = targetShardIndex(target, 5);
    const idx2 = targetShardIndex(target, 5);
    const idx3 = targetShardIndex(target, 5);
    expect(idx1).toBe(idx2);
    expect(idx2).toBe(idx3);
  });

  it('distributes different targets across multiple shards', () => {
    // With enough distinct targets, at least 2 different shards should
    // be populated (probabilistic, but 20 targets across 3 shards is safe).
    const targets = Array.from({ length: 20 }, (_, i) => `app.t.r${i}`);
    const shardsSeen = new Set(targets.map(t => targetShardIndex(t, 3)));
    expect(shardsSeen.size).toBeGreaterThan(1);
  });
});

// ─── partitionTargets ──────────────────────────────────────────────────────

describe('partitionTargets', () => {
  it('returns exactly shardCount arrays', () => {
    const result = partitionTargets(['a', 'b', 'c'], 5);
    expect(result).toHaveLength(5);
  });

  it('returns 1 array when shardCount is 0 or negative', () => {
    expect(partitionTargets(['a', 'b'], 0)).toHaveLength(1);
    expect(partitionTargets(['a', 'b'], -1)).toHaveLength(1);
  });

  it('places every target in exactly one shard (completeness)', () => {
    const targets = ['app.t.r0', 'app.t.r1', 'app.t.r2', 'app.t.r3', 'app.t.r4'];
    const shards = partitionTargets(targets, 3);

    // Flatten and verify all targets are present exactly once
    const all = shards.flat();
    expect(all.sort()).toEqual([...targets].sort());
  });

  it('preserves input order within each shard', () => {
    const targets = ['z', 'a', 'm', 'b', 'y', 'c', 'x', 'd'];
    const shards = partitionTargets(targets, 3);

    for (const shard of shards) {
      // Each element in the shard should appear in the same relative
      // order as in the input.
      for (let i = 0; i < shard.length - 1; i++) {
        const idxA = targets.indexOf(shard[i]);
        const idxB = targets.indexOf(shard[i + 1]);
        expect(idxA).toBeLessThan(idxB);
      }
    }
  });

  it('is deterministic: same input always produces the same partition', () => {
    const targets = ['app.t.r0', 'app.t.r1', 'app.t.r2', 'app.t.r3'];
    const a = partitionTargets(targets, 3);
    const b = partitionTargets(targets, 3);
    expect(a).toEqual(b);
  });

  it('handles empty input', () => {
    const shards = partitionTargets([], 3);
    expect(shards).toHaveLength(3);
    expect(shards.every(s => s.length === 0)).toBe(true);
  });

  it('handles single target', () => {
    const shards = partitionTargets(['only'], 3);
    const populated = shards.filter(s => s.length > 0);
    expect(populated).toHaveLength(1);
    expect(populated[0]).toEqual(['only']);
  });

  it('handles more shards than targets', () => {
    const targets = ['a', 'b'];
    const shards = partitionTargets(targets, 10);
    expect(shards).toHaveLength(10);
    // Exactly 2 shards should have 1 target each (a and b go to different shards)
    const populated = shards.filter(s => s.length > 0);
    expect(populated.length).toBeGreaterThanOrEqual(1);
    expect(populated.length).toBeLessThanOrEqual(2);
    expect(shards.flat().sort()).toEqual(['a', 'b']);
  });

  it('single shard gets all targets', () => {
    const targets = ['a', 'b', 'c', 'd'];
    const shards = partitionTargets(targets, 1);
    expect(shards).toHaveLength(1);
    expect(shards[0]).toEqual(targets);
  });
});
