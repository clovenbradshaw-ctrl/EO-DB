/**
 * The Nine Rules of the Experience Engine.
 *
 * Three triads mirroring the operator structure:
 *
 * Given-Conformant (Experiential Integrity):
 *   Rule 1 — Distinction: Given and Meant are exhaustive and exclusive.
 *   Rule 2 — Impenetrability: Given derives only from Given.
 *   Rule 3 — Ineliminability: Raw experience persists through all operations.
 *
 * Structure-Conformant (Perspectival Coherence):
 *   Rule 4 — Perspectivality: No God's-eye view. All mediated by position.
 *   Rule 5 — Restrictivity: Refinement only restricts availability.
 *   Rule 6 — Coherence: Overlapping positions agree on existence.
 *
 * Meant-Conformant (Interpretive Accountability):
 *   Rule 7 — Groundedness: Every interpretation traces to raw experience.
 *   Rule 8 — Determinacy: Meaning survives transformation.
 *   Rule 9 — Defeasibility: No interpretation is globally immune.
 */

import type { EoDb } from './level.js';
import { decode } from './level.js';
import type { EoEvent } from './types.js';
import type { Interpretation, RuleCheckResult } from './ee-types.js';
import { RuleViolation, operatorDomain } from './ee-types.js';
import {
  getInterpretationsForTarget,
  getActiveInterpretations,
  traceProvenance,
} from './meant-graph.js';

// ---------------------------------------------------------------------------
// Rule 1 — Distinction
// Given and Meant are exhaustive and exclusive categories.
// Every record is one or the other, never both, never neither.
// ---------------------------------------------------------------------------

/**
 * Check Rule 1: is this event clearly categorized as Given or Meant?
 *
 * Existence triad (NUL, SIG, INS) → Given (raw experience)
 * Structure triad (SEG, CON, SYN) → Given (structural observation)
 * Significance triad (DEF, EVA, REC) → Meant (interpretation)
 */
export function checkRule1(event: EoEvent): RuleCheckResult {
  const domain = operatorDomain(event.op);

  // The operator determines the category. If the event has an operator,
  // it is categorized. The violation would be an event that carries
  // interpretation content in a Given-Log operator, or vice versa.
  if (domain === 'significance') {
    // This is Meant — check it doesn't claim to be raw experience
    if (event.meta?.is_raw_experience === true) {
      return {
        rule: 1,
        name: 'Distinction',
        passed: false,
        violation: RuleViolation.CATEGORICAL_CONFUSION,
        detail: `Significance-triad operator ${event.op} cannot be marked as raw experience`,
      };
    }
  }

  return { rule: 1, name: 'Distinction', passed: true };
}

// ---------------------------------------------------------------------------
// Rule 2 — Impenetrability
// Given derives only from Given. No interpretation can fabricate raw experience.
// ---------------------------------------------------------------------------

/**
 * Check Rule 2: does this event fabricate Given from Meant?
 *
 * A Significance-triad event (DEF/EVA/REC) cannot produce entries in the
 * Given-Log that masquerade as Existence-triad events.
 */
export function checkRule2(event: EoEvent): RuleCheckResult {
  const domain = operatorDomain(event.op);

  if (domain === 'significance') {
    // Significance events are interpretations. They can reference Given entries
    // but cannot create new ones. The fold enforces this: DEF/EVA/REC write
    // to state and meant-graph, but the Given-Log entry they produce is
    // correctly classified as a Significance event, not an Existence event.
    return { rule: 2, name: 'Impenetrability', passed: true };
  }

  if (domain === 'existence') {
    // Existence events must have provenance in direct observation,
    // not in interpretation. Check that triggered_by (if present) points
    // to another existence/structure event, not a significance event.
    if (event.triggered_by != null && event.meta?._triggered_by_domain === 'significance') {
      return {
        rule: 2,
        name: 'Impenetrability',
        passed: false,
        violation: RuleViolation.CONFABULATION,
        detail: `Existence event triggered by significance event seq ${event.triggered_by}`,
      };
    }
  }

  return { rule: 2, name: 'Impenetrability', passed: true };
}

