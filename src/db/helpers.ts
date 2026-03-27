import { EoDb } from './level.js';
import { getState } from './state.js';
import { getEdgesTo } from './graph.js';
import type { EoState } from './types.js';

/**
 * SYN capacity: Follow _alias chain to canonical target.
 * If the target was merged via SYN, its state has { _alias: canonicalTarget }.
 * Resolves transitively (A -> B -> C returns C).
 */
export async function resolveAlias(db: EoDb, target: string): Promise<string> {
  const maxDepth = 10;
  let current = target;
  for (let i = 0; i < maxDepth; i++) {
    const state = await getState(db, current);
    if (state?.value?._alias) {
      current = state.value._alias;
    } else {
      return current;
    }
  }
  return current;
}

/**
 * INS capacity: Verify target is instantiated.
 * Returns the state if it exists, null otherwise.
 */
export async function checkExists(db: EoDb, target: string): Promise<EoState | null> {
  return getState(db, target);
}

/**
 * SEG capacity: Read partition/boundary metadata from state.
 * Returns the boundary info if the target has been SEG'd, null otherwise.
 */
export async function checkBoundary(db: EoDb, target: string): Promise<{ boundary: string; reason?: string } | null> {
  const state = await getState(db, target);
  if (state?.last_op === 'SEG' && state.value?.boundary) {
    return state.value as { boundary: string; reason?: string };
  }
  return null;
}

/**
 * CON capacity: Find all targets that depend on the given target
 * by walking the reverse graph (targets that point TO this one).
 */
export async function findDependents(db: EoDb, target: string): Promise<string[]> {
  const reverseEdges = await getEdgesTo(db, target);
  return reverseEdges.map(e => e.source);
}
