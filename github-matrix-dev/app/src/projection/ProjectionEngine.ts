/**
 * ProjectionEngine — replay the Given-Log under alternative branch policies.
 *
 * The engine never mutates the Given-Log or the live state store. It reads
 * log events from a scratch EoStore and produces in-memory ProjectedState
 * objects which the BranchExplorer renders.
 *
 * Three world types:
 *   W-0 canonical      — straight replay, merge happened
 *   W-1 never-merged   — drop the SYN and any survivor-targeted events;
 *                        post-merge fields render as 'shadow'
 *   W-2 always-merged  — replay every source-entity event as if it had
 *                        targeted the survivor entity from t=0; conflicts
 *                        resolved per the EVA stance
 */

import type { EoStore } from '../db/encrypted-store';
import { readLogSince } from '../db/log';
import type { EoEvent } from '../db/types';
import type {
  BranchRecord,
  DivergencePoint,
  EvaStance,
  ProjectedEntity,
  ProjectedField,
  ProjectedState,
  WorldType,
} from '../types/branch';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract per-field updates from an event. Two encodings are supported:
 *
 *   1. Object operand at the entity target  →  one update per top-level key
 *      INS target=case.A operand={status:'active', owner:'Jordan'}
 *
 *   2. Scalar operand at a child target     →  one update with the suffix
 *      DEF target=case.A.fldStatus operand='pending'
 *
 * Events that don't fit either pattern (e.g. SYN, CON, EVA) yield nothing.
 */
function eventFields(
  event: EoEvent,
  entityPrefix: string,
): Array<{ key: string; value: unknown }> {
  if (event.target === entityPrefix) {
    const operand = event.operand;
    if (operand && typeof operand === 'object' && !Array.isArray(operand)) {
      return Object.entries(operand)
        // Skip private/internal markers like _alias, _edges
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => ({ key: k, value: v }));
    }
    return [];
  }
  if (event.target.startsWith(entityPrefix + '.')) {
    const fieldKey = event.target.slice(entityPrefix.length + 1);
    // Field path may itself be dotted (e.g. fldStatus.value) — collapse to leaf
    if (fieldKey.includes('.')) return [];
    return [{ key: fieldKey, value: event.operand }];
  }
  return [];
}

/** Returns true if event.op is one of the field-mutating operators. */
function isFieldMutator(event: EoEvent): boolean {
  return event.op === 'INS' || event.op === 'DEF';
}

/** Stable timestamp comparator that falls back to seq for ties. */
function compareEvents(a: EoEvent, b: EoEvent): number {
  if (a.ts !== b.ts) return a.ts.localeCompare(b.ts);
  return a.seq - b.seq;
}

/** Source entities listed in a SYN event's operand. */
function synSources(event: EoEvent): string[] {
  const operand = event.operand as { merge?: unknown[] } | null | undefined;
  if (!operand || !Array.isArray(operand?.merge)) return [];
  return operand.merge.map((x) => String(x));
}

/** Survivor (merged) target produced by a SYN event. */
function synSurvivor(event: EoEvent): string | null {
  if (event.op !== 'SYN') return null;
  const operand = event.operand as { into?: unknown } | null | undefined;
  if (operand && typeof operand.into === 'string') return operand.into;
  return event.target;
}

// ─── Stance application (W-2) ────────────────────────────────────────────────

interface SourceContribution {
  source: string;
  value: unknown;
  ts: string;
}

/**
 * Apply an EVA stance to a set of per-source contributions for a single field.
 * Returns the resolved ProjectedField.
 *
 * If only one source contributed at all, the field is still 'policy-sensitive'
 * because a different stance would have made no difference but the world is
 * still W-2 (synthetic merge).
 */
