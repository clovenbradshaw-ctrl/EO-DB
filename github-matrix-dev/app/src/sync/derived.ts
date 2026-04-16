/**
 * Derived-event computation.
 *
 * The fold emits DEF, SYN, and REC events itself when it detects their
 * triggering conditions on the projection. They are not sent over the wire;
 * each device's fold derives them locally. Other devices see them when they
 * fold their own log.
 *
 * Stable `client_event_id` dedupes re-derivation: the ID is a hash of
 * (op, site, sorted derivation inputs) so the same derivation on any device
 * at any time yields the same id.
 */

import type { EoEvent, LoggableOperator } from '../db/types';
import type { SyncProjection, PieceProjection, PeerProjection } from './projection';
import { pieceStatus } from './projection';

export interface DerivedKnobs {
  /** Independent peers required to derive a piece-site SYN. */
  synThreshold: number;
  /** Independent observer devices required to derive a peer-site SYN. */
  reputationThreshold: number;
  /** ts / acquired_ts for generated events. */
  now: string;
  /** agent string recorded on the generated event. */
  systemAgent: string;
  /** For piece REC(unrecoverable_pending_author): set of author device ids
   *  currently known to be reachable. If a piece's author is NOT in this set,
   *  and all attempted deliveries have failed verification, we derive REC. */
  reachableAuthors: Set<string>;
}

export const DEFAULT_SYN_THRESHOLD = 3;
export const DEFAULT_REPUTATION_THRESHOLD = 3;

/**
 * Compute DEF/SYN/REC events the fold should emit. Each has a stable
 * `client_event_id` based on derivation inputs; callers should dedupe against
 * events they've already emitted.
 */
export function computeDerivedEvents(proj: SyncProjection, knobs: DerivedKnobs): EoEvent[] {
  const out: EoEvent[] = [];

  for (const piece of proj.pieces.values()) {
    emitPieceDef(piece, knobs, out);
    emitPieceSyn(piece, knobs, out);
    emitPieceUnrecoverableRec(piece, knobs, out);
  }

  for (const peer of proj.peers.values()) {
    emitPeerSyn(peer, knobs, out);
  }

  return out;
}

// ─── Piece DEF — collapse ────────────────────────────────────────────────

function emitPieceDef(piece: PieceProjection, knobs: DerivedKnobs, out: EoEvent[]): void {
  if (piece.definedHash) return; // already defined

  // Path 1: authoritative SEG arrived.
  if (piece.authorHash) {
    out.push(buildDerivedEvent('DEF', piece.piece_site, {
      hash: piece.authorHash,
      resolved_from: 'author_seg',
    }, ['author_seg', piece.piece_site, piece.authorHash], knobs));
    return;
  }

  // Path 2: swarm attestation already computed — collapse to unanimous hash.
  if (piece.swarmAttestedHash) {
    out.push(buildDerivedEvent('DEF', piece.piece_site, {
      hash: piece.swarmAttestedHash,
      resolved_from: 'swarm_attestation',
    }, ['swarm_attestation', piece.piece_site, piece.swarmAttestedHash], knobs));
    return;
  }

  // Path 3: exactly one verifying delivery, all candidates concur (or unique).
  const verifyingHashes = new Set<string>();
  for (const d of piece.deliveries.values()) {
    if (d.verified) verifyingHashes.add(d.observed_hash);
  }
  if (verifyingHashes.size === 1 && piece.deliveries.size >= 1) {
    const hash = [...verifyingHashes][0];
    // Only collapse via single verified delivery if no contested superposition
    // remains (either only one candidate, or all verifying on the same hash
    // with no conflicting verifying deliveries).
    if (piece.candidates.size <= 1 || piece.candidates.has(hash)) {
      out.push(buildDerivedEvent('DEF', piece.piece_site, {
        hash,
        resolved_from: 'single_verified_delivery',
      }, ['single_verified_delivery', piece.piece_site, hash], knobs));
    }
  }
}

// ─── Piece SYN — N independent verifying deliveries ─────────────────────

function emitPieceSyn(piece: PieceProjection, knobs: DerivedKnobs, out: EoEvent[]): void {
  if (piece.swarmAttestedHash) return;
  const byHash = new Map<string, Set<string>>();
  for (const d of piece.deliveries.values()) {
    if (!d.verified) continue;
    const set = byHash.get(d.observed_hash) ?? new Set<string>();
    set.add(d.peer);
    byHash.set(d.observed_hash, set);
  }
  for (const [hash, peers] of byHash) {
    if (peers.size >= knobs.synThreshold) {
      const contributors = [...peers].sort();
      out.push(buildDerivedEvent('SYN', piece.piece_site, {
        contributors,
        unanimous_hash: hash,
        threshold: knobs.synThreshold,
      }, ['piece_syn', piece.piece_site, hash, ...contributors], knobs));
      return;
    }
  }
}

