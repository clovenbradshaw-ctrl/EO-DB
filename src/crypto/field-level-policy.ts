/**
 * Field-level encryption policy — declares what gets encrypted and at what granularity.
 *
 * Policies bridge the gap between manual SEG boundaries and automatic per-field encryption.
 * A policy at a target prefix says: "every field under here gets its own encryption key,
 * generated on first write and distributed through the key room that governs this scope."
 *
 * Policy granularity levels:
 *   - 'table'  — one key per table (all records share a key)
 *   - 'record' — one key per record (all fields in a record share a key)
 *   - 'field'  — one key per field (maximum granularity, each field individually encrypted)
 *
 * Storage: Policies are stored as EO state via SEG operator with `boundary: 'encrypt-policy'`.
 * This keeps them in the same event log, subject to the same replication, and visible
 * to the Horizon reader.
 */

import type { EoDb } from '../db/level.js';
import { getState, getStateByPrefix } from '../db/state.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** How granular key generation should be. */
export type EncryptionGranularity = 'table' | 'record' | 'field';

/** Stored in state via SEG operator. */
export interface FieldEncryptionPolicy {
  /** Marker for policy detection */
  boundary: 'encrypt-policy';
  /** How finely to generate keys */
  granularity: EncryptionGranularity;
  /** Key room ID where keys for this scope are distributed */
  key_room_id: string;
  /** Algorithm (always aes-256-gcm for now) */
  algorithm: 'aes-256-gcm';
  /** Whether to auto-generate keys for new targets under this scope */
  auto_generate: boolean;
  /** Optional: specific field names to encrypt (if empty, encrypt ALL fields) */
  field_filter?: string[];
  /** Who created this policy */
  created_by: string;
  /** When this policy was created */
  created_at: string;
}

/** Type guard for encryption policy operands. */
export function isEncryptionPolicy(operand: any): operand is FieldEncryptionPolicy {
  return (
    operand != null &&
    typeof operand === 'object' &&
    operand.boundary === 'encrypt-policy' &&
    typeof operand.granularity === 'string' &&
    typeof operand.key_room_id === 'string'
  );
}

// ─── Policy Resolution ──────────────────────────────────────────────────────

/**
 * Resolve the encryption policy for a target by walking ancestry.
 * Returns the most specific (deepest) policy, or null if no policy covers this target.
 *
 * Example: target = "app.tblClients.rec123.fldSSN"
 *   checks: fldSSN → rec123 → tblClients → app
 *   first policy hit wins.
 */
export async function resolveEncryptionPolicy(
  db: EoDb,
  target: string,
): Promise<{ policy: FieldEncryptionPolicy; scope: string } | null> {
  const parts = target.split('.');

  for (let depth = parts.length; depth >= 1; depth--) {
    const candidate = parts.slice(0, depth).join('.');
    const state = await getState(db, candidate);

    if (state?.value && isEncryptionPolicy(state.value)) {
      return { policy: state.value, scope: candidate };
    }
  }

  return null;
}

/**
 * Determine the encryption key scope for a given target based on the policy's granularity.
 *
 * Given a target like "app.tblClients.rec123.fldSSN" and a policy at "app.tblClients":
 *   - granularity 'table'  → key scope = "app.tblClients"
 *   - granularity 'record' → key scope = "app.tblClients.rec123"
 *   - granularity 'field'  → key scope = "app.tblClients.rec123.fldSSN"
 *
 * Returns the scope string that should be used as the key's scope identifier.
 */
export function deriveKeyScope(
  target: string,
  policyScope: string,
  granularity: EncryptionGranularity,
): string {
  if (granularity === 'table') {
    return policyScope;
  }

  const policyDepth = policyScope.split('.').length;
  const parts = target.split('.');

  if (granularity === 'record') {
    // Key scope = policy scope + one more level (the record)
    const recordDepth = policyDepth + 1;
    if (parts.length >= recordDepth) {
      return parts.slice(0, recordDepth).join('.');
    }
    return policyScope; // Target IS the policy scope or shallower
  }

  // granularity === 'field'
  // Key scope = the full target path (each field gets its own key)
  return target;
}

/**
 * Check whether a specific field name should be encrypted under a given policy.
 * If the policy has no field_filter, all fields are encrypted.
 * If it has a field_filter, only listed fields are encrypted.
 */
export function shouldEncryptField(
  fieldName: string,
  policy: FieldEncryptionPolicy,
): boolean {
  if (!policy.field_filter || policy.field_filter.length === 0) {
    return true; // No filter = encrypt everything
  }
  return policy.field_filter.includes(fieldName);
}

/**
 * List all active encryption policies in the database.
 * Scans state for encrypt-policy boundaries.
 */
export async function listEncryptionPolicies(
  db: EoDb,
): Promise<Array<{ scope: string; policy: FieldEncryptionPolicy }>> {
  const allStates = await getStateByPrefix(db, 'app');
  const policies: Array<{ scope: string; policy: FieldEncryptionPolicy }> = [];

  for (const state of allStates) {
    if (isEncryptionPolicy(state.value)) {
      policies.push({ scope: state.target, policy: state.value });
    }
  }

  return policies;
}
