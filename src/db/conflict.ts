/**
 * Conflict detection and resolution for branching timelines.
 *
 * When two branches diverge and are later merged (SYN absorb), targets that
 * were written on both sides have conflicting values. This module detects
 * those conflicts, stores them as ConflictState, and resolves them according
 * to an EVAResolutionPolicy.
 *
 * Storage keys:
 *   eva-resolve:{target}  → EVAResolutionPolicy (resolution policy)
 *   (conflicts themselves are written to state/{branchId}/{target} via setBranchState)
 */

import { EoDb, encode, decode } from './level.js';
import type { ConflictState, EVAResolutionPolicy, ResolutionMode } from './types.js';

export const resolutionModes = new Set<ResolutionMode>([
  'Dissecting', 'Clearing', 'Binding', 'Tending',
  'Unraveling', 'Cultivating', 'Composing', 'Making', 'Tracing',
]);

// ─── Policy storage ────────────────────────────────────────────────────────

/** Read the EVA resolution policy for a target (eva-resolve:{target}). */
export async function getResolutionPolicy(
  db: EoDb,
  target: string,
): Promise<EVAResolutionPolicy | null> {
  try {
    const buf = await db.get(`eva-resolve:${target}`);
    return decode(buf) as EVAResolutionPolicy;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

/** Write the EVA resolution policy for a target (eva-resolve:{target}). */
export async function setResolutionPolicy(
  db: EoDb,
  target: string,
  policy: EVAResolutionPolicy,
): Promise<void> {
  await db.put(`eva-resolve:${target}`, encode(policy));
}

// ─── Detection ────────────────────────────────────────────────────────────

/**
 * Detect a conflict between two state values.
 *
 * Returns null if the values are deep-equal (false conflict filtered out).
 * Returns a ConflictState if the values genuinely diverge.
 */
export function detectConflict(
  originOp: ConflictState['originOp'],
  valueA: unknown,
  branchA: string,
  seqA: number | null,
  agentA: string | null,
  valueB: unknown,
  branchB: string,
  seqB: number | null,
  agentB: string | null,
): ConflictState | null {
  if (deepEqualConflict(valueA, valueB)) return null;

  return {
    conflict: true,
    originOp,
    values: [
      { value: valueA, branch: branchA, seq: seqA, agent: agentA },
      { value: valueB, branch: branchB, seq: seqB, agent: agentB },
    ],
  };
}

function deepEqualConflict(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keysA = Object.keys(ao).sort();
  const keysB = Object.keys(bo).sort();
  if (keysA.length !== keysB.length) return false;
  if (keysA.join(',') !== keysB.join(',')) return false;
  for (const k of keysA) {
    if (!deepEqualConflict(ao[k], bo[k])) return false;
  }
  return true;
}

// ─── Resolution ───────────────────────────────────────────────────────────

/**
 * Resolve a conflict according to a policy.
 *
 * @param conflict    The ConflictState to resolve.
 * @param policy      The EVAResolutionPolicy to apply.
 * @param logHistory  Optional ordered list of pre-conflict values (needed for Tending).
 * @returns The resolved value, or null for Clearing, or the ConflictState for Binding.
 */
export function resolveConflict(
  conflict: ConflictState,
  policy: EVAResolutionPolicy,
  logHistory?: unknown[],
): unknown {
  const [entryA, entryB] = conflict.values;

  switch (policy.type) {
    case 'Binding':
      // Conflict IS the datum — return as-is
      return conflict;

    case 'Clearing':
      // Reductive — VOID wins, discard both sides
      return null;

    case 'Unraveling':
      // Forensic — expose the full conflict structure
      return conflict;

    case 'Cultivating':
      // Deferred — flag as pending for manual resolution
      return { pending: true, conflict };

    case 'Dissecting': {
      // Analytic — one value wins by rule
      const rule = policy.rule ?? 'last-write-wins';

      if (rule === 'last-write-wins') {
        // Higher seq wins
        const seqA = entryA.seq ?? -1;
        const seqB = entryB.seq ?? -1;
        return seqA >= seqB ? entryA.value : entryB.value;
      }

      if (rule === 'timestamp-ordered') {
        // Compare using agent string as tiebreaker if seqs equal
        const seqA = entryA.seq ?? -1;
        const seqB = entryB.seq ?? -1;
        if (seqA !== seqB) return seqA >= seqB ? entryA.value : entryB.value;
        // Fallback: string comparison on agent
        const agentA = entryA.agent ?? '';
        const agentB = entryB.agent ?? '';
        return agentA >= agentB ? entryA.value : entryB.value;
      }

      if (rule === 'authority-ranked') {
        // Stub — without authority tables, first entry wins
        return entryA.value;
      }

      if (rule === 'priority-weighted') {
        // Stub — without weight tables, higher seq wins
        const seqA = entryA.seq ?? -1;
        const seqB = entryB.seq ?? -1;
        return seqA >= seqB ? entryA.value : entryB.value;
      }

      return entryA.value;
    }

    case 'Tending': {
      // Temporal — revert to the most recent pre-conflict value from log history
      if (logHistory && logHistory.length > 0) {
        return logHistory[logHistory.length - 1];
      }
      // No history available — fall back to Binding
      return conflict;
    }

    case 'Composing':
      throw new Error('Composing resolution not yet implemented (stub)');

    case 'Making':
      throw new Error('Making resolution not yet implemented (stub)');

    case 'Tracing':
      throw new Error('Tracing resolution not yet implemented (stub)');

    default: {
      const _exhaustive: never = policy.type;
      void _exhaustive;
      return conflict;
    }
  }
}

/**
 * Resolve an INS/VOID conflict (one side has a value, the other is absent/VOID).
 *
 * - Dissecting: propagate existence — instantiated side wins
 * - Clearing:   keep VOID (return null)
 * - Binding:    return ConflictState as co-equal data
 */
export function resolveExistenceConflict(
  policy: EVAResolutionPolicy,
  instantiatedValue: unknown,
): unknown {
  switch (policy.type) {
    case 'Dissecting':
      return instantiatedValue;
    case 'Clearing':
      return null;
    case 'Binding':
    default:
      return { conflict: true, originOp: 'INS', instantiated: instantiatedValue, void: true };
  }
}
