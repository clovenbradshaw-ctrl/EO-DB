import { EoDb } from './level.js';
import { getState } from './state.js';
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
