/**
 * Sync-layer projection — the fold-derived state for swarm/peer/log/piece/tail
 * sites.
 *
 * The projection is a pure function of the log: same events (after canonical
 * causal sort) produce the same projection on every device. `applyEvent` is
 * immutable — it returns a new projection and never mutates its input.
 *
 * Pieces, peer reputation, and swarm membership live here as projected state;
 * there is no separate bitfield, blacklist map, or piece table. To answer
 * "what does this device have?" query pieces where
 * `status ∈ {'instantiated', 'swarm_attested'}`.
 *
 * Superposition is held as multi-valued state: when conflicting SIGs or EVAs
 * arrive, the projection records all candidates until collapse (DEF derivation)
 * resolves them. Derived DEF/SYN/REC events are computed separately by
 * `computeDerivedEvents` in ./derived.ts.
 */

import type { EoEvent } from '../db/types';
import type {
  SwarmPeerCoupling,
  PeerEligibilityValue,
  PeerEvaPredicate,
  PeerPieceCoupling,
  DefResolvedFrom,
  CacheDefOperand,
  ArchiveScheme,
} from './operators';
import { isRecognizedSyncVariant, syncEventFamily, DEFAULT_CACHE_DEF } from './operators';
import { parsePieceSite, parsePeerSite, parseCacheSite, pieceSite } from './sites';
import { getOriginDeviceId } from './agent';

// ─── Types ───────────────────────────────────────────────────────────────

export type AuthorDeviceId = string;
export type PeerSite = string;
export type PieceSiteStr = string;

/** Observed per-peer membership in the swarm. */
export interface SwarmMember {
  peer: PeerSite;
  coupling: SwarmPeerCoupling;
  last_seq: number;
}

export interface SwarmProjection {
  joined: boolean;
  members: Map<PeerSite, SwarmMember>;
  /** Author device ids that have been observed on this swarm's SIGs. */
  knownAuthors: Set<AuthorDeviceId>;
  synEvents: number; // count of swarm-level SYN events observed
}

/** Candidate hash announced for a piece, with which peers advertised it. */
export interface PieceHashCandidate {
  expected_hash: string;
  advertised_by: Set<PeerSite>;
  first_seq: number;
  last_seq: number;
}

/** Verifying delivery for a piece from a particular peer. */
export interface PieceDelivery {
  peer: PeerSite;
  observed_hash: string;
  verified: boolean;
  seq: number;
}

export type PieceStatus =
  | 'absent'
  | 'signaled'
  | 'contested'
  | 'requested'
  | 'instantiated'
  | 'swarm_attested'
  | 'archived'
  | 'unrecoverable';

/**
 * Set once REC(locally_archived) lands. Identifies where the archived bytes
 * now live; the piece's hash/bounds are unchanged.
 */
export interface PieceArchive {
  archive_uri: string;
  scheme: ArchiveScheme;
  content_hash: string;
  archived_at: string;
  size_bytes: number;
  seq: number;
}

export interface PieceProjection {
  piece_site: PieceSiteStr;
  author_device_id: AuthorDeviceId;
  piece_index: number;
  /** Candidate hashes seen so far. Size > 1 ⇒ superposition (contested). */
  candidates: Map<string /*hash*/, PieceHashCandidate>;
  /** Verifying deliveries, keyed by peer_site → latest delivery. */
  deliveries: Map<PeerSite, PieceDelivery>;
  /** Peers who've failed verification. */
  failedDeliveries: Map<PeerSite, PieceDelivery>;
  /** Author-asserted hash (from SEG on log site). */
  authorHash: string | null;
  /** Collapsed hash (after DEF). */
  definedHash: string | null;
  definedFrom: DefResolvedFrom | null;
  /** Set once INS lands locally. */
  instantiatedHash: string | null;
  /** Set once SYN threshold met. */
  swarmAttestedHash: string | null;
  /** Set once REC recognizes unrecoverability. */
  unrecoverable: boolean;
  /** Set once REC(locally_archived) lands. Cleared on subsequent INS. */
  archive: PieceArchive | null;
  /** Sequence number of the last event applied to this piece. */
  last_seq: number;
}

export interface PeerPieceEdge {
  piece_site: PieceSiteStr;
  coupling: PeerPieceCoupling;
  last_seq: number;
}

