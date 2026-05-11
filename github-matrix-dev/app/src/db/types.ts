// Re-export governance & access control types
export type { AccessRole, ResolvedPermissions, FieldAssignment, SpaceConfig } from '../permissions/types';
export { ROLE_POWER_LEVELS, ROLE_LABELS, powerLevelToRole } from '../permissions/types';

// The nine operators
export type Operator = 'NUL' | 'SIG' | 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'REC';

// ─── Resolution axis (Phase A slice 6) ────────────────────────────────────────

/**
 * Resolution — the depth coordinate in the operator × site × resolution lattice.
 * Nine canonical stances. `unspecified` is the default nibble (0) and is the
 * only value written for events that do not carry an explicit resolution.
 */
export type Resolution =
  | 'unspecified'
  | 'Clearing'
  | 'Dissecting'
  | 'Unraveling'
  | 'Tending'
  | 'Binding'
  | 'Tracing'
  | 'Cultivating'
  | 'Making'
  | 'Composing';

/** Resolution → low-nibble encoding in the compound glyph written to eodb.idx byte 0. */
export const RESOLUTION_NIBBLE: Record<Resolution, number> = {
  unspecified: 0,
  Clearing:    1,
  Dissecting:  2,
  Unraveling:  3,
  Tending:     4,
  Binding:     5,
  Tracing:     6,
  Cultivating: 7,
  Making:      8,
  Composing:   9,
};

/** Low-nibble → Resolution decoding. Index i corresponds to RESOLUTION_NIBBLE value i. */
export const NIBBLE_TO_RESOLUTION: Resolution[] = [
  'unspecified', 'Clearing', 'Dissecting', 'Unraveling',
  'Tending', 'Binding', 'Tracing', 'Cultivating', 'Making', 'Composing',
];

// ─── Self-Healing Types ───────────────────────────────────────────────────────

/**
 * @deprecated Use `EoEvent.resolution` (Resolution) instead. Kept as a type
 *   alias for backward compatibility with existing data and UI components that
 *   have not yet been migrated to the resolution axis. Mapping:
 *     'cleared'            → Resolution 'Clearing'
 *     'unknown'            → Resolution 'Tracing'
 *     'never-set'          → Resolution 'unspecified'
 *     'promotion_blocked'  → Resolution 'Unraveling'
 *
 *   Convert via `nulStateToResolution` / `resolutionToNulState` below.
 */
export type NulState = 'never-set' | 'unknown' | 'cleared' | 'promotion_blocked';

/**
 * Convert a legacy NulState value to the corresponding Resolution. Used by
 * the fold worker and permissions layer while they are still writing NulState
 * values but persisting events whose canonical field is `resolution`.
 */
export function nulStateToResolution(s: NulState): Resolution {
  switch (s) {
    case 'cleared':           return 'Clearing';
    case 'unknown':           return 'Tracing';
    case 'never-set':         return 'unspecified';
    case 'promotion_blocked': return 'Unraveling';
  }
}

/**
 * Convert a Resolution to the closest legacy NulState value. Used by UI
 * components that still render NulStateBadge — they can read `event.resolution`
 * and produce a NulState for the existing color map. Resolutions that do not
 * map to a named NulState fall back to 'never-set'.
 */
export function resolutionToNulState(r: Resolution): NulState {
  switch (r) {
    case 'Clearing':   return 'cleared';
    case 'Tracing':    return 'unknown';
    case 'Unraveling': return 'promotion_blocked';
    default:           return 'never-set';
  }
}

/** Partition context envelope — stamped on writes during split operation (F2.1). */
export interface ContextEnvelope {
  partition_id: string;
  node_id: string;
  seq_range?: [number, number];
}

/** Declarative migration rule for REC frame-level restructuring (F3.4). */
export interface RecMigrationRule {
  scope: string;
  op: 'rename_field' | 'coerce_field' | 'set_field' | 'delete_field';
  field: string;
  to_field?: string;
  to_type?: 'string' | 'number' | 'boolean';
  value?: any;
}

