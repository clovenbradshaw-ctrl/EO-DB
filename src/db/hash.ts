import { createHash } from 'crypto';
import type { EoEvent } from './types.js';

/**
 * Serialize a value deterministically for hashing.
 * Uses JSON.stringify with sorted keys to ensure consistent output.
 */
function serialize(value: any): string {
  return JSON.stringify(value, Object.keys(value ?? {}).sort());
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
