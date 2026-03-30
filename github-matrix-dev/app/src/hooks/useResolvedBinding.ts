/**
 * useResolvedBinding — Reactive hook that resolves a DataBinding to EoState records.
 *
 * Subscribes to lastSeq from the eo-store and re-resolves when data changes.
 * Debounced to avoid thrashing on rapid updates.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import type { EoState } from '../db/types';
import type { DataBinding } from '../blocks/types';
import { useEoStore } from '../store/eo-store';
import { resolveBinding } from '../components/query-engine';
import { useDataBindingContext } from '../contexts/DataBindingContext';

export interface ResolvedBinding {
  /** Resolved records (for multi-value bindings like tables) */
  records: EoState[];
  /** Resolved scalar values (for single-value bindings like heading text) */
  scalars: any[];
  /** Number of resolved records */
  count: number;
  /** Whether the resolution is currently loading */
  loading: boolean;
  /** Error message if resolution failed */
  error?: string;
}

const DEBOUNCE_MS = 100;

export function useResolvedBinding(binding?: DataBinding): ResolvedBinding {
  const getStateByPrefix = useEoStore(s => s.getStateByPrefix);
  const ready = useEoStore(s => s.ready);
  const lastSeq = useEoStore(s => s.lastSeq);
  const { contextItem } = useDataBindingContext();

  const [allStates, setAllStates] = useState<EoState[]>([]);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load all states with debouncing on seq changes
  useEffect(() => {
    if (!ready) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      getStateByPrefix('').then(states => {
        setAllStates(states);
        setLoading(false);
      });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [ready, lastSeq, getStateByPrefix]);

  // Resolve the binding
  const result = useMemo(() => {
    if (!binding || allStates.length === 0) {
      return { records: [], scalars: [], count: 0, loading, error: undefined };
    }

    const resolved = resolveBinding(binding, allStates, contextItem);
    return {
      records: resolved.records,
      scalars: resolved.scalars,
      count: resolved.records.length,
      loading,
      error: resolved.error,
    };
  }, [binding, allStates, contextItem, loading]);

  return result;
}

/**
 * useResolvedScalar — Convenience wrapper that returns a single scalar value
 * from a binding (e.g., for heading text bound to @.name).
 */
export function useResolvedScalar(binding?: DataBinding): {
  value: any;
  loading: boolean;
  error?: string;
} {
  const resolved = useResolvedBinding(binding);

  const value = useMemo(() => {
    if (resolved.scalars.length > 0) return resolved.scalars[0];
    if (resolved.records.length === 1 && binding?.field) {
      const record = resolved.records[0];
      return record.value?.[binding.field] ?? record.value?.fields?.[binding.field];
    }
    if (resolved.records.length === 1) {
      return resolved.records[0].value?.name || resolved.records[0].target;
    }
    return undefined;
  }, [resolved, binding?.field]);

  return { value, loading: resolved.loading, error: resolved.error };
}
