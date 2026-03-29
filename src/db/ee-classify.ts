/**
 * Experience Engine classification helpers.
 *
 * Auto-classifies events into their cell type (Mode × Object) and
 * NUL absence state. Called by the fold when these fields are not
 * explicitly provided, ensuring backwards compatibility.
 */

import type { Operator, EoState } from './types.js';

/**
 * Classify an operator + operand into a cell type.
 * Mode is determined by the operator's position in the existence triad.
 * Object axis is inferred from operand shape.
 */
export function classifyCellType(
  op: Operator,
  operand: any,
): { mode: 'NUL' | 'SIG' | 'INS'; object: 'ground' | 'figure' | 'pattern' } {
  // Mode: which existence-triad position does this operator occupy?
  let mode: 'NUL' | 'SIG' | 'INS';
  if (op === 'NUL') {
    mode = 'NUL';
  } else if (op === 'SIG') {
    mode = 'SIG';
  } else {
    // INS and all operators above the persistence threshold
    // produce instantiated entries in the Given-Log
    mode = 'INS';
  }

  // Object axis: Ground / Figure / Pattern
  let object: 'ground' | 'figure' | 'pattern';

  if (op === 'SEG' || operand?._ambient || operand?.boundary) {
    // SEG draws boundaries (ambient structure), ambient conditions → Ground
    object = 'ground';
  } else if (
    op === 'CON' || op === 'SYN' || op === 'REC' ||
    operand?.merge || operand?.contains ||
    Array.isArray(operand?.added)
  ) {
    // Relationships spanning multiple figures, composites, recursion → Pattern
    object = 'pattern';
  } else {
    // INS of a specific entity, DEF of a value, EVA of a policy → Figure
    object = 'figure';
  }

  return { mode, object };
}

/**
 * Infer the NUL absence state from the operand and prior state.
 *
 * The three states:
 *   cleared:   was present, now absent (NUL acting on prior INS)
 *   unknown:   slot exists but no observation made (SIG without INS)
 *   never_set: no history for this position (pre-SIG)
 */
export function inferNulState(
  operand: any,
  priorState: EoState | null,
): 'cleared' | 'unknown' | 'never_set' {
  // Explicit state in operand takes precedence
  if (operand?.nul_state === 'cleared' || operand?.nul_state === 'unknown' || operand?.nul_state === 'never_set') {
    return operand.nul_state;
  }

  if (priorState) {
    // Something was here before → cleared
    return 'cleared';
  }

  // No prior state. Without log inspection, default to unknown.
  // A more precise classification would check if SIG ever targeted this path,
  // distinguishing unknown (SIG happened, INS didn't) from never_set (no SIG either).
  return 'unknown';
}
