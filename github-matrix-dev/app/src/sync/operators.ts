/**
 * Discriminated union of sync-layer events — one variant per (op, site-family)
 * pair that the sync layer emits or folds.
 *
 * The payload of each variant is the shape of `event.operand` for that
 * variant. The spec calls this payload the "resolution"; in this codebase
 * the `resolution` field is the existing 9-value enum (Clearing, Dissecting,
 * …), so we keep the name `operand` and refer to the spec's terminology in
 * docstrings only.
 *
 * Call sites should construct these via the helpers here rather than by hand,
 * so the fold worker and scheduler always see well-typed operands.
 */

import type { EoEvent } from '../db/types';
import type { SyncSiteFamily } from './sites';
import {
  parsePeerSite,
  parsePieceSite,
  parseSwarmSite,
  parseLogSite,
  parseTailSite,
  isSyncTarget,
} from './sites';

export type PeerId = string; // piece_site uses the peer site string for edges

// ─── swarm:<roomId> operands ─────────────────────────────────────────────

export interface SwarmInsOperand {
  joined_at: string; // ISO ts — when this device joined
}

export type SwarmPeerCoupling = 'active' | 'stale' | 'departed';

export interface SwarmConOperand {
  joined: PeerId; // peer_site string
  coupling: SwarmPeerCoupling;
}

export interface SwarmSigOperand {
  author_device_id: string;
  piece_index: number;
  expected_hash: string;
  advertised_by: PeerId; // peer_site string
}

export interface SwarmSynOperand {
  kind: 'high_redundancy' | 'partition_healed' | 'other';
  contributors?: PeerId[];
  detail?: Record<string, unknown>;
}

// ─── peer:<user>|<device> operands ───────────────────────────────────────

export interface PeerInsOperand {
  first_seen_at: string;
}

export type PeerEvaPredicate =
  | 'satisfies_claimed_hash'
  | 'delivers_promptly'
  | 'authoring_device_reachable';

export interface PeerEvaOperand {
  predicate: PeerEvaPredicate;
  result: boolean;
  evidence: {
    piece_site?: string;
    expected_hash?: string;
    observed_hash?: string;
    [k: string]: unknown;
  };
}

export type PeerEligibilityValue = 'eligible' | `blacklisted_until_${number}`;

export interface PeerRecOperand {
  restructured_field: string; // e.g. "eligibility_for[<piece_site>]"
  from: PeerEligibilityValue | 'unknown';
  to: PeerEligibilityValue;
  until?: number; // epoch ms; present on blacklist transitions
  reason?: string;
}

export type PeerPieceCoupling =
  | 'advertised'
  | 'delivered_verified'
  | 'delivered_failed';

export interface PeerConOperand {
  joined: string; // piece_site
  coupling: PeerPieceCoupling;
  expected_hash?: string;
  observed_hash?: string;
}

export interface PeerSynOperand {
  kind: 'cross_device_unreliability' | 'cross_device_reliability';
  contributors: string[]; // device ids whose RECs were aggregated
  target_field: string;
  threshold: number;
}

// ─── log:<authorDeviceId> operands ───────────────────────────────────────

export interface LogInsOperand {
  first_seen_at: string;
}

export interface LogSegOperand {
  segment_id: string; // piece_site
  bounds: { from_seq: number; to_seq: number };
  closes_at: string; // event_id / client_event_id of closing event
  content_hash: string;
}

export interface LogRecOperand {
  restructured_field: 'tail_head';
  from: number;
  to: number;
}

// ─── piece:<authorDeviceId>/v1/<index> operands ──────────────────────────

export interface PieceInsOperand {
  content_hash: string;
  verified_at: string;
  delivered_by?: PeerId; // peer_site
}

export type DefResolvedFrom =
  | 'author_seg'
  | 'swarm_attestation'
  | 'single_verified_delivery';

export interface PieceDefOperand {
  hash: string;
  resolved_from: DefResolvedFrom;
  evidence?: {
    seg_event_id?: string;
    delivering_peers?: PeerId[];
    [k: string]: unknown;
  };
}

