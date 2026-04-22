/**
 * Tombstone marker — soft-delete semantics for EoState records.
 *
 * EO-DB deliberately commits to the nine canonical operators (NUL, SIG, INS,
 * SEG, CON, SYN, DEF, EVA, REC). Adding a tenth `DEL` op would force changes
 * to the fold core, HELIX_LEVEL placement, processing-class tables, sync
 * manifests, trajectory fingerprints, and every UI consumer that enumerates
 * operators. Instead, a tombstone is represented as a reserved field written
 * via the existing DEF operator:
 *
 *     value._deleted = { at: <ISO>, by: <agent>, source?: <string> }
 *
 * Consequences of this design:
 *
 *   - No fold changes. DEF already deep-merges the operand into value, so a
 *     single event installs the marker and leaves the rest of the record
 *     intact — the historical snapshot survives for audit.
 *   - Matrix sync works automatically. Tombstones ride the same event log
 *     as every other mutation, so every device converges to the same
 *     "record is deleted" view without bespoke wiring.
 *   - Idempotent. The caller supplies a stable `client_event_id` derived
 *     from the deletion source (e.g. an Airtable webhook payload) so replays
 *     dedup via the existing idem:{id} check in the fold.
 *   - Reversible. A subsequent DEF that sets `_deleted: null` un-tombstones
 *     the record — useful if an upstream system walks back a delete.
 *
 * UI consumers that render record lists should filter tombstoned states out
 * by default (see `isDeleted` below) so deletes propagate to the visible
 * grid without surprising the user. Horizon, statistics, and fold-cache
 * intentionally still see tombstoned rows: the event log is complete and
 * log-level consumers need to observe the full history.
 */

import type { EoStore } from './encrypted-store';
import type { EoState } from './types';
import { processEvent } from './fold';

/** Reserved key on `EoState.value` that holds tombstone metadata. */
export const TOMBSTONE_KEY = '_deleted' as const;

/** Shape of the tombstone marker persisted under `value._deleted`. */
export interface TombstoneMarker {
  /** ISO timestamp when the record was marked deleted. */
  at: string;
  /** Agent identifier that issued the delete (Matrix user id, "airtable-sync", ...). */
  by: string;
  /** Optional free-form provenance tag — e.g. "airtable-webhook" for webhook-driven deletes. */
  source?: string;
}

/**
 * Return true when the state represents a tombstoned record. Safe to call on
 * `null`, `undefined`, or states with no `value` — returns false in those
 * cases so list filters can use it as a predicate without extra guards.
 */
export function isDeleted(state: EoState | null | undefined): boolean {
  if (!state || !state.value || typeof state.value !== 'object') return false;
  const marker = (state.value as Record<string, unknown>)[TOMBSTONE_KEY];
  // Truthy check — `{ at: ..., by: ... }` qualifies, `null` (un-tombstoned)
  // and absent both don't. We deliberately don't require the full
  // TombstoneMarker shape: legacy rows that just carry `_deleted: true`
  // should still be treated as tombstoned.
  return marker != null && marker !== false;
}

/**
 * Emit a DEF event that tombstones the given target. Idempotent via the
 * caller-supplied `client_event_id` — repeated calls with the same id are
 * dropped by the fold's idempotency table.
 *
 * Does NOT verify that the target exists. The caller is responsible for
 * gating on presence if "delete a record we never had" should be a no-op
 * (for Airtable webhooks it is: destroyedRecordIds can legitimately refer
 * to records that never reached this device).
 */
export async function markDeleted(
  store: EoStore,
  target: string,
  agent: string,
  opts: {
    /** Stable id for dedup — replays must supply the same value. */
    clientEventId: string;
    /** Optional provenance tag stored alongside the marker. */
    source?: string;
    /** ISO timestamp; defaults to `new Date().toISOString()`. */
    at?: string;
    /** Forwarded to processEvent so the webhook sync stream picks it up. */
    onEvent?: (event: any) => void;
  },
): Promise<void> {
  const nowIso = opts.at ?? new Date().toISOString();
  const marker: TombstoneMarker = {
    at: nowIso,
    by: agent,
    ...(opts.source ? { source: opts.source } : {}),
  };
  try {
    await processEvent(store, {
      op: 'DEF',
      target,
      operand: { [TOMBSTONE_KEY]: marker },
      agent,
      ts: nowIso,
      acquired_ts: nowIso,
      client_event_id: opts.clientEventId,
    }, opts.onEvent);
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? '';
    // Idempotent replay — the same tombstone event was already folded.
    if (msg.includes('already') || msg.includes('duplicate')) return;
    throw e;
  }
}

/**
 * Partition an array of states into (alive, deleted). Convenience for list
 * views that want to render both sets separately (e.g. a "Show deleted"
 * toggle) without two passes.
 */
export function partitionByTombstone<T extends EoState>(states: T[]): { alive: T[]; deleted: T[] } {
  const alive: T[] = [];
  const deleted: T[] = [];
  for (const s of states) {
    if (isDeleted(s)) deleted.push(s);
    else alive.push(s);
  }
  return { alive, deleted };
}
