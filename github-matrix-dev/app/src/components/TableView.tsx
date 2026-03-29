import { useEffect, useState, useMemo } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import { deriveColumns, applyFilters, type FilterRule, type FilterDefinition, type ColumnDef } from './filter-types';
import { FilterBar } from './FilterBar';
import { useTheme, type Theme } from '../theme';

interface TableViewProps {
  scope: string;
  onSelectRecord: (target: string) => void;
  activeRecord?: string | null;
  session: { userId: string };
}

function formatScopeName(scope: string): string {
  const last = scope.split('.').pop() || scope;
  let name = last.replace(/^(tbl|rec|fld)/, '');
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  return name || last;
}

function renderCell(value: any, key: string, onNavigate: (t: string) => void, t: Theme): React.ReactNode {
  if (value == null || value === '') {
    return <span style={{ color: t.textMuted }}>--</span>;
  }

  // Status pill
  if (key === 'status' && typeof value === 'string') {
    const statusMap: Record<string, { bg: string; color: string; border: string }> = {
      active: t.statusActive,
      archived: t.statusArchived,
      pending: t.statusPending,
    };
    const sc = statusMap[value];
    if (sc) {
      return (
        <span style={{
          padding: '2px 10px',
          borderRadius: 12,
          fontSize: 11,
          fontWeight: 500,
          background: sc.bg,
          color: sc.color,
          border: `1px solid ${sc.border}`,
        }}>
          {value}
        </span>
      );
    }
  }

  // Linked objects (CON)
  if (typeof value === 'object' && value !== null && value.linked && Array.isArray(value.linked)) {
    return (
      <span>
        {value.linked.map((target: string, i: number) => (
          <span key={target}>
            {i > 0 && ', '}
            <span
              style={{ color: t.purple, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: t.purpleBorder }}
              onClick={(e) => { e.stopPropagation(); onNavigate(target); }}
            >
              {target}
            </span>
          </span>
        ))}
      </span>
    );
  }

  // Other objects
  if (typeof value === 'object' && value !== null) {
    const json = JSON.stringify(value);
    const display = json.length > 50 ? json.slice(0, 47) + '...' : json;
    return <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.textSecondary }}>{display}</span>;
  }

  // Boolean
  if (typeof value === 'boolean') {
    return <span>{value ? 'Yes' : 'No'}</span>;
  }

  return <span>{String(value)}</span>;
}

