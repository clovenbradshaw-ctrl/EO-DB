/**
 * ScopePicker — Universal holonic item picker with 5 selection modes.
 *
 * Modes:
 *   1. Hierarchy — browse the tree, pick a node
 *   2. Depth — select all items at a given depth level
 *   3. Type — select all items matching a _type value
 *   4. Connected — pick a source item, then browse its relationships via @.field
 *   5. Query — power-user text box for EOQL / SQL
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { EoState } from '../db/types';
import type { DataBinding, SelectionMode } from '../blocks/types';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import {
  buildTree,
  formatName,
  resolveByHierarchy,
  resolveByDepth,
  resolveByType,
  collectTypes,
  getMaxDepth,
  collectRelationshipFields,
  type TreeNode,
} from './scope-picker-utils';
import {
  getTargetSuggestions,
  getFieldSuggestions,
  resolveFieldChain,
  resolveBinding,
  detectLanguage,
  executeQuery,
} from './query-engine';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ScopePickerProps {
  /** Current binding value */
  value?: DataBinding;
  /** Called when the user applies a new binding */
  onChange: (binding: DataBinding) => void;
  /** Optional @ context from parent section */
  context?: EoState | null;
  /** Label for the field */
  label?: string;
}

// ---------------------------------------------------------------------------
// Mode tabs
// ---------------------------------------------------------------------------