/** Audit trail for a self-healing operation. */
export interface HealingRecord {
  failure_class: 'F1.1' | 'F1.2' | 'F2.1' | 'F2.2' | 'F2.3' | 'F3.1' | 'F3.2' | 'F3.3' | 'F3.4';
  target: string;
  detected_at: string;
  helix_ops: Array<{ op: string; target: string; reason: string }>;
  resolved: boolean;
  resolution_tier?: 1 | 2 | 3;
}

// Operators that produce log entries (post-INS threshold)
export type LoggableOperator = 'NUL' | 'SIG' | 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'REC';

/**
 * Per-target structural record of which operators have been declared over the target's lifetime.
 * Monotonically advancing: operators are added to declared but never removed.
 * Stored at helix:<target> — separate from EoState to avoid TypeScript construction-site churn
 * across all the existing setState call sites.
 */
export interface HelixPosition {
  /** Which operators have fired on this target (monotonically growing). */
  declared: LoggableOperator[];
  /** Seq of the first event per operator. */
  firstSeq: Partial<Record<LoggableOperator, number>>;
  /** Seq of the most recent event per operator. */
  lastSeq: Partial<Record<LoggableOperator, number>>;
  /** How many times each operator has fired. */
  count: Partial<Record<LoggableOperator, number>>;
}

// Operators that can be submitted externally (by humans or sync bridges)
export type ExternalOperator = 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'NUL' | 'SIG';

// An event in the log
export interface EoEvent {
  seq: number;
  op: LoggableOperator;
  target: string;
  operand: any;
  agent: string;                  // Matrix user ID for human ops, "system" for REC/INS2+
  ts: string;                     // submission timestamp — when the agent/user submitted this event (ISO 8601)
  acquired_ts: string;            // acquisition timestamp — when the system received this event (ISO 8601)
  level?: number;                 // INS level: 1 = human-authored, 2+ = system-discovered
  client_event_id?: string;
  triggered_by?: number;          // for REC/INS2+: seq of the human-initiated event that caused the cycle
  meta?: Record<string, any>;
  branch?: string;                // branch this event belongs to ('main' if absent)
  source?: string;                // originating sync method: 'user' | 'airtable' | 'sync' | 'sandbox' | 'revert' | ...
  context_envelope?: ContextEnvelope; // set during partition operation (F2.1)
  /**
   * Depth coordinate in the operator × site × resolution lattice. Defaults to
   * 'unspecified' when absent — every event written before Phase A slice 6
   * reads back as 'unspecified'. NUL events: the canonical flavor-of-absence
   * field (the legacy `nul_state` field is still read as a fallback).
   */
  resolution?: Resolution;
  /** @deprecated Set by system on NUL events (F1.2). Use `resolution` instead. */
  nul_state?: NulState;
}

// Projected state at a target
export interface EoState {
  target: string;
  value: any;
  hash?: string;                  // transformation hash — fingerprint of the fold history
  level: number;                  // 1 = human-authored (INS1), 2+ = system-discovered (INS2+)
  last_seq: number;
  last_op: Operator;
  last_agent: string;
  last_ts: string;                // submission timestamp of last event
  last_acquired_ts: string;       // acquisition timestamp of last event
  // Incrementally-maintained fold cache — updated on each event for this target.
  // Reads are O(1); horizonGet consumes these directly instead of rescanning the log.
  _fold?: EoStateFold;
  graphMetrics?: GraphMetrics;    // maintained by CON/SYN on edge changes
  _lastRecSeq?: number;           // seq of latest REC event on this target (for RecCycleInfo)
  defeasible_since?: number;      // seq of last REC that superseded this interpretation (F3.3)
}

