/**
 * Experience Engine — Formal Specification Types
 *
 * 𝓔 = (G, S, M, π, γ, σ)
 *
 * G = Given-Log: what happened (append-only sequence of phenomena)
 * S = Structure-Lattice: how what happened is connected (partially ordered set)
 * M = Meant-Graph: what it means (mutable space of interpretations)
 * π = provenance function: interpretations → grounding in raw experience
 * γ = availability function: positions → accessible entries and interpretations
 * σ = supersession function: (position, interpretation) → overridable interpretations
 *
 * The three data structures correspond to the three operator triads:
 *   Existence triad (NUL, SIG, INS)  → Given-Log
 *   Structure triad (SEG, CON, SYN)  → Structure-Lattice
 *   Significance triad (DEF, EVA, REC) → Meant-Graph
 */

import type { Operator, EoEvent, EoState, GraphEdge } from './types.js';

// ---------------------------------------------------------------------------
// Given-Log (G): What happened
// ---------------------------------------------------------------------------

/**
 * Mode of givenness — HOW the experience was encountered.
 * The mode shapes what can appear. A measurement, a report, a perception,
 * and a reception of data each constitute the phenomenon differently.
 */
export type ModeOfGivenness =
  | 'perceived'    // direct sensory/instrument observation
  | 'reported'     // communicated by another agent
  | 'measured'     // systematic quantitative observation
  | 'received'     // ingested from external system (API, webhook, sync)
  | 'derived'      // computed from other entries (system-generated)
  | 'recalled'     // retrieved from memory/archive
  | string;        // open — domains define their own modes

/**
 * Object axis — WHAT kind of thing was registered.
 * Determines the shape of the content field.
 *
 * Ground: ambient, no stable referent (conditions, context, atmosphere)
 * Figure: has identity, a particular thing (entities, records, people)
 * Pattern: spans multiple figures, has structure (relationships, trends, configurations)
 */
export type ObjectAxis = 'ground' | 'figure' | 'pattern';

/**
 * Cell type — the operator address: Mode × Object on the Existence face.
 * This determines the record type, not a tag on a uniform record.
 */
export interface CellType {
  /** The operator mode (existence row): NUL, SIG, or INS for Given-Log entries */
  mode: 'NUL' | 'SIG' | 'INS';
  /** The object axis (existence column): what kind of thing */
  object: ObjectAxis;
}

/**
 * The three structurally distinct kinds of absence.
 * NOT subtypes of a single NULL. They carry different information about
 * the sequence of prior frames and have different downstream effects.
 *
 * Collapsing these into a single absence marker (as SQL's NULL does)
 * destroys the information that makes a sequence of entries readable as motion.
 */
export enum NulState {
  /**
   * Was present; now absent.
   * Something was registered here and has been superseded.
   * NUL acting on a prior INS.
   */
  CLEARED = 'cleared',

  /**
   * Applicable but unregistered.
   * The slot exists in the schema; no observation has been made.
   * SIG without INS — attention was directed, but nothing was instantiated.
   */
  UNKNOWN = 'unknown',

  /**
   * No history for this slot.
   * This position was not part of any prior projection.
   * Pre-SIG — not even attention has been directed here.
   */
  NEVER_SET = 'never_set',
}

/**
 * Context envelope — the frame within which the appearance occurred.
 * The same event appears differently across frames.
 */
export interface ContextEnvelope {
  /** The scope/frame in which this observation was made */
  frame?: string;
  /** Source system or instrument that produced the observation */
  source?: string;
  /** Conditions under which the observation occurred */
  conditions?: Record<string, any>;
  /** Reference to prior observations this one relates to */
  prior_refs?: string[];
}

/**
 * Extended Given-Log entry — an EoEvent with the four requirements satisfied.
 *
 * Requirements:
 * 1. That it occurred: ts, agent, seq/client_event_id
 * 2. What kind: cell_type (Mode × Object)
 * 3. What was registered: operand (shape varies by object axis)
 * 4. Absence condition: nul_state (NUL rows only)
 */
