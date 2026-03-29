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

export function deriveColumns(records: EoState[]): ColumnDef[] {
  const keyValues = new Map<string, any[]>();

  for (const rec of records) {
    if (!rec.value || typeof rec.value !== 'object') continue;
    for (const [key, val] of Object.entries(rec.value)) {
      if (key.startsWith('_')) continue;
      const arr = keyValues.get(key) || [];
      arr.push(val);
      keyValues.set(key, arr);
    }
  }

  const columns: ColumnDef[] = [];
  for (const [key, values] of keyValues) {
    const type = inferColumnType(values);
    const col: ColumnDef = {
      key,
      label: key,
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
