import { useEffect, useState, useMemo } from 'react';
import { useEoStore } from '../store/eo-store';
import { groupSchemaStates, schemaFieldTarget, schemaResolveTarget, schemaConstraintTarget, type FieldSchema } from '../db/schema-rules';
import { ResolutionPolicyComposer, summarizePolicy, type ResolvePolicy } from './ResolutionPolicyComposer';
import { ConstraintComposer } from './ConstraintComposer';
import { readLogForPrefix } from '../db/log';
import { useTheme, type Theme } from '../theme';
import { formatName } from './scope-picker-utils';
import type { EoEvent, EoState } from '../db/types';

// ─── Operator colors (matches LogView) ──────────────────────────────────

const OP_COLORS: Record<string, { bg: string; text: string }> = {
  INS: { bg: '#DCFCE7', text: '#166534' },
  DEF: { bg: '#FFF7ED', text: '#9A3412' },
  CON: { bg: '#E0E7FF', text: '#3730A3' },
  SEG: { bg: '#DBEAFE', text: '#1E40AF' },
  SYN: { bg: '#F3E8FF', text: '#6B21A8' },
  EVA: { bg: '#F0FDFA', text: '#115E59' },
  NUL: { bg: '#F0F0F0', text: '#888' },
  REC: { bg: '#FDF2F8', text: '#9D174D' },
};

// ─── Sort helpers ────────────────────────────────────────────────────────

type SortKey = 'fieldKey' | 'name' | 'type' | 'constraints' | 'resolve';
type SortDir = 'asc' | 'desc';

function getSortValue(fs: FieldSchema, key: SortKey): string {
  switch (key) {
    case 'fieldKey': return fs.fieldKey;
    case 'name': return fs.name || '';
    case 'type': return fs.typeDef?.value?.type || fs.ingestedType || '';
    case 'constraints': return fs.constraints.map(c => c.name).join(', ');
    case 'resolve': return fs.resolve?.value?.strategy || '';
  }
}

// ─── Time formatting ─────────────────────────────────────────────────────

function formatTime(ts: string): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getAgentName(agent: string): string {
  if (agent === 'system' || agent === 'system:eva') return 'system';
  if (agent.startsWith('@')) return agent.slice(1).split(':')[0];
  return agent;
}

function summarizeOperand(op: string, operand: any): string {
  if (!operand) return '';
  if (op === 'INS') {
    const keys = Object.keys(operand).filter(k => !k.startsWith('_'));
    return keys.length === 0 ? 'created' : `created with ${keys.join(', ')}`;
  }
  if (op === 'DEF') {
    const keys = Object.keys(operand).filter(k => !k.startsWith('_'));
    return keys.length === 0 ? 'updated' : keys.map(k => `${k} updated`).join(', ');
  }
  if (op === 'EVA') return operand.strategy || 'evaluated';
  if (op === 'NUL') return 'cleared';
  return '';
}

// ─── SchemaFieldHistory ──────────────────────────────────────────────────

