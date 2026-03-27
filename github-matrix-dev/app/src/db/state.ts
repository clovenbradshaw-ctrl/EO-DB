import type { EoStore } from './encrypted-store';
import type { EoState } from './types';

export async function getState(store: EoStore, target: string): Promise<EoState | null> {
  return store.get(`state:${target}`);
}

export async function setState(store: EoStore, state: EoState): Promise<void> {
  await store.put(`state:${state.target}`, state);
}

export async function getStateByPrefix(store: EoStore, prefix: string): Promise<EoState[]> {
  const entries = await store.iterator(`state:${prefix}`);
  return entries.map(([, value]) => value as EoState);
}

export async function removeState(store: EoStore, target: string): Promise<void> {
  await store.del(`state:${target}`);
}