export interface PieceSynOperand {
  contributors: PeerId[]; // peer_sites whose verifying deliveries contributed
  unanimous_hash: string;
  threshold: number;
}

export interface PieceRecOperand {
  recognized: 'unrecoverable_pending_author';
  awaiting: string; // author_device_id
}

// ─── tail:<authorDeviceId> operands ──────────────────────────────────────

export interface TailInsOperand {
  first_seen_at: string;
}

export interface TailRecOperand {
  field: 'local_tail_head';
  from: number;
  to: number;
}

export interface TailSynOperand {
  kind: 'multi_sourced_unanimous';
  contributors: PeerId[];
  head: number;
}

// ─── Variants (discriminated on (op, site-family)) ───────────────────────

export type SyncEventVariant =
  // swarm
  | { op: 'INS'; family: 'swarm'; operand: SwarmInsOperand }
  | { op: 'CON'; family: 'swarm'; operand: SwarmConOperand }
  | { op: 'SIG'; family: 'swarm'; operand: SwarmSigOperand }
  | { op: 'SYN'; family: 'swarm'; operand: SwarmSynOperand }
  // peer
  | { op: 'INS'; family: 'peer'; operand: PeerInsOperand }
  | { op: 'EVA'; family: 'peer'; operand: PeerEvaOperand }
  | { op: 'REC'; family: 'peer'; operand: PeerRecOperand }
  | { op: 'CON'; family: 'peer'; operand: PeerConOperand }
  | { op: 'SYN'; family: 'peer'; operand: PeerSynOperand }
  // log
  | { op: 'INS'; family: 'log'; operand: LogInsOperand }
  | { op: 'SEG'; family: 'log'; operand: LogSegOperand }
  | { op: 'REC'; family: 'log'; operand: LogRecOperand }
  // piece
  | { op: 'INS'; family: 'piece'; operand: PieceInsOperand }
  | { op: 'DEF'; family: 'piece'; operand: PieceDefOperand }
  | { op: 'SYN'; family: 'piece'; operand: PieceSynOperand }
  | { op: 'REC'; family: 'piece'; operand: PieceRecOperand }
  // tail
  | { op: 'INS'; family: 'tail'; operand: TailInsOperand }
  | { op: 'REC'; family: 'tail'; operand: TailRecOperand }
  | { op: 'SYN'; family: 'tail'; operand: TailSynOperand };

export type SyncOp = SyncEventVariant['op'];

// ─── Classification ──────────────────────────────────────────────────────

/** Is `event.target` a sync-layer site? This is the fold worker's wire check. */
export function isSyncEvent(event: EoEvent): boolean {
  return isSyncTarget(event.target);
}

/** Return the family of an event's target, or null if it is not a sync site. */
export function syncEventFamily(event: EoEvent): SyncSiteFamily | null {
  if (parseSwarmSite(event.target)) return 'swarm';
  if (parsePeerSite(event.target)) return 'peer';
  if (parseLogSite(event.target)) return 'log';
  if (parsePieceSite(event.target)) return 'piece';
  if (parseTailSite(event.target)) return 'tail';
  return null;
}

/**
 * Check whether an event's `(op, family)` is a recognized sync variant.
 * Events that fail this check are ignored by the sync fold (they may still
 * be valid application-layer events, or malformed sync events to drop).
 */
export function isRecognizedSyncVariant(op: string, family: SyncSiteFamily): boolean {
  switch (family) {
    case 'swarm':
      return op === 'INS' || op === 'CON' || op === 'SIG' || op === 'SYN';
    case 'peer':
      return op === 'INS' || op === 'EVA' || op === 'REC' || op === 'CON' || op === 'SYN';
    case 'log':
      return op === 'INS' || op === 'SEG' || op === 'REC';
    case 'piece':
      return op === 'INS' || op === 'DEF' || op === 'SYN' || op === 'REC';
    case 'tail':
      return op === 'INS' || op === 'REC' || op === 'SYN';
  }
}