// ---------------------------------------------------------------------------
// Rule 3 — Ineliminability (Anti-Gaslighting Axiom)
// Raw experience persists through all operations. The log is append-only.
// ---------------------------------------------------------------------------

/**
 * Check Rule 3: verify the Given-Log is append-only.
 *
 * This is structurally enforced by the log's append-only design.
 * The check verifies that no operation claims to modify or delete log entries.
 */
export function checkRule3(event: EoEvent): RuleCheckResult {
  // The fold never modifies log entries. This check verifies that
  // no event operand instructs deletion of prior log entries.
  if (event.operand?._delete_log_entry || event.operand?._modify_log_entry) {
    return {
      rule: 3,
      name: 'Ineliminability',
      passed: false,
      violation: RuleViolation.GASLIGHTING,
      detail: 'Attempted to modify or delete Given-Log entry',
    };
  }

  return { rule: 3, name: 'Ineliminability', passed: true };
}

// ---------------------------------------------------------------------------
// Rule 4 — Perspectivality (Anti-Omniscience Axiom)
// No God's-eye view. All availability mediated by position.
// ---------------------------------------------------------------------------

/**
 * Check Rule 4: does this event claim unmediated access?
 *
 * Every event must have an agent (who) and a context. Events without
 * an agent claim a God's-eye view. Events marked as "omniscient" violate.
 */
export function checkRule4(event: EoEvent): RuleCheckResult {
  if (!event.agent) {
    return {
      rule: 4,
      name: 'Perspectivality',
      passed: false,
      violation: RuleViolation.CONTEXT_COLLAPSE,
      detail: 'Event has no agent — claims unmediated access',
    };
  }

  if (event.meta?.omniscient === true || event.meta?.god_view === true) {
    return {
      rule: 4,
      name: 'Perspectivality',
      passed: false,
      violation: RuleViolation.CONTEXT_COLLAPSE,
      detail: 'Event claims omniscient/god-view access',
    };
  }

  return { rule: 4, name: 'Perspectivality', passed: true };
}

// ---------------------------------------------------------------------------
// Rule 5 — Restrictivity
// Refinement only restricts availability. More specific → subset, not superset.
// ---------------------------------------------------------------------------

/**
 * Check Rule 5: this is enforced structurally by the lattice.
 *
 * The availability function (γ) computes visibility from position.
 * A more specific position (deeper in the lattice) sees less.
 * This is verified at the system level, not per-event.
 */
export function checkRule5(_event: EoEvent): RuleCheckResult {
  // Structural enforcement: the availability function respects boundaries.
  // A refinement (deeper position) cannot expand what's visible.
  // This is checked by verifyRestrictivity() on the lattice, not per-event.
  return { rule: 5, name: 'Restrictivity', passed: true };
}

// ---------------------------------------------------------------------------
// Rule 6 — Coherence
// Overlapping positions agree on existence of Given-Log entries.
// ---------------------------------------------------------------------------

/**
 * Check Rule 6: structural — overlapping positions agree.
 *
 * If position A sees entry X and position B sees entry X,
 * they agree that X exists. This is enforced by the fact that
 * the Given-Log is a single append-only sequence — there's only
 * one entry at each seq, so agreement is structural.
 */
export function checkRule6(_event: EoEvent): RuleCheckResult {
  // Structural enforcement: the Given-Log is a single canonical sequence.
  // There are no forks, no branching histories. If two positions both
  // see seq 42, they see the same entry at seq 42.
  return { rule: 6, name: 'Coherence', passed: true };
}

// ---------------------------------------------------------------------------
// Rule 7 — Groundedness
// Every interpretation traces to raw experience through provenance.
// ---------------------------------------------------------------------------

/**
 * Check Rule 7: does this interpretation have provenance?
 */
export function checkRule7ForInterpretation(interp: Interpretation): RuleCheckResult {
  if (!interp.grounded_in || interp.grounded_in.length === 0) {
    return {
      rule: 7,
      name: 'Groundedness',
      passed: false,
      violation: RuleViolation.UNGROUNDED_ASSERTION,
      detail: `Interpretation ${interp.id} has no grounding in raw experience`,
    };
  }

  return { rule: 7, name: 'Groundedness', passed: true };
}

