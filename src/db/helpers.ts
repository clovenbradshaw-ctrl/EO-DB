import { EoDb } from './level.js';
import { getState } from './state.js';
import { getBranchState } from './branch.js';
import type { EoState } from './types.js';

/**
 * SYN capacity: Follow _alias chain to canonical target.
 * If the target was merged via SYN, its state has { _alias: canonicalTarget }.
 * Resolves transitively (A -> B -> C returns C).
 *
 * Branch-aware: alias resolution follows the state visible on the given branch.
 * Note: alias chains that cross branch boundaries (an alias created on branch A
 * pointing to a target only visible on branch B) are not resolved in this PR.
 * Branch-local alias chains work correctly.
 *
 * @param branchId Branch to resolve aliases on. Defaults to 'main' for backward compat.
 */
export async function resolveAlias(
  db: EoDb,
  target: string,
  branchId: string = 'main',
): Promise<string> {
  const maxDepth = 10;
  let current = target;
  for (let i = 0; i < maxDepth; i++) {
    const state = branchId === 'main'
      ? await getState(db, current)
      : await getBranchState(db, branchId, current);
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
 *
 * Branch-aware: checks the state visible on the given branch (including fallback
 * through the parent chain for inherited state).
 *
 * @param branchId Branch to check existence on. Defaults to 'main' for backward compat.
 */
export async function checkExists(
  db: EoDb,
  target: string,
  branchId: string = 'main',
): Promise<EoState | null> {
  if (branchId === 'main') return getState(db, target);
  return getBranchState(db, branchId, target);
}
