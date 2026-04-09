// The nine operators
export type Operator = 'NUL' | 'SIG' | 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'REC';

// ─── Branching ────────────────────────────────────────────────────────────────

/** A named branch (version) of the database. Main is implicit — not stored here. */
export interface Branch {
  id: string;
  name: string;
  parent?: string;        // undefined on 'main'
  /** seq of the fork NUL — the last shared event. Child events start at forkSeq+1. */
  forkSeq: number;
  createdAt: string;
  agent: string;
  /**
   * Optional table scope — limits which targets this branch can diverge from its parent.
   * If set (e.g. 'firm.cases'), getBranchState for targets outside this prefix falls
   * directly to the parent, bypassing branch-specific state.
   *
   * This models "Bob's review of the cases table" — Bob's branch only holds divergent
   * state for cases.*, not for firm-wide config or other tables.
   */
  scope?: string;
  /**
   * Optional role that created / owns this branch.
   * Enables role-scoped parallel review: 'attorney', 'reviewer', 'caseworker', etc.
   * Multiple users can each have their own role branch on the same table simultaneously.
   */
  role?: string;
}

// ─── Conflict ─────────────────────────────────────────────────────────────────

/** Resolution modes — aligned with EO operator capacities. */
export type ResolutionMode =
  | 'Dissecting'   // analytic — one value wins by rule
  | 'Clearing'     // reductive — VOID wins
  | 'Binding'      // relational — conflict IS the datum (default)
  | 'Tending'      // temporal — revert to pre-conflict value from log history
  | 'Unraveling'   // forensic — expose full conflict structure
  | 'Cultivating'  // deferred — flag as pending
  | 'Composing'    // synthetic — merge values by formula (stub)
  | 'Making'       // generative — produce new entity (stub)
  | 'Tracing';     // genealogical — reconstruct provenance (stub)

/**
 * EVA resolution policy — stored at eva-resolve:{target}.
 * Separate from EvaRegistration (formula), which lives at eva:{target}.
 */
export interface EVAResolutionPolicy {
  type: ResolutionMode;
  rule?: 'last-write-wins' | 'priority-weighted' | 'authority-ranked' | 'timestamp-ordered';
  customFormula?: unknown;
}

/** A divergent conflict state — written to the target's state when merge detects disagreement. */
export interface ConflictState {
  conflict: true;
  originOp: 'DEF' | 'INS' | 'CON' | 'SEG';
  values: Array<{ value: unknown; branch: string; seq: number | null; agent: string | null }>;
  resolutionPolicy?: EVAResolutionPolicy;
}

// ─── Self-Healing Types ───────────────────────────────────────────────────────

/** Three NUL states — distinct absence conditions (F1.2). */
export type NulState = 'never-set' | 'unknown' | 'cleared';

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

// Operators that produce log entries
export type LoggableOperator = 'NUL' | 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'REC';

// Operators that can be submitted externally (by humans or sync bridges)
// SIG is submittable but ephemeral — tracked locally, never persisted to the log.
export type ExternalOperator = 'NUL' | 'SIG' | 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA';

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
  source?: string;                // originating context: 'agent' | 'sync' | 'sandbox' etc.
  objectType?: string;            // semantic object class hint (optional)
  context_envelope?: ContextEnvelope; // set during partition operation (F2.1)
  nul_state?: NulState;               // set by system on NUL events (F1.2)
}

// Projected state at a target
export interface EoState {
  target: string;
  value: any;
  hash: string;                   // transformation hash — compressed history of all operations
  level: number;                  // 1 = human-authored (INS1), 2+ = system-discovered (INS2+)
  last_seq: number;
  last_op: Operator;
  last_agent: string;
  last_ts: string;                // submission timestamp of last event
  last_acquired_ts: string;       // acquisition timestamp of last event
  defeasible_since?: number;      // seq of last REC that superseded this interpretation (F3.3)
}

// Derived entity registration — tracks INS2+ entities and their constituents
export interface DerivedEntity {
  target: string;                 // the derived entity's target path
  level: number;                  // INS level (2+)
  constituents: string[];         // targets this entity is made of
  topology: string;               // "cycle" — how the constituents relate
  inert: boolean;                 // true if the dependency cycle has dissolved
}

// Crystallization rule — registered at a scope to watch for emergent structure.
// When the predicate holds stably across `window` consecutive events, the fold
// precipitates a new entity (INS2+) from the stable configuration beneath it.
export interface CrystallizationRule {
  scope: string;              // prefix to watch (e.g. "firm.cases")
  predicate: 'cohort_forms';
  window: number;             // events of stability required before crystallization
  min_members: number;        // minimum cohort size (default 2)
  traits: string[];           // field keys to group by
}

