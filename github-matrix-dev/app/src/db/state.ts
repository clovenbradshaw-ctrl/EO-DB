import type { EoStore, IteratorOpts } from './encrypted-store';
import type { EoState } from './types';

export async function getState(store: EoStore, target: string): Promise<EoState | null> {
  return store.get(`state:${target}`);
}

export interface StatePage {
  rows: EoState[];
  /**
   * Cursor to pass as `afterTarget` on the next call to continue paging.
   * Null when the page is the last one (fewer rows than requested).
   */
  nextCursor: string | null;
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

export async function getStateByPrefix(
  store: EoStore,
  prefix: string,
  opts?: { limit?: number; afterTarget?: string },
): Promise<EoState[]> {
  const iterOpts: IteratorOpts | undefined = opts
    ? { limit: opts.limit, afterKey: opts.afterTarget ? `state:${opts.afterTarget}` : undefined }
    : undefined;
  const entries = await store.iterator(`state:${prefix}`, iterOpts);
  return entries.map(([, value]) => value as EoState);
}

/**
 * Cursor-paginated variant of getStateByPrefix. Returns a page of rows plus
 * a `nextCursor` (a target string) to pass on the next call. When the page
 * contains fewer than `limit` rows, `nextCursor` is null (end of prefix).
 *
 * Use this for list views over large collections — avoids materializing
 * the full prefix range into memory.
 */
export async function getStateByPrefixPage(
  store: EoStore,
  prefix: string,
  limit: number,
  afterTarget?: string,
): Promise<StatePage> {
  const entries = await store.iterator(`state:${prefix}`, {
    limit,
    afterKey: afterTarget ? `state:${afterTarget}` : undefined,
  });
  const rows = entries.map(([, value]) => value as EoState);
  const nextCursor = rows.length === limit ? rows[rows.length - 1].target : null;
  return { rows, nextCursor };
}

export async function removeState(store: EoStore, target: string): Promise<void> {
  await store.del(`state:${target}`);
}
