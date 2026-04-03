/**
 * Encryption middleware — transparent encrypt-on-write and decrypt-on-read.
 *
 * This module sits between the fold engine / horizon reader and the raw state layer.
 * When encryption is enabled (MatrixAuthConfig.encryption.enabled = true):
 *
 *   WRITE PATH (fold → state):
 *     1. Check if target has a field-specific encryption designation (field-encrypt)
 *     2. If not, check waterfall encryption scope (encrypt boundary from ancestor SEG)
 *     3. If either applies, encrypt the operand before it hits setState
 *     4. If neither, pass through as plaintext
 *
 *   READ PATH (state → horizon):
 *     1. Check if the value is an EncryptedOperand (_encrypted: true)
 *     2. If so, look up the key in the local keyring
 *     3. If key found, decrypt and return plaintext
 *     4. If key not found, return a redacted marker (user lacks access)
 *
 * The middleware is stateless — it takes a keyring and config and produces
 * pure functions. This makes it testable and composable.
 */

import type { EoDb } from '../db/level.js';
import type { LocalKeyring, EncryptedOperand } from '../db/crypto-types.js';
import { isEncryptedOperand } from '../db/crypto-types.js';
import { getEncryptionScope } from '../db/encryption-scope.js';
import { getFieldEncryptionDesignation, isFieldEncryptionDesignation } from './field-access-control.js';
import { encryptOperand, decryptOperand, getKeyById, resolveKeyForTarget } from './segment-keys.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Configuration for the encryption middleware. */
export interface EncryptionMiddlewareConfig {
  /** Master toggle — when false, everything passes through unchanged */
  enabled: boolean;
  /** The local keyring holding decrypted segment keys */
  keyring: LocalKeyring;
}

/** Redacted marker — returned when the user lacks the key to decrypt a field. */
export interface RedactedValue {
  _redacted: true;
  /** The key_id needed to decrypt (so the client knows which room to join) */
  required_key_id: string;
  /** The key room where the key lives (if known) */
  key_room_id?: string;
}

/** Type guard for redacted values. */
export function isRedactedValue(value: any): value is RedactedValue {
  return value != null && typeof value === 'object' && value._redacted === true;
}

// ─── Write Path: Encrypt Before Store ───────────────────────────────────────

/**
 * Maybe encrypt an operand before it gets stored via setState.
 *
 * Resolution order:
 *   1. Field-specific designation (field-encrypt) — exact match on target
 *   2. Waterfall encryption scope (encrypt boundary from ancestor)
 *   3. No encryption — return operand unchanged
 *
 * If the operand is already encrypted (_encrypted: true), pass through as-is.
 * This handles the case where the client pre-encrypted before sending.
 */
export async function maybeEncryptForWrite(
  db: EoDb,
  config: EncryptionMiddlewareConfig,
  target: string,
  operand: any,
): Promise<any> {
  // Master toggle off → passthrough
  if (!config.enabled) return operand;

  // Already encrypted by the client → don't double-encrypt
  if (isEncryptedOperand(operand)) return operand;

  // Skip internal/structural operands that should never be encrypted
  if (isStructuralOperand(operand)) return operand;

  // 1. Check for field-specific encryption designation
  const fieldDesignation = await getFieldEncryptionDesignation(db, target);
  if (fieldDesignation) {
    const entry = getKeyById(config.keyring, fieldDesignation.key_id);
    if (entry) {
      return encryptOperand(entry.key, fieldDesignation.key_id, fieldDesignation.key_version, operand);
    }
    // Field is designated for encryption but this writer lacks the key.
    // Refuse to store plaintext — the caller must acquire the key first.
    throw new Error(
      `Cannot write to encrypted field: missing segment key ${fieldDesignation.key_id}. ` +
      `Request key access before writing to this field.`,
    );
  }

  // 2. Check waterfall encryption scope
  const scope = await getEncryptionScope(db, target);
  if (scope) {
    const entry = getKeyById(config.keyring, scope.key_id);
    if (entry) {
      return encryptOperand(entry.key, scope.key_id, scope.key_version, operand);
    }
    // Scope exists but key not in keyring — try resolveKeyForTarget (prefix match)
    const resolved = resolveKeyForTarget(config.keyring, target);
    if (resolved) {
      // Find the key_id for this resolved entry
      for (const [keyId, e] of config.keyring.keys) {
        if (e === resolved) {
          return encryptOperand(e.key, keyId, e.version, operand);
        }
      }
    }
    // Encryption scope exists but no usable key found — refuse to leak plaintext
    throw new Error(
      `Cannot write to encrypted scope: missing segment key ${scope.key_id}. ` +
      `Request key access before writing to this target.`,
    );
  }

  // 3. No encryption applies
  return operand;
}

// ─── Read Path: Decrypt After Load ──────────────────────────────────────────

/**
 * Maybe decrypt a value read from state.
 *
 * If the value is an EncryptedOperand:
 *   - Look up the key in the keyring
 *   - If found, decrypt and return plaintext
 *   - If not found, return a RedactedValue marker
 *
 * If the value is not encrypted, return as-is.
 */
export async function maybeDecryptForRead(
  config: EncryptionMiddlewareConfig,
  value: any,
  target?: string,
): Promise<any> {
  // Master toggle off → passthrough
  if (!config.enabled) return value;

  if (!isEncryptedOperand(value)) return value;

  const encrypted = value as EncryptedOperand;
  const entry = getKeyById(config.keyring, encrypted.key_id);

  if (entry) {
    return decryptOperand(entry.key, encrypted);
  }

  // No key — return redacted marker
  return {
    _redacted: true,
    required_key_id: encrypted.key_id,
  } as RedactedValue;
}

/**
 * Decrypt all encrypted fields in a record's aggregated value object.
 * Used by the Horizon reader after aggregateFieldColumns merges child values.
 *
 * Walks the value object and decrypts any EncryptedOperand values it finds.
 * Non-encrypted values pass through unchanged. Missing keys produce RedactedValue.
 */
export async function decryptRecordFields(
  config: EncryptionMiddlewareConfig,
  value: any,
): Promise<any> {
  if (!config.enabled) return value;
  if (value == null || typeof value !== 'object') return value;

  // If the entire value is encrypted (record-level encryption)
  if (isEncryptedOperand(value)) {
    return maybeDecryptForRead(config, value);
  }

  // Walk object fields and decrypt individually
  const result: Record<string, any> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (isEncryptedOperand(fieldValue)) {
      result[key] = await maybeDecryptForRead(config, fieldValue);
    } else {
      result[key] = fieldValue;
    }
  }

  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Structural operands that must never be encrypted — they're metadata the
 * system needs to read without a key.
 */
function isStructuralOperand(operand: any): boolean {
  if (operand == null) return true;
  if (typeof operand !== 'object') return false;

  // Encryption boundaries themselves
  if (operand.boundary === 'encrypt' || operand.boundary === 'encrypt-policy' || operand.boundary === 'field-encrypt') {
    return true;
  }

  // Alias markers
  if (operand._alias) return true;

  // CON link sets
  if (Array.isArray(operand.linked)) return true;
  if (Array.isArray(operand.added) || Array.isArray(operand.removed)) return true;

  // Formula definitions
  if ('formula' in operand && 'dependencies' in operand) return true;

  return false;
}

/**
 * Create a no-op middleware config (encryption disabled).
 * Useful for tests and when the feature is toggled off.
 */
export function disabledMiddleware(): EncryptionMiddlewareConfig {
  return {
    enabled: false,
    keyring: { keys: new Map() },
  };
}
