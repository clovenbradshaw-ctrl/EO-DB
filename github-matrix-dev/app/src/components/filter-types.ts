import type { EoState } from '../db/types';
import { formatName } from './scope-picker-utils';

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

export type ColumnType =
  | 'text' | 'richText' | 'email' | 'url' | 'phone'
  | 'number' | 'currency' | 'percent' | 'rating' | 'duration'
  | 'select' | 'multiSelect'
  | 'date'
  | 'boolean'
  | 'attachment' | 'linkedRecord' | 'link' | 'relationship'
  | 'formula' | 'rollup' | 'lookup' | 'count'
  | 'autoNumber' | 'createdTime' | 'lastModifiedTime' | 'createdBy' | 'lastModifiedBy'
  | 'collaborator' | 'collaborators';

export interface ColumnDef {
  key: string;
  label: string;
  type: ColumnType;
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
const DATE_OPS: FilterOperator[] = ['equals', 'not_equals', 'gt', 'lt', 'gte', 'lte', 'is_empty', 'is_not_empty'];
const SELECT_OPS: FilterOperator[] = ['equals', 'not_equals', 'is_empty', 'is_not_empty'];
const BOOLEAN_OPS: FilterOperator[] = ['equals', 'not_equals'];
const OBJECT_OPS: FilterOperator[] = ['is_empty', 'is_not_empty', 'contains'];

export function operatorsForType(type: ColumnDef['type']): FilterOperator[] {
  switch (type) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'rating':
    case 'duration':
    case 'autoNumber':
    case 'count':
      return NUMBER_OPS;
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime':
      return DATE_OPS;
    case 'select':
    case 'multiSelect':
      return SELECT_OPS;
    case 'boolean':
      return BOOLEAN_OPS;
    case 'attachment':
    case 'linkedRecord':
    case 'link':
    case 'relationship':
    case 'collaborator':
    case 'collaborators':
      return OBJECT_OPS;
    default:
      return TEXT_OPS;
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

/** Fields that represent operational metadata rather than current-state data.
 *  Hidden from the Horizon table but visible in the record detail panel. */
export const HORIZON_HIDDEN_FIELDS = new Set([
  'OP', 'op', 'Op',
  'Agent', 'agent', 'AGENT',
  'last_op', 'last_agent',
]);

// --- Column Inference ---

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const EMAIL_RE = /@.*\./;
const URL_RE = /^https?:\/\//;

export function inferColumnType(values: any[]): ColumnDef['type'] {
  const nonNull = values.filter(v => v != null);
  if (nonNull.length === 0) return 'text';

  const types = new Set(nonNull.map(v => typeof v));

  if (types.size === 1 && types.has('number')) return 'number';
  if (types.size === 1 && types.has('boolean')) return 'boolean';

  if (types.has('string')) {
    const strings = nonNull.filter(v => typeof v === 'string') as string[];
    if (strings.length > 0) {
      // Date detection: if >50% of non-null string values look like ISO dates
      const dateCount = strings.filter(s => ISO_DATE_RE.test(s) && !isNaN(new Date(s).getTime())).length;
      if (dateCount / strings.length > 0.5) return 'date';

      // Email detection: if >50% look like emails
      const emailCount = strings.filter(s => EMAIL_RE.test(s)).length;
      if (emailCount / strings.length > 0.5) return 'email';

      // URL detection: if >50% look like URLs
      const urlCount = strings.filter(s => URL_RE.test(s)).length;
      if (urlCount / strings.length > 0.5) return 'url';
    }
  }

  // If all strings and < 10 unique values, treat as select
  if (types.size === 1 && types.has('string')) {
    const unique = new Set(nonNull as string[]);
    if (unique.size <= 10 && unique.size < nonNull.length * 0.5) return 'select';
    return 'text';
  }

  // Objects (linked arrays, nested data) — auto-detect as link fields
  if (nonNull.some(v => typeof v === 'object')) return 'link';

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
 * Build a field name map from per-field schema entities (stored under _schema).
 * Each schema entity has `value.name` (Airtable field name) and optionally
 * `value._label` (user-set display name override).
 * The last segment of the target path is the field ID.
 */
export function buildFieldNameMapFromSchema(
  schemaStates: EoState[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const st of schemaStates) {
    const fieldId = st.target.split('.').pop();
    if (!fieldId) continue;
    const label = st.value?._label || st.value?.name;
    if (label) map.set(fieldId, label);
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
  columnTypeOverrides?: Map<string, any>,
  showFieldIds?: boolean,
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
      if (HORIZON_HIDDEN_FIELDS.has(key)) continue;
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
    const typeOverride = columnTypeOverrides?.get(key);
    const type = (typeOverride?.type as ColumnDef['type']) ?? inferColumnType(values);
    const prettyName = showFieldIds
      ? key
      : (fieldNameMap?.get(key) ?? (key.startsWith('fld') ? formatName(key) : key));
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

  // Add columns for schema-defined fields with no record data (computed/EVA)
  if (fieldNameMap) {
    for (const [fieldId, name] of fieldNameMap) {
      if (!keyValues.has(fieldId)) {
        const typeOverride = columnTypeOverrides?.get(fieldId);
        const type = (typeOverride?.type as ColumnDef['type']) ?? 'text';
        columns.push({ key: fieldId, label: showFieldIds ? fieldId : name, type });
      }
    }
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

// ─── EO / SQL ↔ FilterRule Conversion ─────────────────────────────────

/** Operator mapping: EO filter syntax → FilterOperator */
const EO_OP_MAP: Record<string, FilterOperator> = {
  '=': 'equals',
  '!=': 'not_equals',
  '~': 'contains',
  '!~': 'not_contains',
  '>': 'gt',
  '<': 'lt',
  '>=': 'gte',
  '<=': 'lte',
};

const FILTER_OP_TO_EO: Record<FilterOperator, string> = {
  equals: '=',
  not_equals: '!=',
  contains: '~',
  not_contains: '!~',
  starts_with: '^=',
  ends_with: '$=',
  is_empty: '=∅',
  is_not_empty: '!=∅',
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
};

const FILTER_OP_TO_SQL: Record<FilterOperator, string> = {
  equals: '=',
  not_equals: '!=',
  contains: 'LIKE',
  not_contains: 'NOT LIKE',
  starts_with: 'LIKE',
  ends_with: 'LIKE',
  is_empty: 'IS NULL',
  is_not_empty: 'IS NOT NULL',
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
};

/**
 * Parse an EO filter expression (the part inside brackets) into FilterRules.
 * Example: "status=active,score>100,name~John"
 */
export function parseEoFilterExpr(expr: string): { rules: FilterRule[]; conjunction: 'AND' | 'OR' } {
  const rules: FilterRule[] = [];
  // EO uses comma for AND, pipe for OR
  const isOr = expr.includes('|') && !expr.includes(',');
  const parts = isOr ? expr.split('|') : expr.split(',');
  const conjunction: 'AND' | 'OR' = isOr ? 'OR' : 'AND';

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Match: field{op}value  (ops: >=, <=, !=, !~, ~, >, <, =)
    const m = trimmed.match(/^(\w+)(>=|<=|!=|!~|~|>|<|=)(.*)$/);
    if (!m) continue;

    const [, field, eoOp, value] = m;
    const operator = EO_OP_MAP[eoOp] || 'equals';

    // Handle empty checks
    if (value === '∅') {
      rules.push({ id: crypto.randomUUID(), field, operator: eoOp === '!=' ? 'is_not_empty' : 'is_empty', value: '' });
      continue;
    }

    rules.push({ id: crypto.randomUUID(), field, operator, value });
  }

  return { rules, conjunction };
}

/**
 * Parse a SQL WHERE clause into FilterRules.
 * Example: "status = 'active' AND score > 100"
 */
export function parseSqlWhereClause(whereStr: string): { rules: FilterRule[]; conjunction: 'AND' | 'OR' } {
  const rules: FilterRule[] = [];
  const conjunction: 'AND' | 'OR' = /\bOR\b/i.test(whereStr) ? 'OR' : 'AND';
  const parts = whereStr.split(/\s+(?:AND|OR)\s+/i);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // IS NULL / IS NOT NULL
    const nullMatch = trimmed.match(/^(\w+)\s+(IS\s+NOT\s+NULL|IS\s+NULL)$/i);
    if (nullMatch) {
      const operator: FilterOperator = /NOT/i.test(nullMatch[2]) ? 'is_not_empty' : 'is_empty';
      rules.push({ id: crypto.randomUUID(), field: nullMatch[1], operator, value: '' });
      continue;
    }

    // field op value
    const m = trimmed.match(/^(\w+)\s*(NOT\s+LIKE|LIKE|>=|<=|!=|<>|>|<|=)\s*(.+)$/i);
    if (!m) continue;

    const [, field, sqlOp, rawVal] = m;
    let value = rawVal.trim().replace(/^['"]|['"]$/g, '');
    const opUpper = sqlOp.toUpperCase().replace(/\s+/g, ' ');

    let operator: FilterOperator;
    switch (opUpper) {
      case '=': operator = 'equals'; break;
      case '!=': case '<>': operator = 'not_equals'; break;
      case '>': operator = 'gt'; break;
      case '<': operator = 'lt'; break;
      case '>=': operator = 'gte'; break;
      case '<=': operator = 'lte'; break;
      case 'LIKE':
        if (value.startsWith('%') && value.endsWith('%')) {
          operator = 'contains'; value = value.slice(1, -1);
        } else if (value.endsWith('%')) {
          operator = 'starts_with'; value = value.slice(0, -1);
        } else if (value.startsWith('%')) {
          operator = 'ends_with'; value = value.slice(1);
        } else {
          operator = 'equals';
        }
        break;
      case 'NOT LIKE':
        operator = 'not_contains';
        value = value.replace(/^%|%$/g, '');
        break;
      default: operator = 'equals';
    }

    rules.push({ id: crypto.randomUUID(), field, operator, value });
  }

  return { rules, conjunction };
}

/** Convert FilterRules to an EO filter expression string. */
export function filtersToEo(
  scope: string,
  rules: FilterRule[],
  conjunction: 'AND' | 'OR',
): string {
  if (rules.length === 0) return `${scope}.*`;

  const sep = conjunction === 'OR' ? '|' : ',';
  const exprs = rules.map((r) => {
    const eoOp = FILTER_OP_TO_EO[r.operator] || '=';
    if (r.operator === 'is_empty') return `${r.field}=∅`;
    if (r.operator === 'is_not_empty') return `${r.field}!=∅`;
    return `${r.field}${eoOp}${r.value}`;
  });

  return `${scope}[${exprs.join(sep)}]`;
}

/** Convert FilterRules to a SQL SELECT string. */
export function filtersToSql(
  scope: string,
  rules: FilterRule[],
  conjunction: 'AND' | 'OR',
): string {
  const table = scope.split('.').pop() || scope;

  if (rules.length === 0) return `SELECT * FROM ${table}`;

  const clauses = rules.map((r) => {
    const sqlOp = FILTER_OP_TO_SQL[r.operator];
    switch (r.operator) {
      case 'is_empty': return `${r.field} IS NULL`;
      case 'is_not_empty': return `${r.field} IS NOT NULL`;
      case 'contains': return `${r.field} LIKE '%${r.value}%'`;
      case 'not_contains': return `${r.field} NOT LIKE '%${r.value}%'`;
      case 'starts_with': return `${r.field} LIKE '${r.value}%'`;
      case 'ends_with': return `${r.field} LIKE '%${r.value}'`;
      default: {
        const isNum = !isNaN(Number(r.value)) && r.value !== '';
        const val = isNum ? r.value : `'${r.value}'`;
        return `${r.field} ${sqlOp} ${val}`;
      }
    }
  });

  return `SELECT * FROM ${table} WHERE ${clauses.join(` ${conjunction} `)}`;
}

export function applyFilters(
  records: EoState[],
  filters: FilterRule[],
  conjunction: 'AND' | 'OR',
  useFieldsSub = false,
): EoState[] {
  if (filters.length === 0) return records;

  return records.filter((rec) => {
    const check = (f: FilterRule) => evaluateRule(getFieldValue(rec, f.field, useFieldsSub), f);
    return conjunction === 'AND' ? filters.every(check) : filters.some(check);
  });
}