export interface EoStateFold {
  trajectory: TrajectoryEntry[];         // compressed per-op entries with running hash
  trajectoryHead: string;                // running hash after the last event (for O(1) chain-append)
  trajectoryFingerprint: TrajectoryFingerprint;
  cadence: CadenceInfo;
  eventCount: number;
  firstEventTs: string;
  lastEventTs: string;
  intervalsSorted: number[];             // sorted ms gaps between consecutive events (capped window)
  recentTimestamps: number[];            // event timestamps within the last hour of lastEventTs
  // ─── Similarity signals (incrementally maintained) ───
  touchedAgents?: string[];              // deduplicated list of all agents who wrote to this target
  segmentMemberships?: string[];         // segment/boundary tags from the last SEG event
  crystallizedIn?: string;              // target ID of the derived entity this record is a constituent of
}

// Derived entity registration — tracks INS2+ entities and their constituents
export interface DerivedEntity {
  target: string;
  level: number;
  constituents: string[];
  topology: string;
  inert: boolean;
}

// CON graph edge
export interface GraphEdge {
  source: string;
  dest: string;
  edge_type?: string;
  seq: number;
  /** Typed attribute data carried on relationship-field edges. */
  attrs?: Record<string, unknown>;
}

/** A single edge addition item — either a plain dest string (legacy) or an object with attrs. */
export type ConEdgeAddItem = string | { dest: string; attrs?: Record<string, unknown> };

/** CON operand structure. */
export interface ConOperand {
  added?: ConEdgeAddItem[];
  removed?: string[];
  edge_type?: string;
}

/** Definition of a typed attribute on a relationship edge. */
export interface EdgeAttrDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select';
  options?: string[];
}

// EVA-active registration
export interface EvaRegistration {
  target: string;
  formula: any;
  mode: 'fold' | 'horizon' | 'deferred';
  dependencies: string[];
  /** Set when mode is 'deferred' — explains why evaluation is pending. */
  deferred_reason?: string;
}

// REC recursion result
export interface RecResult {
  converged: boolean;
  iterations: number;
  cycle_length?: number;
  states?: Array<Record<string, any>>;   // populated on oscillation: the cycling states
  stable_state?: Record<string, any>;    // populated on convergence: the final stable state
}

// Subscription for changefeed
export interface Subscription {
  id: string;
  target_pattern: string;
  ops?: Operator[];
  callback: (event: EoEvent) => void;
}

// Input event (before seq assignment — acquired_ts is system-assigned, not caller-provided)
export type EoEventInput = Omit<EoEvent, 'seq'>;

// --- Horizon: The File Cabinet ---

// A single entry in the trajectory timeline, pairing an operator with its running hash
export interface TrajectoryEntry {
  op: LoggableOperator;
  hash: string;                   // running transformation hash after this event
}

export interface HorizonResponse {
  target: string;
  figure: EoState | null;
  ancestry?: AncestryEntry[];
  grounds: GroundEntry[];
  nearby?: SimilarRecord[];
  observations?: Observation[];
  governance?: GovernanceEntry[];
  trajectory?: TrajectoryEntry[];
  signals?: SignalEntry[];
  // ─── Pattern Surfacing (cheap, auto-computed) ───
  hashCohort?: string[];
  trajectoryFingerprint?: TrajectoryFingerprint;
  cadence?: CadenceInfo;
  graphMetrics?: GraphMetrics;
  recCycle?: RecCycleInfo;
  classification?: EntityClassification;
}

export interface AncestryEntry {
  target: string;
  figure: EoState | null;
  grounds: GroundEntry[];
  nearby_count: number;
  children_count: number;
  depth: number;
}

export interface GroundEntry {
  source: string;
  key: string;
  value: any;
  distance: number;
}

/** Similarity dimensions — which axes contributed to the match. */
export interface SimilarityDimensions {
  /** Exact trajectory fingerprint match (identical op sequence). */
  hash?: boolean;
  /** Trajectory op-count cosine similarity (0–1). */
  trajectory?: number;
  /** Field-key Jaccard overlap (0–1). */
  state?: number;
  /** Shared connection ratio (0–1). */
  connections?: number;
}