export interface PeerEvaObservation {
  predicate: PeerEvaPredicate;
  result: boolean;
  evidence: Record<string, unknown>;
  seq: number;
}

/** Reputation restructuring RECs observed *from other devices* for this peer. */
export interface PeerReputationRec {
  observer_device_id: AuthorDeviceId | null;
  restructured_field: string;
  from: string;
  to: string;
  until?: number;
  seq: number;
}

export interface PeerProjection {
  peer_site: PeerSite;
  user_id: string;
  device_id: string;
  first_seen_seq: number | null;
  /** eligibility keyed by scope — "eligibility_for[<piece_site>]" or "global". */
  eligibility: Map<string /*field*/, PeerEligibilityValue>;
  /** Until-epoch-ms for any non-eligible eligibility entry. */
  eligibilityUntil: Map<string /*field*/, number>;
  /** Multi-valued EVA history (held for reconciliation). */
  evas: PeerEvaObservation[];
  /** RECs observed, including those from other devices (keyed by observer). */
  recsByObserver: Map<AuthorDeviceId, PeerReputationRec[]>;
  /** Observed edges (peer ↔ piece coupling). */
  edges: Map<PieceSiteStr, PeerPieceEdge>;
  /** Last SYN on this peer — cross-device aggregate. */
  lastSyn: { contributors: string[]; target_field: string; threshold: number; seq: number } | null;
}

export interface LogProjection {
  author_device_id: AuthorDeviceId;
  first_seen_seq: number | null;
  /** SEGs authoritatively closed by this author, keyed by piece_site. */
  segs: Map<PieceSiteStr, { segment_id: PieceSiteStr; bounds: { from_seq: number; to_seq: number }; closes_at: string; content_hash: string; seq: number }>;
  /** Most recent observed tail head (local perspective). */
  localTailHead: number;
}

export interface TailProjection {
  author_device_id: AuthorDeviceId;
  first_seen_seq: number | null;
  localTailHead: number;
  /** Most recent SYN on this tail — multi-sourced unanimity. */
  lastSyn: { contributors: PeerSite[]; head: number; seq: number } | null;
}

/**
 * Per-device retention schema and latest measurement. Lives on
 * `cache:<deviceId>` — each device has its own. The DEF is what the ⊢DEF
 * slot of the archival loop holds; EVA is the last storage reading.
 */
export interface CacheProjection {
  device_id: string;
  cache_site: string;
  first_seen_seq: number | null;
  /** Merged retention schema (falls back to DEFAULT_CACHE_DEF field-wise). */
  def: CacheDefOperand;
  def_seq: number | null;
  /** Latest usage_measurement EVA, if any. */
  lastUsageMb: number | null;
  lastQuotaMb: number | null;
  lastResidentPieces: number | null;
  lastArchivedPieces: number | null;
  lastEvaSeq: number | null;
}

export interface SyncProjection {
  swarm: SwarmProjection;
  peers: Map<PeerSite, PeerProjection>;
  logs: Map<AuthorDeviceId, LogProjection>;
  pieces: Map<PieceSiteStr, PieceProjection>;
  tails: Map<AuthorDeviceId, TailProjection>;
  caches: Map<string /*deviceId*/, CacheProjection>;
}

// ─── Constructors ────────────────────────────────────────────────────────

export function emptyProjection(): SyncProjection {
  return {
    swarm: {
      joined: false,
      members: new Map(),
      knownAuthors: new Set(),
      synEvents: 0,
    },
    peers: new Map(),
    logs: new Map(),
    pieces: new Map(),
    tails: new Map(),
    caches: new Map(),
  };
}

function emptyCache(device_id: string, cache_site: string): CacheProjection {
  return {
    device_id,
    cache_site,
    first_seen_seq: null,
    def: { ...DEFAULT_CACHE_DEF },
    def_seq: null,
    lastUsageMb: null,
    lastQuotaMb: null,
    lastResidentPieces: null,
    lastArchivedPieces: null,
    lastEvaSeq: null,
  };
}

function emptyPiece(piece_site: PieceSiteStr, author_device_id: AuthorDeviceId, piece_index: number): PieceProjection {
  return {
    piece_site,
    author_device_id,
    piece_index,
    candidates: new Map(),
    deliveries: new Map(),
    failedDeliveries: new Map(),
    authorHash: null,
    definedHash: null,
    definedFrom: null,
    instantiatedHash: null,
    swarmAttestedHash: null,
    unrecoverable: false,
    archive: null,
    last_seq: -1,
  };
}

