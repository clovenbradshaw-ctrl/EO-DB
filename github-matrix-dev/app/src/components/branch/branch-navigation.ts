/**
 * branch-navigation — pure helpers for scrubber navigation in the Branch
 * Explorer.
 *
 * These functions implement "jump to next / previous divergence" and the
 * timestamp ↔ scrubber-t conversion used by the divergence list and keyboard
 * shortcut handlers. They are kept pure and dependency-free so the jump
 * logic can be unit-tested without mounting the React tree.
 */

import type { DivergencePoint } from '../../types/branch';

/**
 * Time window shared with BranchExplorer. Declared here (rather than
 * imported from the component) so the helpers have no UI-layer coupling.
 */
export interface NavTimeWindow {
  minMs: number;
  maxMs: number;
}

/** Convert a timestamp to a 0..1 scrubber position within the window. */
export function tAtTs(window: NavTimeWindow, ts: string): number {
  if (window.maxMs <= window.minMs) return 0;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return 0;
  const raw = (ms - window.minMs) / (window.maxMs - window.minMs);
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

/**
 * Deduplicate divergence points that share an (ts, field_path) and compose
 * the union of their `worlds_diverge` arrays into one entry. Used by the
 * navigation helpers so a point that diverges in multiple worlds counts as
 * a single jump target instead of three.
 */
export function mergeDivergencePoints(points: DivergencePoint[]): DivergencePoint[] {
  const byKey = new Map<string, DivergencePoint>();
  for (const p of points) {
    const key = `${p.ts}::${p.field_path}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...p, worlds_diverge: [...p.worlds_diverge] });
      continue;
    }
    for (const w of p.worlds_diverge) {
      if (!existing.worlds_diverge.includes(w)) existing.worlds_diverge.push(w);
    }
  }
  return Array.from(byKey.values());
}

/**
 * Sort divergence points by timestamp, stable-ish (ties broken by
 * field_path so the order is deterministic across renders).
 */
export function sortDivergencePoints(points: DivergencePoint[]): DivergencePoint[] {
  const copy = [...points];
  copy.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts.localeCompare(b.ts);
    return a.field_path.localeCompare(b.field_path);
  });
  return copy;
}

/**
 * First divergence point strictly after `currentTs`, or null if none. The
 * input list may be in any order — the function sorts internally.
 */
export function findNextDivergence(
  points: DivergencePoint[],
  currentTs: string,
): DivergencePoint | null {
  const sorted = sortDivergencePoints(points);
  for (const p of sorted) {
    if (p.ts > currentTs) return p;
  }
  return null;
}

/**
 * Last divergence point strictly before `currentTs`, or null if none.
 */
export function findPrevDivergence(
  points: DivergencePoint[],
  currentTs: string,
): DivergencePoint | null {
  const sorted = sortDivergencePoints(points);
  let best: DivergencePoint | null = null;
  for (const p of sorted) {
    if (p.ts < currentTs) best = p;
    else break;
  }
  return best;
}

/**
 * Find the divergence point closest to `currentTs` (used by the list panel
 * to highlight the "active" row as the scrubber moves). Ties on distance
 * are broken by preferring the earlier point.
 */
export function findNearestDivergence(
  points: DivergencePoint[],
  currentTs: string,
): DivergencePoint | null {
  const currentMs = Date.parse(currentTs);
  if (!Number.isFinite(currentMs)) return null;
  const sorted = sortDivergencePoints(points);
  let best: DivergencePoint | null = null;
  let bestDelta = Infinity;
  for (const p of sorted) {
    const ms = Date.parse(p.ts);
    if (!Number.isFinite(ms)) continue;
    const delta = Math.abs(ms - currentMs);
    if (delta < bestDelta) {
      best = p;
      bestDelta = delta;
    }
  }
  return best;
}