// Stability snapshot for crystallization tracking — persisted in LevelDB
export interface CrystStabilityState {
  scope: string;
  snapshot_hash: string;      // unused for cohort_forms (structural diff is tracked via index)
  counter: number;            // consecutive events with stable structure
  last_seq: number;           // seq of last event that touched this scope
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
// Uses Operator for op since both external (incl SIG) and internal (REC) events pass through
export type EoEventInput = Omit<EoEvent, 'seq' | 'op'> & { op: Operator };

// --- Horizon: The Current State ---
// Layers: Figure, Ground, Nearby, Governance (cheap), Signals (expensive/on-demand)

export interface HorizonResponse {
  target: string;
  figure: EoState | null;                   // what this target IS (with fields as columns)
  ancestry?: AncestryEntry[];                // the ontology chain — parent figures up to root
  grounds: GroundEntry[];                    // ambient conditions pervading this region
  nearby?: NearbyEntry[];                    // similar records in the same collection
  governance?: GovernanceEntry[];            // EVA policies that govern this target
  signals?: SignalEntry[];                   // statistical patterns (on-demand, expensive)
  // ─── Pattern Surfacing (cheap, auto-computed) ───
  /** Structural twins — targets with the exact same transformation hash */
  hashCohort?: string[];
  /** Graph metrics — CON graph role and degree */
  graphMetrics?: GraphMetrics;
  /** REC cycle info — if this target is part of a dependency cycle */
  recCycle?: RecCycleInfo;
  /** Crystallized entities this target is a constituent of */
  crystallizedIn?: CrystallizedInEntry[];
}

/** A crystallized entity that this target participates in. */
export interface CrystallizedInEntry {
  /** Target path of the crystallized entity */
  target: string;
  /** Shared traits that define the cohort */
  traits: Record<string, any>;
  /** How many members in the cohort */
  member_count: number;
  /** Whether the crystallized entity is currently inert */
  inert: boolean;
}

// An ancestor in the ontology chain — each level is a mini-Horizon
export interface AncestryEntry {
  target: string;                            // the ancestor target path
  figure: EoState | null;                    // projected state at this ancestor
  grounds: GroundEntry[];                    // this ancestor's own ambient conditions from above
  nearby_count: number;                      // how many siblings at this level
  children_count: number;                    // how many direct children under this ancestor
  depth: number;                             // 1 = parent, 2 = grandparent, etc.
}

// A ground condition inherited from an ancestor prefix
export interface GroundEntry {
  source: string;
  key: string;
  value: any;
  distance: number;
}

// A nearby record sharing structural traits with the current target
export interface NearbyEntry {
  target: string;
  shared: string[];                          // shared traits: "type:H1B", "caseworker:@maria"
  distance: number;                          // 1 = shares most traits, higher = fewer shared
}

// An EVA policy or formula registration governing this region
export interface GovernanceEntry {
  target: string;                            // the EVA-registered target
  strategy?: string;                         // conflict resolution strategy if EVA policy
  formula?: any;                             // formula definition if formula target
  mode?: 'fold' | 'horizon';                 // computation mode
  scope: 'direct' | 'collection' | 'ancestor'; // how this governance applies
}

// An ephemeral signal detected by population analysis
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
  /** The targets participating in the cycle */
  participants: string[];
  /** The event that closed the cycle (triggered_by) */
  triggeringSeq?: number;
  /** Result of the convergence/oscillation check */
  result: RecResult;
  /** Dependency edges forming the cycle */
  edges: Array<{ source: string; dest: string }>;
}

// ─── Schema rules ────────────────────────────────────────────────────────

/** Schema rule summary for a single field — aggregated from ._schema.{field}.* children.
 *  DEF/EVA counts are projected (Horizon); REC count is deferred (requires log scan). */
export interface FieldSchemaEntry {
  fieldKey: string;
  /** Projected: type + constraints currently active */
  defCount: number;
  /** Projected: resolve policies active */
  evaCount: number;
  /** Current type definition operand (full object, e.g. {type: "number", format: "currency"}) */
  typeDef?: any;
  /** Individually addressable constraints */
  constraints: Array<{ name: string; value: any }>;
  /** Current resolution policy operand */
  resolve?: any;
}

// ─── Ingestion job tracking ────────────────────────────────────────────────

/** Per-table progress within a hydration/sync job. */
export interface TableProgress {
  base_id: string;
  table_id: string;
  table_name: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  records_fetched: number;
  records_ingested: number;
  error?: string;
  started_at?: string;
  completed_at?: string;
}

/** Persistent job record for tracking hydration/sync progress across restarts. */
export interface HydrationJob {
  job_id: string;
  type: 'hydration' | 'update';
  api_key_label: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  agent: string;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  error?: string;
  /** Persisted manifest from schema discovery (survives crash). */
  manifest_bases?: Array<{ id: string; name: string }>;
  /** Per-table progress, keyed by `{baseId}:{tableId}`. */
  table_progress: Record<string, TableProgress>;
  totals: {
    tables_total: number;
    tables_completed: number;
    records_ingested: number;
    records_skipped: number;
  };
}

