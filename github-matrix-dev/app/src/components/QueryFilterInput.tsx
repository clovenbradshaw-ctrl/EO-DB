/**
 * QueryFilterInput — inline EO / SQL query input with rich autocomplete.
 *
 * Sits inside the FilterBar panel and lets users type queries in either
 * EO notation or SQL, with contextual suggestions that auto-fill field names,
 * operators, values, and common patterns.
 *
 * On submit (Enter / Apply), the query is parsed into FilterRules that
 * integrate with the existing visual filter pipeline.
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { ColumnDef, FilterRule } from './filter-types';
import { parseEoFilterExpr, parseSqlWhereClause, filtersToEo, filtersToSql } from './filter-types';
import { useTheme, type Theme } from '../theme';

type QueryFilterLang = 'eo' | 'sql';

interface Suggestion {
  label: string;
  detail?: string;
  /** If set, inserting this replaces only from `replaceFrom` to cursor */
  insertText?: string;
  kind: 'keyword' | 'field' | 'operator' | 'value' | 'template';
}

interface QueryFilterInputProps {
  columns: ColumnDef[];
  scope: string;
  /** Current visual filters — used to seed the query text on mode switch */
  currentFilters: FilterRule[];
  currentConjunction: 'AND' | 'OR';
  onApply: (rules: FilterRule[], conjunction: 'AND' | 'OR') => void;
}

