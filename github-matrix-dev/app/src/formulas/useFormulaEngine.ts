/**
 * Lightweight formula engine hook for TableView.
 *
 * Works with the existing data flow: takes field schemas (already loaded)
 * and records, compiles formula expressions once, caches results per record.
 *
 * Performance strategy:
 * - Compiled formulas are memoized — parse/compile happens once per schema change
 * - Per-record results are cached and invalidated on records/schema change
 * - Only computes when called (lazy) — only visible rows pay the cost
 * - Formula values are Horizon output — never persisted
 */

import { useMemo, useRef } from 'react';
import type { FieldSchema } from '../db/schema-rules';
import type { EoState } from '../db/types';
import { parseFormula, extractFieldRefs } from './parser';
import { compileAST } from './compiler';
import { FormulaError } from './functions';
import type { EvalContext } from './types';

type CompiledFormula = (fieldValues: Record<string, any>, ctx: EvalContext) => any;

interface CompiledEntry {
  fieldKey: string;
  fieldName: string;
  compiled: CompiledFormula;
  dependencies: string[];
}

interface FormulaEngine {
  /** Get computed value for a formula column on a given record */
  getFormulaValue: (rec: EoState, fieldKey: string, useFieldsSub: boolean) => any;
  /** Set of field keys that are formula columns */
  formulaFields: Set<string>;
  /** Whether any formula fields exist */
  hasFormulas: boolean;
}

export function useFormulaEngine(
  fieldSchemas: Map<string, FieldSchema>,
  fieldNameMap: Map<string, string>,
): FormulaEngine {
  // Compile formulas once per schema change
  const compiled = useMemo(() => {
    const entries = new Map<string, CompiledEntry>();
    const formulaFields = new Set<string>();

    for (const [fieldKey, schema] of fieldSchemas) {
      // A formula field has type=formula AND a formula expression
      const isFormulaType = schema.typeDef?.value?.type === 'formula' ||
                            schema.ingestedType === 'formula';
      const expression = schema.formulaDef?.value;

      if (isFormulaType && expression && typeof expression === 'string') {
        formulaFields.add(fieldKey);
        try {
          const ast = parseFormula(expression);
          const fn = compileAST(ast);
          const deps = extractFieldRefs(expression);
          entries.set(fieldKey, {
            fieldKey,
            fieldName: schema.name ?? fieldKey,
            compiled: fn,
            dependencies: deps,
          });
        } catch (e) {
          entries.set(fieldKey, {
            fieldKey,
            fieldName: schema.name ?? fieldKey,
            compiled: () => { throw new FormulaError(`Parse error: ${e instanceof Error ? e.message : String(e)}`); },
            dependencies: [],
          });
        }
      }
    }

    return { entries, formulaFields };
  }, [fieldSchemas]);

  // Topological evaluation order (computed once per schema)
  const evalOrder = useMemo(() => {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: string[] = [];

    // Build name-to-key map for dependency resolution
    const nameToKey = new Map<string, string>();
    for (const [key, entry] of compiled.entries) {
      nameToKey.set(entry.fieldName, key);
    }

    const visit = (key: string) => {
      if (visited.has(key)) return;
      if (visiting.has(key)) return; // circular — break
      visiting.add(key);
      const entry = compiled.entries.get(key);
      if (entry) {
        for (const depName of entry.dependencies) {
          const depKey = nameToKey.get(depName);
          if (depKey && compiled.entries.has(depKey)) visit(depKey);
        }
      }
      visiting.delete(key);
      visited.add(key);
      result.push(key);
    };

    for (const key of compiled.entries.keys()) visit(key);
    return result;
  }, [compiled]);

  // Per-record cache — cleared when compiled entries or fieldNameMap changes
  const cacheRef = useRef(new WeakMap<EoState, Map<string, any>>());
  const cacheVersion = useRef(0);
  const prevCompiled = useRef(compiled);

  if (prevCompiled.current !== compiled) {
    cacheRef.current = new WeakMap();
    cacheVersion.current++;
    prevCompiled.current = compiled;
  }

  // Build name-to-id map for EvalContext
  const nameToId = useMemo(() => {
    const map = new Map<string, string>();
    for (const [key, name] of fieldNameMap) {
      map.set(name, key);
    }
    return map;
  }, [fieldNameMap]);

  const getFormulaValue = useMemo(() => {
    if (compiled.entries.size === 0) {
      return (_rec: EoState, _fieldKey: string, _useFieldsSub: boolean) => undefined;
    }

    return (rec: EoState, fieldKey: string, useFieldsSub: boolean): any => {
      // Check cache first
      let recordCache = cacheRef.current.get(rec);
      if (recordCache?.has(fieldKey)) return recordCache.get(fieldKey);

      // Compute all formulas for this record (dependency order)
      if (!recordCache) {
        recordCache = new Map();
        cacheRef.current.set(rec, recordCache);

        // Extract stored field values from record
        const storedValues: Record<string, any> = {};
        const source = useFieldsSub && rec.value?.fields && typeof rec.value.fields === 'object' && !Array.isArray(rec.value.fields)
          ? rec.value.fields as Record<string, any>
          : rec.value ?? {};

        for (const [k, v] of Object.entries(source)) {
          if (k.startsWith('_')) continue;
          storedValues[k] = v;
          // Also store by display name
          const displayName = fieldNameMap.get(k);
          if (displayName) storedValues[displayName] = v;
        }

        const ctx: EvalContext = {
          recordId: rec.target.split('.').pop() ?? '',
          tableTarget: rec.target.split('.').slice(0, -1).join('.'),
          fieldNameToId: nameToId,
          eoState: { get: () => undefined, getByPrefix: () => new Map() },
          now: () => new Date(),
        };

        // Evaluate in dependency order
        for (const key of evalOrder) {
          const entry = compiled.entries.get(key);
          if (!entry) continue;
          try {
            const result = entry.compiled(storedValues, ctx);
            recordCache.set(key, result);
            storedValues[key] = result;
            storedValues[entry.fieldName] = result;
          } catch {
            recordCache.set(key, null);
            storedValues[key] = null;
            storedValues[entry.fieldName] = null;
          }
        }
      }

      return recordCache.get(fieldKey);
    };
  }, [compiled, evalOrder, nameToId, fieldNameMap]);

  return {
    getFormulaValue,
    formulaFields: compiled.formulaFields,
    hasFormulas: compiled.formulaFields.size > 0,
  };
}
