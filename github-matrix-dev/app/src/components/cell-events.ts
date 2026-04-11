/**
 * Event builders for interactive cell-clearing and first-fill actions in
 * TableView and FigureFields editors.
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
 * Phase A.6/5 — the symmetric slice on the DEF wave. When a user types a
 * value into a previously-empty field, the DEF that lands carries
 * resolution `'Making'` ("this is the first contribution to this
 * definition; the field is being composed into existence"), so the
 * compound glyph in eodb.idx[0] is DEF × Making (0x68) rather than the
 * unspecified default DEF × unspecified (0x60). Later updates to the same
 * field stay at unspecified — the Making stance only applies to the
 * first fill. This mirrors the `if (!existing)` → `defaultResolution`
 * stamping pattern in airtable-sync.ts on the ingestion path, but on DEF
 * instead of INS and driven by the interactive first-fill predicate in
 * handleCellSave.
 *
 * Extracted here as pure data builders so the event shapes can be unit
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

/**
 * Build the DEF × Making event for an interactive first-fill cell save —
 * a field that was previously undefined / null / '' / [] is receiving its
 * first non-empty value. The operand shape matches what `handleCellSave`
 * builds inline for ordinary updates: a `{ fields: { [fieldKey]: parsed } }`
 * wrapper when the record uses the Airtable-style fields sub-object,
 * otherwise a flat `{ [fieldKey]: parsed }` operand. The only difference
 * from a plain DEF is the `resolution: 'Making'` stamp that writes the
 * Making nibble (0x8) into the low half of eodb.idx byte 0, producing the
 * compound glyph DEF × Making (0x68) that a Phase C.5 nibble scan can
 * route on without decoding the payload.
 *
 * `ts` defaults to the current wall clock. Override at call sites that
 * need deterministic time (tests, replays).
 */
export function buildMakingDefEvent(
  target: string,
  fieldKey: string,
  parsed: unknown,
  agent: string,
  useFieldsSub: boolean,
  ts: string = new Date().toISOString(),
): EoEventInput {
  const operand = useFieldsSub
    ? { fields: { [fieldKey]: parsed } }
    : { [fieldKey]: parsed };
  return {
    op: 'DEF',
    target,
    operand,
    resolution: 'Making',
    agent,
    ts,
    acquired_ts: ts,
  };
}
