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
  await db.put(`state:${state.target}`, encode(state));
}

export async function getStateByPrefix(db: EoDb, prefix: string): Promise<EoState[]> {
  const states: EoState[] = [];
  const startKey = `state:${prefix}`;
  // Use prefix + high char to capture all keys starting with this prefix
  const endKey = `state:${prefix}\xff`;

  for await (const [, value] of db.iterator({
    gte: startKey,
    lte: endKey,
  })) {
    states.push(decode(value) as EoState);
  }
  return states;
}

export async function removeState(db: EoDb, target: string): Promise<void> {
  await db.del(`state:${target}`);
}
