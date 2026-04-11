/**
 * Event builders for interactive cell-clearing actions in TableView and
 * FigureFields editors.
 *
 * Phase A.6/3 — when a user explicitly clears a field value (via a "Clear
 * value" or "Clear all" context menu, not by editing to an empty string),
 * the interaction has a richer semantics than "set this field to empty":
 * it is a deliberate erasure act that belongs in the NUL slice of the
 * lattice at resolution `'Clearing'`. The fold dispatch for NUL stays a
 * state-map no-op (see `fold.ts` case 'NUL'), so the clearing act does
 * not itself mutate the cell value — the caller is expected to dispatch a
 * DEF alongside this NUL to actually empty the state. What the NUL buys
 * is the NulHorizon entry: a per-site observation tagged with the flavor
 * of absence that future queries (and the Phase C resolution-aware
 * routing) can distinguish from never-set (nibble 0 / 'unspecified') or
 * Tracing ("we looked, found nothing, are tracking it").
 *
 * Extracted here as a pure data builder so the event shape can be unit
 * tested without rendering React. Callers thread the returned event
 * through their own dispatch hook.
 */

import type { EoEventInput } from '../db/types';

/**
 * Build the NUL × Clearing observation event for an interactive field
 * clear. The caller should dispatch its state-mutating DEF first so the
 * state map reflects the cleared value, then dispatch this event second
 * so the NulHorizon entry is chronologically after the DEF it annotates.
 *
 * `ts` defaults to the current wall clock. Override at call sites that
 * need deterministic time (tests, replays).
 */
export function buildNulClearingEvent(
  target: string,
  fieldKey: string,
  agent: string,
  ts: string = new Date().toISOString(),
): EoEventInput {
  return {
    op: 'NUL',
    target,
    operand: { fieldKey },
    resolution: 'Clearing',
    agent,
    ts,
    acquired_ts: ts,
  };
}
