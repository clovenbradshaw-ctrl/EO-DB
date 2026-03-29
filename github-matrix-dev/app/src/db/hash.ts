/**
 * Browser-compatible transformation hash functions.
 * Mirrors src/db/hash.ts but uses SubtleCrypto (Web Crypto API) instead of Node crypto.
 *
 * Three tiers:
 *  1. seedHash / chainHash — trajectory fingerprinting (running hash of fold history)
 *  2. eventHash — content-addressable event ID for idempotency / deduplication
 *  3. storeFingerprint — Merkle-style digest of the full store for peer sync
 */

function serialize(value: any): string {
  if (value == null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(serialize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(value[k])).join(',') + '}';
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Trajectory seed — hash of the first event in a target's history. */
export async function seedHash(event: { op: string; target: string; operand: any; ts: string }): Promise<string> {
  const input = event.op + event.target + serialize(event.operand) + event.ts;
  return sha256(input);
}

/** Trajectory chain — running hash incorporating previous hash + new event. */
export async function chainHash(previousHash: string, event: { op: string; operand: any }): Promise<string> {
  const input = previousHash + event.op + serialize(event.operand);
  return sha256(input);
}

/**
 * Content-addressable event hash — deterministic ID derived from event content.
 *
 * Two identical events (same op, target, operand, agent, ts) from different
 * devices produce the same hash. This is the primary deduplication mechanism:
 * if two devices create the "same" event offline, only one copy gets folded.
 *
 * Prefixed with "ev:" to distinguish from trajectory hashes.
 */
export async function eventHash(event: {
  op: string;
  target: string;
  operand: any;
  agent: string;
  ts: string;
}): Promise<string> {
  const input = [
    event.op,
    event.target,
    serialize(event.operand),
    event.agent,
    event.ts,
  ].join('\0');
  const hash = await sha256(input);
  return `ev:${hash}`;
}

/**
 * Store fingerprint — lightweight digest of the store's current state.
 *
 * Computes a rolling hash over all state keys+last_seq values. Two stores
 * with identical projected state will produce the same fingerprint, even
 * if their local seq numbers differ (because seq is assigned locally).
 *
 * Used by peer sync to detect divergence without comparing full state.
 */
export async function storeFingerprint(
  stateEntries: Array<{ target: string; last_seq: number; hash?: string }>,
): Promise<string> {
  // Sort by target for determinism
  const sorted = [...stateEntries].sort((a, b) => a.target.localeCompare(b.target));
  const parts = sorted.map((s) => `${s.target}:${s.hash || s.last_seq}`);
  return sha256(parts.join('|'));
}
