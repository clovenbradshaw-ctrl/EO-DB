/**
 * fold-pool.ts — Phase E: Worker-pool fold primitives.
 *
 * Deterministic hash-based target partitioning for shard-pool fold dispatch.
 * The wave-synchronized shard pool groups targets into N fixed shards and
 * processes each shard's targets sequentially within the shard, with shards
 * running concurrently via Promise.all. Wave boundaries act as barriers:
 * all shards complete wave N before any shard starts wave N+1.
 *
 * Phase E proves that this partitioning strategy produces identical
 * projections to the serial and bulk paths. The partitioning is the
 * same algorithm that real Web Worker dispatch will use — the only
 * difference is transport (in-process async vs postMessage).
 *
 * Cross-shard dependency resolution:
 *
 *   A naive partition-by-target shard runner was prototyped and rejected in
 *   Phase D because CON edges create cross-shard dependencies: a CON event
 *   writes both a forward edge (graph:fwd:source:dest) in the source
 *   target's key space and a reverse edge (graph:rev:dest:source) in the
 *   destination's key space. If the destination lives in a different shard,
 *   the reverse-edge write crosses shard boundaries.
 *
 *   Phase E resolves this with **wave-level synchronization**: the helix
 *   wave model already groups events by operator precedence (INS at level 1,
 *   CON at level 2). All shards complete each wave before the next wave
 *   starts. Since all INS events run in wave 1 and all CON events run in
 *   wave 2, every target is guaranteed to exist (via real or synthetic INS)
 *   before any CON references it. The pre-pass in processEventsBulk
 *   additionally generates synthetic INS events for CON destinations,
 *   closing the gap for targets that have no explicit INS in the input.
 *
 *   The shared-store model (all shards read/write the same EoStore) makes
 *   cross-shard reverse-edge writes immediately visible. For real Web
 *   Workers with isolated stores, this would need a merge phase — but that
 *   is deferred to the worker-transport phase.
 */

// ─── Deterministic target hashing ──────────────────────────────────────────

/**
 * Version stamp for the sharding hash. The worker-transport path ships
 * snapshots partitioned by `targetShardIndex`; if the hash algorithm,
 * seed, or modulus strategy ever changes, shards processed against an
 * older snapshot would be misaligned. This constant is written into the
 * snapshot bundle (see `snapshotStoreWithEdgeIndex`) and verified on the
 * consuming side so that a seed/hash change is loud, not silent.
 *
 * Bump this whenever any of `SHARDING_HASH_SEED`, the djb2 loop, or the
 * `% shardCount` partitioning strategy in `targetShardIndex` changes.
 */
export const SHARDING_HASH_VERSION = 1 as const;

/**
 * The initial seed for djb2. Split out as a named constant so (a) call
 * sites can see it, (b) the version gate above has something concrete to
 * point at, and (c) any future seed change is visible in a diff.
 */
export const SHARDING_HASH_SEED = 5381 as const;

/**
 * djb2 string hash. Returns a non-negative integer. Deterministic: same
 * input always produces the same output regardless of runtime or platform.
 *
 * If you change this function, bump `SHARDING_HASH_VERSION`.
 */
function djb2(str: string): number {
  let hash: number = SHARDING_HASH_SEED;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash < 0 ? -hash : hash;
}

/**
 * Assign a target to a shard index. Deterministic: same target always
 * maps to the same shard for a given shardCount.
 */
export function targetShardIndex(target: string, shardCount: number): number {
  if (shardCount <= 1) return 0;
  return djb2(target) % shardCount;
}

// ─── Target partitioning ───────────────────────────────────────────────────

/**
 * Partition an array of targets into N shards. Each target is assigned
 * to exactly one shard via targetShardIndex. Order within each shard
 * preserves the input order (critical for deterministic dispatch when
 * the input is already sorted).
 *
 * Returns exactly `shardCount` arrays. Some may be empty if fewer
 * unique targets than shards — empty shards are included so the caller
 * can index by shard number without bounds checking.
 *
 * Properties:
 *   - Deterministic: same (targets, shardCount) → same partition
 *   - Complete: every input target appears in exactly one shard
 *   - Order-preserving: within each shard, targets appear in input order
 *   - Fixed-arity: always returns exactly shardCount arrays
 */
export function partitionTargets(
  targets: readonly string[],
  shardCount: number,
): string[][] {
  const effective = Math.max(1, shardCount);
  const shards: string[][] = Array.from({ length: effective }, () => []);
  for (const target of targets) {
    shards[targetShardIndex(target, effective)].push(target);
  }
  return shards;
}
