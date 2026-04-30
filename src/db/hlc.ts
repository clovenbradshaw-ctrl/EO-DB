/**
 * Hybrid Logical Clock for EO-DB replication.
 *
 * Every event that crosses a replica boundary carries an HLC. The HLC gives a
 * total order that respects causality: if A happens-before B, then HLC(A) <
 * HLC(B). Concurrent events get a partial order that resolves deterministically
 * via the `replica_id` tiebreaker.
 *
 * Pure functions, no I/O. The replica's persisted HLC is updated by the caller
 * (typically the fold's event-construction path).
 */

import type { HLC } from './types.js';

/** Origin: a brand-new clock at the start of time. */
export function zeroHLC(): HLC {
  return { wall_ms: 0, logical: 0 };
}

/**
 * Advance the local HLC for an event originated on this replica.
 * Monotonic w.r.t. both the previous HLC and the wall clock.
 */
export function tickLocal(prev: HLC, now_ms: number): HLC {
  const wall = Math.max(now_ms, prev.wall_ms);
  const logical = wall === prev.wall_ms ? prev.logical + 1 : 0;
  return { wall_ms: wall, logical };
}

/**
 * Advance the local HLC after observing an event from another replica.
 * Ensures the local clock is at least as recent as the incoming one.
 */
export function tickReceive(prev: HLC, incoming: HLC, now_ms: number): HLC {
  const wall = Math.max(now_ms, prev.wall_ms, incoming.wall_ms);
  let logical: number;
  if (wall === prev.wall_ms && wall === incoming.wall_ms) {
    logical = Math.max(prev.logical, incoming.logical) + 1;
  } else if (wall === prev.wall_ms) {
    logical = prev.logical + 1;
  } else if (wall === incoming.wall_ms) {
    logical = incoming.logical + 1;
  } else {
    logical = 0;
  }
  return { wall_ms: wall, logical };
}

/**
 * Total order on HLCs (without replica_id). Returns negative / 0 / positive.
 * Callers that need a fully total order across replicas should break ties on
 * replica_id lexicographically.
 */
export function compareHLC(a: HLC, b: HLC): number {
  if (a.wall_ms !== b.wall_ms) return a.wall_ms - b.wall_ms;
  return a.logical - b.logical;
}

/** Total order including replica_id tiebreaker. */
export function compareHLCWithReplica(
  a: HLC, aReplica: string,
  b: HLC, bReplica: string,
): number {
  const c = compareHLC(a, b);
  if (c !== 0) return c;
  return aReplica < bReplica ? -1 : aReplica > bReplica ? 1 : 0;
}

/**
 * Deterministic HLC for an EVA-from-DEF resolution event: increments the
 * logical counter without touching wall_ms. This makes resolution events
 * reproducible across replicas without reading any clock.
 */
export function tickFromDEF(defHlc: HLC): HLC {
  return { wall_ms: defHlc.wall_ms, logical: defHlc.logical + 1 };
}

/**
 * Two events are concurrent within a window if their HLC wall_ms values are
 * close and neither has the other in its causal chain. The fold-barrier uses
 * this to detect contention candidates; the `caused_by` chain check happens at
 * the call site (it requires log access).
 */
export function withinWindow(a: HLC, b: HLC, windowMs: number): boolean {
  return Math.abs(a.wall_ms - b.wall_ms) < windowMs;
}
