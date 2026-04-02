import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { EoEvent, EoState, GraphEdge } from '../db/types';
import {
  type QueryLanguage,
  detectLanguage,
  getTargetSuggestions,
  getQuerySuggestions,
  executeQuery,
} from './query-engine';

const NODE_COLORS = ['#4ade80', '#38bdf8', '#a78bfa', '#34d399', '#fb923c', '#f472b6'];
const MAX_DISPLAY_NODES = 200;
const LANG_ORDER: QueryLanguage[] = ['target', 'sql', 'eo'];
const LANG_LABELS: Record<string, string> = { target: 'Search', sql: 'SQL', eo: 'EO Path' };
const LANG_PLACEHOLDERS: Record<string, string> = {
  target: 'Search targets by name or path...',
  sql: 'SELECT * FROM tableName WHERE ...',
  eo: 'app.tableName[field=value]',
};

interface Edge { source: string; dest: string }
interface NodePos { x: number; y: number }

function extractEdgesFromEvents(events: EoEvent[]): Edge[] {
  const edgeList: Edge[] = [];
  events
    .filter((e) => e.op === 'CON')
    .forEach((e) => {
      const source = e.target.split('.').slice(0, 3).join('.');
      if (e.operand?.added) {
        (e.operand.added as string[]).forEach((dest) => {
          edgeList.push({ source, dest });
        });
      }
    });
  return edgeList;
}

