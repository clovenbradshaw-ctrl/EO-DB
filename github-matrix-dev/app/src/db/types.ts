// The nine operators
export type Operator = 'NUL' | 'SIG' | 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'REC';

// Operators that produce log entries (post-INS threshold)
export type LoggableOperator = 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'REC';

// An event in the log
export interface EoEvent {
  seq: number;
  op: LoggableOperator;
  target: string;
  operand: any;
  agent: string;
  ts: string;                     // submission timestamp — when the agent/user submitted this event (ISO 8601)
  acquired_ts: string;            // acquisition timestamp — when the system received this event (ISO 8601)
  client_event_id?: string;
  meta?: Record<string, any>;
}

// Projected state at a target
export interface EoState {
  target: string;
  value: any;
  last_seq: number;
  last_op: Operator;
  last_agent: string;
  last_ts: string;                // submission timestamp of last event
  last_acquired_ts: string;       // acquisition timestamp of last event
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

export interface HorizonResponse {
  target: string;
  figure: EoState | null;
  ancestry?: AncestryEntry[];
  grounds: GroundEntry[];
  nearby?: NearbyEntry[];
  governance?: GovernanceEntry[];
  trajectory?: LoggableOperator[];
  signals?: SignalEntry[];
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
