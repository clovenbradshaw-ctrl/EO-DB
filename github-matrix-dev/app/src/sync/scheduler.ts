/**
 * Sync-layer scheduler — pure (projection, inFlight) → intents.
 *
 * Holds no state of its own. All inputs come from the projection or
 * short-lived bookkeeping (`inFlight`). Same input → same intents.
 *
 * Algorithm (spec):
 *   1. Find pieces in status `absent | signaled | contested` not satisfied
 *      by inFlight at the per-piece fan-out.
 *   2. Rank by rarest-first (lowest swarm availability), deterministic
 *      tiebreak (seed + piece_site hash).
 *   3. For each piece, pick eligible peers that advertised it (respecting
 *      `inFlightPerPeer` and `maxConcurrentPeers`).
 *   4. Endgame fan-out: if missing < `endgameThreshold`, 3 peers per piece.
 *   5. If all peers blacklisted but the authoring device is reachable,
 *      escalate to the author.
 */

import type { SyncProjection, PieceProjection, PeerProjection } from './projection';
import { pieceStatus } from './projection';
import { parsePeerSite } from './sites';
import { stableDerivedId } from './derived';

export type PeerSite = string;
export type PieceSiteStr = string;

export interface SchedulerKnobs {
  /** Max parallel outstanding requests to any one peer. */
  inFlightPerPeer: number;
  /** Max distinct peers a single piece is concurrently requested from. */
  maxConcurrentPeers: number;
  /** Below this many missing pieces, enable endgame fan-out. */
  endgameThreshold: number;
  /** Timeout for the first request to a previously-untried piece. */
  requestTimeoutFirstMs: number;
  /** Timeout for subsequent requests to a piece. */
  requestTimeoutSubsequentMs: number;
  /** Serving-side — refill rate of per-peer token bucket. */
  seedTokenBucketRefillPerSec: number;
  /** Serving-side — burst size of per-peer token bucket. */
  seedTokenBucketBurst: number;
  /** Serving-side — global concurrency cap when seeding. */
  seedGlobalConcurrencyCap: number;
}

export const DEFAULT_KNOBS: SchedulerKnobs = {
  inFlightPerPeer: 4,
  maxConcurrentPeers: 4,
  endgameThreshold: 5,
  requestTimeoutFirstMs: 15_000,
  requestTimeoutSubsequentMs: 10_000,
  seedTokenBucketRefillPerSec: 10,
  seedTokenBucketBurst: 20,
  seedGlobalConcurrencyCap: 16,
};

export const ENDGAME_FANOUT = 3;
export const NORMAL_FANOUT = 1;

export interface SchedulerInput {
  projection: SyncProjection;
  /** piece_site → set of peer_sites already dispatched to. */
  inFlight: Map<PieceSiteStr, Set<PeerSite>>;
  myDeviceId: string;
  /** Epoch ms — used to expire blacklist entries. */
  nowMs: number;
  knobs: SchedulerKnobs;
  /** Deterministic tiebreaker seed. Same seed + same inputs → same intents. */
  seed: number;
}

export type SchedulerIntent =
  | {
      kind: 'request_piece';
      piece_site: PieceSiteStr;
      peer: PeerSite;
      expected_hash: string;
      timeoutMs: number;
    }
  | {
      kind: 'escalate_to_author';
      piece_site: PieceSiteStr;
      author_device_id: string;
      expected_hash: string;
      timeoutMs: number;
    };

// ─── Entry point ─────────────────────────────────────────────────────────