export function GraphView({ allStates }: { allStates?: EoState[] }) {
  const { theme } = useTheme();
  const recentEvents = useEoStore((s) => s.recentEvents);
  const store = useEoStore((s) => s.store);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const s = styles(theme);

  // Data source state
  const [dataSource, setDataSource] = useState<'recent' | 'full'>('recent');
  const [fullGraphEdges, setFullGraphEdges] = useState<Edge[]>([]);
  const [fullGraphLoading, setFullGraphLoading] = useState(false);

  // Query bar state
  const [query, setQuery] = useState('');
  const [lang, setLang] = useState<QueryLanguage>('target');
  const [queryTargets, setQueryTargets] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Auto-detect language from query content
  useEffect(() => {
    if (query.length > 2) {
      const detected = detectLanguage(query);
      if (detected !== 'target' && detected !== lang) {
        setLang(detected);
      }
    }
  }, [query, lang]);

  // Load full graph edges from IndexedDB
  useEffect(() => {
    if (dataSource !== 'full' || !store) return;
    let cancelled = false;
    setFullGraphLoading(true);

    store.iterator('graph:fwd:').then((entries) => {
      if (cancelled) return;
      const edges: Edge[] = entries.map(([, value]) => {
        const ge = value as GraphEdge;
        return { source: ge.source, dest: ge.dest };
      });
      setFullGraphEdges(edges);
      setFullGraphLoading(false);
    });

    return () => { cancelled = true; };
  }, [dataSource, store]);

  // Get suggestions
  const suggestions = useMemo(() => {
    if (!focused || !query.trim()) return [];
    const states = allStates || [];
    if (lang === 'target') {
      return getTargetSuggestions(query, states).map((s) => ({
        label: s.target,
        detail: s.name,
      }));
    }
    return getQuerySuggestions(query, lang, states).map((s) => ({
      label: s,
      detail: undefined as string | undefined,
    }));
  }, [query, lang, allStates, focused]);

  // Reset selection when suggestions change
  useEffect(() => setSelectedIdx(0), [suggestions]);

  // Scroll selected suggestion into view
  useEffect(() => {
    if (dropdownRef.current) {
      const item = dropdownRef.current.children[selectedIdx] as HTMLElement;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIdx]);

  // Execute query
  const handleExecute = useCallback(() => {
    if (!query.trim()) {
      setQueryTargets(null);
      setError(null);
      return;
    }

    const states = allStates || [];

    if (lang === 'target') {
      const matches = getTargetSuggestions(query, states);
      if (matches.length === 0) {
        setError('No matching targets');
        return;
      }
      setError(null);
      setQueryTargets(new Set(matches.map((m) => m.target)));
      setFocused(false);
      return;
    }

    const result = executeQuery(query, lang, states);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.records.length === 0) {
      setError('No matching records');
      return;
    }
    setError(null);
    setQueryTargets(new Set(result.records.map((r) => r.target)));
    setFocused(false);
  }, [query, lang, allStates]);

  const handleClear = useCallback(() => {
    setQuery('');
    setQueryTargets(null);
    setError(null);
    inputRef.current?.focus();
  }, []);

  const handleSelectSuggestion = useCallback((value: string) => {
    if (lang === 'target') {
      setQuery(value);
      // Auto-execute for target search
      const states = allStates || [];
      const matches = getTargetSuggestions(value, states);
      if (matches.length > 0) {
        setQueryTargets(new Set(matches.map((m) => m.target)));
      }
      setFocused(false);
    } else {
      setQuery(value);
      setSelectedIdx(0);
    }
  }, [lang, allStates]);

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
        handleSelectSuggestion(suggestions[selectedIdx].label);
      } else {
        handleExecute();
      }
    } else if (e.key === 'Tab' && suggestions[selectedIdx]) {
      e.preventDefault();
      setQuery(suggestions[selectedIdx].label);
    } else if (e.key === 'Escape') {
      setFocused(false);
      inputRef.current?.blur();
    }
  }

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const toolbar = document.getElementById('graph-query-toolbar');
      if (toolbar && !toolbar.contains(e.target as Node)) {
        setFocused(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Compute all edges (unfiltered) from selected data source
  const allEdges = useMemo(() => {
    return dataSource === 'full'
      ? fullGraphEdges
      : extractEdgesFromEvents(recentEvents);
  }, [dataSource, recentEvents, fullGraphEdges]);

  // Compute all nodes from unfiltered edges
  const allNodesSet = useMemo(() => {
    const set = new Set<string>();
    allEdges.forEach((e) => { set.add(e.source); set.add(e.dest); });
    return set;
  }, [allEdges]);

  // Apply query filter
  const { nodes, edges } = useMemo(() => {
    const filtered = queryTargets
      ? allEdges.filter((e) => queryTargets.has(e.source) || queryTargets.has(e.dest))
      : allEdges;

    const nodesSet = new Set<string>();
    filtered.forEach((e) => { nodesSet.add(e.source); nodesSet.add(e.dest); });

    const nodeArr = Array.from(nodesSet);
    const capped = nodeArr.length > MAX_DISPLAY_NODES;
    return {
      nodes: capped ? nodeArr.slice(0, MAX_DISPLAY_NODES) : nodeArr,
      edges: capped
        ? filtered.filter((e) => {
            const cappedSet = new Set(nodeArr.slice(0, MAX_DISPLAY_NODES));
            return cappedSet.has(e.source) && cappedSet.has(e.dest);
          })
        : filtered,
    };
  }, [allEdges, queryTargets]);

  const toggleHighlight = useCallback((name: string) => {
    setHighlighted((h) => (h === name ? null : name));
  }, []);

  // Layout: circular
  const CX = 400, CY = 280, RADIUS = 180;
  const positions = useMemo(() => {
    const pos: Record<string, NodePos> = {};
    nodes.forEach((n, i) => {
      const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
      pos[n] = { x: CX + Math.cos(angle) * RADIUS, y: CY + Math.sin(angle) * RADIUS };
    });
    return pos;
  }, [nodes]);

  // Status line
  const isFiltered = queryTargets !== null;
  const totalNodes = allNodesSet.size;
  const totalEdges = allEdges.length;
  const statusText = isFiltered
    ? `${nodes.length} of ${totalNodes} nodes · ${edges.length} of ${totalEdges} edges (filtered)`
    : `${nodes.length} nodes · ${edges.length} edges`;
  const showCappedWarning = nodes.length >= MAX_DISPLAY_NODES && totalNodes > MAX_DISPLAY_NODES;

  const showDropdown = focused && suggestions.length > 0;

  return (
    <div style={s.container}>
      {/* Sidebar: node list */}
      <aside style={s.sidebar}>
        <div style={s.sidebarTitle}>Nodes ({nodes.length})</div>
        {nodes.map((n, i) => {
          const label = n.split('.').pop() || n;
          const isActive = highlighted === n;
          return (
            <button
              key={n}
              onClick={() => toggleHighlight(n)}
              style={{
                ...s.nodeItem,
                background: isActive ? theme.bgActive : 'transparent',
              }}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: NODE_COLORS[i % NODE_COLORS.length], flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{label}</span>
            </button>
          );
        })}
        <div style={{ ...s.sidebarTitle, marginTop: 16 }}>Edges ({edges.length})</div>
        {edges.slice(0, 20).map((e, i) => (
          <div key={i} style={s.edgeItem}>
            <span style={{ color: theme.accent }}>{e.source.split('.').pop()}</span>
            <span style={{ color: theme.textMuted }}>&rarr;</span>
            <span style={{ color: theme.accent }}>{e.dest.split('.').pop()}</span>
          </div>
        ))}
        {edges.length > 20 && <div style={{ ...s.edgeItem, color: theme.textMuted }}>...+{edges.length - 20} more</div>}
      </aside>

      {/* Right panel: toolbar + graph */}
      <div style={s.rightPanel}>
        {/* Toolbar */}
        <div style={s.toolbar} id="graph-query-toolbar">
          {/* Data source toggle */}
          <div style={s.toolbarRow}>
            <div style={s.sourceToggle}>
              <button
                onClick={() => setDataSource('recent')}
                style={dataSource === 'recent' ? s.sourceBtnActive : s.sourceBtn}
              >
                Recent
              </button>
              <button
                onClick={() => setDataSource('full')}
                style={dataSource === 'full' ? s.sourceBtnActive : s.sourceBtn}
              >
                Full Graph
              </button>
            </div>
          </div>

          {/* Query bar */}
          <div style={s.querySection}>
            {/* Language tabs */}
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

            {/* Input row */}
            <div style={s.inputWrap}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: 0.6 }}>
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
                <button onClick={handleClear} style={s.clearBtn}>&times;</button>
              )}
              {lang !== 'target' && (
                <button onClick={handleExecute} style={s.runBtn}>Run</button>
              )}
              {lang === 'target' && query && (
                <button onClick={handleExecute} style={s.runBtn}>Filter</button>
              )}
            </div>

            {/* Error */}
            {error && (
              <div style={s.errorRow}>{error}</div>
            )}

            {/* Suggestions dropdown */}
            {showDropdown && (
              <div style={s.dropdown} ref={dropdownRef}>
                {suggestions.map((item, i) => (
                  <div
                    key={i}
                    style={{
                      ...s.suggestion,
                      ...(i === selectedIdx ? s.suggestionActive : {}),
                    }}
                    onMouseEnter={() => setSelectedIdx(i)}
                    onMouseDown={(e) => { e.preventDefault(); handleSelectSuggestion(item.label); }}
                  >
                    <span style={s.suggestionLabel}>{item.label}</span>
                    {item.detail && <span style={s.suggestionDetail}>{item.detail}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Graph area */}
        <div style={s.graphArea}>
          {fullGraphLoading && dataSource === 'full' ? (
            <div style={s.empty}>
              <div style={{ fontSize: 12, color: theme.textMuted }}>Loading full graph...</div>
            </div>
          ) : nodes.length === 0 ? (
            <div style={s.empty}>
              <div style={{ fontSize: 14, color: theme.textSecondary, fontWeight: 300 }}>
                {isFiltered ? 'No edges match this query' : 'No graph data yet'}
              </div>
              <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>
                {isFiltered
                  ? 'Try a broader query or clear the filter to see all edges.'
                  : 'Use the Compose tab to create CON events, which link targets together as graph edges.'}
              </div>
            </div>
          ) : (
            <>
              <svg viewBox="0 0 800 560" style={{ width: '100%', height: '100%' }}>
                <defs>
                  <marker id="arrow" viewBox="0 0 10 10" refX="35" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#a78bfa" fillOpacity="0.6" />
                  </marker>
                </defs>

                {/* Edges */}
                {edges.map((e, i) => {
                  const sp = positions[e.source];
                  const dp = positions[e.dest];
                  if (!sp || !dp) return null;
                  const midX = (sp.x + dp.x) / 2;
                  const midY = (sp.y + dp.y) / 2 - 20;
                  const connected = !highlighted || e.source === highlighted || e.dest === highlighted;
                  return (
                    <path
                      key={i}
                      d={`M${sp.x},${sp.y} Q${midX},${midY} ${dp.x},${dp.y}`}
                      fill="none"
                      stroke="#a78bfa"
                      strokeWidth={connected && highlighted ? 2 : 1.5}
                      strokeOpacity={highlighted ? (connected ? 0.8 : 0.08) : 0.5}
                      markerEnd="url(#arrow)"
                    />
                  );
                })}

                {/* Nodes — sized by degree, colored by role */}
                {nodes.map((n, i) => {
                  const p = positions[n];
                  const c = NODE_COLORS[i % NODE_COLORS.length];
                  const label = n.split('.').pop() || n;
                  const isSelected = n === highlighted;
                  const opacity = highlighted ? (isSelected ? 1 : 0.2) : 1;

                  // Compute degree for sizing
                  const degree = edges.filter(e => e.source === n || e.dest === n).length;
                  const baseR = 28;
                  const r = isSelected ? baseR + 4 + degree : baseR + Math.min(degree * 2, 12);

                  // Detect role for coloring
                  const connCollections = new Set<string>();
                  edges.filter(e => e.source === n).forEach(e => {
                    const ep = e.dest.split('.');
                    if (ep.length >= 2) connCollections.add(ep.slice(0, 2).join('.'));
                  });
                  edges.filter(e => e.dest === n).forEach(e => {
                    const ep = e.source.split('.');
                    if (ep.length >= 2) connCollections.add(ep.slice(0, 2).join('.'));
                  });
                  const isBridge = connCollections.size >= 2;
                  const isHub = degree >= 6;
                  const roleColor = isHub ? '#a855f7' : isBridge ? '#eab308' : c;

                  return (
                    <g key={n} onClick={() => toggleHighlight(n)} style={{ cursor: 'pointer' }}>
                      <circle
                        cx={p.x} cy={p.y} r={r}
                        fill={`${roleColor}15`}
                        stroke={roleColor}
                        strokeWidth={isSelected ? 2.5 : isHub ? 2 : 1.5}
                        strokeOpacity={opacity}
                        fillOpacity={opacity}
                      />
                      {/* Role label for hubs and bridges */}
                      {(isHub || isBridge) && (
                        <text
                          x={p.x} y={p.y - r - 4}
                          textAnchor="middle"
                          fill={roleColor}
                          fontFamily="JetBrains Mono, monospace"
                          fontSize={7}
                          fontWeight="600"
                          fillOpacity={opacity * 0.7}
                        >
                          {isHub ? 'HUB' : 'BRIDGE'}
                        </text>
                      )}
                      <text
                        x={p.x} y={p.y + 1}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill={roleColor}
                        fontFamily="JetBrains Mono, monospace"
                        fontSize={isSelected ? 10 : 9}
                        fontWeight="600"
                        fillOpacity={opacity}
                      >
                        {label}
                      </text>
                      {/* Degree count */}
                      <text
                        x={p.x} y={p.y + 12}
                        textAnchor="middle"
                        fill={roleColor}
                        fontFamily="JetBrains Mono, monospace"
                        fontSize={7}
                        fillOpacity={opacity * 0.5}
                      >
                        {degree}
                      </text>
                    </g>
                  );
                })}

                {/* Status text at bottom of SVG */}
                <text
                  x={400} y={548}
                  textAnchor="middle"
                  fill={theme.textMuted}
                  fontFamily="JetBrains Mono, monospace"
                  fontSize={9}
                  fillOpacity={0.7}
                >
                  {statusText}
                  {showCappedWarning ? ` (capped at ${MAX_DISPLAY_NODES})` : ''}
                </text>
              </svg>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function styles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: { display: 'flex', flex: 1, overflow: 'hidden' },
    sidebar: {
      width: 220,
      borderRight: `1px solid ${t.border}`,
      background: t.bgCard,
      overflowY: 'auto',
      padding: '12px 0',
    },
    sidebarTitle: {
      padding: '4px 14px 8px',
      fontSize: 9,
      fontWeight: 700,
      fontFamily: "'JetBrains Mono', monospace",
      textTransform: 'uppercase' as const,
      letterSpacing: '0.08em',
      color: t.textMuted,
    },
    nodeItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      padding: '6px 14px',
      border: 'none',
      background: 'transparent',
      color: t.text,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      cursor: 'pointer',
      textAlign: 'left' as const,
    },
    edgeItem: {
      display: 'flex',
      gap: 6,
      padding: '3px 14px',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
    },
    rightPanel: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column' as const,
      overflow: 'hidden',
    },
    toolbar: {
      background: t.bgCard,
      borderBottom: `1px solid ${t.border}`,
      position: 'relative' as const,
      zIndex: 50,
    },
    toolbarRow: {
      display: 'flex',
      alignItems: 'center',
      padding: '8px 12px 0',
      gap: 12,
    },
    sourceToggle: {
      display: 'flex',
      gap: 0,
      borderRadius: 4,
      overflow: 'hidden',
      border: `1px solid ${t.border}`,
    },
    sourceBtn: {
      padding: '4px 12px',
      fontSize: 9,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: '0.04em',
      border: 'none',
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
      textTransform: 'uppercase' as const,
    },
    sourceBtnActive: {
      padding: '4px 12px',
      fontSize: 9,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: '0.04em',
      border: 'none',
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
      textTransform: 'uppercase' as const,
    },
    querySection: {
      position: 'relative' as const,
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
    errorRow: {
      padding: '6px 12px',
      fontSize: 11,
      color: t.dangerText,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.dangerBg,
      borderBottom: `1px solid ${t.dangerBorder}`,
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
      maxHeight: 260,
      overflowY: 'auto' as const,
      boxShadow: `0 8px 24px ${t.shadow}`,
      zIndex: 100,
    },
    suggestion: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 14px',
      cursor: 'pointer',
      fontSize: 11,
      borderBottom: `1px solid ${t.borderLight}`,
      transition: 'background .08s',
      fontFamily: "'JetBrains Mono', monospace",
    } as React.CSSProperties,
    suggestionActive: {
      background: t.bgHover,
    },
    suggestionLabel: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textHeading,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    suggestionDetail: {
      fontSize: 11,
      color: t.textMuted,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
      flexShrink: 1,
      marginLeft: 10,
    },
    graphArea: {
      flex: 1,
      background: t.bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
    },
    empty: {
      display: 'flex',
      flexDirection: 'column' as const,
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      flex: 1,
    },
  };
}