function applyStance(
  contributions: SourceContribution[],
  stance: EvaStance,
): ProjectedField {
  // Sort by source name for deterministic stance behaviour.
  const sorted = [...contributions].sort((a, b) => a.source.localeCompare(b.source));
  const values = sorted.map((c) => c.value);
  const sources = sorted.map((c) => c.source);

  if (sorted.length === 0) {
    return { value: null, epistemic: 'shadow' };
  }
  if (sorted.length === 1) {
    return {
      value: sorted[0].value,
      epistemic: 'policy-sensitive',
      provenance: stance === 'tracing' ? sorted[0].source : undefined,
    };
  }

  switch (stance) {
    case 'clearing':
      return {
        value: sorted[0].value,
        epistemic: 'policy-sensitive',
      };
    case 'binding':
      return {
        value: values,
        epistemic: 'policy-sensitive',
      };
    case 'dissecting':
      return {
        value: values,
        epistemic: 'conflict',
        conflict_values: values,
      };
    case 'composing': {
      const synthesized = composeValues(values);
      return {
        value: synthesized,
        epistemic: 'policy-sensitive',
      };
    }
    case 'tracing':
      return {
        value: sorted[0].value,
        epistemic: 'policy-sensitive',
        provenance: sources.join('+'),
      };
  }
}

/**
 * Synthesize a single value from a conflict set.
 *  - all numbers   → arithmetic mean
 *  - all strings   → joined with " + "
 *  - mixed / other → array (fallback to binding behaviour)
 */
