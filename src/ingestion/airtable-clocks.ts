/**
 * Per-field hybrid logical clocks for Airtable record state.
 *
 * Every field on `at.{base}.{table}.{record}` carries an HLC + replica id in
 * the operand sidecar at `_airtable.fieldClocks[fieldId]`. Two replicas
 * participate:
 *   - `LOCAL_REPLICA_ID` — this EO-DB instance (set by `applyLocalEdit`)
 *   - `airtable:{baseId}` — Airtable (set by the pull path from
 *     `record.fields.lastModifiedTime` or `record.createdTime`)
 *
 * Comparison uses `(wall_ms, logical, replica_id)`. The winner of a per-field
 * race overwrites; the loser is discarded. Pending writebacks that lose to an
 * incoming pull are superseded (see airtable-writeback.ts).
 *
 * No I/O lives here — readFieldClocks just inspects a `getState` result that
 * the caller supplies, so this module stays a pure-data utility.
 */

import type { HLC } from '../db/types.js';
import {
  tickLocal,
  compareHLCWithReplica,
  zeroHLC,
} from '../db/hlc.js';

/** Stable identifier for the local EO-DB replica (used for HLC tiebreaks). */
export const LOCAL_REPLICA_ID = 'eo-db-local';

/** Replica id for the Airtable side of a base. */
export function airtableReplicaId(baseId: string): string {
  return `airtable:${baseId}`;
}

export interface FieldClock {
  hlc: HLC;
  replica: string;
}

/**
 * Order two field clocks. Positive ⇒ `a` wins (is newer); negative ⇒ `b`
 * wins; zero ⇒ tie (only possible with identical wall_ms+logical+replica).
 */
export function compareFieldClocks(a: FieldClock, b: FieldClock): number {
  return compareHLCWithReplica(a.hlc, a.replica, b.hlc, b.replica);
}

// ─── Local replica tick (in-memory) ────────────────────────────────────────

// Module-global because the tick must be monotonic across calls. On process
// restart `wall_ms` starts at 0, but `tickLocal` does Math.max(now, prev), so
// the very next wall clock reading takes over and monotonicity is preserved.
let localHlc: HLC = zeroHLC();

/** Tick the local replica's HLC and return a clock stamped with it. */
export function tickLocalReplica(now_ms: number = Date.now()): FieldClock {
  localHlc = tickLocal(localHlc, now_ms);
  return { hlc: { ...localHlc }, replica: LOCAL_REPLICA_ID };
}

/** Test hook: reset the local HLC. Production code should never call this. */
export function _resetLocalHlcForTests(): void {
  localHlc = zeroHLC();
}

// ─── Airtable-side clock derivation ────────────────────────────────────────

/**
 * Derive a field clock for an Airtable-originated change. Uses
 * `lastModifiedTime` if available, else `createdTime`, else (0,0).
 * Logical counter is always 0 — Airtable's wall-clock resolution is good
 * enough for our purposes and we have no logical-counter signal from it.
 */
export function airtableClock(
  baseId: string,
  lastModifiedIso: string | undefined,
  fallbackCreatedTime?: string,
): FieldClock {
  const iso = lastModifiedIso || fallbackCreatedTime;
  const wall = iso ? Date.parse(iso) : NaN;
  return {
    hlc: { wall_ms: Number.isFinite(wall) ? wall : 0, logical: 0 },
    replica: airtableReplicaId(baseId),
  };
}

// ─── Clock storage (in operand sidecar) ────────────────────────────────────

/** Read per-field clocks from a record's current EO state. */
export function readFieldClocksFromState(
  state: { value?: any } | null | undefined,
): Record<string, FieldClock> {
  const raw = state?.value?._airtable?.fieldClocks;
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, FieldClock> = {};
  for (const [k, v] of Object.entries(raw)) {
    const c = v as any;
    if (
      c?.hlc &&
      typeof c.hlc.wall_ms === 'number' &&
      typeof c.hlc.logical === 'number' &&
      typeof c.replica === 'string'
    ) {
      out[k] = {
        hlc: { wall_ms: c.hlc.wall_ms, logical: c.hlc.logical },
        replica: c.replica,
      };
    }
  }
  return out;
}

/**
 * Merge `updates` into `existing`, keeping the winner per field. Returns a
 * new object; inputs are not mutated.
 */
export function mergeFieldClocks(
  existing: Record<string, FieldClock>,
  updates: Record<string, FieldClock>,
): Record<string, FieldClock> {
  const out: Record<string, FieldClock> = { ...existing };
  for (const [field, clock] of Object.entries(updates)) {
    const cur = out[field];
    if (!cur || compareFieldClocks(clock, cur) > 0) {
      out[field] = clock;
    }
  }
  return out;
}

/**
 * Decide a winner for each field in `incoming` against the current per-field
 * clocks. Used by the pull path to drop fields where local has a newer write.
 *
 * Returns the subset of `incoming` whose clock strictly beats the existing
 * clock (or where no existing clock is recorded). The accompanying
 * `newClocks` map is what to merge into state.
 */
export function pickIncomingWinners(
  existing: Record<string, FieldClock>,
  incoming: Record<string, unknown>,
  incomingClock: FieldClock,
): { winners: Record<string, unknown>; newClocks: Record<string, FieldClock> } {
  const winners: Record<string, unknown> = {};
  const newClocks: Record<string, FieldClock> = {};
  for (const [field, val] of Object.entries(incoming)) {
    const cur = existing[field];
    if (!cur || compareFieldClocks(incomingClock, cur) > 0) {
      winners[field] = val;
      newClocks[field] = incomingClock;
    }
  }
  return { winners, newClocks };
}
