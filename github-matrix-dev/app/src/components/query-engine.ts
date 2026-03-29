/**
 * Query engine for Horizon — parses SQL, GraphQL, and EO path queries
 * and executes them against in-memory EoState records.
 */

import type { EoState } from '../db/types';

export type QueryLanguage = 'target' | 'sql' | 'graphql' | 'eo';

export interface QueryResult {
  records: EoState[];
  error?: string;
  /** Which scope (prefix) was targeted */
  scope?: string;
  /** Which specific target was matched (for single-record queries) */
  target?: string;
}

// ─── Target Path Suggestions ───────────────────────────────────────────

export function getTargetSuggestions(
  input: string,
  allStates: EoState[],
  limit = 20,
): { target: string; name?: string; lastOp?: string }[] {
  const q = input.toLowerCase().trim();
  if (!q) return [];

  const scored: { target: string; name?: string; lastOp?: string; score: number }[] = [];

  for (const s of allStates) {
    if (s.value?._alias) continue;
    const t = s.target.toLowerCase();
    const name = (s.value?.name as string) || '';
    const nameLower = name.toLowerCase();

    let score = 0;

    // Exact prefix match on target path
    if (t.startsWith(q)) {
      score = 100 - (t.length - q.length);
    }
    // Target path contains query
    else if (t.includes(q)) {
      score = 60 - (t.length - q.length);
    }
    // Name starts with query
    else if (nameLower.startsWith(q)) {
      score = 80 - (nameLower.length - q.length);
    }
    // Name contains query
    else if (nameLower.includes(q)) {
      score = 50 - (nameLower.length - q.length);
    }
    // Fuzzy: each segment of the target matches
    else {
      const segments = t.split('.');
      const queryParts = q.split('.');
      const allMatch = queryParts.every((qp) =>
        segments.some((seg) => seg.includes(qp)),
      );
      if (allMatch) score = 30;
    }

    if (score > 0) {
      scored.push({ target: s.target, name: name || undefined, lastOp: s.last_op, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ─── Field Name Suggestions ────────────────────────────────────────────

export function getFieldSuggestions(
  allStates: EoState[],
): string[] {
  const fields = new Set<string>();
  for (const s of allStates) {
    if (!s.value || typeof s.value !== 'object') continue;
    for (const key of Object.keys(s.value)) {
      if (!key.startsWith('_')) fields.add(key);
    }
  }
  return [...fields].sort();
}

// ─── SQL Parser ────────────────────────────────────────────────────────

interface SqlParsed {
  fields: string[] | '*';
  from: string;
  where?: WhereClause[];
  conjunction: 'AND' | 'OR';
  orderBy?: { field: string; dir: 'ASC' | 'DESC' };
  limit?: number;
}

interface WhereClause {
  field: string;
  op: string;
  value: string | number | boolean | null;
}

function parseSql(query: string): SqlParsed {
  const q = query.trim();

  // Match: SELECT fields FROM table [WHERE ...] [ORDER BY ...] [LIMIT n]
  const selectMatch = q.match(
    /^SELECT\s+(.+?)\s+FROM\s+(\S+?)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\d+))?\s*;?\s*$/i,
  );
  if (!selectMatch) throw new Error('Invalid SQL. Expected: SELECT ... FROM ... [WHERE ...] [ORDER BY ...] [LIMIT n]');

  const rawFields = selectMatch[1].trim();
  const from = selectMatch[2].trim();
  const rawWhere = selectMatch[3]?.trim();
  const rawOrder = selectMatch[4]?.trim();
  const rawLimit = selectMatch[5];

  // Parse fields
  const fields: string[] | '*' = rawFields === '*' ? '*' : rawFields.split(',').map((f) => f.trim());

  // Parse WHERE clauses
  let where: WhereClause[] | undefined;
  let conjunction: 'AND' | 'OR' = 'AND';
  if (rawWhere) {
    // Detect conjunction
    conjunction = /\bOR\b/i.test(rawWhere) ? 'OR' : 'AND';
    const parts = rawWhere.split(/\s+(?:AND|OR)\s+/i);
    where = parts.map((part) => {
      const m = part.trim().match(
        /^(\w+)\s*(=|!=|<>|>=|<=|>|<|LIKE|NOT\s+LIKE|IS\s+NOT|IS|IN)\s*(.+)$/i,
      );
      if (!m) throw new Error(`Invalid WHERE clause: "${part.trim()}"`);
      const field = m[1];
      let op = m[2].toUpperCase().replace(/\s+/g, ' ');
      let rawVal = m[3].trim();

      // Parse value
      let value: string | number | boolean | null;
      if (rawVal.toUpperCase() === 'NULL') {
        value = null;
      } else if (rawVal.toUpperCase() === 'TRUE') {
        value = true;
      } else if (rawVal.toUpperCase() === 'FALSE') {
        value = false;
      } else if (/^['"]/.test(rawVal)) {
        value = rawVal.replace(/^['"]|['"]$/g, '');
      } else if (!isNaN(Number(rawVal))) {
        value = Number(rawVal);
      } else {
        value = rawVal;
      }

      return { field, op, value };
    });
  }

  // Parse ORDER BY
  let orderBy: { field: string; dir: 'ASC' | 'DESC' } | undefined;
  if (rawOrder) {
    const parts = rawOrder.split(/\s+/);
    orderBy = {
      field: parts[0],
      dir: (parts[1]?.toUpperCase() as 'ASC' | 'DESC') || 'ASC',
    };
  }

  return {
    fields,
    from,
    where,
    conjunction,
    orderBy,
    limit: rawLimit ? Number(rawLimit) : undefined,
  };
}

function evalWhereClause(record: any, clause: WhereClause): boolean {
  const val = record[clause.field];
  const cmp = clause.value;

  switch (clause.op) {
    case '=':
      return String(val).toLowerCase() === String(cmp).toLowerCase();
    case '!=':
    case '<>':
      return String(val).toLowerCase() !== String(cmp).toLowerCase();
    case '>':
      return Number(val) > Number(cmp);
    case '<':
      return Number(val) < Number(cmp);
    case '>=':
      return Number(val) >= Number(cmp);
    case '<=':
      return Number(val) <= Number(cmp);
    case 'LIKE': {
      const pattern = String(cmp).replace(/%/g, '.*').replace(/_/g, '.');
      return new RegExp(`^${pattern}$`, 'i').test(String(val ?? ''));
    }
    case 'NOT LIKE': {
      const pattern = String(cmp).replace(/%/g, '.*').replace(/_/g, '.');
      return !new RegExp(`^${pattern}$`, 'i').test(String(val ?? ''));
    }
    case 'IS':
      return val == null || val === '';
    case 'IS NOT':
      return val != null && val !== '';
    default:
      return false;
  }
}

export function executeSql(query: string, allStates: EoState[]): QueryResult {
  try {
    const parsed = parseSql(query);

    // Resolve FROM: match scope prefix (strip tbl prefix for convenience)
    const fromLower = parsed.from.toLowerCase().replace(/^app\./, '');
    let matchingStates = allStates.filter((s) => {
      if (s.value?._alias) return false;
      const target = s.target.toLowerCase();
      // Match "tblX" or just "X" against the target path
      return (
        target.startsWith(`app.${fromLower}.`) ||
        target.startsWith(`app.tbl${fromLower}.`) ||
        target === `app.${fromLower}` ||
        target === `app.tbl${fromLower}`
      );
    });

    // Scope to direct children only (records within the table)
    const scope = matchingStates.length > 0
      ? matchingStates[0].target.split('.').slice(0, 2).join('.')
      : `app.${fromLower}`;
    const scopeDepth = scope.split('.').length;
    matchingStates = matchingStates.filter(
      (s) => s.target.split('.').length === scopeDepth + 1,
    );

    // Apply WHERE
    if (parsed.where) {
      matchingStates = matchingStates.filter((s) => {
        const record = s.value || {};
        if (parsed.conjunction === 'AND') {
          return parsed.where!.every((clause) => evalWhereClause(record, clause));
        }
        return parsed.where!.some((clause) => evalWhereClause(record, clause));
      });
    }

    // Apply ORDER BY
    if (parsed.orderBy) {
      const { field, dir } = parsed.orderBy;
      matchingStates.sort((a, b) => {
        const av = a.value?.[field] ?? '';
        const bv = b.value?.[field] ?? '';
        const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
        return dir === 'DESC' ? -cmp : cmp;
      });
    }

    // Apply LIMIT
    if (parsed.limit) {
      matchingStates = matchingStates.slice(0, parsed.limit);
    }

    // Project fields
    if (parsed.fields !== '*') {
      matchingStates = matchingStates.map((s) => {
        const projected: any = {};
        for (const f of parsed.fields as string[]) {
          projected[f] = s.value?.[f];
        }
        return { ...s, value: projected };
      });
    }

    return { records: matchingStates, scope };
  } catch (e: any) {
    return { records: [], error: e.message };
  }
}

// ─── GraphQL-like Parser ───────────────────────────────────────────────

export function executeGraphql(query: string, allStates: EoState[]): QueryResult {
  try {
    // Parse: { scope(where: { field: "value" }, limit: 10) { field1 field2 } }
    const m = query.match(
      /\{\s*(\w+)\s*(?:\(([^)]*)\))?\s*\{([^}]+)\}\s*\}/s,
    );
    if (!m) throw new Error('Invalid GraphQL. Expected: { scope(where: {...}) { field1 field2 } }');

    const scopeName = m[1];
    const args = m[2]?.trim() || '';
    const fieldStr = m[3].trim();

    const fields = fieldStr.split(/\s+/).filter(Boolean);

    // Parse args
    let whereArgs: Record<string, string> = {};
    let limit: number | undefined;

    const whereMatch = args.match(/where\s*:\s*\{([^}]+)\}/i);
    if (whereMatch) {
      const pairs = whereMatch[1].split(',');
      for (const pair of pairs) {
        const [k, v] = pair.split(':').map((s) => s.trim());
        if (k && v) {
          whereArgs[k] = v.replace(/^["']|["']$/g, '');
        }
      }
    }

    const limitMatch = args.match(/limit\s*:\s*(\d+)/i);
    if (limitMatch) limit = Number(limitMatch[1]);

    // Find records
    const fromLower = scopeName.toLowerCase();
    let matchingStates = allStates.filter((s) => {
      if (s.value?._alias) return false;
      const target = s.target.toLowerCase();
      return (
        target.startsWith(`app.${fromLower}.`) ||
        target.startsWith(`app.tbl${fromLower}.`)
      );
    });

    // Scope to direct children
    if (matchingStates.length > 0) {
      const scope = matchingStates[0].target.split('.').slice(0, 2).join('.');
      const scopeDepth = scope.split('.').length;
      matchingStates = matchingStates.filter(
        (s) => s.target.split('.').length === scopeDepth + 1,
      );
    }

    // Apply where
    if (Object.keys(whereArgs).length > 0) {
      matchingStates = matchingStates.filter((s) => {
        const record = s.value || {};
        return Object.entries(whereArgs).every(
          ([k, v]) => String(record[k]).toLowerCase() === v.toLowerCase(),
        );
      });
    }

    // Limit
    if (limit) matchingStates = matchingStates.slice(0, limit);

    // Project
    if (fields.length > 0 && fields[0] !== '*') {
      matchingStates = matchingStates.map((s) => {
        const projected: any = {};
        for (const f of fields) {
          projected[f] = s.value?.[f];
        }
        return { ...s, value: projected };
      });
    }

    return { records: matchingStates, scope: `app.${fromLower}` };
  } catch (e: any) {
    return { records: [], error: e.message };
  }
}

// ─── EO Path Query ─────────────────────────────────────────────────────

export function executeEoPath(query: string, allStates: EoState[]): QueryResult {
  // EO path queries:
  //   app.tblClients.*                  → all direct children
  //   app.tblClients.**                 → all descendants
  //   app.tblClients[status=active]     → filtered
  //   app.tblClients[name~John]         → contains
  const q = query.trim();

  try {
    // Check for filter brackets
    const bracketMatch = q.match(/^(.+?)\[(.+?)\]$/);
    let pathPattern = bracketMatch ? bracketMatch[1] : q;
    const filterExpr = bracketMatch ? bracketMatch[2] : null;

    // Determine match mode
    let matchFn: (target: string) => boolean;

    if (pathPattern.endsWith('.**')) {
      const prefix = pathPattern.slice(0, -3);
      matchFn = (t) => t.startsWith(prefix + '.') || t === prefix;
    } else if (pathPattern.endsWith('.*')) {
      const prefix = pathPattern.slice(0, -2);
      const depth = prefix.split('.').length + 1;
      matchFn = (t) => t.startsWith(prefix + '.') && t.split('.').length === depth;
    } else {
      // Exact or prefix match
      matchFn = (t) => t === pathPattern || t.startsWith(pathPattern + '.');
    }

    let results = allStates.filter((s) => {
      if (s.value?._alias) return false;
      return matchFn(s.target);
    });

    // Apply filter expression
    if (filterExpr) {
      const filters = filterExpr.split(',').map((f) => f.trim());
      results = results.filter((s) => {
        const record = s.value || {};
        return filters.every((filter) => {
          // Contains: field~value
          const containsMatch = filter.match(/^(\w+)~(.+)$/);
          if (containsMatch) {
            const [, field, val] = containsMatch;
            return String(record[field] ?? '').toLowerCase().includes(val.toLowerCase());
          }
          // Not equals: field!=value
          const neqMatch = filter.match(/^(\w+)!=(.+)$/);
          if (neqMatch) {
            const [, field, val] = neqMatch;
            return String(record[field] ?? '').toLowerCase() !== val.toLowerCase();
          }
          // Equals: field=value
          const eqMatch = filter.match(/^(\w+)=(.+)$/);
          if (eqMatch) {
            const [, field, val] = eqMatch;
            return String(record[field] ?? '').toLowerCase() === val.toLowerCase();
          }
          // Greater than: field>value
          const gtMatch = filter.match(/^(\w+)>(.+)$/);
          if (gtMatch) {
            const [, field, val] = gtMatch;
            return Number(record[field]) > Number(val);
          }
          // Less than: field<value
          const ltMatch = filter.match(/^(\w+)<(.+)$/);
          if (ltMatch) {
            const [, field, val] = ltMatch;
            return Number(record[field]) < Number(val);
          }
          return true;
        });
      });
    }

    return { records: results, scope: pathPattern.replace(/\.\*{1,2}$/, '') };
  } catch (e: any) {
    return { records: [], error: e.message };
  }
}

// ─── Unified Execute ───────────────────────────────────────────────────

export function detectLanguage(query: string): QueryLanguage {
  const q = query.trim();
  if (/^SELECT\s/i.test(q)) return 'sql';
  if (/^\{/.test(q)) return 'graphql';
  if (/^app\./.test(q) || /\.\*/.test(q) || /\[.+\]/.test(q)) return 'eo';
  return 'target';
}

export function executeQuery(
  query: string,
  lang: QueryLanguage,
  allStates: EoState[],
): QueryResult {
  switch (lang) {
    case 'sql':
      return executeSql(query, allStates);
    case 'graphql':
      return executeGraphql(query, allStates);
    case 'eo':
      return executeEoPath(query, allStates);
    case 'target':
      // For target mode, find exact or single match
      const exact = allStates.find((s) => s.target === query.trim());
      if (exact) return { records: [exact], target: exact.target };
      return { records: [], error: 'Target not found' };
  }
}

// ─── SQL Keyword Suggestions ───────────────────────────────────────────

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'ORDER BY', 'LIMIT',
  'LIKE', 'NOT LIKE', 'IS NULL', 'IS NOT NULL', 'ASC', 'DESC',
  'IN', '=', '!=', '>', '<', '>=', '<=',
];

const SQL_TEMPLATES = [
  'SELECT * FROM {table}',
  'SELECT * FROM {table} WHERE {field} = \'{value}\'',
  'SELECT * FROM {table} WHERE {field} LIKE \'%{value}%\'',
  'SELECT * FROM {table} ORDER BY {field} DESC',
  'SELECT * FROM {table} WHERE {field} > {value} LIMIT 10',
  'SELECT {field1}, {field2} FROM {table} WHERE status = \'active\'',
];

const GRAPHQL_TEMPLATES = [
  '{ {table} { name status } }',
  '{ {table}(where: { status: "active" }) { name status } }',
  '{ {table}(limit: 10) { name } }',
];

const EO_TEMPLATES = [
  'app.{table}.*',
  'app.{table}.**',
  'app.{table}[status=active]',
  'app.{table}[name~{value}]',
];

export function getQuerySuggestions(
  input: string,
  lang: QueryLanguage,
  allStates: EoState[],
): string[] {
  const q = input.trim();

  // Collect table names from states
  const tables = new Set<string>();
  for (const s of allStates) {
    const parts = s.target.split('.');
    if (parts.length >= 2) tables.add(parts[1]);
  }
  const tableList = [...tables].sort();
  const fields = getFieldSuggestions(allStates);

  if (lang === 'sql') {
    if (!q) {
      return SQL_TEMPLATES.slice(0, 4).map((t) =>
        t.replace('{table}', tableList[0] || 'table')
          .replace('{field}', fields[0] || 'name')
          .replace('{field1}', fields[0] || 'name')
          .replace('{field2}', fields[1] || 'status')
          .replace('{value}', 'value'),
      );
    }

    const upper = q.toUpperCase();

    // After SELECT, suggest fields or *
    if (/^SELECT\s*$/i.test(q)) {
      return ['SELECT *', `SELECT ${fields.slice(0, 3).join(', ')}`];
    }

    // After FROM, suggest table names
    if (/\bFROM\s*$/i.test(q)) {
      return tableList.map((t) => q + t);
    }

    // After WHERE or AND/OR, suggest field names
    if (/\b(?:WHERE|AND|OR)\s*$/i.test(q)) {
      return fields.slice(0, 8).map((f) => q + f);
    }

    // After field name and operator, suggest values
    const fieldOpMatch = q.match(/\b(?:WHERE|AND|OR)\s+(\w+)\s*(=|!=|LIKE)\s*$/i);
    if (fieldOpMatch) {
      const field = fieldOpMatch[1];
      const values = new Set<string>();
      for (const s of allStates) {
        const v = s.value?.[field];
        if (v != null && typeof v === 'string') values.add(v);
      }
      return [...values].slice(0, 8).map((v) => `${q}'${v}'`);
    }

    // After a table name, suggest WHERE or ORDER BY
    if (/\bFROM\s+\S+\s*$/i.test(q)) {
      return [q + ' WHERE', q + ' ORDER BY', q + ' LIMIT'];
    }

    // SQL keywords that match
    const lastWord = q.split(/\s+/).pop()?.toUpperCase() || '';
    const kwMatches = SQL_KEYWORDS.filter((kw) => kw.startsWith(lastWord) && kw !== lastWord);
    if (kwMatches.length > 0) {
      const prefix = q.slice(0, q.length - lastWord.length);
      return kwMatches.slice(0, 5).map((kw) => prefix + kw);
    }

    return [];
  }

  if (lang === 'graphql') {
    if (!q) {
      return GRAPHQL_TEMPLATES.map((t) =>
        t.replace('{table}', tableList[0] || 'table'),
      );
    }
    // After opening brace, suggest table names
    if (/^\{\s*$/.test(q)) {
      return tableList.map((t) => `{ ${t}`);
    }
    return [];
  }

  if (lang === 'eo') {
    if (!q) {
      return EO_TEMPLATES.map((t) =>
        t.replace('{table}', tableList[0] || 'table')
          .replace('{value}', 'value'),
      );
    }
    // After app., suggest table names
    if (/^app\.\s*$/i.test(q) || q === 'app.') {
      return tableList.map((t) => `app.${t}`);
    }
    // After app.tableName, suggest patterns
    const tableMatch = q.match(/^app\.(\w+)$/);
    if (tableMatch) {
      return [
        `${q}.*`,
        `${q}.**`,
        `${q}[status=active]`,
      ];
    }
    return [];
  }

  return [];
}
