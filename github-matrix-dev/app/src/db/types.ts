// Re-export governance & access control types
export type { AccessRole, ResolvedPermissions, FieldAssignment, SpaceConfig } from '../permissions/types';
export { ROLE_POWER_LEVELS, ROLE_LABELS, powerLevelToRole } from '../permissions/types';

// The nine operators
export type Operator = 'NUL' | 'SIG' | 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'REC';

// Operators that produce log entries (post-INS threshold)
export type LoggableOperator = 'NUL' | 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'REC';

// Operators that can be submitted externally (by humans or sync bridges)
export type ExternalOperator = 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'NUL';

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
}

// EVA-active registration
export interface EvaRegistration {
  target: string;
  formula: any;
  mode: 'fold' | 'horizon';
  dependencies: string[];
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
  nearby?: NearbyEntry[];
  governance?: GovernanceEntry[];
  trajectory?: TrajectoryEntry[];
  signals?: SignalEntry[];
  // ─── Pattern Surfacing (cheap, auto-computed) ───
  hashCohort?: string[];
  trajectoryFingerprint?: TrajectoryFingerprint;
  cadence?: CadenceInfo;
  graphMetrics?: GraphMetrics;
  recCycle?: RecCycleInfo;
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

export interface NearbyEntry {
  target: string;
  shared: string[];
  distance: number;
}

export interface GovernanceEntry {
  target: string;
  strategy?: string;
  formula?: any;
  mode?: 'fold' | 'horizon';
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
