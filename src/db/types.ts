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
  ts: string;
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
  last_ts: string;
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

// Subscription for changefeed
export interface Subscription {
  id: string;
  target_pattern: string;
  ops?: Operator[];
  callback: (event: EoEvent) => void;
}

// Input event (before seq assignment)
export type EoEventInput = Omit<EoEvent, 'seq'>;

// --- Three-Layer Horizon ---

// Three-layer Horizon response
export interface HorizonResponse {
  target: string;
  figure: EoState | null;
  grounds: GroundEntry[];
  signals?: SignalEntry[];
}

// A ground condition inherited from an ancestor prefix
export interface GroundEntry {
  source: string;
  key: string;
  value: any;
  distance: number;
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

// Population-tracked pattern registration
export interface PatternRegistration extends EvaRegistration {
  pattern: true;
  over: string;
  where?: Record<string, any>;
  population_targets: string[];
}