export interface GivenLogEntry extends EoEvent {
  /** The cell type: Mode × Object on the Existence face */
  cell_type: CellType;
  /** Mode of givenness — how the experience was encountered */
  mode_of_givenness: ModeOfGivenness;
  /** Context envelope — the frame within which the appearance occurred */
  context_envelope?: ContextEnvelope;
  /** Absence state — required for NUL entries, absent for others */
  nul_state?: NulState;
  /** Prior reference — for NUL×Figure and NUL×Pattern, points to what was present before */
  prior_ref?: string;
}

// ---------------------------------------------------------------------------
// Structure-Lattice (S): How what happened is connected
// ---------------------------------------------------------------------------

/**
 * A position in the Structure-Lattice.
 * Determines what an observer can see (γ) and what they can override (σ).
 * Position is not assigned — it emerges from the agent's relationships (CON edges)
 * and the boundaries (SEG partitions) they are within.
 */
export interface LatticePosition {
  /** The agent at this position */
  agent: string;
  /** The target path that anchors this position */
  anchor: string;
  /** SEG boundaries this position is inside (from innermost to outermost) */
  boundaries: string[];
  /** CON edges accessible from this position */
  connections: string[];
  /** SYN composites this position participates in */
  composites: string[];
}

/**
 * Window specification — bounds a read against the Given-Log.
 * Entity-type claims require a window. Single-entry reads are face-projections.
 *
 * "A window is a bounded region of the lattice; its grain (SEG), connectivity (CON),
 * and composite structure (SYN) determine what trajectory signatures are recoverable."
 */
export interface Window {
  /** The grain — partition granularity (SEG). What level of detail? */
  grain: string;
  /** Temporal bounds — start and end of the observation window */
  bounds: {
    from?: string;   // ISO 8601 timestamp or seq number
    to?: string;     // ISO 8601 timestamp or seq number
  };
  /** The lattice position from which this window is opened */
  position: string;  // agent or position identifier
  /** Connectivity scope — which CON paths are included */
  scope?: string[];
}

// ---------------------------------------------------------------------------
// Meant-Graph (M): What it means
// ---------------------------------------------------------------------------

/**
 * An interpretation in the Meant-Graph.
 *
 * Every interpretation carries:
 * - A link to Given-Log entries it is grounded in (provenance)
 * - A position in the Structure-Lattice from which it was produced
 * - A window specification (grain and bounds of the read that produced it)
 * - Content (what the interpretation asserts)
 * - Supersession relationships to other interpretations
 *
 * Unlike the Given-Log, the Meant-Graph can be restructured.
 * Interpretations can be added, superseded, recontextualized, and retired.
 * The provenance chain must remain intact for audit.
 */
export interface Interpretation {
  /** Unique identifier for this interpretation */
  id: string;
  /** The target this interpretation is about */
  target: string;
  /** Which operator created this interpretation */
  op: 'DEF' | 'EVA' | 'REC';
  /** The content of the interpretation — what it asserts */
  content: any;
  /** Given-Log entries this interpretation is grounded in (Rule 7: Groundedness) */
  grounded_in: number[];   // seq numbers of Given-Log entries
  /** Position in the Structure-Lattice from which this was produced */
  position: string;
  /** Window specification — the read that produced this interpretation */
  window: Window;
  /** Interpretations this one supersedes (Rule 9: Defeasibility) */
  supersedes: string[];    // interpretation IDs
  /** Interpretations that supersede this one */
  superseded_by: string[];
  /** The agent who produced this interpretation */
  agent: string;
  /** When this interpretation was produced */
  ts: string;
  /** Whether this interpretation is currently active or has been retired */
  status: 'active' | 'superseded' | 'retired';
  /**
   * Coordinate in the capacity ground — Mode × Domain × Object.
   * If DEF is operative, may occupy superposition of positions.
   */
  coordinates?: {
    mode: string;
    domain: string;
    object: string;
  };
}

