/**
 * Branch Explorer — type definitions.
 *
 * A "branch" is a speculative reading of the Given-Log under a different
 * world policy. The Given-Log is never mutated; the projection engine simply
 * replays it through alternative rules. The three worlds are:
 *
 *   W-0  canonical       — the merge happened, accept its consequences
 *   W-1  never-merged    — pretend the merge never happened
 *   W-2  always-merged   — pretend the merge happened from t=0
 *
 * BranchRecords are first-class log entities (created via INS + DEF), so
 * branches are themselves part of the Given-Log and survive page reloads.
 * ProjectedState is *not* persisted — it is recomputed on every read and
 * cached only in memory.
 */

export type WorldType = 'canonical' | 'never-merged' | 'always-merged';

export type EvaStance =
  | 'clearing'      // one source wins across all conflicts
  | 'binding'       // values composited / range
  | 'dissecting'    // conflicts held as DEF superposition (max information)
  | 'composing'     // new synthesized value constructed
  | 'tracing';      // values annotated with provenance

export interface BranchPolicy {
  world: WorldType;
  /**
   * For 'always-merged': which EVA stance resolves retroactive conflicts.
   * Null for canonical and never-merged.
   */
  stance: EvaStance | null;
  /**
   * The log event IDs involved in the SYN event this branch pivots on.
   *  - suppress_event_ids: events to exclude from replay (W-1)
   *  - retroject_event_ids: events to replay as if they occurred at t=0 (W-2)
   * Identifiers are stringified seq numbers (canonical, stable, log-resident).
   */
  suppress_event_ids: string[];
  retroject_event_ids: string[];
  /**
   * ISO timestamp of the merge/SYN event. Branch point.
   */
  branch_point_ts: string;
}

export interface BranchRecord {
  branch_id: string;             // UUID
  subject: string;               // target(s) this branch covers, e.g. "case:A,case:B"
  survivor_id: string;           // merged entity target in canonical world
  policy: BranchPolicy;
  /** Always 'projection-sketch' — branches are speculative by construction. */
  epistemic_status: 'projection-sketch';
  author: string;                // agent who created this branch
  created_at: string;
  label?: string;                // human-readable name
}

/**
 * Result of projecting the log under a branch policy at a given timestamp.
 * This is NOT stored — it is computed on read.
 */
export interface ProjectedState {
  world: WorldType;
  stance: EvaStance | null;
  t: string;                     // ISO timestamp of the projection
  entities: ProjectedEntity[];
  /** True if t > branch_point_ts in 'never-merged'. */
  indeterminate: boolean;
}

export interface ProjectedEntity {
  target: string;
  fields: Record<string, ProjectedField>;
  status: 'canonical' | 'policy-sensitive' | 'shadow';
}

export interface ProjectedField {
  value: unknown;
  /**
   *  canonical          — same value as W-0 would yield
   *  policy-sensitive   — value depends on the chosen W-2 stance
   *  shadow             — canonical event exists but has no projection here (W-1 post-merge)
   *  conflict           — DEF superposition held unresolved (W-2 dissecting stance)
   */
  epistemic: 'canonical' | 'policy-sensitive' | 'shadow' | 'conflict';
  conflict_values?: unknown[];   // populated when epistemic === 'conflict'
  provenance?: string;           // source entity for tracing stance
}

export interface DivergencePoint {
  ts: string;
  worlds_diverge: WorldType[];
  field_path: string;
}
