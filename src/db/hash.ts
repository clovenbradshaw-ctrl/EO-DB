import { createHash } from 'crypto';
import type { EoEvent, EoEventInput } from './types.js';

/**
 * Serialize a value deterministically for hashing.
 * Uses JSON.stringify with sorted keys to ensure consistent output.
 */
function serialize(value: any): string {
  return JSON.stringify(value, Object.keys(value ?? {}).sort());
}

/**
 * Deep deterministic serialization — recursively sorts keys at every level,
 * not just the top level, to handle nested objects and arrays of objects.
 */
function deepSerialize(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(deepSerialize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + deepSerialize(value[k])).join(',') + '}';
}

/**
 * Compute the seed hash for an INS event.
 * The seed encodes the birth of the entity: operator, target, operand, and timestamp.
 *
 *   hash = sha256("INS" + target + serialize(operand) + timestamp)
 */
export function seedHash(event: EoEvent): string {
  const input = event.op + event.target + serialize(event.operand) + event.ts;
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Chain a new event onto an existing hash.
 * The new hash incorporates the previous hash, the operator code, and the operand.
 *
 *   new_hash = sha256(old_hash + event.op + serialize(event.operand))
 *
 * Timestamp is deliberately excluded from the chain — only the seed includes it.
 * Two targets that underwent the same operations in the same order produce the same hash
 * regardless of when the operations occurred.
 */
export function chainHash(previousHash: string, event: EoEvent): string {
  const input = previousHash + event.op + serialize(event.operand);
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Compute a deterministic hash for a log event based on its content.
 * Used as an automatic client_event_id to prevent duplicate logging
 * when the same event is synced across multiple users/devices.
 *
 * Inputs: op + target + deepSerialize(operand) + agent + ts
 *
 * This ensures that the exact same event submitted from different sync paths
 * produces the same hash, enabling idempotent deduplication.
 */
export function eventHash(event: EoEventInput | EoEvent): string {
  const input = event.op + '\0' + event.target + '\0' + deepSerialize(event.operand) + '\0' + event.agent + '\0' + event.ts;
  return 'ev:' + createHash('sha256').update(input).digest('hex');
}
