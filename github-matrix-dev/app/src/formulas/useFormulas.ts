/**
 * React hook that wires the formula engine into the rendering pipeline.
 *
 * Performance strategy:
 * - Registry is memoized per table target — only rebuilt on table switch
 * - Compiled formulas are cached — parse/compile happens once
 * - Per-record results are cached and invalidated on state snapshot change
 * - Formula values are Horizon output — ephemeral, never persisted
 */

import { useMemo, useRef } from 'react';
import type { EoStateReader, ComputedValue } from './types';
import { FormulaRegistry } from './registry';
import { initializeFormulas, computeRecordFormulas } from './integration';

interface UseFormulasResult {
  /**
   * Compute all formula values for a record.
   * Returns a map of fieldId -> { value, error? }.
   * Results are Horizon output — not logged.
   */
  computeRecord: (recordId: string) => Map<string, ComputedValue>;

  /**
   * Get field IDs that need recomputation when a given field changes.
   * Used for targeted cache invalidation.
   */
  getDependents: (fieldNameOrId: string) => string[];

  /** Whether the registry has any formula fields. */
  hasFormulas: boolean;
}

/**
 * Hook to initialize and use the formula engine for a table.
 *
 * Usage:
 *   const { computeRecord, hasFormulas } = useFormulas(tableTarget, eoState);
 *   const formulaValues = computeRecord(recordId);
 *   // formulaValues.get('fldRevenue') -> { value: 50000 }
 */
export function useFormulas(
  tableTarget: string | null,
  eoState: EoStateReader
): UseFormulasResult {

  const registryRef = useRef<{
    tableTarget: string;
    registry: FormulaRegistry;
    fieldNameToId: Map<string, string>;
  } | null>(null);

  const { registry, fieldNameToId } = useMemo(() => {
    if (!tableTarget) {
      return { registry: new FormulaRegistry(), fieldNameToId: new Map<string, string>() };
    }

    // Reuse cached registry if same table
    if (registryRef.current?.tableTarget === tableTarget) {
      return registryRef.current;
    }

    const result = initializeFormulas(tableTarget, eoState);
    registryRef.current = { tableTarget, ...result };
    return result;
  }, [tableTarget, eoState]);

  // Per-record result cache — invalidated on state snapshot change
  const cacheRef = useRef<Map<string, Map<string, ComputedValue>>>(new Map());

  const computeRecord = useMemo(() => {
    cacheRef.current = new Map();

    if (!tableTarget) return () => new Map<string, ComputedValue>();

    return (recordId: string) => {
      const cached = cacheRef.current.get(recordId);
      if (cached) return cached;

      const result = computeRecordFormulas(
        recordId, tableTarget, registry, fieldNameToId, eoState
      );
      cacheRef.current.set(recordId, result);
      return result;
    };
  }, [tableTarget, registry, fieldNameToId, eoState]);

  const getDependents = useMemo(() => {
    return (fieldNameOrId: string) => registry.getDependents(fieldNameOrId);
  }, [registry]);

  return {
    computeRecord,
    getDependents,
    hasFormulas: registry.size > 0,
  };
}