function emptyPeer(peer_site: PeerSite, user_id: string, device_id: string): PeerProjection {
  return {
    peer_site,
    user_id,
    device_id,
    first_seen_seq: null,
    eligibility: new Map(),
    eligibilityUntil: new Map(),
    evas: [],
    recsByObserver: new Map(),
    edges: new Map(),
    lastSyn: null,
  };
}

function emptyLog(author_device_id: AuthorDeviceId): LogProjection {
  return {
    author_device_id,
    first_seen_seq: null,
    segs: new Map(),
    localTailHead: 0,
  };
}

function emptyTail(author_device_id: AuthorDeviceId): TailProjection {
  return {
    author_device_id,
    first_seen_seq: null,
    localTailHead: 0,
    lastSyn: null,
  };
}

// ─── Piece status derivation (pure) ──────────────────────────────────────

export function pieceStatus(p: PieceProjection): PieceStatus {
  if (p.unrecoverable) return 'unrecoverable';
  // Archive implies "bytes not held locally". INS (rehydrate) clears the
  // archive flag, so `archive && !instantiatedHash` is the "faded" state.
  if (p.archive && !p.instantiatedHash) return 'archived';
  if (p.swarmAttestedHash) return 'swarm_attested';
  if (p.instantiatedHash) return 'instantiated';
  if (p.candidates.size > 1) return 'contested';
  if (p.candidates.size === 1 || p.authorHash) return 'signaled';
  return 'absent';
}

// ─── Immutable update helpers ────────────────────────────────────────────

function copyProjection(p: SyncProjection): SyncProjection {
  return {
    swarm: {
      joined: p.swarm.joined,
      members: new Map(p.swarm.members),
      knownAuthors: new Set(p.swarm.knownAuthors),
      synEvents: p.swarm.synEvents,
    },
    peers: new Map(p.peers),
    logs: new Map(p.logs),
    pieces: new Map(p.pieces),
    tails: new Map(p.tails),
    caches: new Map(p.caches),
  };
}

function copyCache(c: CacheProjection): CacheProjection {
  return { ...c, def: { ...c.def } };
}

function copyPiece(p: PieceProjection): PieceProjection {
  const candidates = new Map<string, PieceHashCandidate>();
  for (const [k, v] of p.candidates) {
    candidates.set(k, {
      expected_hash: v.expected_hash,
      advertised_by: new Set(v.advertised_by),
      first_seq: v.first_seq,
      last_seq: v.last_seq,
    });
  }
  return {
    ...p,
    candidates,
    deliveries: new Map(p.deliveries),
    failedDeliveries: new Map(p.failedDeliveries),
  };
}

function copyPeer(p: PeerProjection): PeerProjection {
  const recsByObserver = new Map<AuthorDeviceId, PeerReputationRec[]>();
  for (const [k, v] of p.recsByObserver) recsByObserver.set(k, v.slice());
  return {
    ...p,
    eligibility: new Map(p.eligibility),
    eligibilityUntil: new Map(p.eligibilityUntil),
    evas: p.evas.slice(),
    recsByObserver,
    edges: new Map(p.edges),
  };
}

function copyLog(l: LogProjection): LogProjection {
  return { ...l, segs: new Map(l.segs) };
}

function copyTail(t: TailProjection): TailProjection {
  return { ...t };
}

// ─── applyEvent (pure, immutable) ────────────────────────────────────────

/**
 * Fold one sync-layer event into the projection. Returns a new projection;
 * the input is not mutated.
 *
 * Events whose target is not a sync site, or whose (op, family) is not a
 * recognized sync variant, are returned unchanged. Malformed operands are
 * dropped.
 */
export function applyEvent(proj: SyncProjection, event: EoEvent): SyncProjection {
  const family = syncEventFamily(event);
  if (!family) return proj;
  if (!isRecognizedSyncVariant(event.op, family)) return proj;

  switch (family) {
    case 'swarm':
      return applySwarmEvent(proj, event);
    case 'peer':
      return applyPeerEvent(proj, event);
    case 'log':
      return applyLogEvent(proj, event);
    case 'piece':
      return applyPieceEvent(proj, event);
    case 'tail':
      return applyTailEvent(proj, event);
    case 'cache':
      return applyCacheEvent(proj, event);
  }
}

