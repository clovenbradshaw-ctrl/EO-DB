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
  // Include branch so the same content on different branches produces different hashes.
  // This prevents false idem suppression across branches.
  const branch = (event as any).branch ?? 'main';
  const input = event.op + '\0' + event.target + '\0' + deepSerialize(event.operand) + '\0' + event.agent + '\0' + event.ts + '\0' + branch;
  return 'ev:' + createHash('sha256').update(input).digest('hex');
}

/**
 * Canonical content id for a replicated event.
 *
 * If the event has no HLC (legacy / local-only path), this delegates to
 * `eventHash` and returns a byte-identical id — so `client_event_id`-based
 * idempotency keeps working untouched.
 *
 * If the event carries an HLC, the id covers the replication-relevant
 * payload deterministically across replicas:
 *   sha256(op | target | deepSerialize(operand) | agent | branch
 *          | replica_id | hlc.wall_ms | hlc.logical
 *          | resolves | rule_id)
 *
 * Excluded by design (per spec §4.1, adapted for our event shape):
 *   - `ts` and `acquired_ts`: informational, vary per replica
 *   - `caused_by`: causal links, not part of identity
 *   - `seq`, `client_event_id`: derived / local
 *   - `meta`, `level`, `triggered_by`, `source`, `objectType`,
 *     `context_envelope`, `nul_state`: bookkeeping that does not change which
 *     event this is. (Promote into the id later if any of these turn out to
 *     be identity-bearing for a specific operator.)
 */
export function canonicalEventId(event: EoEventInput | EoEvent): string {
  const hlc = (event as any).hlc as { wall_ms: number; logical: number } | undefined;
  if (!hlc) {
    // Legacy path: identical bytes to today's client_event_id.
    return eventHash(event);
  }
  const branch = (event as any).branch ?? 'main';
  const replica = (event as any).replica_id ?? '';
  const resolves = (event as any).resolves ?? '';
  const rule_id = (event as any).rule_id ?? '';
  const input =
    event.op + '\0' +
    event.target + '\0' +
    deepSerialize(event.operand) + '\0' +
    event.agent + '\0' +
    branch + '\0' +
    replica + '\0' +
    String(hlc.wall_ms) + '\0' +
    String(hlc.logical) + '\0' +
    resolves + '\0' +
    rule_id;
  return 'ev:' + createHash('sha256').update(input).digest('hex');
}

/**
 * Store fingerprint — lightweight digest of the full projected state.
 *
 * Computes a rolling hash over all state keys + transformation hashes.
 * Two stores with identical projected state produce the same fingerprint,
 * even if local seq numbers differ. Used by peer sync to detect divergence.
 */
export function storeFingerprint(
  stateEntries: Array<{ target: string; last_seq: number; hash?: string }>,
): string {
  const sorted = [...stateEntries].sort((a, b) => a.target.localeCompare(b.target));
  const parts = sorted.map((s) => `${s.target}:${s.hash || s.last_seq}`);
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
