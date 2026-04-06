/**
 * EO State Integration Layer for formulas.
 *
 * Reads entirely from eo_state. All tables are present.
 * Field name resolution uses .name DEFs. Cross-table lookups traverse CONs.
 */

import type { FormulaField, EvalContext, EoStateReader, ComputedValue } from './types';
import { FormulaRegistry } from './registry';

/**
 * Initialize the formula engine for a table.
 * Reads field metadata from eo_state, identifies formula fields,
 * builds name-to-ID map, returns a ready-to-use registry.
 */
export function initializeFormulas(
  tableTarget: string,
  eoState: EoStateReader
): { registry: FormulaRegistry; fieldNameToId: Map<string, string> } {

  const fieldNameToId = new Map<string, string>();
  const formulaFields: FormulaField[] = [];

  const tableEntries = eoState.getByPrefix(tableTarget + '.');

  // First pass: build name-to-ID map for ALL fields
  for (const [target] of tableEntries) {
    const parts = target.split('.');
    if (parts.length === 4 && parts[3] === 'name' && isFieldId(parts[2])) {
      const fieldId = parts[2];
      const nameEntry = eoState.get(target);
      if (nameEntry?.value) {
        fieldNameToId.set(nameEntry.value, fieldId);
      }
    }
  }

  // Second pass: identify formula/computed fields
  for (const [target] of tableEntries) {
    const parts = target.split('.');
    if (parts.length === 3 && isFieldId(parts[2])) {
      const fieldId = parts[2];
      const sig = eoState.get(target);
      if (!sig?.value?.type) continue;

      const fieldType = sig.value.type;
      if (!isComputedType(fieldType)) continue;

      const nameEntry = eoState.get(`${target}.name`);
      const fieldName = nameEntry?.value ?? fieldId;

      let formulaExpression: string | undefined;
      if (fieldType === 'formula') {
        const formulaDef = eoState.get(`${target}.formula`);
        formulaExpression = formulaDef?.value;
        if (!formulaExpression && sig.value.options?.formula) {
          formulaExpression = sig.value.options.formula;
        }
      }

      let rollupFunction: string | undefined;
      let linkedTableId: string | undefined;
      let linkedFieldId: string | undefined;

      if (fieldType === 'rollup') {
        rollupFunction = sig.value.options?.rollupFunction;
        linkedFieldId = sig.value.options?.fieldIdInLinkedTable;
        const linkFieldId = sig.value.options?.recordLinkFieldId;
        if (linkFieldId) {
          const linkSig = eoState.get(`${tableTarget}.${linkFieldId}`);
          linkedTableId = linkSig?.value?.options?.linkedTableId;
        }
      }

      if (fieldType === 'lookup') {
        linkedFieldId = sig.value.options?.fieldIdInLinkedTable;
        const linkFieldId = sig.value.options?.recordLinkFieldId;
        if (linkFieldId) {
          const linkSig = eoState.get(`${tableTarget}.${linkFieldId}`);
          linkedTableId = linkSig?.value?.options?.linkedTableId;
        }
      }

      formulaFields.push({
        fieldId,
        fieldName,
        formulaExpression: formulaExpression ?? '',
        resultType: sig.value.options?.result?.type,
        fieldType,
        linkedTableId,
        linkedFieldId,
        rollupFunction,
      });
    }
  }

  const registry = new FormulaRegistry();
  registry.register(formulaFields, fieldNameToId);

  return { registry, fieldNameToId };
}

/**
 * Compute all formula values for a single record.
 * Reads stored field values from eo_state, evaluates formulas,
 * returns computed values — Horizon output, never persisted.
 */
