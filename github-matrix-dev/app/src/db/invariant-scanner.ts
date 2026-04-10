/**
 * Invariant scanner — checks all EO structural invariants against a store.
 *
 * Returns a list of violations with target, level, type, detail, and severity.
 * Run this at startup or on demand to detect and report inconsistencies.
 *
 * Usage (browser console after opening a real space):
 *   import { scanInvariants } from './db/invariant-scanner';
 *   import { useEoStore } from './store/eo-store';
 *   const store = useEoStore.getState().store;
 *   const violations = await scanInvariants(store);
 *   console.table(violations);
 */

import type { EoStore } from './encrypted-store';
import type { EoEvent, EvaRegistration } from './types';
import { readLogForTarget } from './log';

export interface Violation {
  target: string;
  level: number;
  type: string;
  detail: string;
  severity: 'critical' | 'warning' | 'info';
}

/**
 * Scan all invariants in a store and return violations.
 *
 * Levels checked:
 *   2 — INS integrity: every state: target has a log: INS entry
 *   4 — CON symmetry: forward and reverse edges match; endpoints exist
 *   6 — DEF freshness: state last_seq matches highest log DEF seq
 *   7 — EVA dependency existence: EVA formulas reference live targets
 *   8 — Failed events: error: keys indicate operator failures
 */
export async function scanInvariants(store: EoStore): Promise<Violation[]> {
  const violations: Violation[] = [];

  // ── Level 2: INS integrity ─────────────────────────────────────────────────

  const allStateKeys = (await store.iterator('state:')).map(([k]) => k);

  for (const key of allStateKeys) {
    const target = key.replace('state:', '');
    const events = await readLogForTarget(store, target);
    const hasINS = events.some((e: EoEvent) => e.op === 'INS');
    if (!hasINS) {
      violations.push({
        target,
        level: 2,
        type: 'missing_ins',
        detail: `Target has state: entry but no INS in log:. Possible DEF auto-INS not logged.`,
        severity: 'critical',
      });
    }
  }

  // ── Level 4: CON symmetry ──────────────────────────────────────────────────

  const fwdEdges = await store.iterator('graph:fwd:');

  for (const [key] of fwdEdges) {
    // key = graph:fwd:{source}:{dest}
    const rest = key.replace('graph:fwd:', '');
    const colonIdx = rest.indexOf(':');
    if (colonIdx < 0) continue;
    const source = rest.slice(0, colonIdx);
    const dest = rest.slice(colonIdx + 1);

    const revKey = `graph:rev:${dest}:${source}`;
    const revEdge = await store.get(revKey);
    if (!revEdge) {
      violations.push({
        target: source,
        level: 4,
        type: 'asymmetric_con',
        detail: `Forward edge ${source}→${dest} has no reverse entry graph:rev:${dest}:${source}.`,
        severity: 'critical',
      });
    }

    const srcState = await store.get(`state:${source}`);
    const dstState = await store.get(`state:${dest}`);
    if (!srcState) {
      violations.push({
        target: source,
        level: 4,
        type: 'orphan_con_source',
        detail: `CON source ${source} has no state: entry.`,
        severity: 'critical',
      });
    }
    if (!dstState) {
      violations.push({
        target: dest,
        level: 4,
        type: 'orphan_con_dest',
        detail: `CON destination ${dest} has no state: entry.`,
        severity: 'critical',
      });
    }
  }

  // Reverse check: every rev entry has a matching fwd entry
  const revEdges = await store.iterator('graph:rev:');
  for (const [key] of revEdges) {
    const rest = key.replace('graph:rev:', '');
    const colonIdx = rest.indexOf(':');
    if (colonIdx < 0) continue;
    const dest = rest.slice(0, colonIdx);
    const source = rest.slice(colonIdx + 1);

    const fwdKey = `graph:fwd:${source}:${dest}`;
    const fwdEdge = await store.get(fwdKey);
    if (!fwdEdge) {
      violations.push({
        target: dest,
        level: 4,
        type: 'asymmetric_con_rev',
        detail: `Reverse edge ${dest}←${source} has no forward entry graph:fwd:${source}:${dest}.`,
        severity: 'critical',
      });
    }
  }

  // ── Level 6: DEF freshness ─────────────────────────────────────────────────

  for (const key of allStateKeys) {
    const target = key.replace('state:', '');
    const state = await store.get(key) as any;
    if (!state) continue;

    const logEvents = await readLogForTarget(store, target);
    const defEvents = logEvents
      .filter((e: EoEvent) => e.op === 'DEF')
      .sort((a: EoEvent, b: EoEvent) => a.seq - b.seq);

    if (defEvents.length === 0) continue;

    const lastDef = defEvents[defEvents.length - 1];
    if (state.last_op === 'DEF' && state.last_seq !== undefined && state.last_seq !== lastDef.seq) {
      violations.push({
        target,
        level: 6,
        type: 'stale_def',
        detail: `State last_seq=${state.last_seq} but log has DEF at seq=${lastDef.seq}. Possible stale projection.`,
        severity: 'warning',
      });
    }
  }

  // ── Level 7: EVA dependency existence ─────────────────────────────────────

  const evaEntries = await store.iterator('eva:');
  for (const [, reg] of evaEntries) {
    const r = reg as EvaRegistration;
    if (!r || !r.dependencies) continue;
    for (const dep of r.dependencies) {
      const depState = await store.get(`state:${dep}`);
      if (!depState) {
        violations.push({
          target: r.target,
          level: 7,
          type: 'missing_eva_dep',
          detail: `EVA formula on ${r.target} depends on ${dep} which has no state: entry.`,
          severity: 'warning',
        });
      }
    }
  }

  // ── Level 8: Failed events ─────────────────────────────────────────────────

  const errorEntries = await store.iterator('error:');
  for (const [, err] of errorEntries) {
    const e = err as any;
    violations.push({
      target: e.target || 'unknown',
      level: 8,
      type: 'failed_event',
      detail: `Event seq=${e.seq} op=${e.op} target=${e.target} failed: ${e.error}`,
      severity: 'warning',
    });
  }

  return violations;
}

/** Filter violations to only critical ones. */
export function criticalViolations(violations: Violation[]): Violation[] {
  return violations.filter(v => v.severity === 'critical');
}

/** Format violations as a readable report string. */
export function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return 'No violations found. Store is clean.';
  const lines = violations.map(
    v => `[L${v.level}] ${v.severity.toUpperCase()} ${v.type} on ${v.target}: ${v.detail}`,
  );
  return `${violations.length} violation(s) found:\n${lines.join('\n')}`;
}
