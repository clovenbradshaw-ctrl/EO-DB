import type { EoStore } from './encrypted-store';
import type { EoState } from './types';

export async function getState(store: EoStore, target: string): Promise<EoState | null> {
  return store.get(`state:${target}`);
}

/**
 * Cache fields that live on EoState but are maintained by the fold cache layer
 * (fold-cache.ts), not by operator handlers. setState auto-preserves them from
 * the existing row unless the caller explicitly supplies the key, so handlers
 * can write `{target, value, level, last_seq, ...}` without wiping the cache.
 */
const CACHE_KEYS = ['_fold', 'graphMetrics', '_lastRecSeq'] as const;

export async function setState(store: EoStore, state: EoState): Promise<void> {
  // If any cache key is missing from the incoming state, copy it from the
  // existing row. Callers that want to clear a cache field must pass it
  // explicitly (e.g. _fold: undefined is honored; absent key is merged).
  let needsMerge = false;
  for (const k of CACHE_KEYS) {
    if (!(k in state)) { needsMerge = true; break; }
  }
  if (needsMerge) {
    const existing = await store.get(`state:${state.target}`) as EoState | null;
    if (existing) {
      const merged: EoState = { ...state };
      for (const k of CACHE_KEYS) {
        if (!(k in state) && k in existing) {
          (merged as any)[k] = (existing as any)[k];
        }
      }
      await store.put(`state:${state.target}`, merged);
      return;
    }
  }
  await store.put(`state:${state.target}`, state);
}

export async function getStateByPrefix(store: EoStore, prefix: string): Promise<EoState[]> {
  const entries = await store.iterator(`state:${prefix}`);
  return entries.map(([, value]) => value as EoState);
}

export async function removeState(store: EoStore, target: string): Promise<void> {
  await store.del(`state:${target}`);
}
