/**
 * Encryption scope resolution — walks target ancestry to find SEG encrypt boundaries.
 * Implements waterfall: a boundary at "app.tblClients" covers everything below it.
 */

import type { EoDb } from './level.js';
import { getState } from './state.js';
import { isEncryptBoundary, type EncryptBoundaryOperand } from './crypto-types.js';

export interface EncryptionScope {
  /** The segment key UUID */
  key_id: string;
  /** The target prefix where the encryption boundary was declared */
  scope: string;
  /** Key version (from the boundary operand, defaults to 1) */
  key_version: number;
}

/**
 * Walk the target's ancestry upward looking for a SEG with boundary: 'encrypt'.
 * Returns the most specific (deepest) encryption scope, or null if plaintext.
 *
 * Example: target = "app.tblClients.rec123.fldSSN"
 *   checks: app.tblClients.rec123.fldSSN → app.tblClients.rec123 → app.tblClients → app
 *   first hit wins (most specific scope).
 */
export async function getEncryptionScope(
  db: EoDb,
  target: string,
): Promise<EncryptionScope | null> {
  const parts = target.split('.');

  // Walk from the target itself up to the root, checking each ancestor
  for (let depth = parts.length; depth >= 1; depth--) {
    const candidate = parts.slice(0, depth).join('.');
    const state = await getState(db, candidate);

    if (state?.value && isEncryptBoundary(state.value)) {
      const boundary = state.value as EncryptBoundaryOperand;
      return {
        key_id: boundary.key_id,
        scope: candidate,
        key_version: boundary.key_version ?? 1,
      };
    }
  }

  return null; // No encryption boundary — plaintext
}
