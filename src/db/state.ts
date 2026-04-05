import { EoDb, encode, decode } from './level.js';
import type { EoState } from './types.js';

export async function getState(db: EoDb, target: string): Promise<EoState | null> {
  try {
    const buf = await db.get(`state:${target}`);
    return decode(buf) as EoState;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

export async function setState(db: EoDb, state: EoState): Promise<void> {
  // Maintain hash-cohort reverse index: hash → [targets]
  // When a state's hash changes, remove from old cohort and add to new
  const oldState = await getState(db, state.target);
  const oldHash = oldState?.hash;
  const newHash = state.hash;

  await db.put(`state:${state.target}`, encode(state));

  if (newHash && oldHash !== newHash) {
    // Remove from old cohort
    if (oldHash) {
      await removeFromCohort(db, oldHash, state.target);
    }
    // Add to new cohort
    await addToCohort(db, newHash, state.target);
  }
}

// ─── Hash Cohort Index ────────────────────────────────────────────────

/**
 * Get all targets sharing the same transformation hash (structural twins).
 * Returns an empty array if no cohort exists for this hash.
 */
export async function getHashCohort(db: EoDb, hash: string): Promise<string[]> {
  try {
    const buf = await db.get(`hash-cohort:${hash}`);
    return decode(buf) as string[];
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return [];
    throw e;
  }
}

async function addToCohort(db: EoDb, hash: string, target: string): Promise<void> {
  const cohort = await getHashCohort(db, hash);
  if (!cohort.includes(target)) {
    cohort.push(target);
    await db.put(`hash-cohort:${hash}`, encode(cohort));
  }
}

async function removeFromCohort(db: EoDb, hash: string, target: string): Promise<void> {
  const cohort = await getHashCohort(db, hash);
  const idx = cohort.indexOf(target);
  if (idx >= 0) {
    cohort.splice(idx, 1);
    if (cohort.length === 0) {
      try { await db.del(`hash-cohort:${hash}`); } catch {}
    } else {
      await db.put(`hash-cohort:${hash}`, encode(cohort));
    }
  }
}

export async function getStateByPrefix(db: EoDb, prefix: string, limit?: number): Promise<EoState[]> {
  const states: EoState[] = [];
  const startKey = `state:${prefix}`;
  // Use prefix + high char to capture all keys starting with this prefix
  const endKey = `state:${prefix}\xff`;

  for await (const [, value] of db.iterator({
    gte: startKey,
    lte: endKey,
  })) {
    states.push(decode(value) as EoState);
    if (limit !== undefined && states.length >= limit) break;
  }
  return states;
}

export async function removeState(db: EoDb, target: string): Promise<void> {
  await db.del(`state:${target}`);
}
