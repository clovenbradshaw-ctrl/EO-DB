/**
 * Event validation — checks structural integrity of incoming events
 * before they enter the fold engine.
 *
 * Prevents malformed events from half-applying: the fold assigns a seq
 * and appends to log before executing the operator, so a bad event that
 * throws mid-operator would leave the store in an inconsistent state.
 * Validation catches these before any state mutation.
 */

import type { EoEventInput, ExternalOperator } from './types';

const VALID_EXTERNAL_OPS = new Set<string>(['NUL', 'INS', 'SEG', 'CON', 'SYN', 'DEF', 'EVA', 'SIG']);

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate an incoming event. Returns null if valid, or an array of errors.
 */
export function validateEvent(event: any): ValidationError[] | null {
  const errors: ValidationError[] = [];

  if (!event || typeof event !== 'object') {
    return [{ field: 'event', message: 'Event must be a non-null object' }];
  }

  // op: required, must be a valid external operator
  if (typeof event.op !== 'string' || !VALID_EXTERNAL_OPS.has(event.op)) {
    errors.push({
      field: 'op',
      message: `Invalid operator: ${JSON.stringify(event.op)}. Must be one of: ${[...VALID_EXTERNAL_OPS].join(', ')}`,
    });
  }

  // target: required, non-empty string
  if (typeof event.target !== 'string' || event.target.length === 0) {
    errors.push({ field: 'target', message: 'Target must be a non-empty string' });
  }

  // agent: required, non-empty string
  if (typeof event.agent !== 'string' || event.agent.length === 0) {
    errors.push({ field: 'agent', message: 'Agent must be a non-empty string' });
  }

  // ts: required, must be a valid ISO 8601 timestamp
  if (typeof event.ts !== 'string' || isNaN(Date.parse(event.ts))) {
    errors.push({ field: 'ts', message: 'Timestamp (ts) must be a valid ISO 8601 string' });
  }

  // Operator-specific operand validation
  if (errors.length === 0) {
    const opErrors = validateOperand(event.op, event.operand);
    if (opErrors) errors.push(...opErrors);
  }

  return errors.length > 0 ? errors : null;
}

function validateOperand(op: string, operand: any): ValidationError[] | null {
  switch (op) {
    case 'CON':
      if (!operand || typeof operand !== 'object') {
        return [{ field: 'operand', message: 'CON operand must be an object' }];
      }
      if (operand.added && !Array.isArray(operand.added)) {
        return [{ field: 'operand.added', message: 'CON operand.added must be an array' }];
      }
      if (operand.removed && !Array.isArray(operand.removed)) {
        return [{ field: 'operand.removed', message: 'CON operand.removed must be an array' }];
      }
      break;

    case 'SYN':
      if (!operand || typeof operand !== 'object') {
        return [{ field: 'operand', message: 'SYN operand must be an object' }];
      }
      if (operand.merge) {
        if (!Array.isArray(operand.merge) || operand.merge.length !== 2) {
          return [{ field: 'operand.merge', message: 'SYN operand.merge must be a 2-element array' }];
        }
      }
      break;

    case 'NUL':
      // NUL is pure observation, operand is optional
      break;

    case 'SIG':
      if (!operand || typeof operand !== 'object') {
        return [{ field: 'operand', message: 'SIG operand must be an object' }];
      }
      if (typeof operand.fieldKey !== 'string' || operand.fieldKey.length === 0) {
        return [{ field: 'operand.fieldKey', message: 'SIG operand.fieldKey must be a non-empty string' }];
      }
      if (operand.editing !== false && typeof operand.draft !== 'string') {
        return [{ field: 'operand.draft', message: 'SIG operand must include draft (string) or editing: false' }];
      }
      break;

    default:
      // INS, SEG, DEF, EVA — operand is flexible
      break;
  }

  return null;
}

/**
 * Format validation errors into a human-readable string.
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map((e) => `${e.field}: ${e.message}`).join('; ');
}