function composeValues(values: unknown[]): unknown {
  if (values.length === 0) return null;
  if (values.every((v) => typeof v === 'number')) {
    const sum = (values as number[]).reduce((a, b) => a + b, 0);
    return sum / values.length;
  }
  if (values.every((v) => typeof v === 'string')) {
    return [...new Set(values as string[])].join(' + ');
  }
  return values;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export interface ProjectionEngineOpts {
  store: EoStore;
}

export class ProjectionEngine {
  private cache = new Map<string, ProjectedState>();
  private logCache: EoEvent[] | null = null;

  constructor(private opts: ProjectionEngineOpts) {}

  /** Drop all cached projections — call when new log events arrive. */
  invalidate(): void {
    this.cache.clear();
    this.logCache = null;
  }

  private cacheKey(branch: BranchRecord, atTs: string): string {
    const stance = branch.policy.stance ?? '_';
    return `${branch.branch_id}:${branch.policy.world}:${stance}:${atTs}`;
  }

  /** Load and cache the entire log, sorted by (ts, seq). */
  private async loadEvents(): Promise<EoEvent[]> {
    if (this.logCache) return this.logCache;
    const all = await readLogSince(this.opts.store, 0);
    all.sort(compareEvents);
    this.logCache = all;
    return all;
  }

  /**
   * Replay the log up to atTs under the given branch policy.
   * Cached by (branch_id, world, stance, atTs).
   */
  async project(branch: BranchRecord, atTs: string): Promise<ProjectedState> {
    const key = this.cacheKey(branch, atTs);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const events = await this.loadEvents();
    let result: ProjectedState;
    switch (branch.policy.world) {
      case 'canonical':
        result = this.projectCanonical(branch, events, atTs);
        break;
      case 'never-merged':
        result = this.projectNeverMerged(branch, events, atTs);
        break;
      case 'always-merged':
        result = this.projectAlwaysMerged(branch, events, atTs);
        break;
    }
    this.cache.set(key, result);
    return result;
  }

  /**
   * Find timestamps where the three worlds yield divergent state. Used by
   * BranchExplorer to colour event dots on the timeline tracks.
   */
  async divergenceMap(branch: BranchRecord): Promise<DivergencePoint[]> {
    const events = await this.loadEvents();
    const points: DivergencePoint[] = [];
    const branchTs = branch.policy.branch_point_ts;

    // The SYN event itself is always a divergence point — that's where W-0
    // and W-1 separate.
    points.push({
      ts: branchTs,
      worlds_diverge: ['canonical', 'never-merged'],
      field_path: '_syn',
    });

    // W-2 diverges any time a source-entity event sets a field that another
    // source has also set. Walk the log and detect cross-source field collisions.
    const sources = branch.subject.split(',').map((s) => s.trim()).filter(Boolean);
    if (sources.length >= 2) {
      const fieldOwners = new Map<string, Set<string>>();
      for (const event of events) {
        if (!isFieldMutator(event)) continue;
        for (const source of sources) {
          const fields = eventFields(event, source);
          for (const f of fields) {
            const owners = fieldOwners.get(f.key) ?? new Set<string>();
            owners.add(source);
            fieldOwners.set(f.key, owners);
            if (owners.size > 1) {
              points.push({
                ts: event.ts,
                worlds_diverge: ['always-merged'],
                field_path: f.key,
              });
            }
          }
        }
      }
    }

    return points;
  }

  // ─── World projectors ──────────────────────────────────────────────────────

  /**
   * W-0 canonical: standard replay. Pre-SYN, source entities exist independently.
   * Post-SYN, the survivor entity carries the merged fields.
   */
  private projectCanonical(
    branch: BranchRecord,
    events: EoEvent[],
    atTs: string,
  ): ProjectedState {
    const sources = branch.subject.split(',').map((s) => s.trim()).filter(Boolean);
    const survivor = branch.survivor_id;
    const branchTs = branch.policy.branch_point_ts;
    const beforeMerge = atTs < branchTs;

    if (beforeMerge) {
      // Two separate entities, each with their own field accumulation.
      const entities: ProjectedEntity[] = [];
      for (const src of sources) {
        const fields = this.foldFields(events, src, atTs);
        entities.push({
          target: src,
          fields: this.markAll(fields, 'canonical'),
          status: 'canonical',
        });
      }
      return {
        world: 'canonical',
        stance: null,
        t: atTs,
        entities,
        indeterminate: false,
      };
    }

    // Post-merge: survivor entity carries the union of source fields at branchTs
    // plus any subsequent events targeting the survivor.
    const sourceMerged: Record<string, unknown> = {};
    for (const src of sources) {
      const fields = this.foldFields(events, src, branchTs);
      Object.assign(sourceMerged, fields);
    }
    const survivorFields = this.foldFields(events, survivor, atTs);
    const merged: Record<string, unknown> = { ...sourceMerged, ...survivorFields };

    return {
      world: 'canonical',
      stance: null,
      t: atTs,
      entities: [
        {
          target: survivor,
          fields: this.markAll(merged, 'canonical'),
          status: 'canonical',
        },
      ],
      indeterminate: false,
    };
  }

  /**
   * W-1 never-merged: skip SYN events and any events targeting the survivor.
   * Source entities continue to live independently. After branch_point_ts the
   * cards render their fields as 'shadow' — events still arrive in the canonical
   * log, but they have no place in this projected world.
   */
  private projectNeverMerged(
    branch: BranchRecord,
    events: EoEvent[],
    atTs: string,
  ): ProjectedState {
    const sources = branch.subject.split(',').map((s) => s.trim()).filter(Boolean);
    const survivor = branch.survivor_id;
    const branchTs = branch.policy.branch_point_ts;
    const indeterminate = atTs >= branchTs;

    // Filter out: SYN events for the merge, any events targeting the survivor,
    // and any explicit suppress_event_ids.
    const suppressed = new Set(branch.policy.suppress_event_ids);
    const filtered = events.filter((e) => {
      if (suppressed.has(String(e.seq))) return false;
      if (e.op === 'SYN' && synSources(e).some((s) => sources.includes(s))) return false;
      if (e.target === survivor || e.target.startsWith(survivor + '.')) return false;
      return true;
    });

    const entities: ProjectedEntity[] = [];
    for (const src of sources) {
      const fields = this.foldFields(filtered, src, atTs);
      const status: ProjectedEntity['status'] = indeterminate ? 'shadow' : 'canonical';
      const epistemic: ProjectedField['epistemic'] = indeterminate ? 'shadow' : 'canonical';
      entities.push({
        target: src,
        fields: this.markAll(fields, epistemic),
        status,
      });
    }
    return {
      world: 'never-merged',
      stance: null,
      t: atTs,
      entities,
      indeterminate,
    };
  }

  /**
   * W-2 always-merged: every source-entity event is replayed against the
   * survivor target as if the merge had always existed. Where multiple
   * sources have updated the same field, the chosen EVA stance resolves
   * the conflict.
   */
  private projectAlwaysMerged(
    branch: BranchRecord,
    events: EoEvent[],
    atTs: string,
  ): ProjectedState {
    const sources = branch.subject.split(',').map((s) => s.trim()).filter(Boolean);
    const survivor = branch.survivor_id;
    const stance = branch.policy.stance ?? 'clearing';

    // Bucket: for each (field key) → for each source → latest contribution ≤ atTs
    const buckets = new Map<string, Map<string, SourceContribution>>();

    for (const event of events) {
      if (event.ts > atTs) continue;
      if (!isFieldMutator(event)) continue;

      // Identify which source this event belongs to (or the survivor itself).
      let source: string | null = null;
      let entityPrefix: string | null = null;
      for (const s of sources) {
        if (event.target === s || event.target.startsWith(s + '.')) {
          source = s;
          entityPrefix = s;
          break;
        }
      }
      if (!source) {
        if (event.target === survivor || event.target.startsWith(survivor + '.')) {
          source = survivor;
          entityPrefix = survivor;
        }
      }
      if (!source || !entityPrefix) continue;

      const fields = eventFields(event, entityPrefix);
      for (const f of fields) {
        let bySource = buckets.get(f.key);
        if (!bySource) {
          bySource = new Map<string, SourceContribution>();
          buckets.set(f.key, bySource);
        }
        const existing = bySource.get(source);
        if (!existing || existing.ts <= event.ts) {
          bySource.set(source, { source, value: f.value, ts: event.ts });
        }
      }
    }

    const fields: Record<string, ProjectedField> = {};
    for (const [key, bySource] of buckets) {
      const contributions = [...bySource.values()];
      fields[key] = applyStance(contributions, stance);
    }

    return {
      world: 'always-merged',
      stance,
      t: atTs,
      entities: [
        {
          target: survivor,
          fields,
          status: 'policy-sensitive',
        },
      ],
      indeterminate: false,
    };
  }

  // ─── Field accumulation ────────────────────────────────────────────────────

  /**
   * Walk events for a single entity prefix up to atTs and accumulate the
   * latest field values. Pure last-write-wins by ts; ties broken by seq.
   */
  private foldFields(
    events: EoEvent[],
    entityPrefix: string,
    atTs: string,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const event of events) {
      if (event.ts > atTs) continue;
      if (!isFieldMutator(event)) continue;
      const fields = eventFields(event, entityPrefix);
      for (const f of fields) {
        result[f.key] = f.value;
      }
    }
    return result;
  }

  private markAll(
    fields: Record<string, unknown>,
    epistemic: ProjectedField['epistemic'],
  ): Record<string, ProjectedField> {
    const out: Record<string, ProjectedField> = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = { value: v, epistemic };
    }
    return out;
  }
}

/**
 * Convenience: project a branch at every 5% step across the timeline.
 * Used by BranchExplorer on first load to warm the cache so the scrubber
 * stays smooth at 60 fps.
 */
export async function warmProjectionCache(
  engine: ProjectionEngine,
  branch: BranchRecord,
  minTs: string,
  maxTs: string,
  steps = 21,
): Promise<void> {
  const minMs = Date.parse(minTs);
  const maxMs = Date.parse(maxTs);
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || maxMs <= minMs) {
    await engine.project(branch, maxTs);
    return;
  }
  for (let i = 0; i < steps; i++) {
    const u = i / (steps - 1);
    const ts = new Date(minMs + (maxMs - minMs) * u).toISOString();
    await engine.project(branch, ts);
  }
}

// Re-exported helpers for tests.
export const __testing = {
  eventFields,
  synSources,
  synSurvivor,
  applyStance,
  composeValues,
};

export type { WorldType, EvaStance };