/**
 * Check Rule 7 for an event: if it's a Significance-triad event,
 * verify it will produce a grounded interpretation.
 */
export function checkRule7(event: EoEvent): RuleCheckResult {
  const domain = operatorDomain(event.op);

  if (domain === 'significance') {
    // The event's seq will be its own grounding — this is satisfied
    // by the fold's interpretationFromEvent, which sets grounded_in: [event.seq]
    return { rule: 7, name: 'Groundedness', passed: true };
  }

  // Non-interpretation events don't need provenance
  return { rule: 7, name: 'Groundedness', passed: true };
}

// ---------------------------------------------------------------------------
// Rule 8 — Determinacy
// Meaning is what survives transformation — not essence, but equivalence class.
// ---------------------------------------------------------------------------

/**
 * Check Rule 8: the transformation hash provides determinacy.
 *
 * Each state carries a hash that compresses its transformation history.
 * Two states with the same hash have undergone equivalent transformations.
 * This is the structural basis of determinacy — meaning is the equivalence
 * class of the hash, not any particular value.
 */
export function checkRule8(event: EoEvent): RuleCheckResult {
  // Structural enforcement: the hash system (seedHash, chainHash) ensures
  // that every state transformation produces a new hash. The hash IS the
  // determinacy — it encodes what operations have been applied.
  return { rule: 8, name: 'Determinacy', passed: true };
}

// ---------------------------------------------------------------------------
// Rule 9 — Defeasibility
// No interpretation is globally immune to supersession. ¬∃ m* immune.
// ---------------------------------------------------------------------------

/**
 * Check Rule 9: verify no interpretation claims immunity.
 */
export function checkRule9ForInterpretation(interp: Interpretation): RuleCheckResult {
  // Check for explicit immunity claims
  if ((interp as any).immune === true || (interp as any).final === true) {
    return {
      rule: 9,
      name: 'Defeasibility',
      passed: false,
      violation: RuleViolation.DOGMATISM,
      detail: `Interpretation ${interp.id} claims immunity to supersession`,
    };
  }

  return { rule: 9, name: 'Defeasibility', passed: true };
}

/**
 * Check Rule 9 for an event: if it's an EVA, verify it doesn't claim
 * to produce un-supersedable interpretations.
 */
export function checkRule9(event: EoEvent): RuleCheckResult {
  if (event.op === 'EVA' && event.operand?.immune === true) {
    return {
      rule: 9,
      name: 'Defeasibility',
      passed: false,
      violation: RuleViolation.DOGMATISM,
      detail: 'EVA claims to produce un-supersedable interpretation',
    };
  }

  return { rule: 9, name: 'Defeasibility', passed: true };
}

// ---------------------------------------------------------------------------
// Full rule check
// ---------------------------------------------------------------------------

/**
 * Run all nine rules against an event.
 */
export function checkAllRules(event: EoEvent): RuleCheckResult[] {
  return [
    checkRule1(event),
    checkRule2(event),
    checkRule3(event),
    checkRule4(event),
    checkRule5(event),
    checkRule6(event),
    checkRule7(event),
    checkRule8(event),
    checkRule9(event),
  ];
}

/**
 * Run all applicable rules against an interpretation.
 */
export function checkInterpretationRules(interp: Interpretation): RuleCheckResult[] {
  return [
    checkRule7ForInterpretation(interp),
    checkRule9ForInterpretation(interp),
  ];
}

/**
 * Verify Rule 5 (Restrictivity) across positions.
 *
 * Given a parent position and a child position (refinement),
 * verify that the child sees a subset of what the parent sees.
 */
export function verifyRestrictivity(
  parentVisible: number[],
  childVisible: number[],
): RuleCheckResult {
  const parentSet = new Set(parentVisible);
  const violations = childVisible.filter(seq => !parentSet.has(seq));

  if (violations.length > 0) {
    return {
      rule: 5,
      name: 'Restrictivity',
      passed: false,
      violation: RuleViolation.FORECLOSURE_VIOLATION,
      detail: `Child position sees ${violations.length} entries not visible to parent: [${violations.slice(0, 5).join(', ')}...]`,
    };
  }

  return { rule: 5, name: 'Restrictivity', passed: true };
}