export function schedule(input: SchedulerInput): SchedulerIntent[] {
  const { projection, inFlight, nowMs, knobs, seed } = input;

  // 1. Collect target pieces.
  const targets: PieceProjection[] = [];
  for (const piece of projection.pieces.values()) {
    const status = pieceStatus(piece);
    if (status === 'absent' || status === 'signaled' || status === 'contested') {
      targets.push(piece);
    }
  }

  if (targets.length === 0) return [];

  // 2. Rank rarest-first with deterministic tiebreak.
  const ranked = rankRarestFirst(targets, seed);

  // 3. Compute fan-out.
  const missing = targets.length;
  const rawFanout = missing < knobs.endgameThreshold ? ENDGAME_FANOUT : NORMAL_FANOUT;
  const perPieceFanout = Math.min(rawFanout, knobs.maxConcurrentPeers);

  // 4. Track per-peer outstanding count across the whole scheduling pass.
  const perPeerInFlight = countPerPeer(inFlight);

  // 5. Emit intents.
  const out: SchedulerIntent[] = [];
  const anyPriorActivity = hasAnyPriorActivity(projection, inFlight);
  const firstTimeout = knobs.requestTimeoutFirstMs;
  const subseqTimeout = knobs.requestTimeoutSubsequentMs;

  for (const piece of ranked) {
    const expected_hash = chooseExpectedHash(piece);
    if (!expected_hash) continue;

    const existingInFlight = inFlight.get(piece.piece_site) ?? new Set<PeerSite>();
    const room = perPieceFanout - existingInFlight.size;
    if (room <= 0) continue;

    const pieceFirstAttempt = isPieceFirstAttempt(piece, existingInFlight);
    const timeoutMs = anyPriorActivity && !pieceFirstAttempt ? subseqTimeout : firstTimeout;

    const eligiblePeers = pickEligiblePeers(projection, piece, existingInFlight, perPeerInFlight, knobs, nowMs, seed);

    let emitted = 0;
    for (const peer of eligiblePeers) {
      if (emitted >= room) break;
      out.push({ kind: 'request_piece', piece_site: piece.piece_site, peer, expected_hash, timeoutMs });
      perPeerInFlight.set(peer, (perPeerInFlight.get(peer) ?? 0) + 1);
      emitted += 1;
    }

    // 6. Escalation: every advertising peer is blacklisted (no eligible peers
    //    found AND the piece has prior advertisers) and the author is reachable.
    if (emitted === 0 && pieceHasAdvertisers(piece)) {
      if (authorReachable(projection, piece.author_device_id)) {
        out.push({
          kind: 'escalate_to_author',
          piece_site: piece.piece_site,
          author_device_id: piece.author_device_id,
          expected_hash,
          timeoutMs,
        });
      }
    }
  }

  return out;
}

// ─── Ranking ─────────────────────────────────────────────────────────────

/** Lower score = rarer = higher priority. */
function swarmAvailability(piece: PieceProjection): number {
  const advertisers = new Set<PeerSite>();
  for (const c of piece.candidates.values()) {
    for (const p of c.advertised_by) advertisers.add(p);
  }
  for (const d of piece.deliveries.values()) {
    if (d.verified) advertisers.add(d.peer);
  }
  return advertisers.size;
}

function rankRarestFirst(pieces: PieceProjection[], seed: number): PieceProjection[] {
  const annotated = pieces.map((p) => ({
    piece: p,
    availability: swarmAvailability(p),
    tiebreak: stableTiebreak(p.piece_site, seed),
  }));
  annotated.sort((a, b) => {
    if (a.availability !== b.availability) return a.availability - b.availability;
    if (a.tiebreak < b.tiebreak) return -1;
    if (a.tiebreak > b.tiebreak) return 1;
    return 0;
  });
  return annotated.map((a) => a.piece);
}

/** Deterministic hex string — same (site, seed) → same output. */
function stableTiebreak(site: string, seed: number): string {
  return stableDerivedId('TIE', site, [String(seed)]);
}

// ─── Piece-local helpers ────────────────────────────────────────────────

function chooseExpectedHash(piece: PieceProjection): string | null {
  // Prefer author-asserted hash (SEG).
  if (piece.authorHash) return piece.authorHash;
  // Otherwise the most-advertised candidate.
  let best: { hash: string; count: number; firstSeq: number } | null = null;
  for (const c of piece.candidates.values()) {
    const count = c.advertised_by.size;
    if (!best || count > best.count || (count === best.count && c.first_seq < best.firstSeq)) {
      best = { hash: c.expected_hash, count, firstSeq: c.first_seq };
    }
  }
  return best?.hash ?? null;
}