function SchemaFieldHistory({ scope, fieldKey }: { scope: string; fieldKey: string }) {
  const store = useEoStore((s) => s.store);
  const [events, setEvents] = useState<EoEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);
  const { theme } = useTheme();

  const prefix = schemaFieldTarget(scope, fieldKey);

  useEffect(() => {
    if (!store) return;
    setLoading(true);
    readLogForPrefix(store, prefix).then((evts) => {
      setEvents(evts.reverse()); // newest first
      setLoading(false);
    });
  }, [store, prefix]);

  if (loading) {
    return <div style={{ padding: '12px 0', fontSize: 12, color: theme.textMuted }}>Loading history...</div>;
  }

  if (events.length === 0) {
    return <div style={{ padding: '12px 0', fontSize: 12, color: theme.textMuted }}>No changes recorded</div>;
  }

  return (
    <div style={{ padding: '8px 0' }}>
      {events.map((event, i) => {
        const colors = OP_COLORS[event.op] || OP_COLORS.NUL;
        const isExpanded = expandedSeq === event.seq;
        // Show which sub-target was affected
        const relPath = event.target.slice(prefix.length);
        const subTarget = relPath.startsWith('.') ? relPath.slice(1) : (relPath || 'field');

        return (
          <div key={event.seq} style={{ display: 'flex', gap: 10, minHeight: 36 }}>
            {/* Timeline track */}
            <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center', width: 14, flexShrink: 0 }}>
              <div style={{
                width: 10, height: 10, borderRadius: '50%', flexShrink: 0, marginTop: 4,
                background: colors.bg, border: `2px solid ${colors.text}`,
              }} />
              {i < events.length - 1 && (
                <div style={{ width: 2, flex: 1, background: theme.border, marginTop: 3 }} />
              )}
            </div>

            {/* Content */}
            <div style={{ flex: 1, paddingBottom: 10, minWidth: 0 }}>
              <div
                style={{ cursor: 'pointer' }}
                onClick={() => setExpandedSeq(isExpanded ? null : event.seq)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const }}>
                  <span style={{
                    display: 'inline-block', padding: '1px 6px', borderRadius: 3,
                    fontSize: 10, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace",
                    background: colors.bg, color: colors.text,
                  }}>
                    {event.op}
                  </span>
                  <span style={{
                    fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
                    color: theme.accent, background: `${theme.accent}10`,
                    padding: '1px 5px', borderRadius: 3,
                  }}>
                    {subTarget}
                  </span>
                  <span style={{ fontSize: 12, color: theme.text }}>
                    {summarizeOperand(event.op, event.operand)}
                  </span>
                  <span style={{
                    fontSize: 10, color: theme.textMuted, marginLeft: 'auto', flexShrink: 0,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}>
                    {formatTime(event.ts)}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 3, fontFamily: "'JetBrains Mono', monospace" }}>
                  {getAgentName(event.agent)}
                </div>
              </div>

              {isExpanded && (
                <div style={{
                  marginTop: 6, padding: 8, background: theme.bgMuted,
                  borderRadius: 6, border: `1px solid ${theme.border}`,
                }}>
                  <pre style={{
                    fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
                    color: theme.textSecondary, margin: 0,
                    whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const,
                    lineHeight: 1.5, maxHeight: 200, overflowY: 'auto' as const,
                  }}>
                    {JSON.stringify(event.operand, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── SchemaView ──────────────────────────────────────────────────────────

interface SchemaViewProps {
  scope: string;
}

export function SchemaView({ scope }: SchemaViewProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const getState = useEoStore((s) => s.getState);
  const dispatch = useEoStore((s) => s.dispatch);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const [fieldSchemas, setFieldSchemas] = useState<Map<string, FieldSchema>>(new Map());
  const [loading, setLoading] = useState(true);
  const [expandedField, setExpandedField] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<{ fieldKey: string; value: string } | null>(null);
  const [resolutionComposer, setResolutionComposer] = useState<{ fieldKey: string; x: number; y: number } | null>(null);
  const [constraintComposer, setConstraintComposer] = useState<{ fieldKey: string; x: number; y: number } | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('fieldKey');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [recordCount, setRecordCount] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [collectionDisplayName, setCollectionDisplayName] = useState<string | null>(null);
  const [rollups, setRollups] = useState<Array<{ id: string; name: string; value: any; unit?: string }>>([]);

  // Resolve collection display name from state
  useEffect(() => {
    if (!ready) return;
    getState(scope).then((scopeState) => {
      if (scopeState?.value?.name) {
        setCollectionDisplayName(scopeState.value.name);
      }
    });
  }, [ready, lastSeq, scope, getState]);

  // Load schema fields
  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    const schemaPrefix = `${scope}._schema.`;
    getStateByPrefix(schemaPrefix).then((states) => {
      const grouped = groupSchemaStates(states, schemaPrefix);
      setFieldSchemas(grouped);
      setLoading(false);
    });
  }, [ready, lastSeq, scope, getStateByPrefix]);

  // Load record count and last updated
  useEffect(() => {
    if (!ready) return;
    getStateByPrefix(scope + '.').then((states: EoState[]) => {
      const scopeDepth = scope.split('.').length;
      // Count direct children, excluding internal (_-prefixed) targets
      let count = 0;
      let latestTs: string | null = null;
      const seen = new Set<string>();
      for (const st of states) {
        const parts = st.target.split('.');
        if (parts.length <= scopeDepth) continue;
        const childSeg = parts[scopeDepth];
        if (childSeg.startsWith('_')) continue;
        // Only count direct children (unique first segment after scope)
        const directChild = parts.slice(0, scopeDepth + 1).join('.');
        if (!seen.has(directChild)) {
          seen.add(directChild);
          count++;
        }
        if (!latestTs || st.last_ts > latestTs) latestTs = st.last_ts;
      }
      setRecordCount(count);
      setLastUpdated(latestTs);
    });
  }, [ready, lastSeq, scope, getStateByPrefix]);

  // Load rollup metrics
  useEffect(() => {
    if (!ready) return;
    const rollupPrefix = `${scope}._rollups.`;
    getStateByPrefix(rollupPrefix).then((states: EoState[]) => {
      const rollupDepth = rollupPrefix.split('.').length - 1; // depth of scope._rollups
      const metrics: Array<{ id: string; name: string; value: any; unit?: string }> = [];
      for (const st of states) {
        const parts = st.target.split('.');
        // Only top-level rollup entities (scope._rollups.metricId)
        if (parts.length !== rollupDepth + 1) continue;
        if (!st.value?.name) continue;
        metrics.push({
          id: parts[parts.length - 1],
          name: st.value.name,
          value: st.value.value ?? '\u2014',
          unit: st.value.unit,
        });
      }
      setRollups(metrics);
    });
  }, [ready, lastSeq, scope, getStateByPrefix]);

  const sortedFields = useMemo(() => {
    const arr = Array.from(fieldSchemas.values());
    arr.sort((a, b) => {
      const va = getSortValue(a, sortKey).toLowerCase();
      const vb = getSortValue(b, sortKey).toLowerCase();
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [fieldSchemas, sortKey, sortDir]);

  async function handleLabelSave(fieldKey: string, newLabel: string) {
    try {
      await dispatch({
        op: 'DEF',
        target: `${scope}._schema.${fieldKey}`,
        operand: { _label: newLabel || undefined },
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
    } catch { /* ignore */ }
    setEditingLabel(null);
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  function sortIndicator(key: SortKey): string {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' \u25B4' : ' \u25BE';
  }

  async function handleSetResolution(fieldKey: string, policy: ResolvePolicy) {
    try {
      await dispatch({
        op: 'EVA',
        target: schemaResolveTarget(scope, fieldKey),
        operand: policy,
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setFieldSchemas((prev) => {
        const next = new Map(prev);
        const existing = next.get(fieldKey) ?? { fieldKey, constraints: [] };
        next.set(fieldKey, {
          ...existing,
          resolve: { target: schemaResolveTarget(scope, fieldKey), value: policy },
        });
        return next;
      });
    } catch { /* ignore */ }
    setResolutionComposer(null);
  }

  async function handleClearResolution(fieldKey: string) {
    try {
      await dispatch({
        op: 'DEF',
        target: schemaResolveTarget(scope, fieldKey),
        operand: {},
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setFieldSchemas((prev) => {
        const next = new Map(prev);
        const existing = next.get(fieldKey);
        if (existing) {
          next.set(fieldKey, { ...existing, resolve: undefined });
        }
        return next;
      });
    } catch { /* ignore */ }
    setResolutionComposer(null);
  }

  async function handleAddConstraint(fieldKey: string, name: string, value: any) {
    try {
      await dispatch({
        op: 'DEF',
        target: schemaConstraintTarget(scope, fieldKey, name),
        operand: value,
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setFieldSchemas((prev) => {
        const next = new Map(prev);
        const existing = next.get(fieldKey) ?? { fieldKey, constraints: [] };
        const constraints = existing.constraints.filter(c => c.name !== name);
        constraints.push({ target: schemaConstraintTarget(scope, fieldKey, name), name, value });
        next.set(fieldKey, { ...existing, constraints });
        return next;
      });
    } catch { /* ignore */ }
  }

  async function handleRemoveConstraint(fieldKey: string, name: string) {
    try {
      await dispatch({
        op: 'DEF',
        target: schemaConstraintTarget(scope, fieldKey, name),
        operand: {},
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setFieldSchemas((prev) => {
        const next = new Map(prev);
        const existing = next.get(fieldKey);
        if (existing) {
          next.set(fieldKey, {
            ...existing,
            constraints: existing.constraints.filter(c => c.name !== name),
          });
        }
        return next;
      });
    } catch { /* ignore */ }
  }

  if (loading) {
    return <div style={s.empty}>Loading schema...</div>;
  }

  if (sortedFields.length === 0) {
    return (
      <div style={s.empty}>
        <div style={{ fontSize: 24, opacity: 0.3, marginBottom: 8 }}>{'\u2261'}</div>
        <div style={{ fontSize: 13, fontWeight: 500 }}>No schema defined</div>
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
          This collection has no schema defined yet
        </div>
      </div>
    );
  }

  const collectionSegment = scope.split('.').pop() || scope;
  const collectionName = collectionDisplayName || formatName(collectionSegment);

  return (
    <div style={s.container}>
      {/* Dashboard header */}
      <div style={s.dashboard}>
        <div style={s.dashboardTitle}>{collectionName}</div>
        <div style={s.dashboardSubtitle}>Collection</div>

        {/* Built-in stats */}
        <div style={s.statsRow}>
          <div style={s.statCard}>
            <div style={s.statValue}>{recordCount}</div>
            <div style={s.statLabel}>Records</div>
          </div>
          <div style={s.statCard}>
            <div style={s.statValue}>{sortedFields.length}</div>
            <div style={s.statLabel}>Fields</div>
          </div>
          <div style={s.statCard}>
            <div style={s.statValue}>{lastUpdated ? formatTime(lastUpdated) : '\u2014'}</div>
            <div style={s.statLabel}>Last updated</div>
          </div>
          {/* Rollup metric cards */}
          {rollups.map((r) => (
            <div key={r.id} style={s.statCard}>
              <div style={s.statValue}>{String(r.value)}</div>
              <div style={s.statLabel}>{r.name}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Schema field table */}
      <div style={s.header}>
        <span style={s.headerTitle}>Schema</span>
        <span style={s.headerCount}>{sortedFields.length} field{sortedFields.length !== 1 ? 's' : ''}</span>
      </div>

      <div style={s.tableWrapper}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th} onClick={() => handleSort('name')}>
                Display Name{sortIndicator('name')}
              </th>
              <th style={s.th} onClick={() => handleSort('fieldKey')}>
                Field Key{sortIndicator('fieldKey')}
              </th>
              <th style={s.th} onClick={() => handleSort('type')}>
                Type{sortIndicator('type')}
              </th>
              <th style={s.th} onClick={() => handleSort('constraints')}>
                Constraints{sortIndicator('constraints')}
              </th>
              <th style={s.th} onClick={() => handleSort('resolve')}>
                Resolution{sortIndicator('resolve')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedFields.map((fs) => {
              const isExpanded = expandedField === fs.fieldKey;
              const typeDisplay = fs.typeDef?.value?.type || fs.ingestedType || '\u2014';
              const formatDisplay = fs.typeDef?.value?.format ? ` (${fs.typeDef.value.format})` : '';
              const constraintDisplay = fs.constraints.length > 0
                ? fs.constraints.map(c => c.name).join(', ')
                : '\u2014';
              const resolvePolicy: ResolvePolicy | null = fs.resolve?.value?.stances
                ? fs.resolve.value as ResolvePolicy
                : fs.resolve?.value?.strategy
                  ? { stances: [{ stance: 'dissecting', subType: fs.resolve.value.strategy }] }
                  : null;
              const resolveDisplay = resolvePolicy ? summarizePolicy(resolvePolicy) : '\u2014';

              return (
                <tr key={fs.fieldKey} style={{ cursor: 'pointer' }}>
                  <td colSpan={5} style={{ padding: 0, border: 'none' }}>
                    {/* Field row */}
                    <div
                      style={{
                        ...s.row,
                        ...(isExpanded ? { background: theme.bgMuted } : {}),
                      }}
                      onClick={() => setExpandedField(isExpanded ? null : fs.fieldKey)}
                    >
                      <div style={s.cell}>
                        <span style={s.expandIcon}>{isExpanded ? '\u25BE' : '\u25B8'}</span>
                        {editingLabel?.fieldKey === fs.fieldKey ? (
                          <form
                            style={{ flex: 1 }}
                            onSubmit={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              const input = (e.target as HTMLFormElement).elements.namedItem('labelVal') as HTMLInputElement;
                              handleLabelSave(fs.fieldKey, input.value.trim());
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              name="labelVal"
                              autoFocus
                              defaultValue={editingLabel.value}
                              placeholder="Display name..."
                              style={{
                                width: '100%',
                                padding: '2px 6px',
                                fontSize: 12,
                                border: `1px solid ${theme.accent}`,
                                borderRadius: 3,
                                background: theme.bg,
                                color: theme.text,
                                outline: 'none',
                                boxSizing: 'border-box' as const,
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  e.stopPropagation();
                                  setEditingLabel(null);
                                }
                              }}
                              onBlur={(e) => handleLabelSave(fs.fieldKey, e.target.value.trim())}
                            />
                          </form>
                        ) : (
                          <span
                            style={s.cellText}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              setEditingLabel({ fieldKey: fs.fieldKey, value: fs.name || '' });
                            }}
                          >
                            {fs.name || formatName(fs.fieldKey)}
                          </span>
                        )}
                      </div>
                      <div style={s.cell}>
                        <span style={s.fieldKey}>{fs.fieldKey}</span>
                      </div>
                      <div style={s.cell}>
                        <span style={s.typeBadge}>{typeDisplay}{formatDisplay}</span>
                      </div>
                      <div style={s.cell}>
                        <span
                          style={{ ...s.cellText, cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' as const, textUnderlineOffset: '3px' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConstraintComposer({ fieldKey: fs.fieldKey, x: e.clientX, y: e.clientY });
                          }}
                        >
                          {constraintDisplay}
                        </span>
                      </div>
                      <div style={s.cell}>
                        <span
                          style={{ ...s.cellText, cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' as const, textUnderlineOffset: '3px' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setResolutionComposer({ fieldKey: fs.fieldKey, x: e.clientX, y: e.clientY });
                          }}
                        >
                          {resolveDisplay}
                        </span>
                      </div>
                    </div>

                    {/* Expanded audit trail */}
                    {isExpanded && (
                      <div style={s.auditPanel}>
                        <div style={s.auditHeader}>
                          Change History — <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{fs.fieldKey}</span>
                        </div>
                        <SchemaFieldHistory scope={scope} fieldKey={fs.fieldKey} />
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Constraint Composer popup */}
      {constraintComposer && (() => {
        const fs = fieldSchemas.get(constraintComposer.fieldKey);
        return (
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
              onClick={() => setConstraintComposer(null)}
            />
            <div style={{
              position: 'fixed',
              left: Math.min(constraintComposer.x, window.innerWidth - 800),
              top: Math.min(constraintComposer.y, window.innerHeight - 600),
              zIndex: 9999,
            }}>
              <ConstraintComposer
                fieldKey={constraintComposer.fieldKey}
                existingConstraints={fs?.constraints ?? []}
                onAdd={(name, value) => handleAddConstraint(constraintComposer.fieldKey, name, value)}
                onRemove={(name) => handleRemoveConstraint(constraintComposer.fieldKey, name)}
                onClose={() => setConstraintComposer(null)}
              />
            </div>
          </>
        );
      })()}

      {/* Resolution Policy Composer popup */}
      {resolutionComposer && (() => {
        const fs = fieldSchemas.get(resolutionComposer.fieldKey);
        const currentPolicy: ResolvePolicy | null = fs?.resolve?.value?.stances
          ? fs.resolve.value as ResolvePolicy
          : fs?.resolve?.value?.strategy
            ? { stances: [{ stance: 'dissecting', subType: fs.resolve.value.strategy }] }
            : null;
        return (
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
              onClick={() => setResolutionComposer(null)}
            />
            <div style={{
              position: 'fixed',
              left: Math.min(resolutionComposer.x, window.innerWidth - 800),
              top: Math.min(resolutionComposer.y, window.innerHeight - 600),
              zIndex: 9999,
            }}>
              <ResolutionPolicyComposer
                currentPolicy={currentPolicy}
                onApply={(policy) => handleSetResolution(resolutionComposer.fieldKey, policy)}
                onClear={() => handleClearResolution(resolutionComposer.fieldKey)}
                onClose={() => setResolutionComposer(null)}
              />
            </div>
          </>
        );
      })()}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    },
    empty: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      color: t.textMuted,
      gap: 4,
    },
    dashboard: {
      padding: '20px 20px 16px',
      borderBottom: `1px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
    },
    dashboardTitle: {
      fontSize: 18,
      fontWeight: 700,
      color: t.textHeading,
      marginBottom: 2,
    },
    dashboardSubtitle: {
      fontSize: 11,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
      fontWeight: 500,
      marginBottom: 14,
    },
    statsRow: {
      display: 'flex',
      gap: 10,
      flexWrap: 'wrap' as const,
    },
    statCard: {
      flex: '0 0 auto',
      minWidth: 100,
      padding: '10px 14px',
      background: t.bg,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
    },
    statValue: {
      fontSize: 16,
      fontWeight: 700,
      color: t.textHeading,
      fontFamily: "'JetBrains Mono', monospace",
      marginBottom: 2,
    },
    statLabel: {
      fontSize: 10,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.3,
      fontWeight: 500,
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '14px 20px',
      borderBottom: `1px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
    },
    headerTitle: {
      fontSize: 13,
      fontWeight: 600,
      color: t.textHeading,
    },
    headerCount: {
      fontSize: 11,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    tableWrapper: {
      flex: 1,
      overflowY: 'auto' as const,
    },
    table: {
      width: '100%',
      borderCollapse: 'collapse' as const,
    },
    th: {
      position: 'sticky' as const,
      top: 0,
      background: t.bgCard,
      textAlign: 'left' as const,
      padding: '8px 16px',
      fontSize: 10,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
      color: t.textMuted,
      borderBottom: `1px solid ${t.border}`,
      cursor: 'pointer',
      userSelect: 'none' as const,
      whiteSpace: 'nowrap' as const,
    },
    row: {
      display: 'grid',
      gridTemplateColumns: '1.2fr 1.2fr 1fr 1fr 0.8fr',
      borderBottom: `1px solid ${t.border}`,
      transition: 'background 0.1s',
    },
    cell: {
      padding: '10px 16px',
      fontSize: 12,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      minWidth: 0,
    },
    cellText: {
      color: t.text,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    fieldKey: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.accent,
      fontWeight: 500,
    },
    expandIcon: {
      fontSize: 10,
      color: t.textMuted,
      width: 10,
      flexShrink: 0,
    },
    typeBadge: {
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textSecondary,
      background: t.bgMuted,
      padding: '2px 8px',
      borderRadius: 4,
    },
    auditPanel: {
      padding: '4px 20px 16px 36px',
      borderBottom: `1px solid ${t.border}`,
      background: t.bg,
    },
    auditHeader: {
      fontSize: 11,
      fontWeight: 600,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
      paddingBottom: 4,
      borderBottom: `1px solid ${t.border}`,
      marginBottom: 4,
    },
  };
}