export function computeRecordFormulas(
  recordId: string,
  tableTarget: string,
  registry: FormulaRegistry,
  fieldNameToId: Map<string, string>,
  eoState: EoStateReader
): Map<string, ComputedValue> {

  const recTarget = `${tableTarget}.${recordId}`;
  const recEntry = eoState.get(recTarget);
  const storedValues: Record<string, any> = {};

  if (recEntry?.value) {
    // Support both flat records and fields sub-object pattern
    const fields = recEntry.value.fields && typeof recEntry.value.fields === 'object' && !Array.isArray(recEntry.value.fields)
      ? recEntry.value.fields as Record<string, any>
      : recEntry.value;

    for (const [key, val] of Object.entries(fields)) {
      if (key.startsWith('_')) continue;
      storedValues[key] = val;
      // Also store by display name for formula resolution
      const name = [...fieldNameToId.entries()].find(([, id]) => id === key)?.[0];
      if (name) storedValues[name] = val;
    }
  }

  const ctx: EvalContext = {
    recordId,
    tableTarget,
    fieldNameToId,
    eoState,
    now: () => new Date(),
  };

  return registry.computeRecord(recordId, storedValues, ctx);
}

/**
 * Resolve a lookup: traverse a link to another table and collect values.
 * Works because eo_state has ALL tables.
 */
export function resolveLookup(
  recordId: string,
  tableTarget: string,
  linkFieldId: string,
  linkedTableTarget: string,
  targetFieldId: string,
  eoState: EoStateReader
): any[] {
  const recEntry = eoState.get(`${tableTarget}.${recordId}`);
  if (!recEntry?.value) return [];

  const fields = recEntry.value.fields ?? recEntry.value;
  const linkValue = fields[linkFieldId];
  if (!linkValue) return [];

  const linkedIds: string[] = Array.isArray(linkValue)
    ? linkValue
    : linkValue?.linkedRecordIds ?? [];

  const values: any[] = [];
  for (const linkedRecId of linkedIds) {
    const linkedEntry = eoState.get(`${linkedTableTarget}.${linkedRecId}`);
    if (!linkedEntry?.value) continue;
    const linkedFields = linkedEntry.value.fields ?? linkedEntry.value;
    const val = linkedFields[targetFieldId];
    if (val != null) values.push(val);
  }
  return values;
}

/**
 * Resolve a rollup: lookup + aggregation.
 * SUM/MAX/MIN are EVAs (judgments). CONCATENATE/ARRAYJOIN are DEFs.
 */
export function resolveRollup(
  recordId: string,
  tableTarget: string,
  linkFieldId: string,
  linkedTableTarget: string,
  targetFieldId: string,
  rollupFunction: string,
  eoState: EoStateReader
): any {
  const values = resolveLookup(
    recordId, tableTarget, linkFieldId,
    linkedTableTarget, targetFieldId, eoState
  );

  if (values.length === 0) return null;

  const fn = rollupFunction?.toUpperCase() ?? 'ARRAYJOIN';
  switch (fn) {
    case 'SUM': return values.reduce((a, b) => (Number(a) || 0) + (Number(b) || 0), 0);
    case 'AVERAGE': {
      const nums = values.map(Number).filter(n => !isNaN(n));
      return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    }
    case 'MAX': return Math.max(...values.map(Number).filter(n => !isNaN(n)));
    case 'MIN': return Math.min(...values.map(Number).filter(n => !isNaN(n)));
    case 'COUNT': return values.length;
    case 'COUNTA': return values.filter(v => v != null && v !== '').length;
    case 'AND': return values.every(Boolean) ? 1 : 0;
    case 'OR': return values.some(Boolean) ? 1 : 0;
    case 'XOR': return values.filter(Boolean).length % 2 === 1 ? 1 : 0;
    case 'CONCATENATE':
    case 'ARRAYJOIN': return values.join(', ');
    case 'ARRAYCOMPACT': return values.filter(v => v != null && v !== '');
    case 'ARRAYUNIQUE': return [...new Set(values)];
    default: return values;
  }
}

// ─── Helpers ─────────────────────────────────────────────

function isFieldId(s: string): boolean {
  return s.startsWith('fld');
}

function isComputedType(type: string): boolean {
  return ['formula', 'rollup', 'lookup', 'count'].includes(type);
}