const MODES: { key: SelectionMode; label: string }[] = [
  { key: 'hierarchy', label: 'Hierarchy' },
  { key: 'depth', label: 'Depth' },
  { key: 'type', label: 'Type' },
  { key: 'connection', label: 'Connected' },
  { key: 'query', label: 'Query' },
];

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function ScopePicker({ value, onChange, context, label }: ScopePickerProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SelectionMode>(value?.mode || 'hierarchy');
  const [draft, setDraft] = useState<DataBinding>(value || { mode: 'hierarchy' });
  const [allStates, setAllStates] = useState<EoState[]>([]);

  const getStateByPrefix = useEoStore(s => s.getStateByPrefix);
  const ready = useEoStore(s => s.ready);
  const lastSeq = useEoStore(s => s.lastSeq);
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Load all states
  useEffect(() => {
    if (!ready) return;
    getStateByPrefix('').then(setAllStates);
  }, [ready, lastSeq, getStateByPrefix]);

  // Sync mode with draft
  useEffect(() => {
    setDraft(prev => ({ ...prev, mode }));
  }, [mode]);

  // Preview count
  const preview = useMemo(() => {
    if (allStates.length === 0) return { count: 0, samples: [] as string[] };
    const result = resolveBinding(draft, allStates, context);
    const records = result.records;
    const samples = records.slice(0, 3).map(r =>
      r.value?.name || formatName(r.target.split('.').pop() || '')
    );
    return { count: records.length, samples, error: result.error };
  }, [draft, allStates, context]);

  // Display label for current binding
  const displayLabel = useMemo(() => {
    if (!value) return 'Select data source...';
    switch (value.mode) {
      case 'hierarchy':
        return value.target ? `${formatName(value.target.split('.').pop() || '')} (${value.depth === 'all' ? 'all' : 'children'})` : 'Select...';
      case 'depth':
        return value.level ? `Level ${value.level}` : 'Select...';
      case 'type':
        return value.typeFilter ? `Type: ${value.typeFilter}` : 'Select...';
      case 'connection':
        return value.fieldChain || 'Select...';
      case 'query':
        return value.query ? value.query.slice(0, 40) + (value.query.length > 40 ? '...' : '') : 'Enter query...';
      default:
        return 'Select...';
    }
  }, [value]);

  function handleApply() {
    onChange(draft);
    setOpen(false);
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div style={s.wrapper}>
      {label && <div style={s.label}>{label}</div>}

      {/* Trigger button */}
      <button
        type="button"
        style={s.trigger}
        onClick={() => setOpen(!open)}
      >
        <span style={s.triggerText}>{displayLabel}</span>
        {preview.count > 0 && <span style={s.badge}>{preview.count}</span>}
        <span style={s.chevron}>{open ? '\u25B4' : '\u25BE'}</span>
      </button>

      {/* Popover */}
      {open && (
        <div ref={popoverRef} style={s.popover}>
          {/* Mode tabs */}
          <div style={s.tabs}>
            {MODES.map(m => (
              <button
                key={m.key}
                type="button"
                style={{
                  ...s.tab,
                  ...(mode === m.key ? s.tabActive : {}),
                }}
                onClick={() => {
                  setMode(m.key);
                  setDraft({ mode: m.key });
                }}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Mode content */}
          <div style={s.content}>
            {mode === 'hierarchy' && (
              <HierarchyMode
                states={allStates}
                draft={draft}
                onChange={setDraft}
                theme={theme}
              />
            )}
            {mode === 'depth' && (
              <DepthMode
                states={allStates}
                draft={draft}
                onChange={setDraft}
                theme={theme}
              />
            )}
            {mode === 'type' && (
              <TypeMode
                states={allStates}
                draft={draft}
                onChange={setDraft}
                theme={theme}
              />
            )}
            {mode === 'connection' && (
              <ConnectionMode
                states={allStates}
                draft={draft}
                onChange={setDraft}
                context={context}
                theme={theme}
              />
            )}
            {mode === 'query' && (
              <QueryMode
                states={allStates}
                draft={draft}
                onChange={setDraft}
                theme={theme}
              />
            )}
          </div>

          {/* Preview + Apply */}
          <div style={s.footer}>
            <div style={s.previewText}>
              {preview.error
                ? <span style={{ color: theme.danger }}>{preview.error}</span>
                : <>
                    <strong>{preview.count}</strong> items
                    {preview.samples.length > 0 && (
                      <span style={{ color: theme.textMuted }}>
                        {' '}— {preview.samples.join(', ')}
                        {preview.count > 3 && '...'}
                      </span>
                    )}
                  </>
              }
            </div>
            <button type="button" style={s.applyBtn} onClick={handleApply}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hierarchy Mode
// ---------------------------------------------------------------------------

function HierarchyMode({ states, draft, onChange, theme }: {
  states: EoState[];
  draft: DataBinding;
  onChange: (d: DataBinding) => void;
  theme: Theme;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(states, ''), [states]);
  const s = makeModeStyles(theme);

  // Auto-expand roots
  useEffect(() => {
    if (tree.length > 0 && expanded.size === 0) {
      setExpanded(new Set(tree.map(n => n.fullPath)));
    }
  }, [tree, expanded.size]);

  function toggleExpand(path: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderNode(node: TreeNode, depth: number) {
    const isActive = draft.target === node.fullPath;
    const isExpanded = expanded.has(node.fullPath);
    const hasChildren = node.children.length > 0;

    return (
      <div key={node.fullPath}>
        <div
          style={{
            ...s.treeItem,
            paddingLeft: 8 + depth * 16,
            ...(isActive ? s.treeItemActive : {}),
          }}
          onClick={() => onChange({ ...draft, mode: 'hierarchy', target: node.fullPath })}
        >
          <span
            style={s.chevron}
            onClick={(e) => {
              e.stopPropagation();
              if (hasChildren) toggleExpand(node.fullPath);
            }}
          >
            {hasChildren ? (isExpanded ? '\u25BE' : '\u25B8') : '\u00A0\u00A0'}
          </span>
          <span style={s.nodeName}>
            {node.state?.value?.name || formatName(node.segment)}
          </span>
          {node.state?.value?._type && (
            <span style={s.typeBadge}>{node.state.value._type}</span>
          )}
          {node.childCount > 0 && (
            <span style={s.count}>{node.childCount}</span>
          )}
        </div>
        {isExpanded && node.children.map(child => renderNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <div>
      {/* Depth toggle */}
      <div style={s.optionRow}>
        <label style={s.checkLabel}>
          <input
            type="checkbox"
            checked={draft.depth === 'all'}
            onChange={e => onChange({ ...draft, depth: e.target.checked ? 'all' : 'children' })}
          />
          Include all descendants
        </label>
      </div>

      {/* Tree */}
      <div style={s.scrollArea}>
        {tree.map(node => renderNode(node, 0))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Depth Mode
// ---------------------------------------------------------------------------

function DepthMode({ states, draft, onChange, theme }: {
  states: EoState[];
  draft: DataBinding;
  onChange: (d: DataBinding) => void;
  theme: Theme;
}) {
  const maxDepth = useMemo(() => getMaxDepth(states), [states]);
  const s = makeModeStyles(theme);

  const depthCounts = useMemo(() => {
    const counts: Record<number, number> = {};
    for (let d = 1; d <= maxDepth; d++) {
      counts[d] = resolveByDepth(states, d).length;
    }
    return counts;
  }, [states, maxDepth]);

  return (
    <div>
      <div style={s.optionRow}>
        <span style={{ fontSize: 12, color: theme.textSecondary }}>
          Select a depth level (1 = root, {maxDepth} = deepest)
        </span>
      </div>
      <div style={s.scrollArea}>
        {Array.from({ length: maxDepth }, (_, i) => i + 1).map(level => (
          <div
            key={level}
            style={{
              ...s.treeItem,
              ...(draft.level === level ? s.treeItemActive : {}),
            }}
            onClick={() => onChange({ ...draft, mode: 'depth', level })}
          >
            <span style={s.nodeName}>Level {level}</span>
            <span style={s.count}>{depthCounts[level] || 0} items</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Type Mode
// ---------------------------------------------------------------------------

function TypeMode({ states, draft, onChange, theme }: {
  states: EoState[];
  draft: DataBinding;
  onChange: (d: DataBinding) => void;
  theme: Theme;
}) {
  const types = useMemo(() => collectTypes(states), [states]);
  const s = makeModeStyles(theme);

  if (types.length === 0) {
    return <div style={{ padding: 16, fontSize: 12, color: theme.textMuted }}>No typed items found</div>;
  }

  return (
    <div style={s.scrollArea}>
      {types.map(({ type, count }) => (
        <div
          key={type}
          style={{
            ...s.treeItem,
            ...(draft.typeFilter === type ? s.treeItemActive : {}),
          }}
          onClick={() => onChange({ ...draft, mode: 'type', typeFilter: type })}
        >
          <span style={s.typeBadge}>{type}</span>
          <span style={{ flex: 1 }} />
          <span style={s.count}>{count}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection Mode
// ---------------------------------------------------------------------------

function ConnectionMode({ states, draft, onChange, context, theme }: {
  states: EoState[];
  draft: DataBinding;
  onChange: (d: DataBinding) => void;
  context?: EoState | null;
  theme: Theme;
}) {
  const [sourceTarget, setSourceTarget] = useState<string>(draft.fieldChain?.replace(/^@\./, '').split('.')[0] || '');
  const [searchInput, setSearchInput] = useState('');
  const s = makeModeStyles(theme);

  // Find the context or selected source item
  const sourceItem = useMemo(() => {
    if (context) return context;
    // Try to find from existing fieldChain
    return null;
  }, [context]);

  // Suggestions for source target
  const suggestions = useMemo(() => {
    if (!searchInput) return [];
    return getTargetSuggestions(searchInput, states, 10);
  }, [searchInput, states]);

  // Discover relationship fields from the source item
  const relationships = useMemo(() => {
    if (!sourceItem) return [];

    const fields: { name: string; count: number }[] = [];

    // From linked record fields
    const relFields = collectRelationshipFields(sourceItem);
    for (const f of relFields) {
      const val = sourceItem.value[f];
      const count = Array.isArray(val) ? val.length : 1;
      fields.push({ name: f, count });
    }

    // From CON edge_types on this item
    if (sourceItem.value?.edge_type && sourceItem.value?.linked) {
      const et = sourceItem.value.edge_type;
      if (!fields.some(f => f.name === et)) {
        fields.push({ name: et, count: sourceItem.value.linked.length });
      }
    }

    // From CON states that reference this target
    for (const s of states) {
      if (s.last_op === 'CON' && s.target === sourceItem.target && s.value?.edge_type) {
        const et = s.value.edge_type;
        if (!fields.some(f => f.name === et)) {
          fields.push({ name: et, count: Array.isArray(s.value.linked) ? s.value.linked.length : 0 });
        }
      }
    }

    return fields;
  }, [sourceItem, states]);

  return (
    <div>
      {!sourceItem && (
        <div style={s.optionRow}>
          <span style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 4, display: 'block' }}>
            Select a source item (or set @ context via a parent section)
          </span>
          <input
            type="text"
            placeholder="Search for an item..."
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            style={s.textInput}
          />
          {suggestions.length > 0 && (
            <div style={s.scrollArea}>
              {suggestions.map(sug => (
                <div
                  key={sug.target}
                  style={s.treeItem}
                  onClick={() => {
                    setSearchInput(sug.target);
                    // Can't set context from here, but we note it
                  }}
                >
                  <span style={s.nodeName}>{sug.name || formatName(sug.target.split('.').pop() || '')}</span>
                  <span style={{ fontSize: 10, color: theme.textMuted, marginLeft: 4 }}>{sug.target}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {sourceItem && (
        <>
          <div style={s.optionRow}>
            <span style={{ fontSize: 11, color: theme.textMuted }}>
              Source: <strong>{sourceItem.value?.name || formatName(sourceItem.target.split('.').pop() || '')}</strong>
            </span>
          </div>

          {relationships.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, color: theme.textMuted }}>
              No relationships found on this item
            </div>
          ) : (
            <div style={s.scrollArea}>
              {relationships.map(rel => (
                <div
                  key={rel.name}
                  style={{
                    ...s.treeItem,
                    ...(draft.fieldChain === `@.${rel.name}` ? s.treeItemActive : {}),
                  }}
                  onClick={() => onChange({ ...draft, mode: 'connection', fieldChain: `@.${rel.name}` })}
                >
                  <span style={s.nodeName}>@.{rel.name}</span>
                  <span style={s.count}>{rel.count}</span>
                </div>
              ))}
            </div>
          )}

          {/* Manual field chain input */}
          <div style={s.optionRow}>
            <input
              type="text"
              placeholder="@.field.chain"
              value={draft.fieldChain || ''}
              onChange={e => onChange({ ...draft, mode: 'connection', fieldChain: e.target.value })}
              style={s.textInput}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Query Mode
// ---------------------------------------------------------------------------

function QueryMode({ states, draft, onChange, theme }: {
  states: EoState[];
  draft: DataBinding;
  onChange: (d: DataBinding) => void;
  theme: Theme;
}) {
  const [queryText, setQueryText] = useState(draft.query || '');
  const [lang, setLang] = useState<'eo' | 'sql'>(draft.queryLang || 'eo');
  const s = makeModeStyles(theme);

  // Auto-suggestions
  const suggestions = useMemo(() => {
    if (!queryText) return [];
    return getTargetSuggestions(queryText, states, 8);
  }, [queryText, states]);

  // Live preview
  const preview = useMemo(() => {
    if (!queryText.trim()) return null;
    const detected = detectLanguage(queryText);
    const actualLang = detected === 'target' ? lang : detected;
    const result = executeQuery(queryText, actualLang, states);
    return result;
  }, [queryText, states, lang]);

  function handleQueryChange(text: string) {
    setQueryText(text);
    onChange({ ...draft, mode: 'query', query: text, queryLang: lang });
  }

  return (
    <div>
      {/* Language toggle */}
      <div style={{ ...s.optionRow, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          style={{ ...s.miniTab, ...(lang === 'eo' ? s.miniTabActive : {}) }}
          onClick={() => { setLang('eo'); onChange({ ...draft, queryLang: 'eo' }); }}
        >
          EOQL
        </button>
        <button
          type="button"
          style={{ ...s.miniTab, ...(lang === 'sql' ? s.miniTabActive : {}) }}
          onClick={() => { setLang('sql'); onChange({ ...draft, queryLang: 'sql' }); }}
        >
          SQL
        </button>
      </div>

      {/* Query input */}
      <div style={s.optionRow}>
        <textarea
          placeholder={lang === 'eo'
            ? 'app.tblClients[status=active]'
            : "SELECT * FROM clients WHERE status = 'active'"
          }
          value={queryText}
          onChange={e => handleQueryChange(e.target.value)}
          style={{ ...s.textInput, minHeight: 60, resize: 'vertical' as any, fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}
          rows={3}
        />
      </div>

      {/* Suggestions */}
      {suggestions.length > 0 && !queryText.includes(' ') && (
        <div style={{ ...s.scrollArea, maxHeight: 100 }}>
          {suggestions.map(sug => (
            <div
              key={sug.target}
              style={{ ...s.treeItem, fontSize: 11 }}
              onClick={() => handleQueryChange(sug.target)}
            >
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{sug.target}</span>
              {sug.name && <span style={{ color: theme.textMuted, marginLeft: 4, fontSize: 10 }}>{sug.name}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Preview */}
      {preview && (
        <div style={{ padding: '4px 12px', fontSize: 11 }}>
          {preview.error
            ? <span style={{ color: theme.danger }}>{preview.error}</span>
            : <span style={{ color: theme.textSecondary }}>{preview.records.length} results</span>
          }
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    wrapper: { position: 'relative' as const },
    label: {
      fontSize: 11,
      fontWeight: 500,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.5px',
      marginBottom: 4,
    },
    trigger: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      width: '100%',
      padding: '6px 10px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: t.bg,
      color: t.text,
      cursor: 'pointer',
      textAlign: 'left' as const,
    },
    triggerText: {
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    badge: {
      fontSize: 10,
      fontWeight: 600,
      color: t.accent,
      background: t.accentBg,
      padding: '1px 6px',
      borderRadius: 10,
      flexShrink: 0,
    },
    chevron: {
      fontSize: 10,
      color: t.textMuted,
      flexShrink: 0,
    },
    popover: {
      position: 'absolute' as const,
      top: '100%',
      left: 0,
      right: 0,
      zIndex: 100,
      marginTop: 4,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      boxShadow: `0 8px 30px ${t.shadow}`,
      minWidth: 320,
      maxHeight: 480,
      display: 'flex',
      flexDirection: 'column' as const,
    },
    tabs: {
      display: 'flex',
      borderBottom: `1px solid ${t.border}`,
      padding: '0 4px',
    },
    tab: {
      flex: 1,
      padding: '8px 4px',
      fontSize: 11,
      fontWeight: 500,
      border: 'none',
      borderBottom: '2px solid transparent',
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
      textAlign: 'center' as const,
    },
    tabActive: {
      color: t.accent,
      borderBottomColor: t.accent,
    },
    content: {
      flex: 1,
      overflow: 'hidden',
      minHeight: 120,
    },
    footer: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 12px',
      borderTop: `1px solid ${t.border}`,
    },
    previewText: {
      flex: 1,
      fontSize: 11,
      color: t.textSecondary,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    applyBtn: {
      padding: '4px 14px',
      fontSize: 11,
      fontWeight: 500,
      border: 'none',
      borderRadius: 4,
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
      flexShrink: 0,
    },
  };
}

function makeModeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    scrollArea: {
      maxHeight: 240,
      overflowY: 'auto' as const,
      padding: '4px 0',
    },
    treeItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '5px 12px',
      cursor: 'pointer',
      fontSize: 12,
    },
    treeItemActive: {
      background: t.accentBg,
      color: t.accent,
      fontWeight: 500,
    },
    chevron: {
      fontSize: 10,
      color: t.textMuted,
      width: 14,
      flexShrink: 0,
      cursor: 'pointer',
      userSelect: 'none' as const,
    },
    nodeName: {
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    count: {
      fontSize: 10,
      color: t.textMuted,
      flexShrink: 0,
    },
    typeBadge: {
      fontSize: 9,
      fontWeight: 500,
      color: t.purple,
      background: `${t.purple}18`,
      padding: '1px 6px',
      borderRadius: 4,
      flexShrink: 0,
    },
    optionRow: {
      padding: '6px 12px',
    },
    checkLabel: {
      fontSize: 12,
      color: t.textSecondary,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      cursor: 'pointer',
    },
    textInput: {
      width: '100%',
      padding: '6px 8px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bg,
      color: t.text,
      outline: 'none',
      boxSizing: 'border-box' as const,
    },
    miniTab: {
      padding: '2px 8px',
      fontSize: 10,
      fontWeight: 500,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
    },
    miniTabActive: {
      background: t.accentBg,
      color: t.accent,
      borderColor: t.accent,
    },
  };
}