// ---------------------------------------------------------------------------
// The Three Functions (Horizon)
// ---------------------------------------------------------------------------

/**
 * π (provenance): maps interpretations to their grounding in raw experience.
 * Given an interpretation, returns the chain back to Given-Log entries.
 */
export interface ProvenanceChain {
  /** The interpretation being traced */
  interpretation_id: string;
  /** Direct Given-Log entries this interpretation is grounded in */
  direct_grounds: number[];   // seq numbers
  /** Intermediate interpretations in the chain */
  intermediates: string[];    // interpretation IDs
  /** Terminal Given-Log entries (leaves of the provenance tree) */
  terminal_grounds: number[]; // seq numbers — the raw experience
  /** Whether the chain is complete (all links resolved) */
  complete: boolean;
}

/**
 * γ (availability): maps positions in the Structure-Lattice to
 * accessible entries and interpretations.
 * "From this position, what is visible?"
 */
export interface Availability {
  /** The position being evaluated */
  position: LatticePosition;
  /** Given-Log entries visible from this position */
  visible_entries: number[];    // seq numbers
  /** Interpretations accessible from this position */
  accessible_interpretations: string[];  // interpretation IDs
  /** Boundaries that constrain visibility */
  constraining_boundaries: string[];
}

/**
 * σ (supersession): maps position-interpretation pairs to
 * interpretations they may override.
 * "From this position, with this interpretation, what can be superseded?"
 */
export interface SupersessionScope {
  /** The position */
  position: LatticePosition;
  /** The interpretation being used to supersede */
  interpretation_id: string;
  /** Interpretations that can be superseded from this position */
  supersedable: string[];       // interpretation IDs
  /** Interpretations that are immune at this position (but not globally — Rule 9) */
  currently_immune: string[];   // interpretation IDs
}

// ---------------------------------------------------------------------------
// The Nine Rules
// ---------------------------------------------------------------------------

/**
 * Rule violation types — each rule has a named violation.
 */
export enum RuleViolation {
  // Given-Conformant (Experiential Integrity)
  CATEGORICAL_CONFUSION = 'categorical_confusion',     // Rule 1: Given/Meant not exclusive
  CONFABULATION = 'confabulation',                      // Rule 2: Meant fabricated Given
  GASLIGHTING = 'gaslighting',                          // Rule 3: Given-Log entry modified/deleted

  // Structure-Conformant (Perspectival Coherence)
  CONTEXT_COLLAPSE = 'context_collapse',                // Rule 4: Claimed God's-eye view
  FORECLOSURE_VIOLATION = 'foreclosure_violation',      // Rule 5: Refinement expanded availability
  PERSPECTIVAL_FRACTURE = 'perspectival_fracture',      // Rule 6: Overlapping positions disagree

  // Meant-Conformant (Interpretive Accountability)
  UNGROUNDED_ASSERTION = 'ungrounded_assertion',        // Rule 7: Interpretation without provenance
  SEMANTIC_DRIFT = 'semantic_drift',                    // Rule 8: Meaning didn't survive transformation
  DOGMATISM = 'dogmatism',                              // Rule 9: Interpretation claimed immunity
}

/**
 * Result of a rule check.
 */
export interface RuleCheckResult {
  rule: number;             // 1-9
  name: string;
  passed: boolean;
  violation?: RuleViolation;
  detail?: string;
}

// ---------------------------------------------------------------------------
// The Experience Engine tuple
// ---------------------------------------------------------------------------

/**
 * 𝓔 = (G, S, M, π, γ, σ)
 *
 * The complete specification. This interface defines the shape of a
 * conformant Experience Engine implementation.
 */
export interface ExperienceEngine {
  /** G: The Given-Log — append-only sequence of raw experience */
  givenLog: {
    append(entry: GivenLogEntry): Promise<number>;
    read(seq: number): Promise<GivenLogEntry | null>;
    readWindow(window: Window): Promise<GivenLogEntry[]>;
    readForTarget(target: string): Promise<GivenLogEntry[]>;
  };

