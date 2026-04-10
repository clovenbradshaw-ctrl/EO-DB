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

  // Collect all writes and flush in a single LevelDB batch to reduce round-trips.
  type BatchOp =
    | { type: 'put'; key: string; value: Buffer }
    | { type: 'del'; key: string };
  const ops: BatchOp[] = [{ type: 'put', key: `state:${state.target}`, value: encode(state) }];

  if (newHash && oldHash !== newHash) {
    if (oldHash) {
      const oldCohort = await getHashCohort(db, oldHash);
      const idx = oldCohort.indexOf(state.target);
      if (idx >= 0) {
        oldCohort.splice(idx, 1);
        if (oldCohort.length === 0) {
          ops.push({ type: 'del', key: `hash-cohort:${oldHash}` });
        } else {
          ops.push({ type: 'put', key: `hash-cohort:${oldHash}`, value: encode(oldCohort) });
        }
      }
    }
    const newCohort = await getHashCohort(db, newHash);
    if (!newCohort.includes(state.target)) {
      newCohort.push(state.target);
      ops.push({ type: 'put', key: `hash-cohort:${newHash}`, value: encode(newCohort) });
    }
  }

  await db.batch(ops as any);
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
