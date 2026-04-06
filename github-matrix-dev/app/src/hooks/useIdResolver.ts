/**
 * useIdResolver — Resolves short entity IDs (e.g. "CLI-002", "ATT-001") to
 * their full target paths and display names.
 *
 * Works for both explicit references (arrays of IDs in link fields) and
 * implicit foreign keys (single ID values like client_id: "CLI-002").
 *
 * Builds a reverse index from all entities under the scope root, keyed by
 * short ID. Subscribes to lastSeq so the index stays fresh as events arrive.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useEoStore } from '../store/eo-store';

/** Matches entity IDs like CLI-002, ATT-001, CASE-010, HON-005, BILL-003 */
const ID_PATTERN = /^[A-Z]{2,5}-\d+$/;

export interface ResolvedId {
  shortId: string;
  target: string;
  name: string | null;
}

export interface IdResolver {
  /** Resolve a short ID (e.g. "CLI-002") to its target and display name */
  resolve: (shortId: string) => ResolvedId | null;
  /** Resolve a full target path (e.g. "import.clients.CLI-002") to short ID and name */
  resolveTarget: (fullTarget: string) => ResolvedId | null;
  /** Whether the index is still loading */
  loading: boolean;
}

const DEBOUNCE_MS = 150;

export function useIdResolver(scopeRoot: string): IdResolver {
  const getStateByPrefix = useEoStore(s => s.getStateByPrefix);
  const ready = useEoStore(s => s.ready);
  const lastSeq = useEoStore(s => s.lastSeq);

  const [shortIdMap, setShortIdMap] = useState<Map<string, ResolvedId>>(new Map());
  const [targetMap, setTargetMap] = useState<Map<string, ResolvedId>>(new Map());
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!ready || !scopeRoot) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      getStateByPrefix(scopeRoot + '.').then(states => {
        const sMap = new Map<string, ResolvedId>();
        const tMap = new Map<string, ResolvedId>();

        for (const st of states) {
          // Skip internal targets
          if (st.target.includes('._schema.') || st.target.includes('._detail_layout')) continue;
          if (st.value?._alias) continue;

          const shortId = st.target.split('.').pop() || '';
          if (!ID_PATTERN.test(shortId)) continue;

          const name = st.value?.name || st.value?.title || null;
          const entry: ResolvedId = { shortId, target: st.target, name };

          sMap.set(shortId, entry);
          tMap.set(st.target, entry);
        }

        setShortIdMap(sMap);
        setTargetMap(tMap);
        setLoading(false);
      });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [ready, lastSeq, scopeRoot, getStateByPrefix]);

  const resolve = useCallback(
    (shortId: string): ResolvedId | null => shortIdMap.get(shortId) ?? null,
    [shortIdMap],
  );

  const resolveTarget = useCallback(
    (fullTarget: string): ResolvedId | null => targetMap.get(fullTarget) ?? null,
    [targetMap],
  );

  return { resolve, resolveTarget, loading };
}

/** Test whether a string looks like an entity ID */
export function isEntityId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** Test whether an array is entirely entity IDs */
export function isEntityIdArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(v => typeof v === 'string' && ID_PATTERN.test(v));
}