  /** S: The Structure-Lattice — partially ordered relationships */
  structureLattice: {
    partition(seg: { target: string; operand: any }): Promise<void>;
    join(con: { source: string; dest: string; edge_type?: string }): Promise<void>;
    composite(syn: { targets: string[]; into: string }): Promise<void>;
    position(agent: string, anchor: string): Promise<LatticePosition>;
  };

  /** M: The Meant-Graph — mutable space of interpretations */
  meantGraph: {
    assert(interp: Interpretation): Promise<string>;
    supersede(id: string, by: string): Promise<void>;
    retire(id: string): Promise<void>;
    get(id: string): Promise<Interpretation | null>;
    getForTarget(target: string): Promise<Interpretation[]>;
  };

  /** π: Provenance — trace interpretations to raw experience */
  provenance(interpretation_id: string): Promise<ProvenanceChain>;

  /** γ: Availability — what is visible from a position */
  availability(position: LatticePosition): Promise<Availability>;

  /** σ: Supersession — what can be overridden from a position */
  supersession(position: LatticePosition, interpretation_id: string): Promise<SupersessionScope>;

  /** Rule enforcement */
  checkRules(event: GivenLogEntry | Interpretation): Promise<RuleCheckResult[]>;
}

// ---------------------------------------------------------------------------
// Cell type classification helpers
// ---------------------------------------------------------------------------

/**
 * Classify an EoEvent into its cell type (Mode × Object).
 * The operator determines the mode (existence row).
 * The object axis is inferred from the operand shape and target structure.
 */
export function classifyCellType(op: Operator, operand: any, target: string): CellType {
  // Mode is determined by operator triad position
  let mode: CellType['mode'];
  if (op === 'NUL') mode = 'NUL';
  else if (op === 'SIG') mode = 'NUL';  // SIG is ephemeral — it's attention without instantiation
  else mode = 'INS';  // INS and above produce instantiated entries

  // Override: SIG gets its own mode
  if (op === 'SIG') mode = 'SIG';

  // For Structure and Significance triads, mode is INS (they produce instantiated entries in the log)
  if (['SEG', 'CON', 'SYN', 'DEF', 'EVA', 'REC'].includes(op)) {
    mode = 'INS';
  }

  // Object axis: Ground / Figure / Pattern
  let object: ObjectAxis;
  if (operand?._ambient || operand?.boundary) {
    // Ambient conditions, boundaries → Ground
    object = 'ground';
  } else if (operand?.merge || operand?.contains || Array.isArray(operand?.added)) {
    // Relationships spanning multiple figures → Pattern
    object = 'pattern';
  } else {
    // Default: specific entity → Figure
    object = 'figure';
  }

  return { mode, object };
}

/**
 * Infer the NUL absence state from context.
 */
export function inferNulState(
  operand: any,
  priorState: EoState | null,
): NulState {
  if (operand?.nul_state) {
    return operand.nul_state as NulState;
  }
  if (priorState) {
    return NulState.CLEARED;      // was present, now absent
  }
  // No prior state — was attention ever directed?
  // This requires log inspection; default to UNKNOWN
  return NulState.UNKNOWN;
}

/**
 * Determine which operator triad an operator belongs to.
 */
export function operatorDomain(op: Operator): 'existence' | 'structure' | 'significance' {
  if (op === 'NUL' || op === 'SIG' || op === 'INS') return 'existence';
  if (op === 'SEG' || op === 'CON' || op === 'SYN') return 'structure';
  return 'significance'; // DEF, EVA, REC
}

/**
 * Determine which data structure an operator primarily acts on.
 */
export function operatorTarget(op: Operator): 'given_log' | 'structure_lattice' | 'meant_graph' {
  const domain = operatorDomain(op);
  if (domain === 'existence') return 'given_log';
  if (domain === 'structure') return 'structure_lattice';
  return 'meant_graph';
}