// ─── swarm events ────────────────────────────────────────────────────────

function applySwarmEvent(proj: SyncProjection, event: EoEvent): SyncProjection {
  const next = copyProjection(proj);
  const operand = event.operand as Record<string, unknown> | undefined;
  switch (event.op) {
    case 'INS': {
      if (next.swarm.joined) return proj; // idempotent
      next.swarm.joined = true;
      return next;
    }
    case 'CON': {
      const joined = typeof operand?.joined === 'string' ? (operand.joined as string) : null;
      const coupling = operand?.coupling as SwarmPeerCoupling | undefined;
      if (!joined || !isSwarmPeerCoupling(coupling)) return proj;
      const existing = next.swarm.members.get(joined);
      if (existing && existing.last_seq >= event.seq && existing.coupling === coupling) return proj;
      next.swarm.members.set(joined, { peer: joined, coupling, last_seq: event.seq });
      // Ensure peer projection exists.
      ensurePeerForSite(next, joined, event.seq);
      return next;
    }
    case 'SIG': {
      const author_device_id = operand?.author_device_id as string | undefined;
      const piece_index = operand?.piece_index as number | undefined;
      const expected_hash = operand?.expected_hash as string | undefined;
      const advertised_by = operand?.advertised_by as string | undefined;
      if (!author_device_id || !Number.isInteger(piece_index) || !expected_hash || !advertised_by) return proj;
      next.swarm.knownAuthors.add(author_device_id);
      // Announce hash candidate on the piece.
      const siteStr = pieceSite(author_device_id, piece_index as number);
      const piece = copyPiece(next.pieces.get(siteStr) ?? emptyPiece(siteStr, author_device_id, piece_index as number));
      const candidate = piece.candidates.get(expected_hash) ?? {
        expected_hash,
        advertised_by: new Set<PeerSite>(),
        first_seq: event.seq,
        last_seq: event.seq,
      };
      candidate.advertised_by.add(advertised_by);
      candidate.last_seq = Math.max(candidate.last_seq, event.seq);
      piece.candidates.set(expected_hash, candidate);
      piece.last_seq = Math.max(piece.last_seq, event.seq);
      next.pieces.set(siteStr, piece);
      // Ensure peer has an 'advertised' edge to the piece.
      ensurePeerEdge(next, advertised_by, siteStr, 'advertised', event.seq);
      return next;
    }
    case 'SYN': {
      next.swarm.synEvents += 1;
      return next;
    }
  }
  return proj;
}

// ─── peer events ─────────────────────────────────────────────────────────

