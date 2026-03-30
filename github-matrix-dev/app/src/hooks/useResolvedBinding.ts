/**
 * useResolvedBinding — Reactive hook that resolves a DataBinding to EoState records.
 *
 * Subscribes to lastSeq from the eo-store and re-resolves when data changes.
 * Debounced to avoid thrashing on rapid updates.
 *
 * On record pages: if no explicit binding is set, blocks auto-bind to the
 * page record's @ context. A block with just a `field` prop will resolve
 * @.field from the page record automatically.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import type { EoState } from '../db/types';
import type { DataBinding } from '../blocks/types';
import { useEoStore } from '../store/eo-store';
import { resolveBinding, resolveFieldChain } from '../components/query-engine';
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

/**
 * Main hook for resolving data bindings.
 *
 * @param binding - Explicit DataBinding (from block props)
 * @param field - Optional field name for auto-binding on record pages (e.g., "name", "cases")
 */
export function useResolvedBinding(binding?: DataBinding, field?: string): ResolvedBinding {
  const getStateByPrefix = useEoStore(s => s.getStateByPrefix);
  const ready = useEoStore(s => s.ready);
  const lastSeq = useEoStore(s => s.lastSeq);
  const { contextItem, pageRecord, pageType } = useDataBindingContext();

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
    if (allStates.length === 0) {
      return { records: [], scalars: [], count: 0, loading, error: undefined };
    }

    // 1. Explicit binding takes priority
    if (binding) {
      const resolved = resolveBinding(binding, allStates, contextItem);
      return {
        records: resolved.records,
        scalars: resolved.scalars,
        count: resolved.records.length,
        loading,
        error: resolved.error,
      };
    }

    // 2. Auto-binding: on a record page with a field prop, resolve @.field
    const effectiveContext = contextItem || pageRecord;
    if (effectiveContext && field) {
      const chain = resolveFieldChain(`@.${field}`, effectiveContext, allStates);
      return {
        records: chain.records,
        scalars: chain.scalars,
        count: chain.records.length,
        loading,
        error: chain.error,
      };
    }

    // 3. On a record page with no field, return the context item itself
    if (effectiveContext && pageType === 'record') {
      return {
        records: [effectiveContext],
        scalars: [],
        count: 1,
        loading,
        error: undefined,
      };
    }

    return { records: [], scalars: [], count: 0, loading, error: undefined };
  }, [binding, field, allStates, contextItem, pageRecord, pageType, loading]);

  return result;
}

/**
 * useResolvedScalar — Convenience wrapper that returns a single scalar value.
 *
 * On a record page, just pass field="name" and it auto-resolves @.name.
 */
export function useResolvedScalar(binding?: DataBinding, field?: string): {
  value: any;
  loading: boolean;
  error?: string;
} {
  const resolved = useResolvedBinding(binding, field);

  const value = useMemo(() => {
    // Scalars from field chain resolution
    if (resolved.scalars.length > 0) return resolved.scalars[0];

    // Single record with explicit field extraction
    if (resolved.records.length === 1 && (binding?.field || field)) {
      const f = binding?.field || field;
      const record = resolved.records[0];
      return record.value?.[f!] ?? record.value?.fields?.[f!];
    }

    // Single record, return display name
    if (resolved.records.length === 1) {
      return resolved.records[0].value?.name || resolved.records[0].target;
    }

    return undefined;
  }, [resolved, binding?.field, field]);

  return { value, loading: resolved.loading, error: resolved.error };
}

/**
 * usePageContext — Quick access to page-level record context.
 * Returns the page record and whether we're on a record page.
 */
export function usePageContext(): {
  pageRecord: EoState | null;
  isRecordPage: boolean;
  contextItem: EoState | null;
} {
  const { pageRecord, pageType, contextItem } = useDataBindingContext();
  return {
    pageRecord,
    isRecordPage: pageType === 'record',
    contextItem,
  };
}