function pieceHasAdvertisers(piece: PieceProjection): boolean {
  for (const c of piece.candidates.values()) {
    if (c.advertised_by.size > 0) return true;
  }
  return false;
}

function isPieceFirstAttempt(piece: PieceProjection, existingInFlight: Set<PeerSite>): boolean {
  if (existingInFlight.size > 0) return false;
  if (piece.deliveries.size > 0) return false;
  if (piece.failedDeliveries.size > 0) return false;
  return true;
}

function hasAnyPriorActivity(projection: SyncProjection, inFlight: Map<PieceSiteStr, Set<PeerSite>>): boolean {
  if (inFlight.size > 0) return true;
  for (const piece of projection.pieces.values()) {
    if (piece.deliveries.size > 0 || piece.failedDeliveries.size > 0) return true;
  }
  return false;
}

// ─── Peer selection ─────────────────────────────────────────────────────

function pickEligiblePeers(
  projection: SyncProjection,
  piece: PieceProjection,
  existingInFlight: Set<PeerSite>,
  perPeerInFlight: Map<PeerSite, number>,
  knobs: SchedulerKnobs,
  nowMs: number,
  seed: number,
): PeerSite[] {
  // Candidate set: peers that advertised the piece (includes past verified deliveries).
  const advertisers = new Set<PeerSite>();
  for (const c of piece.candidates.values()) {
    for (const p of c.advertised_by) advertisers.add(p);
  }
  for (const d of piece.deliveries.values()) {
    if (d.verified) advertisers.add(d.peer);
  }

  const eligible: PeerSite[] = [];
  for (const peerSite of advertisers) {
    if (existingInFlight.has(peerSite)) continue;
    if ((perPeerInFlight.get(peerSite) ?? 0) >= knobs.inFlightPerPeer) continue;
    const peer = projection.peers.get(peerSite);
    if (!isPeerEligibleForPiece(peer, piece.piece_site, nowMs)) continue;
    eligible.push(peerSite);
  }

  // Deterministic ordering: by tiebreak hash, rarest-first across peers
  // (peers with fewest outstanding requests first).
  eligible.sort((a, b) => {
    const aLoad = perPeerInFlight.get(a) ?? 0;
    const bLoad = perPeerInFlight.get(b) ?? 0;
    if (aLoad !== bLoad) return aLoad - bLoad;
    const aT = stableTiebreak(a, seed);
    const bT = stableTiebreak(b, seed);
    if (aT < bT) return -1;
    if (aT > bT) return 1;
    return 0;
  });

  return eligible;
}

function isPeerEligibleForPiece(
  peer: PeerProjection | undefined,
  piece_site: PieceSiteStr,
  nowMs: number,
): boolean {
  if (!peer) return true; // peer with no observed REC is eligible by default
  const field = `eligibility_for[${piece_site}]`;
  const value = peer.eligibility.get(field);
  if (!value) return true;
  if (value === 'eligible') return true;
  // Blacklisted — check until-time.
  const until = peer.eligibilityUntil.get(field);
  if (typeof until === 'number' && until <= nowMs) return true;
  return false;
}

// ─── Author reachability ────────────────────────────────────────────────

function authorReachable(projection: SyncProjection, authorDeviceId: string): boolean {
  for (const member of projection.swarm.members.values()) {
    if (member.coupling === 'departed') continue;
    const parsed = parsePeerSite(member.peer);
    if (!parsed) continue;
    if (parsed.deviceId === authorDeviceId) return true;
  }
  return false;
}

// ─── In-flight counting ─────────────────────────────────────────────────

function countPerPeer(inFlight: Map<PieceSiteStr, Set<PeerSite>>): Map<PeerSite, number> {
  const counts = new Map<PeerSite, number>();
  for (const peers of inFlight.values()) {
    for (const p of peers) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return counts;
}
