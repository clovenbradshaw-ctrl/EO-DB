/**
 * HorizonQueryBar — autofill search + multi-language query input.
 *
 * Modes:
 *  - Target:  type to search targets by path or name (autofill suggestions)
 *  - SQL:     SELECT * FROM tblClients WHERE status = 'active'
 *  - GraphQL: { clients(where: { status: "active" }) { name status } }
 *  - EO:      app.tblClients[status=active]
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { EoState } from '../db/types';
import { useTheme, type Theme } from '../theme';
import {
  type QueryLanguage,
  detectLanguage,
  getTargetSuggestions,
  getQuerySuggestions,
  executeQuery,
  type QueryResult,
} from './query-engine';

interface HorizonQueryBarProps {
  allStates: EoState[];
  onSelectScope: (scope: string) => void;
  onSelectRecord: (target: string) => void;
  onQueryResults?: (results: QueryResult) => void;
}

const LANG_LABELS: Record<QueryLanguage, string> = {
  target: 'Search',
  sql: 'SQL',
  graphql: 'GraphQL',
  eo: 'EO Path',
};

const LANG_PLACEHOLDERS: Record<QueryLanguage, string> = {
  target: 'Search targets by name or path...',
  sql: 'SELECT * FROM tableName WHERE ...',
  graphql: '{ tableName { field1 field2 } }',
  eo: 'app.tableName[field=value]',
};

const LANG_ORDER: QueryLanguage[] = ['target', 'sql', 'graphql', 'eo'];

export function HorizonQueryBar({
  allStates,
  onSelectScope,
  onSelectRecord,
  onQueryResults,
}: HorizonQueryBarProps) {
  const [query, setQuery] = useState('');
  const [lang, setLang] = useState<QueryLanguage>('target');
  const [focused, setFocused] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  // Auto-detect language from query content
  useEffect(() => {
    if (query.length > 2) {
      const detected = detectLanguage(query);
      if (detected !== 'target' && detected !== lang) {
        setLang(detected);
      }
    }
  }, [query, lang]);

  // Get suggestions based on mode
  const suggestions = useMemo(() => {
    if (lang === 'target') {
      return getTargetSuggestions(query, allStates).map((s) => ({
        label: s.target,
        detail: s.name,
        badge: s.lastOp,
      }));
    }
    return getQuerySuggestions(query, lang, allStates).map((s) => ({
      label: s,
      detail: undefined as string | undefined,
      badge: undefined as string | undefined,
    }));
  }, [query, lang, allStates]);

  // Reset selection when suggestions change
  useEffect(() => setSelectedIdx(0), [suggestions]);

  // Scroll selected item into view
  useEffect(() => {
    if (dropdownRef.current) {
      const item = dropdownRef.current.children[selectedIdx] as HTMLElement;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIdx]);

  const handleSelect = useCallback(
    (value: string) => {
      if (lang === 'target') {
        // Navigate to the target
        const state = allStates.find((s) => s.target === value);
        if (state) {
          const parts = value.split('.');
          if (parts.length <= 2) {
            onSelectScope(value);
          } else {
            // Select the parent scope and then the record
            const scope = parts.slice(0, 2).join('.');
            onSelectScope(scope);
            onSelectRecord(value);
          }
        }
        setQuery('');
        setFocused(false);
        inputRef.current?.blur();
      } else {
        // Fill the suggestion into the input
        setQuery(value);
        setSelectedIdx(0);
      }
    },
    [lang, allStates, onSelectScope, onSelectRecord],
  );

  const handleExecute = useCallback(() => {
    if (!query.trim()) return;

    if (lang === 'target') {
      if (suggestions.length > 0) {
        handleSelect(suggestions[selectedIdx]?.label || suggestions[0].label);
      }
      return;
    }

    setError(null);
    const result = executeQuery(query, lang, allStates);
    if (result.error) {
      setError(result.error);
      return;
    }

    if (result.target) {
      const parts = result.target.split('.');
      if (parts.length <= 2) {
        onSelectScope(result.target);
      } else {
        onSelectScope(parts.slice(0, 2).join('.'));
        onSelectRecord(result.target);
      }
    } else if (result.scope) {
      onSelectScope(result.scope);
    }

    onQueryResults?.(result);
    setFocused(false);
  }, [query, lang, allStates, suggestions, selectedIdx, handleSelect, onSelectScope, onSelectRecord, onQueryResults]);

  function handleKeyDown(e: React.KeyboardEvent) {
    const len = suggestions.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => (i + 1) % Math.max(len, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => (i - 1 + Math.max(len, 1)) % Math.max(len, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (lang === 'target' && suggestions[selectedIdx]) {
        handleSelect(suggestions[selectedIdx].label);
      } else {
        handleExecute();
      }
    } else if (e.key === 'Tab' && suggestions[selectedIdx]) {
      e.preventDefault();
      // Tab-complete
      if (lang === 'target') {
        setQuery(suggestions[selectedIdx].label);
      } else {
        setQuery(suggestions[selectedIdx].label);
      }
    } else if (e.key === 'Escape') {
      setFocused(false);
      inputRef.current?.blur();
    }
  }

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const bar = inputRef.current?.parentElement?.parentElement;
      if (bar && !bar.contains(e.target as Node)) {
        setFocused(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const showDropdown = focused && (suggestions.length > 0 || error);

  return (
    <div style={s.container}>
      <div style={s.bar}>
        {/* Language selector */}
        <div style={s.langSelector}>
          {LANG_ORDER.map((l) => (
            <button
              key={l}
              onClick={() => { setLang(l); setError(null); inputRef.current?.focus(); }}
              style={{
                ...s.langBtn,
                ...(lang === l ? s.langBtnActive : {}),
              }}
            >
              {LANG_LABELS[l]}
            </button>
          ))}
        </div>

        {/* Input area */}
        <div style={s.inputWrap}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={s.searchIcon}>
            <circle cx="6.5" cy="6.5" r="5" stroke={theme.textMuted} strokeWidth="1.5" />
            <path d="M10.5 10.5L14.5 14.5" stroke={theme.textMuted} strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setError(null); }}
            onFocus={() => setFocused(true)}
            onKeyDown={handleKeyDown}
            placeholder={LANG_PLACEHOLDERS[lang]}
            style={s.input}
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button
              onClick={() => { setQuery(''); setError(null); inputRef.current?.focus(); }}
              style={s.clearBtn}
            >
              &times;
            </button>
          )}
          {lang !== 'target' && (
            <button onClick={handleExecute} style={s.runBtn}>
              Run
            </button>
          )}
        </div>
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div style={s.dropdown} ref={dropdownRef}>
          {error && (
            <div style={s.errorRow}>{error}</div>
          )}
          {suggestions.map((item, i) => (
            <div
              key={i}
              style={{
                ...s.suggestion,
                ...(i === selectedIdx ? s.suggestionActive : {}),
              }}
              onMouseEnter={() => setSelectedIdx(i)}
              onMouseDown={(e) => { e.preventDefault(); handleSelect(item.label); }}
            >
              <div style={s.suggestionMain}>
                <span style={s.suggestionLabel}>
                  {lang === 'target'
                    ? highlightMatch(item.label, query, theme)
                    : <span style={s.suggestionCode}>{item.label}</span>
                  }
                </span>
                {item.detail && (
                  <span style={s.suggestionDetail}>{item.detail}</span>
                )}
              </div>
              {item.badge && (
                <span style={{
                  ...s.badge,
                  ...(item.badge === 'CON'
                    ? { color: '#a855f7', background: 'rgba(168,85,247,0.12)' }
                    : item.badge === 'REC'
                      ? { color: '#ef4444', background: 'rgba(239,68,68,0.12)' }
                      : {}),
                }}>
                  {item.badge}
                </span>
              )}
            </div>
          ))}
          {!error && suggestions.length === 0 && query.length > 0 && (
            <div style={s.noResults}>No matches</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Highlight matching substring ──────────────────────────────────────

function highlightMatch(text: string, query: string, theme: Theme): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span style={{ color: theme.accent, fontWeight: 600 }}>
        {text.slice(idx, idx + query.length)}
      </span>
      {text.slice(idx + query.length)}
    </>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      position: 'relative' as const,
      zIndex: 50,
    },
    bar: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 0,
      background: t.bgCard,
      borderBottom: `1px solid ${t.border}`,
    },
    langSelector: {
      display: 'flex',
      gap: 0,
      padding: '6px 12px 0',
    },
    langBtn: {
      padding: '4px 10px',
      fontSize: 9,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: '0.04em',
      border: 'none',
      borderBottom: '1.5px solid transparent',
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
      textTransform: 'uppercase' as const,
      transition: 'color .15s, border-color .15s',
    },
    langBtnActive: {
      color: t.accent,
      borderBottomColor: t.accent,
    },
    inputWrap: {
      display: 'flex',
      alignItems: 'center',
      padding: '6px 12px 8px',
      gap: 6,
    },
    searchIcon: {
      flexShrink: 0,
      opacity: 0.6,
    },
    input: {
      flex: 1,
      border: 'none',
      outline: 'none',
      background: 'transparent',
      fontSize: 12,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.text,
      padding: '4px 0',
      minWidth: 0,
    },
    clearBtn: {
      background: 'none',
      border: 'none',
      color: t.textMuted,
      cursor: 'pointer',
      fontSize: 16,
      padding: '0 4px',
      lineHeight: 1,
      flexShrink: 0,
    },
    runBtn: {
      padding: '3px 10px',
      fontSize: 10,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.accent,
      color: '#fff',
      border: 'none',
      borderRadius: 3,
      cursor: 'pointer',
      flexShrink: 0,
    },
    dropdown: {
      position: 'absolute' as const,
      top: '100%',
      left: 0,
      right: 0,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderTop: 'none',
      borderRadius: '0 0 6px 6px',
      maxHeight: 320,
      overflowY: 'auto' as const,
      boxShadow: `0 8px 24px ${t.shadow}`,
    },
    suggestion: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 14px',
      cursor: 'pointer',
      fontSize: 12,
      borderBottom: `1px solid ${t.borderLight}`,
      transition: 'background .08s',
    } as React.CSSProperties,
    suggestionActive: {
      background: t.bgHover,
    },
    suggestionMain: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flex: 1,
      minWidth: 0,
      overflow: 'hidden',
    },
    suggestionLabel: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textHeading,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    suggestionCode: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textHeading,
    },
    suggestionDetail: {
      fontSize: 11,
      color: t.textMuted,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
      flexShrink: 1,
    },
    badge: {
      fontSize: 8,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      padding: '1px 5px',
      borderRadius: 8,
      color: t.textMuted,
      background: t.bgMuted,
      flexShrink: 0,
      marginLeft: 8,
    },
    errorRow: {
      padding: '10px 14px',
      fontSize: 11,
      color: t.dangerText,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.dangerBg,
      borderBottom: `1px solid ${t.dangerBorder}`,
    },
    noResults: {
      padding: '12px 14px',
      fontSize: 11,
      color: t.textMuted,
      textAlign: 'center' as const,
    },
  };
}
