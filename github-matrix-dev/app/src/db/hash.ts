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

// ─── Sync-layer piece hashing ──────────────────────────────────────────────
//
// `pieceHash` produces a content hash over a sequence of events that forms a
// piece (a bounded segment of an author's log). Two devices computing the
// hash of the same piece must produce the same output — otherwise swarm
// attestation and hash-on-delivery verification break silently.
//
// Canonicalization choice: msgpackr is the project's default msgpack library
// (used by log-opfs, init-cache). It is NOT canonical out of the box:
// `msgpackr.pack({a:1,b:2})` and `msgpackr.pack({b:2,a:1})` produce distinct
// byte strings. It also uses a stateful "records" extension by default,
// caching structures across calls — which is even less reproducible.
//
// So we wrap msgpackr: `canonicalize` deeply sorts object keys, drops
// `undefined`, and normalizes arrays; `Packr({ useRecords: false })` writes
// plain msgpack with the canonical smallest-fitting int encoding msgpackr
// already uses. The result is byte-identical across devices for any
// structurally equal input. We then sha256 the bytes.

import { Packr } from 'msgpackr';

const CANONICAL_PACKR = new Packr({ useRecords: false });

/**
 * Deeply canonicalize a value: sort object keys, drop undefined, recurse into
 * arrays. Preserves `Uint8Array` as-is (msgpack binary). Does not clone
 * primitive leaves.
 */
export function canonicalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    out[k] = canonicalize(v);
  }
  return out;
}

/**
 * Canonical msgpack encoding of a value. Same structural input → byte-
 * identical output on every device.
 */
export function canonicalMsgpack(value: unknown): Uint8Array {
  const packed = CANONICAL_PACKR.pack(canonicalize(value));
  // msgpackr may return a Buffer (Node) or Uint8Array (browser). Normalize.
  if (packed instanceof Uint8Array && packed.constructor === Uint8Array) return packed;
  return new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength);
}

/**
 * Content hash of a piece (an array of events). Canonical msgpack + sha256,
 * hex-encoded.
 */
export async function pieceHash(events: unknown[]): Promise<string> {
  const bytes = canonicalMsgpack(events);
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verify that `events` hash to `expectedHash`. Constant-time string compare.
 */
export async function verifyPieceBytes(events: unknown[], expectedHash: string): Promise<boolean> {
  const actual = await pieceHash(events);
  if (actual.length !== expectedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  }
  return diff === 0;
}