function applyPeerEvent(proj: SyncProjection, event: EoEvent): SyncProjection {
  const parsed = parsePeerSite(event.target);
  if (!parsed) return proj;
  const next = copyProjection(proj);
  const peer = copyPeer(next.peers.get(event.target) ?? emptyPeer(event.target, parsed.userId, parsed.deviceId));
  const operand = event.operand as Record<string, unknown> | undefined;

  switch (event.op) {
    case 'INS': {
      if (peer.first_seen_seq !== null) return proj;
      peer.first_seen_seq = event.seq;
      break;
    }
    case 'EVA': {
      const predicate = operand?.predicate as PeerEvaPredicate | undefined;
      const result = operand?.result;
      if (!predicate || typeof result !== 'boolean') return proj;
      peer.evas.push({
        predicate,
        result,
        evidence: (operand?.evidence as Record<string, unknown>) ?? {},
        seq: event.seq,
      });
      break;
    }
    case 'REC': {
      const restructured_field = operand?.restructured_field as string | undefined;
      const to = operand?.to as PeerEligibilityValue | undefined;
      const from = operand?.from as string | undefined;
      if (!restructured_field || !to || !from) return proj;
      const observer = getOriginDeviceId(event);
      const rec: PeerReputationRec = {
        observer_device_id: observer,
        restructured_field,
        from,
        to,
        until: typeof operand?.until === 'number' ? (operand.until as number) : undefined,
        seq: event.seq,
      };
      const key = observer ?? `__anon:${event.seq}`;
      const list = peer.recsByObserver.get(key) ?? [];
      list.push(rec);
      peer.recsByObserver.set(key, list);
      peer.eligibility.set(restructured_field, to);
      if (typeof rec.until === 'number') {
        peer.eligibilityUntil.set(restructured_field, rec.until);
      } else {
        peer.eligibilityUntil.delete(restructured_field);
      }
      break;
    }
    case 'CON': {
      const joined = operand?.joined as string | undefined;
      const coupling = operand?.coupling as PeerPieceCoupling | undefined;
      if (!joined || !isPeerPieceCoupling(coupling)) return proj;
      peer.edges.set(joined, { piece_site: joined, coupling, last_seq: event.seq });
      // If delivered_verified, also reflect on piece.
      if (coupling === 'delivered_verified') {
        const observed_hash = operand?.observed_hash as string | undefined;
        if (observed_hash) {
          const pieceP = copyPiece(next.pieces.get(joined) ?? createPieceFromSite(joined));
          pieceP.deliveries.set(event.target, {
            peer: event.target,
            observed_hash,
            verified: true,
            seq: event.seq,
          });
          pieceP.failedDeliveries.delete(event.target);
          pieceP.last_seq = Math.max(pieceP.last_seq, event.seq);
          next.pieces.set(joined, pieceP);
        }
      } else if (coupling === 'delivered_failed') {
        const observed_hash = operand?.observed_hash as string | undefined;
        const pieceP = copyPiece(next.pieces.get(joined) ?? createPieceFromSite(joined));
        pieceP.failedDeliveries.set(event.target, {
          peer: event.target,
          observed_hash: observed_hash ?? '',
          verified: false,
          seq: event.seq,
        });
        pieceP.last_seq = Math.max(pieceP.last_seq, event.seq);
        next.pieces.set(joined, pieceP);
      }
      break;
    }
    case 'SYN': {
      const contributors = (operand?.contributors as string[] | undefined) ?? [];
      const target_field = operand?.target_field as string | undefined;
      const threshold = operand?.threshold as number | undefined;
      if (!target_field || typeof threshold !== 'number') return proj;
      peer.lastSyn = { contributors: contributors.slice(), target_field, threshold, seq: event.seq };
      break;
    }
  }
  next.peers.set(event.target, peer);
  return next;
}

// ─── log events ──────────────────────────────────────────────────────────

function applyLogEvent(proj: SyncProjection, event: EoEvent): SyncProjection {
  const author_device_id = event.target.slice('log:'.length);
  if (!author_device_id) return proj;
  const next = copyProjection(proj);
  const log = copyLog(next.logs.get(author_device_id) ?? emptyLog(author_device_id));
  const operand = event.operand as Record<string, unknown> | undefined;

  switch (event.op) {
    case 'INS': {
      if (log.first_seen_seq !== null) return proj;
      log.first_seen_seq = event.seq;
      break;
    }
    case 'SEG': {
      // Authority rule: SEG is valid only if origin_device_id === author_device_id.
      const origin = getOriginDeviceId(event);
      if (origin !== author_device_id) return proj;
      const segment_id = operand?.segment_id as string | undefined;
      const bounds = operand?.bounds as { from_seq: number; to_seq: number } | undefined;
      const closes_at = operand?.closes_at as string | undefined;
      const content_hash = operand?.content_hash as string | undefined;
      if (!segment_id || !bounds || !closes_at || !content_hash) return proj;
      const parsedPiece = parsePieceSite(segment_id);
      if (!parsedPiece || parsedPiece.authorDeviceId !== author_device_id) return proj;
      log.segs.set(segment_id, {
        segment_id,
        bounds: { from_seq: bounds.from_seq, to_seq: bounds.to_seq },
        closes_at,
        content_hash,
        seq: event.seq,
      });
      // Reflect author hash on the piece.
      const piece = copyPiece(next.pieces.get(segment_id) ?? emptyPiece(segment_id, author_device_id, parsedPiece.pieceIndex));
      piece.authorHash = content_hash;
      piece.last_seq = Math.max(piece.last_seq, event.seq);
      next.pieces.set(segment_id, piece);
      break;
    }
    case 'REC': {
      const field = operand?.restructured_field as string | undefined;
      const to = operand?.to as number | undefined;
      if (field !== 'tail_head' || typeof to !== 'number') return proj;
      log.localTailHead = Math.max(log.localTailHead, to);
      break;
    }
  }
  next.logs.set(author_device_id, log);
  return next;
}

// ─── piece events ────────────────────────────────────────────────────────