export interface NearbyEntry {
  target: string;
  /** Overall similarity score (0–1, higher = more similar). */
  score: number;
  /** Which dimensions contributed to the score. */
  dimensions: SimilarityDimensions;
  /** @deprecated kept for backward compat — may be empty. */
  shared: string[];
  /** @deprecated use 1/score instead. */
  distance: number;
}

/** A single plain-English reason why two records are similar. */
export interface SimilarityReason {
  type: 'con' | 'seg' | 'eva' | 'agent' | 'ops' | 'conflict' | 'rec' | 'crystal' | 'temporal';
  weight: number;
  text: string;
  icon: string;
  color: string;
}

/** A similar record with score and ranked plain-English reasons. */
export interface SimilarRecord {
  target: string;
  score: number;
  reasons: SimilarityReason[];
}

/** A template-fired structural observation about the population. */
export interface Observation {
  icon: string;
  color: string;
  text: string;
  action?: string;
  actionTarget?: string;
}

export interface GovernanceEntry {
  target: string;
  strategy?: string;
  formula?: any;
  mode?: 'fold' | 'horizon' | 'deferred';
  scope: 'direct' | 'collection' | 'ancestor';
}

export interface SignalEntry {
  description: string;
  measure: string;
  value: any;
  population: string;
  predicate?: Record<string, any>;
  n: number;
  computed_at: string;
}

// ─── Pattern Surfacing ────────────────────────────────────────────────────

/** Trajectory fingerprint — the operator sequence shape of a target's history. */
export interface TrajectoryFingerprint {
  /** The operator sequence as a dot-joined string, e.g. "INS.DEF.DEF.CON.DEF" */
  sequence: string;
  /** Hash of the sequence string for indexing */
  fingerprint: string;
  /** Count of each operator type (7-dimensional vector) */
  opCounts: Record<LoggableOperator, number>;
}

/** Temporal cadence classification for a target's event rhythm. */
export type CadenceClass = 'burst' | 'periodic' | 'dormant' | 'steady' | 'sparse';

export interface CadenceInfo {
  classification: CadenceClass;
  lastEventTs: string;
  eventCount: number;
  description: string;
}

/** Graph role classification for a node in the CON graph. */
export type GraphRole = 'hub' | 'bridge' | 'leaf' | 'isolated';

export interface GraphMetrics {
  role: GraphRole;
  degree: number;
  inDegree: number;
  outDegree: number;
  mutualCount: number;
}

/** REC cycle visualization data for UX surfacing. */
export interface RecCycleInfo {
  participants: string[];
  triggeringSeq?: number;
  result: RecResult;
  edges: Array<{ source: string; dest: string }>;
}

// ─── Population-Relative Entity Classification ──────────────────────────

/** Raw signals extracted from an entity's fold/card state. */
export interface EntitySignals {
  periodicity:  number;   // 0–1: regularity of event intervals
  momentum:     number;   // recent activity rate
  conflictRate: number;   // ratio of overwrite ops (DEF+SYN) to total
  convergence:  number;   // 0–1: whether entity has settled
  diffSize:     number;   // distance from card prototype
}

/** Online mean + std (Welford internals). */
export interface PopulationStats {
  mean: number;
  std: number;
  n: number;
  m2: number;   // sum of squared diffs for Welford
}

/** Per-signal population statistics, maintained per collection prefix. */
export interface SpaceStatistics {
  periodicity:  PopulationStats;
  momentum:     PopulationStats;
  conflictRate: PopulationStats;
  convergence:  PopulationStats;
  diffSize:     PopulationStats;
}

/** Behavioural entity type — population-relative, not absolute. */
export type EntityType = 'emanon' | 'protogon' | 'holon';

/** Classification result stored on EoState. */
export interface EntityClassification {
  type: EntityType;
  confidence: number;                         // 0–1: how clearly one type dominates
  zScores: Record<string, number>;            // per-signal z-score
  signals: EntitySignals;                     // raw signal values
  population: string;                         // collection prefix used
  populationSize: number;                     // N at classification time
}