export function TableView({ scope, onSelectRecord, activeRecord, session }: TableViewProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const getStateFn = useEoStore((s) => s.getState);
  const dispatch = useEoStore((s) => s.dispatch);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);

  const [records, setRecords] = useState<EoState[]>([]);
  const [filters, setFilters] = useState<FilterRule[]>([]);
  const [conjunction, setConjunction] = useState<'AND' | 'OR'>('AND');
  const [savedSegments, setSavedSegments] = useState<Record<string, FilterDefinition>>({});
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const scopeDepth = scope.split('.').length;

  // Load records
  useEffect(() => {
    if (!ready) return;
    getStateByPrefix(scope + '.').then((states) => {
      const direct = states.filter((st) => {
        const parts = st.target.split('.');
        return parts.length === scopeDepth + 1 && !st.value?._alias;
      });
      setRecords(direct);
    });
  }, [ready, lastSeq, getStateByPrefix, scope, scopeDepth]);

  // Load saved segments from scope target
  useEffect(() => {
    if (!ready) return;
    getStateFn(scope).then((state) => {
      if (state?.value?._segments) {
        setSavedSegments(state.value._segments);
      } else {
        setSavedSegments({});
      }
    });
  }, [ready, lastSeq, getStateFn, scope]);

  // Reset filters when scope changes
  useEffect(() => {
    setFilters([]);
    setConjunction('AND');
  }, [scope]);

  const columns = useMemo(() => deriveColumns(records), [records]);
  const filtered = useMemo(() => applyFilters(records, filters, conjunction), [records, filters, conjunction]);

  // Save segment as SEG operation
  async function handleSaveSegment(name: string) {
    // Ensure scope target exists
    const existing = await getStateFn(scope);
    if (!existing) {
      await dispatch({
        op: 'INS',
        target: scope,
        operand: {},
        agent: session.userId,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
        client_event_id: crypto.randomUUID(),
      });
    }

    const currentState = await getStateFn(scope);
    const currentValue = currentState?.value || {};

    await dispatch({
      op: 'SEG',
      target: scope,
      operand: {
        ...currentValue,
        _segments: {
          ...currentValue._segments,
          [name]: {
            name,
            filters,
            conjunction,
            created_at: new Date().toISOString(),
            created_by: session.userId,
          } satisfies FilterDefinition,
        },
      },
      agent: session.userId,
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
      client_event_id: crypto.randomUUID(),
    });
  }

  // Apply a saved segment
  function handleApplySegment(seg: FilterDefinition) {
    setFilters(seg.filters);
    setConjunction(seg.conjunction);
  }

  return (
    <div style={s.container}>
      {/* Toolbar */}
      <div style={s.toolbar}>
        <div style={s.toolbarLeft}>
          <div style={s.scopeName}>{formatScopeName(scope)}</div>
          <span style={s.recordCount}>{filtered.length} of {records.length} records</span>
        </div>
        <div style={s.toolbarRight}>
          {/* Saved segment picker */}
          {Object.keys(savedSegments).length > 0 && (
            <SegmentPicker segments={savedSegments} onApply={handleApplySegment} />
          )}
          <FilterBar
            columns={columns}
            filters={filters}
            onFiltersChange={setFilters}
            conjunction={conjunction}
            onConjunctionChange={setConjunction}
            onSaveSegment={handleSaveSegment}
          />
        </div>
      </div>

      {/* Table */}
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              {columns.map((col, i) => (
                <th key={col.key} style={{
                  ...s.th,
                  ...(i === 0 ? s.stickyCol : {}),
                }}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={columns.length} style={s.emptyRow}>
                  {records.length === 0 ? 'No records in this scope' : 'No records match the current filters'}
                </td>
              </tr>
            )}
            {filtered.map((rec) => {
              const isActive = rec.target === activeRecord;
              return (
                <tr
                  key={rec.target}
                  style={isActive ? s.rowActive : undefined}
                  onClick={() => onSelectRecord(rec.target)}
                  onMouseEnter={(e) => {
                    if (!isActive) (e.currentTarget as HTMLElement).style.background = theme.bgHover;
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) (e.currentTarget as HTMLElement).style.background = '';
                  }}
                >
                  {columns.map((col, i) => (
                    <td key={col.key} style={{
                      ...s.td,
                      ...(i === 0 ? s.stickyCol : {}),
                      ...(isActive && i === 0 ? { background: theme.accentBg } : {}),
                    }}>
                      {renderCell(rec.value?.[col.key], col.key, onSelectRecord, theme)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Saved Segment Picker ---

function SegmentPicker({ segments, onApply }: {
  segments: Record<string, FilterDefinition>;
  onApply: (seg: FilterDefinition) => void;
}) {
  const [open, setOpen] = useState(false);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <div style={{ position: 'relative' }}>
      <button
        style={s.toolbarBtn}
        onClick={() => setOpen(!open)}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M1 3h14M3 8h10M5 13h6" />
        </svg>
        Segments
      </button>
      {open && (
        <>
          <div style={s.backdrop} onClick={() => setOpen(false)} />
          <div style={s.dropdown}>
            <div style={s.dropdownTitle}>Saved Segments</div>
            {Object.entries(segments).map(([name, seg]) => (
              <div
                key={name}
                style={s.dropdownItem}
                onClick={() => { onApply(seg); setOpen(false); }}
              >
                <span style={{ fontWeight: 500 }}>{name}</span>
                <span style={{ fontSize: 10, color: theme.textMuted }}>
                  {seg.filters.length} filter{seg.filters.length !== 1 ? 's' : ''}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// --- Styles ---

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: t.bgCard,
    },
    toolbar: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '16px 24px',
      borderBottom: `1px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
    },
    toolbarLeft: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 12,
    },
    toolbarRight: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    scopeName: {
      fontFamily: "'Source Serif 4', Georgia, serif",
      fontSize: 20,
      fontWeight: 600,
      color: t.textHeading,
    },
    recordCount: {
      fontSize: 12,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    toolbarBtn: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 12px',
      fontSize: 12,
      fontWeight: 500,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: t.bgCard,
      color: t.text,
      cursor: 'pointer',
    },
    backdrop: {
      position: 'fixed' as const,
      inset: 0,
      zIndex: 99,
    },
    dropdown: {
      position: 'absolute' as const,
      right: 0,
      top: '100%',
      marginTop: 4,
      width: 220,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      boxShadow: `0 4px 16px ${t.shadow}`,
      zIndex: 100,
      overflow: 'hidden',
    },
    dropdownTitle: {
      fontSize: 10,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.06em',
      color: t.textMuted,
      padding: '10px 14px 6px',
    },
    dropdownItem: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '8px 14px',
      fontSize: 13,
      color: t.textHeading,
      cursor: 'pointer',
      borderTop: `1px solid ${t.borderLight}`,
    },

    tableWrap: {
      flex: 1,
      overflowX: 'auto',
      overflowY: 'auto',
    },
    table: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 13,
      color: t.textHeading,
    } as React.CSSProperties,
    th: {
      position: 'sticky' as const,
      top: 0,
      background: t.bg,
      padding: '10px 16px',
      textAlign: 'left' as const,
      fontSize: 10,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.04em',
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
      borderBottom: `2px solid ${t.border}`,
      borderRight: `1px solid ${t.border}`,
      whiteSpace: 'nowrap' as const,
      zIndex: 2,
      minWidth: 120,
    },
    td: {
      padding: '12px 16px',
      borderBottom: `1px solid ${t.border}`,
      borderRight: `1px solid ${t.borderLight}`,
      verticalAlign: 'top' as const,
      background: t.bgCard,
      maxWidth: 300,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    stickyCol: {
      position: 'sticky' as const,
      left: 0,
      zIndex: 1,
      background: t.bgCard,
      boxShadow: `2px 0 4px ${t.shadow}`,
      minWidth: 180,
    },
    rowActive: {
      background: t.accentBg,
    } as React.CSSProperties,
    emptyRow: {
      padding: '40px 16px',
      textAlign: 'center' as const,
      color: t.textMuted,
      fontSize: 13,
    },
  };
}