// ─── Piece REC — unrecoverable ──────────────────────────────────────────

function emitPieceUnrecoverableRec(piece: PieceProjection, knobs: DerivedKnobs, out: EoEvent[]): void {
  if (piece.unrecoverable) return;
  if (piece.instantiatedHash || piece.swarmAttestedHash || piece.definedHash) return;
  const attempted = piece.deliveries.size + piece.failedDeliveries.size;
  if (attempted === 0) return;
  const anyVerified = [...piece.deliveries.values()].some((d) => d.verified);
  if (anyVerified) return;
  if (knobs.reachableAuthors.has(piece.author_device_id)) return;

  out.push(buildDerivedEvent('REC', piece.piece_site, {
    recognized: 'unrecoverable_pending_author',
    awaiting: piece.author_device_id,
  }, ['piece_rec_unrecoverable', piece.piece_site, piece.author_device_id], knobs));
}

// ─── Peer SYN — cross-device unreliability/reliability aggregate ─────────

function emitPeerSyn(peer: PeerProjection, knobs: DerivedKnobs, out: EoEvent[]): void {
  // Aggregate RECs by restructured_field & value direction (eligible vs blacklisted).
  const bins = new Map<string, Set<string>>(); // key = field + '|' + direction
  for (const [observer, recs] of peer.recsByObserver) {
    if (!observer) continue; // anonymous — can't count independent observer
    for (const r of recs) {
      const direction = r.to.startsWith('blacklisted') ? 'blacklisted' : 'eligible';
      const key = r.restructured_field + '|' + direction;
      const set = bins.get(key) ?? new Set<string>();
      set.add(observer);
      bins.set(key, set);
    }
  }
  for (const [key, observers] of bins) {
    if (observers.size >= knobs.reputationThreshold) {
      const [target_field, direction] = key.split('|');
      const contributors = [...observers].sort();
      // Skip if the peer already has a matching SYN for this field at this threshold.
      if (
        peer.lastSyn &&
        peer.lastSyn.target_field === target_field &&
        peer.lastSyn.threshold === knobs.reputationThreshold &&
        sameSet(peer.lastSyn.contributors, contributors)
      ) {
        continue;
      }
      out.push(buildDerivedEvent('SYN', peer.peer_site, {
        kind: direction === 'blacklisted' ? 'cross_device_unreliability' : 'cross_device_reliability',
        contributors,
        target_field,
        threshold: knobs.reputationThreshold,
      }, ['peer_syn', peer.peer_site, target_field, direction, ...contributors], knobs));
    }
  }
}

// ─── Event construction + stable client_event_id ────────────────────────

function buildDerivedEvent(
  op: LoggableOperator,
  target: string,
  operand: Record<string, unknown>,
  derivationInputs: string[],
  knobs: DerivedKnobs,
): EoEvent {
  const client_event_id = stableDerivedId(op, target, derivationInputs);
  return {
    seq: -1, // placeholder — assigned when the event is appended to the log
    op,
    target,
    operand,
    agent: knobs.systemAgent,
    ts: knobs.now,
    acquired_ts: knobs.now,
    level: 2,
    client_event_id,
    meta: { derived: true, derivation_inputs: derivationInputs.slice() },
  };
}

/**
 * Stable id — sha256-like over a canonical string. Uses a pure-JS FNV-1a+xor
 * chain to avoid an async dependency; collision-resistant enough for dedup
 * within a room. If stronger hashing is required later, swap this for
 * sha256; the id surface (hex string) doesn't change.
 */
export function stableDerivedId(op: string, site: string, inputs: string[]): string {
  const sorted = inputs.slice().sort();
  const canon = op + '\x00' + site + '\x00' + sorted.join('\x01');
  return 'der:' + fnv1a128(canon);
}

function fnv1a128(s: string): string {
  // Two parallel FNV-1a 64-bit hashes with different seeds, giving 128 bits.
  const OFFSET_A = 0xcbf29ce484222325n;
  const OFFSET_B = 0x84222325cbf29ce4n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let a = OFFSET_A;
  let b = OFFSET_B;
  for (let i = 0; i < s.length; i++) {
    const c = BigInt(s.charCodeAt(i));
    a = ((a ^ c) * PRIME) & MASK;
    b = ((b ^ (c + 0x9en)) * PRIME) & MASK;
  }
  return a.toString(16).padStart(16, '0') + b.toString(16).padStart(16, '0');
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  for (const x of b) if (!s.has(x)) return false;
  return true;
}