export function QueryFilterInput({
  columns,
  scope,
  currentFilters,
  currentConjunction,
  onApply,
}: QueryFilterInputProps) {
  const [lang, setLang] = useState<QueryFilterLang>('eo');
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  // Seed query from current visual filters when switching lang
  useEffect(() => {
    if (currentFilters.length > 0) {
      const text = lang === 'eo'
        ? filtersToEo(scope || 'app.table', currentFilters, currentConjunction)
        : filtersToSql(scope || 'app.table', currentFilters, currentConjunction);
      setQuery(text);
    } else {
      setQuery('');
    }
    setError(null);
  }, [lang]); // Only on lang switch

  const fieldNames = useMemo(() => columns.map(c => c.label || c.key), [columns]);
  const fieldKeys = useMemo(() => columns.map(c => c.key), [columns]);

  // ─── Autocomplete suggestions ─────────────────────────────────────
  const suggestions = useMemo((): Suggestion[] => {
    const q = query;
    const results: Suggestion[] = [];

    if (lang === 'eo') {
      return getEoSuggestions(q, columns, scope, fieldKeys, fieldNames);
    } else {
      return getSqlSuggestions(q, columns, scope, fieldKeys, fieldNames);
    }
  }, [query, lang, columns, scope, fieldKeys, fieldNames]);

  // Reset selection on suggestion change
  useEffect(() => setSelectedIdx(0), [suggestions]);

  // Scroll into view
  useEffect(() => {
    if (dropdownRef.current) {
      const item = dropdownRef.current.children[selectedIdx] as HTMLElement;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIdx]);

  const handleApply = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    setError(null);

    try {
      if (lang === 'eo') {
        // Extract bracket content
        const bracketMatch = q.match(/\[(.+?)\]$/);
        if (!bracketMatch) {
          // No filter expression — just a path, apply empty
          onApply([], 'AND');
          return;
        }
        const { rules, conjunction } = parseEoFilterExpr(bracketMatch[1]);
        if (rules.length === 0) throw new Error('No valid filter expressions found');
        onApply(rules, conjunction);
      } else {
        // SQL — extract WHERE clause
        const whereMatch = q.match(/\bWHERE\s+(.+?)(?:\s+ORDER\s|\s+LIMIT\s|;?\s*$)/i);
        if (!whereMatch) {
          // No WHERE — clear filters
          onApply([], 'AND');
          return;
        }
        const { rules, conjunction } = parseSqlWhereClause(whereMatch[1]);
        if (rules.length === 0) throw new Error('No valid WHERE conditions found');
        onApply(rules, conjunction);
      }
    } catch (e: any) {
      setError(e.message || 'Parse error');
    }
  }, [query, lang, onApply]);

  function handleKeyDown(e: React.KeyboardEvent) {
    const len = suggestions.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(i => (i + 1) % Math.max(len, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(i => (i - 1 + Math.max(len, 1)) % Math.max(len, 1));
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (focused && suggestions[selectedIdx]) {
        acceptSuggestion(suggestions[selectedIdx]);
      } else {
        handleApply();
      }
    } else if (e.key === 'Tab' && suggestions[selectedIdx]) {
      e.preventDefault();
      acceptSuggestion(suggestions[selectedIdx]);
    } else if (e.key === 'Escape') {
      setFocused(false);
    }
  }

  function acceptSuggestion(sug: Suggestion) {
    const text = sug.insertText ?? sug.label;
    setQuery(text);
    setError(null);
    setSelectedIdx(0);
    // Keep focus for chaining
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  const showDropdown = focused && suggestions.length > 0;

  return (
    <div style={s.container}>
      {/* Language tabs */}
      <div style={s.langRow}>
        <span style={s.label}>Query mode</span>
        <button
          style={{ ...s.langTab, ...(lang === 'eo' ? s.langTabActive : {}) }}
          onClick={() => setLang('eo')}
        >
          EO
        </button>
        <button
          style={{ ...s.langTab, ...(lang === 'sql' ? s.langTabActive : {}) }}
          onClick={() => setLang('sql')}
        >
          SQL
        </button>
      </div>

      {/* Input */}
      <div style={s.inputRow}>
        <span style={s.langBadge}>{lang === 'eo' ? 'EO' : 'SQL'}</span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); setError(null); }}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={handleKeyDown}
          placeholder={lang === 'eo'
            ? `${scope || 'app.table'}[field=value,field>10]`
            : `SELECT * FROM ${(scope || 'app.table').split('.').pop()} WHERE field = 'value'`
          }
          style={s.input}
          spellCheck={false}
          autoComplete="off"
        />
        <button onClick={handleApply} style={s.applyBtn}>
          Apply
        </button>
      </div>

      {/* Error */}
      {error && <div style={s.error}>{error}</div>}

      {/* Autocomplete dropdown */}
      {showDropdown && (
        <div style={s.dropdown} ref={dropdownRef}>
          {suggestions.map((sug, i) => (
            <div
              key={i}
              style={{ ...s.suggestion, ...(i === selectedIdx ? s.suggestionActive : {}) }}
              onMouseEnter={() => setSelectedIdx(i)}
              onMouseDown={e => { e.preventDefault(); acceptSuggestion(sug); }}
            >
              <span style={s.kindBadge(sug.kind, theme)}>{sug.kind}</span>
              <span style={s.sugLabel}>{sug.label}</span>
              {sug.detail && <span style={s.sugDetail}>{sug.detail}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Cheat sheet */}
      <div style={s.helpRow}>
        {lang === 'eo' ? (
          <span style={s.helpText}>
            <b>=</b> equals &nbsp; <b>!=</b> not &nbsp; <b>~</b> contains &nbsp;
            <b>&gt;</b> <b>&lt;</b> <b>&gt;=</b> <b>&lt;=</b> compare &nbsp;
            <b>,</b> AND &nbsp; <b>|</b> OR
          </span>
        ) : (
          <span style={s.helpText}>
            <b>=</b> <b>!=</b> <b>&gt;</b> <b>&lt;</b> compare &nbsp;
            <b>LIKE '%val%'</b> contains &nbsp;
            <b>IS NULL</b> empty &nbsp;
            <b>AND</b> / <b>OR</b>
          </span>
        )}
      </div>
    </div>
  );
}

// ─── EO Autocomplete ────────────────────────────────────────────────

function getEoSuggestions(
  query: string,
  columns: ColumnDef[],
  scope: string,
  fieldKeys: string[],
  fieldNames: string[],
): Suggestion[] {
  const q = query;
  const results: Suggestion[] = [];

  // Empty — show templates
  if (!q) {
    const s = scope || 'app.table';
    results.push(
      { label: `${s}[field=value]`, detail: 'Filter by equality', kind: 'template', insertText: `${s}[` },
      { label: `${s}[field~text]`, detail: 'Filter by contains', kind: 'template', insertText: `${s}[` },
      { label: `${s}[field>100]`, detail: 'Numeric comparison', kind: 'template', insertText: `${s}[` },
      { label: `${s}[a=x,b=y]`, detail: 'Multiple AND filters', kind: 'template', insertText: `${s}[` },
      { label: `${s}[a=x|b=y]`, detail: 'Multiple OR filters', kind: 'template', insertText: `${s}[` },
    );
    return results;
  }

  // Inside brackets — suggest fields
  const bracketOpen = q.lastIndexOf('[');
  if (bracketOpen !== -1 && !q.endsWith(']')) {
    const insideBracket = q.slice(bracketOpen + 1);
    // After comma or pipe or opening bracket — suggest field names
    const lastSep = Math.max(insideBracket.lastIndexOf(','), insideBracket.lastIndexOf('|'));
    const currentToken = lastSep >= 0 ? insideBracket.slice(lastSep + 1) : insideBracket;

    // If token has no operator yet, suggest field names
    if (!/[=!~><]/.test(currentToken)) {
      const prefix = currentToken.toLowerCase();
      const matchingFields = columns.filter(c =>
        c.key.toLowerCase().startsWith(prefix) || (c.label || '').toLowerCase().startsWith(prefix)
      );
      for (const col of matchingFields.slice(0, 10)) {
        const beforeToken = q.slice(0, q.length - currentToken.length);
        results.push({
          label: col.label || col.key,
          detail: col.type,
          kind: 'field',
          insertText: beforeToken + col.key,
        });
      }

      // Also suggest operators if field is complete
      if (matchingFields.length === 0 && currentToken.length > 0) {
        const base = q;
        for (const [op, desc] of [['=', 'equals'], ['!=', 'not equals'], ['~', 'contains'], ['>', 'greater than'], ['<', 'less than'], ['>=', 'greater or equal'], ['<=', 'less or equal']] as const) {
          results.push({ label: `${currentToken}${op}`, detail: desc, kind: 'operator', insertText: `${base}${op}` });
        }
      }
    }
    // If token has an operator, suggest values
    else {
      const opMatch = currentToken.match(/^(\w+)(>=|<=|!=|!~|~|>|<|=)(.*)$/);
      if (opMatch) {
        const [, field, , valuePart] = opMatch;
        const col = columns.find(c => c.key === field);
        if (col?.selectOptions) {
          const vpLower = valuePart.toLowerCase();
          const matchingValues = col.selectOptions.filter(v => v.toLowerCase().startsWith(vpLower));
          const beforeValue = q.slice(0, q.length - valuePart.length);
          for (const val of matchingValues.slice(0, 10)) {
            results.push({ label: val, detail: `${field} value`, kind: 'value', insertText: beforeValue + val });
          }
        }
        // After a complete value, suggest closing bracket or adding more
        if (valuePart.length > 0 && (!col?.selectOptions || col.selectOptions.includes(valuePart))) {
          results.push({ label: `${q}]`, detail: 'Close & apply', kind: 'keyword', insertText: `${q}]` });
          results.push({ label: `${q},`, detail: 'Add AND condition', kind: 'keyword', insertText: `${q},` });
          results.push({ label: `${q}|`, detail: 'Add OR condition', kind: 'keyword', insertText: `${q}|` });
        }
      }
    }

    return results;
  }

  // Before bracket — suggest opening bracket after scope
  if (!q.includes('[')) {
    const s = scope || 'app.table';
    if (q.length > 0 && !q.endsWith('[')) {
      results.push({ label: `${q}[`, detail: 'Add filter', kind: 'keyword', insertText: `${q}[` });
      results.push({ label: `${q}.*`, detail: 'All direct children', kind: 'template', insertText: `${q}.*` });
      results.push({ label: `${q}.**`, detail: 'All descendants', kind: 'template', insertText: `${q}.**` });
    }
  }

  return results;
}

// ─── SQL Autocomplete ───────────────────────────────────────────────

function getSqlSuggestions(
  query: string,
  columns: ColumnDef[],
  scope: string,
  fieldKeys: string[],
  _fieldNames: string[],
): Suggestion[] {
  const q = query;
  const table = (scope || 'app.table').split('.').pop() || 'table';
  const results: Suggestion[] = [];

  // Empty — show templates
  if (!q) {
    results.push(
      { label: `SELECT * FROM ${table}`, detail: 'All records', kind: 'template' },
      { label: `SELECT * FROM ${table} WHERE `, detail: 'With filter', kind: 'template' },
    );
    if (fieldKeys.length > 0) {
      results.push({
        label: `SELECT ${fieldKeys.slice(0, 3).join(', ')} FROM ${table}`,
        detail: 'Select fields',
        kind: 'template',
      });
    }
    return results;
  }

  const upper = q.toUpperCase().trimEnd();

  // After SELECT — suggest * or field names
  if (/^SELECT\s*$/i.test(q.trimEnd())) {
    results.push({ label: `${q}* `, detail: 'All fields', kind: 'keyword', insertText: `${q}* ` });
    for (const key of fieldKeys.slice(0, 8)) {
      results.push({ label: key, detail: 'field', kind: 'field', insertText: `${q}${key}, ` });
    }
    return results;
  }

  // After "SELECT ... " without FROM — suggest FROM
  if (/^SELECT\s+.+$/i.test(q.trimEnd()) && !/\bFROM\b/i.test(q)) {
    results.push({ label: `${q} FROM ${table}`, detail: 'Add FROM clause', kind: 'keyword' });
    return results;
  }

  // After FROM — suggest table
  if (/\bFROM\s*$/i.test(q.trimEnd())) {
    results.push({ label: `${q}${table} `, detail: 'Table', kind: 'keyword', insertText: `${q}${table} ` });
    return results;
  }

  // After "FROM table" — suggest WHERE, ORDER BY, LIMIT
  if (/\bFROM\s+\S+\s*$/i.test(q.trimEnd()) && !/\bWHERE\b/i.test(q)) {
    results.push(
      { label: `${q} WHERE `, detail: 'Add filter', kind: 'keyword', insertText: `${q} WHERE ` },
      { label: `${q} ORDER BY `, detail: 'Add sort', kind: 'keyword', insertText: `${q} ORDER BY ` },
      { label: `${q} LIMIT `, detail: 'Limit results', kind: 'keyword', insertText: `${q} LIMIT ` },
    );
    return results;
  }

  // After WHERE or AND/OR — suggest field names
  if (/\b(?:WHERE|AND|OR)\s*$/i.test(q.trimEnd())) {
    for (const col of columns.slice(0, 10)) {
      results.push({
        label: col.label || col.key,
        detail: col.type,
        kind: 'field',
        insertText: `${q}${col.key} `,
      });
    }
    return results;
  }

  // After "field" — suggest operators
  const fieldEndMatch = q.match(/\b(?:WHERE|AND|OR)\s+(\w+)\s*$/i);
  if (fieldEndMatch) {
    const field = fieldEndMatch[1];
    const col = columns.find(c => c.key === field);
    const ops: [string, string][] = col?.type === 'number'
      ? [['= ', 'equals'], ['!= ', 'not equals'], ['> ', 'greater'], ['< ', 'less'], ['>= ', 'gte'], ['<= ', 'lte']]
      : [['= ', 'equals'], ['!= ', 'not equals'], ["LIKE ", 'pattern match'], ['IS NULL', 'is empty'], ['IS NOT NULL', 'is not empty']];
    for (const [op, desc] of ops) {
      results.push({ label: op.trim(), detail: desc, kind: 'operator', insertText: `${q} ${op}` });
    }
    return results;
  }

  // After "field op" — suggest values
  const valueMatch = q.match(/\b(?:WHERE|AND|OR)\s+(\w+)\s+(?:=|!=|<>|LIKE|NOT\s+LIKE)\s*$/i);
  if (valueMatch) {
    const field = valueMatch[1];
    const col = columns.find(c => c.key === field);
    if (col?.selectOptions) {
      for (const val of col.selectOptions.slice(0, 10)) {
        results.push({
          label: val,
          detail: `${field} value`,
          kind: 'value',
          insertText: `${q}'${val}' `,
        });
      }
    }
    // LIKE pattern suggestions
    if (/LIKE\s*$/i.test(q)) {
      results.push(
        { label: "'%...%'", detail: 'Contains', kind: 'template', insertText: `${q}'%` },
        { label: "'...%'", detail: 'Starts with', kind: 'template', insertText: `${q}'` },
      );
    }
    return results;
  }

  // After a complete condition — suggest AND/OR or ORDER BY
  const afterCondition = /(?:'[^']*'|\d+|NULL)\s*$/i.test(q.trimEnd());
  if (afterCondition && /\bWHERE\b/i.test(q)) {
    results.push(
      { label: 'AND', detail: 'Add AND condition', kind: 'keyword', insertText: `${q} AND ` },
      { label: 'OR', detail: 'Add OR condition', kind: 'keyword', insertText: `${q} OR ` },
      { label: 'ORDER BY', detail: 'Add sort', kind: 'keyword', insertText: `${q} ORDER BY ` },
      { label: 'LIMIT', detail: 'Limit results', kind: 'keyword', insertText: `${q} LIMIT ` },
    );
    return results;
  }

  // After ORDER BY — suggest fields
  if (/\bORDER\s+BY\s*$/i.test(q.trimEnd())) {
    for (const col of columns.slice(0, 8)) {
      results.push({
        label: col.label || col.key,
        detail: col.type,
        kind: 'field',
        insertText: `${q}${col.key} `,
      });
    }
    return results;
  }

  // After ORDER BY field — suggest ASC/DESC
  if (/\bORDER\s+BY\s+\w+\s*$/i.test(q.trimEnd())) {
    results.push(
      { label: 'ASC', detail: 'Ascending', kind: 'keyword', insertText: `${q} ASC` },
      { label: 'DESC', detail: 'Descending', kind: 'keyword', insertText: `${q} DESC` },
    );
    return results;
  }

  return results;
}

// ─── Styles ─────────────────────────────────────────────────────────

function makeStyles(t: Theme) {
  return {
    container: {
      borderTop: `1px solid ${t.borderLight}`,
      padding: '10px 16px',
    } as React.CSSProperties,
    langRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginBottom: 8,
    } as React.CSSProperties,
    label: {
      fontSize: 10,
      fontWeight: 600,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.04em',
      marginRight: 4,
    } as React.CSSProperties,
    langTab: {
      padding: '3px 10px',
      fontSize: 10,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
    } as React.CSSProperties,
    langTabActive: {
      background: t.accent,
      color: '#fff',
      borderColor: t.accent,
    } as React.CSSProperties,
    inputRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      position: 'relative' as const,
    } as React.CSSProperties,
    langBadge: {
      fontSize: 9,
      fontWeight: 700,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.accent,
      background: t.accentBg,
      padding: '2px 6px',
      borderRadius: 3,
      flexShrink: 0,
    } as React.CSSProperties,
    input: {
      flex: 1,
      padding: '7px 10px',
      fontSize: 12,
      fontFamily: "'JetBrains Mono', monospace",
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bg,
      color: t.text,
      outline: 'none',
      minWidth: 0,
    } as React.CSSProperties,
    applyBtn: {
      padding: '6px 14px',
      fontSize: 11,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.accent,
      color: '#fff',
      border: 'none',
      borderRadius: 4,
      cursor: 'pointer',
      flexShrink: 0,
    } as React.CSSProperties,
    error: {
      marginTop: 6,
      padding: '6px 10px',
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.dangerText,
      background: t.dangerBg,
      borderRadius: 4,
      border: `1px solid ${t.dangerBorder}`,
    } as React.CSSProperties,
    dropdown: {
      position: 'absolute' as const,
      left: 16,
      right: 16,
      marginTop: 2,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      maxHeight: 220,
      overflowY: 'auto' as const,
      boxShadow: `0 4px 16px ${t.shadow}`,
      zIndex: 200,
    } as React.CSSProperties,
    suggestion: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '7px 12px',
      cursor: 'pointer',
      fontSize: 12,
      fontFamily: "'JetBrains Mono', monospace",
      borderBottom: `1px solid ${t.borderLight}`,
      transition: 'background .08s',
    } as React.CSSProperties,
    suggestionActive: {
      background: t.bgHover,
    } as React.CSSProperties,
    kindBadge: (kind: Suggestion['kind'], theme: Theme): React.CSSProperties => {
      const colors: Record<string, { bg: string; fg: string }> = {
        keyword: { bg: 'rgba(59,130,246,0.12)', fg: '#3b82f6' },
        field: { bg: 'rgba(16,185,129,0.12)', fg: '#10b981' },
        operator: { bg: 'rgba(168,85,247,0.12)', fg: '#a855f7' },
        value: { bg: 'rgba(245,158,11,0.12)', fg: '#f59e0b' },
        template: { bg: theme.bgMuted, fg: theme.textMuted },
      };
      const c = colors[kind] || colors.template;
      return {
        fontSize: 8,
        fontWeight: 700,
        fontFamily: "'JetBrains Mono', monospace",
        textTransform: 'uppercase' as const,
        padding: '1px 5px',
        borderRadius: 3,
        background: c.bg,
        color: c.fg,
        flexShrink: 0,
      };
    },
    sugLabel: {
      fontSize: 11,
      color: t.textHeading,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
      flex: 1,
    } as React.CSSProperties,
    sugDetail: {
      fontSize: 10,
      color: t.textMuted,
      flexShrink: 0,
    } as React.CSSProperties,
    helpRow: {
      marginTop: 8,
    } as React.CSSProperties,
    helpText: {
      fontSize: 10,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
      lineHeight: 1.6,
    } as React.CSSProperties,
  };
}
