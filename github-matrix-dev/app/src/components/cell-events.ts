/**
 * Event builders for interactive cell mutations in TableView and
 * FigureFields editors.
 *
 * Phase A.6/3 — NUL × Clearing: when a user explicitly clears a field
 * value (via the "Clear value" context menu), the interaction is a
 * deliberate erasure act on the NUL wave at resolution `'Clearing'`.
 *
 * Phase A.6/5 — DEF × Making: when a user fills a previously-empty field
 * for the first time, the DEF is stamped with resolution `'Making'` — the
 * bringing-into-being stance on the DEF wave. This is the DEF-wave
 * counterpart to A.6/3's NUL-wave Clearing: both promote interactive
 * mutations from unspecified state-ops to narrated state transitions on
 * the resolution axis. The compound-glyph byte (operator high nibble |
 * resolution low nibble) in eodb.idx[0] becomes routable by Phase C.5.
 *
 * Extracted here as pure data builders so event shapes can be unit tested
 * without rendering React.
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
 * Build a DEF × Making event for an interactive first-fill — the user is
 * composing this field's value into existence for the first time. The
 * caller determines first-fill by checking the prior value; this builder
 * just stamps the resolution.
 */
export function buildMakingDefEvent(
  target: string,
  fieldKey: string,
  value: unknown,
  agent: string,
  useFieldsSub: boolean,
  ts: string = new Date().toISOString(),
): EoEventInput {
  const operand = useFieldsSub
    ? { fields: { [fieldKey]: value } }
    : { [fieldKey]: value };
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

/**
 * Returns true if `prior` represents an empty/absent field value — the
 * condition under which a subsequent DEF is a "first fill" and should
 * carry resolution 'Making'.
 */
export function isFieldEmpty(prior: unknown): boolean {
  return prior === undefined
    || prior === null
    || prior === ''
    || (Array.isArray(prior) && prior.length === 0);
}
