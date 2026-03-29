// The nine operators
export type Operator = 'NUL' | 'SIG' | 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'REC';

// Operators that produce log entries
export type LoggableOperator = 'NUL' | 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'REC';

// Operators that can be submitted externally (by humans or sync bridges)
export type ExternalOperator = 'NUL' | 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA';

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
  hash: string;                   // transformation hash — compressed history of all operations
  level: number;                  // 1 = human-authored (INS1), 2+ = system-discovered (INS2+)
  last_seq: number;
  last_op: Operator;
  last_agent: string;
  last_ts: string;                // submission timestamp of last event
  last_acquired_ts: string;       // acquisition timestamp of last event
}

// Derived entity registration — tracks INS2+ entities and their constituents
export interface DerivedEntity {
  target: string;                 // the derived entity's target path
  level: number;                  // INS level (2+)
  constituents: string[];         // targets this entity is made of
  topology: string;               // "cycle" — how the constituents relate
  inert: boolean;                 // true if the dependency cycle has dissolved
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
// Six layers: Figure, Ground, Nearby, Governance, Trajectory (cheap), Signals (expensive/on-demand)

// A single entry in the trajectory timeline, pairing an operator with its running hash
export interface TrajectoryEntry {
  op: LoggableOperator;
  hash: string;                              // running transformation hash after this event
}

export interface HorizonResponse {
  target: string;
  figure: EoState | null;                   // what this target IS
  ancestry?: AncestryEntry[];                // the ontology chain — parent figures up to root
  grounds: GroundEntry[];                    // ambient conditions pervading this region
  nearby?: NearbyEntry[];                    // similar records in the same collection
  governance?: GovernanceEntry[];            // EVA policies that govern this target
  trajectory?: TrajectoryEntry[];            // compact operator history with running hashes
  signals?: SignalEntry[];                   // statistical patterns (on-demand, expensive)
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