function applyPieceEvent(proj: SyncProjection, event: EoEvent): SyncProjection {
  const parsed = parsePieceSite(event.target);
  if (!parsed) return proj;
  const next = copyProjection(proj);
  const piece = copyPiece(next.pieces.get(event.target) ?? emptyPiece(event.target, parsed.authorDeviceId, parsed.pieceIndex));
  const operand = event.operand as Record<string, unknown> | undefined;

  switch (event.op) {
    case 'INS': {
      const content_hash = operand?.content_hash as string | undefined;
      if (!content_hash) return proj;
      piece.instantiatedHash = content_hash;
      // Fresh INS after archive = rehydrate. Clear the archive marker so
      // status reports 'instantiated'. The URI is still recoverable from
      // the log history if needed.
      piece.archive = null;
      piece.last_seq = Math.max(piece.last_seq, event.seq);
      break;
    }
    case 'DEF': {
      const hash = operand?.hash as string | undefined;
      const resolved_from = operand?.resolved_from as DefResolvedFrom | undefined;
      if (!hash || !isDefResolvedFrom(resolved_from)) return proj;
      piece.definedHash = hash;
      piece.definedFrom = resolved_from;
      piece.last_seq = Math.max(piece.last_seq, event.seq);
      break;
    }
    case 'SYN': {
      const unanimous_hash = operand?.unanimous_hash as string | undefined;
      if (!unanimous_hash) return proj;
      piece.swarmAttestedHash = unanimous_hash;
      piece.last_seq = Math.max(piece.last_seq, event.seq);
      break;
    }
    case 'REC': {
      const recognized = operand?.recognized as string | undefined;
      if (recognized === 'unrecoverable_pending_author') {
        piece.unrecoverable = true;
        piece.last_seq = Math.max(piece.last_seq, event.seq);
        break;
      }
      if (recognized === 'locally_archived') {
        const archive_uri = operand?.archive_uri as string | undefined;
        const scheme = operand?.archive_scheme as ArchiveScheme | undefined;
        const content_hash = operand?.content_hash as string | undefined;
        const archived_at = operand?.archived_at as string | undefined;
        const size_bytes = operand?.size_bytes as number | undefined;
        if (!archive_uri || !isArchiveScheme(scheme) || !content_hash || !archived_at || typeof size_bytes !== 'number') return proj;
        piece.archive = { archive_uri, scheme, content_hash, archived_at, size_bytes, seq: event.seq };
        // Dropping bytes locally: clear the live residency marker.
        piece.instantiatedHash = null;
        piece.last_seq = Math.max(piece.last_seq, event.seq);
        break;
      }
      return proj;
    }
  }
  next.pieces.set(event.target, piece);
  return next;
}

// ─── tail events ─────────────────────────────────────────────────────────

function applyTailEvent(proj: SyncProjection, event: EoEvent): SyncProjection {
  const author_device_id = event.target.slice('tail:'.length);
  if (!author_device_id) return proj;
  const next = copyProjection(proj);
  const tail = copyTail(next.tails.get(author_device_id) ?? emptyTail(author_device_id));
  const operand = event.operand as Record<string, unknown> | undefined;

  switch (event.op) {
    case 'INS': {
      if (tail.first_seen_seq !== null) return proj;
      tail.first_seen_seq = event.seq;
      break;
    }
    case 'REC': {
      const field = operand?.field as string | undefined;
      const to = operand?.to as number | undefined;
      if (field !== 'local_tail_head' || typeof to !== 'number') return proj;
      tail.localTailHead = Math.max(tail.localTailHead, to);
      break;
    }
    case 'SYN': {
      const contributors = operand?.contributors as string[] | undefined;
      const head = operand?.head as number | undefined;
      if (!contributors || typeof head !== 'number') return proj;
      tail.lastSyn = { contributors: contributors.slice(), head, seq: event.seq };
      break;
    }
  }
  next.tails.set(author_device_id, tail);
  return next;
}

// ─── cache events ────────────────────────────────────────────────────────

