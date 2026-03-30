import type { EoState } from '../db/types';

// --- Filter Types ---

export type FilterOperator =
  | 'equals' | 'not_equals'
  | 'contains' | 'not_contains'
  | 'starts_with' | 'ends_with'
  | 'is_empty' | 'is_not_empty'
  | 'gt' | 'lt' | 'gte' | 'lte';

export interface FilterRule {
  id: string;
  field: string;
  operator: FilterOperator;
  value: string;
}

export interface ColumnDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'boolean' | 'object';
  selectOptions?: string[];
}

export interface FilterDefinition {
  name: string;
  filters: FilterRule[];
  conjunction: 'AND' | 'OR';
  created_at: string;
  created_by: string;
}

// --- Operators available per column type ---

const TEXT_OPS: FilterOperator[] = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'];
const NUMBER_OPS: FilterOperator[] = ['equals', 'not_equals', 'gt', 'lt', 'gte', 'lte', 'is_empty', 'is_not_empty'];
const SELECT_OPS: FilterOperator[] = ['equals', 'not_equals', 'is_empty', 'is_not_empty'];
const BOOLEAN_OPS: FilterOperator[] = ['equals', 'not_equals'];
const OBJECT_OPS: FilterOperator[] = ['is_empty', 'is_not_empty', 'contains'];

export function operatorsForType(type: ColumnDef['type']): FilterOperator[] {
  switch (type) {
    case 'number': return NUMBER_OPS;
    case 'select': return SELECT_OPS;
    case 'boolean': return BOOLEAN_OPS;
    case 'object': return OBJECT_OPS;
    default: return TEXT_OPS;
  }
}

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
};

// --- Column Inference ---

export function inferColumnType(values: any[]): ColumnDef['type'] {
  const nonNull = values.filter(v => v != null);
  if (nonNull.length === 0) return 'text';

  const types = new Set(nonNull.map(v => typeof v));

  if (types.size === 1 && types.has('number')) return 'number';
  if (types.size === 1 && types.has('boolean')) return 'boolean';

  // If all strings and < 10 unique values, treat as select
  if (types.size === 1 && types.has('string')) {
    const unique = new Set(nonNull as string[]);
    if (unique.size <= 10 && unique.size < nonNull.length * 0.5) return 'select';
    return 'text';
  }

  // Objects (linked arrays, nested data)
  if (nonNull.some(v => typeof v === 'object')) return 'object';

  return 'text';
}

/**
 * Build a map from field ID → display name using field metadata stored on the
 * table (scope) state.  The table DEF stores `fields` as an array of
 * `{ id, name, type }` objects from the Airtable schema.
 */
export function buildFieldNameMap(
  fieldMeta: Array<{ id: string; name: string }> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (fieldMeta) {
    for (const f of fieldMeta) map.set(f.id, f.name);
  }
  return map;
}

/**
 * Check whether the records use the Airtable-style `fields` sub-object
 * (i.e. `value.fields` is a plain object whose keys are field IDs).
 */
export function hasFieldsSubObject(records: EoState[]): boolean {
  for (const rec of records) {
    const f = rec.value?.fields;
    if (f && typeof f === 'object' && !Array.isArray(f)) return true;
  }
  return false;
}

/**
 * Return the "flat" field value for a column key.
 * For records that use the `fields` sub-object, reads from `value.fields[key]`.
 * Otherwise reads from `value[key]`.
 */
export function getFieldValue(rec: EoState, key: string, useFieldsSub: boolean): any {
  if (useFieldsSub) {
    // Check fields sub-object first, then fall back to top-level value
    // (e.g. `name` is set at value.name by the display field mechanism)
    const fieldVal = rec.value?.fields?.[key];
    if (fieldVal !== undefined) return fieldVal;
    return rec.value?.[key];
  }
  return rec.value?.[key];
}

export function deriveColumns(
  records: EoState[],
  fieldNameMap?: Map<string, string>,
): ColumnDef[] {
  const keyValues = new Map<string, any[]>();
  const useFieldsSub = hasFieldsSubObject(records);

  for (const rec of records) {
    if (!rec.value || typeof rec.value !== 'object') continue;

    // If records use the Airtable-style `fields` sub-object, iterate its keys
    const source = useFieldsSub
      ? (rec.value.fields && typeof rec.value.fields === 'object' && !Array.isArray(rec.value.fields)
          ? rec.value.fields as Record<string, any>
          : {})
      : rec.value;

    for (const [key, val] of Object.entries(source)) {
      if (key.startsWith('_')) continue;
      const arr = keyValues.get(key) || [];
      arr.push(val);
      keyValues.set(key, arr);
    }

    // When using fields sub-object, also include top-level `name` if present
    // (set by the _displayField mechanism during ingestion)
    if (useFieldsSub && rec.value.name && typeof rec.value.name === 'string') {
      const arr = keyValues.get('name') || [];
      arr.push(rec.value.name);
      keyValues.set('name', arr);
    }
  }

  const columns: ColumnDef[] = [];
  for (const [key, values] of keyValues) {
    const type = inferColumnType(values);
    const prettyName = fieldNameMap?.get(key) ?? key;
    const col: ColumnDef = {
      key,
      label: prettyName,
      type,
    };
    if (type === 'select') {
      col.selectOptions = [...new Set(values.filter(v => typeof v === 'string') as string[])].sort();
    }
    columns.push(col);
  }

  // Sort: name first, status second, then alphabetical
  columns.sort((a, b) => {
    if (a.key === 'name') return -1;
    if (b.key === 'name') return 1;
    if (a.key === 'status') return -1;
    if (b.key === 'status') return 1;
    return a.key.localeCompare(b.key);
  });

  return columns;
}

// --- Filter Application ---

function evaluateRule(value: any, rule: FilterRule): boolean {
  const str = value != null ? String(value) : '';
  const ruleVal = rule.value || '';

  switch (rule.operator) {
    case 'is_empty':
      return value == null || str === '';
    case 'is_not_empty':
      return value != null && str !== '';
    case 'equals':
      return str.toLowerCase() === ruleVal.toLowerCase();
    case 'not_equals':
      return str.toLowerCase() !== ruleVal.toLowerCase();
    case 'contains':
      return str.toLowerCase().includes(ruleVal.toLowerCase());
    case 'not_contains':
      return !str.toLowerCase().includes(ruleVal.toLowerCase());
    case 'starts_with':
      return str.toLowerCase().startsWith(ruleVal.toLowerCase());
    case 'ends_with':
      return str.toLowerCase().endsWith(ruleVal.toLowerCase());
    case 'gt':
      return Number(value) > Number(ruleVal);
    case 'lt':
      return Number(value) < Number(ruleVal);
    case 'gte':
      return Number(value) >= Number(ruleVal);
    case 'lte':
      return Number(value) <= Number(ruleVal);
    default:
      return true;
  }
}

export function applyFilters(
  records: EoState[],
  filters: FilterRule[],
  conjunction: 'AND' | 'OR',
): EoState[] {
  if (filters.length === 0) return records;

  return records.filter((rec) => {
    const val = rec.value || {};
    if (conjunction === 'AND') {
      return filters.every((f) => evaluateRule(val[f.field], f));
    } else {
      return filters.some((f) => evaluateRule(val[f.field], f));
    }
  });
}