function applyCacheEvent(proj: SyncProjection, event: EoEvent): SyncProjection {
  const parsed = parseCacheSite(event.target);
  if (!parsed) return proj;
  const next = copyProjection(proj);
  const cache = copyCache(next.caches.get(parsed.deviceId) ?? emptyCache(parsed.deviceId, event.target));
  const operand = event.operand as Record<string, unknown> | undefined;

  switch (event.op) {
    case 'INS': {
      if (cache.first_seen_seq !== null) return proj;
      cache.first_seen_seq = event.seq;
      break;
    }
    case 'DEF': {
      // Partial DEFs compose field-wise with the existing def so a toggle can
      // flip `enabled` without restating the watermarks.
      const next_def: CacheDefOperand = { ...cache.def };
      if (typeof operand?.enabled === 'boolean') next_def.enabled = operand.enabled;
      if (typeof operand?.high_watermark_mb === 'number') next_def.high_watermark_mb = operand.high_watermark_mb;
      if (typeof operand?.low_watermark_mb === 'number') next_def.low_watermark_mb = operand.low_watermark_mb;
      if (typeof operand?.min_attestation === 'number') next_def.min_attestation = operand.min_attestation;
      if (typeof operand?.hot_window_ms === 'number') next_def.hot_window_ms = operand.hot_window_ms;
      // Defend against nonsensical watermarks: reject if low >= high.
      if (next_def.low_watermark_mb >= next_def.high_watermark_mb) return proj;
      if (next_def.high_watermark_mb <= 0) return proj;
      if (next_def.min_attestation < 0) return proj;
      cache.def = next_def;
      cache.def_seq = event.seq;
      break;
    }
    case 'EVA': {
      const predicate = operand?.predicate as string | undefined;
      if (predicate !== 'usage_measurement') return proj;
      const usage_mb = operand?.usage_mb;
      if (typeof usage_mb !== 'number') return proj;
      cache.lastUsageMb = usage_mb;
      cache.lastQuotaMb = typeof operand?.quota_mb === 'number' ? operand.quota_mb as number : null;
      cache.lastResidentPieces = typeof operand?.resident_pieces === 'number' ? operand.resident_pieces as number : null;
      cache.lastArchivedPieces = typeof operand?.archived_pieces === 'number' ? operand.archived_pieces as number : null;
      cache.lastEvaSeq = event.seq;
      break;
    }
  }
  next.caches.set(parsed.deviceId, cache);
  return next;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function ensurePeerForSite(proj: SyncProjection, peer_site: PeerSite, seq: number): void {
  const parsed = parsePeerSite(peer_site);
  if (!parsed) return;
  if (!proj.peers.has(peer_site)) {
    const p = emptyPeer(peer_site, parsed.userId, parsed.deviceId);
    p.first_seen_seq = seq;
    proj.peers.set(peer_site, p);
  }
}

function ensurePeerEdge(
  proj: SyncProjection,
  peer_site: PeerSite,
  piece_site_str: PieceSiteStr,
  coupling: PeerPieceCoupling,
  seq: number,
): void {
  const parsed = parsePeerSite(peer_site);
  if (!parsed) return;
  const existing = proj.peers.get(peer_site);
  const peer = copyPeer(existing ?? emptyPeer(peer_site, parsed.userId, parsed.deviceId));
  if (peer.first_seen_seq === null) peer.first_seen_seq = seq;
  const edge = peer.edges.get(piece_site_str);
  if (!edge || edge.last_seq < seq) {
    peer.edges.set(piece_site_str, { piece_site: piece_site_str, coupling, last_seq: seq });
  }
  proj.peers.set(peer_site, peer);
}

function createPieceFromSite(piece_site_str: PieceSiteStr): PieceProjection {
  const parsed = parsePieceSite(piece_site_str);
  if (!parsed) {
    return emptyPiece(piece_site_str, 'unknown', 0);
  }
  return emptyPiece(piece_site_str, parsed.authorDeviceId, parsed.pieceIndex);
}

function isSwarmPeerCoupling(v: unknown): v is SwarmPeerCoupling {
  return v === 'active' || v === 'stale' || v === 'departed';
}

function isPeerPieceCoupling(v: unknown): v is PeerPieceCoupling {
  return v === 'advertised' || v === 'delivered_verified' || v === 'delivered_failed';
}

function isDefResolvedFrom(v: unknown): v is DefResolvedFrom {
  return v === 'author_seg' || v === 'swarm_attestation' || v === 'single_verified_delivery';
}

function isArchiveScheme(v: unknown): v is ArchiveScheme {
  return v === 'filen' || v === 'drive' || v === 'https' || v === 'matrix_mxc';
}
