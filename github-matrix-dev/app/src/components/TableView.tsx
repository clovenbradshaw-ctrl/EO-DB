import { useEffect, useState, useMemo } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import { deriveColumns, applyFilters, type FilterRule, type FilterDefinition, type ColumnDef } from './filter-types';
import { FilterBar } from './FilterBar';

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

const statusColors: Record<string, { bg: string; color: string; border: string }> = {
  active: { bg: '#e8f7ee', color: '#16643a', border: '#b8e4ca' },
  archived: { bg: '#eceae6', color: '#aba69e', border: '#d4d0ca' },
  pending: { bg: '#fef6e8', color: '#8a6d20', border: '#eedcaa' },
};

function renderCell(value: any, key: string, onNavigate: (t: string) => void): React.ReactNode {
  if (value == null || value === '') {
    return <span style={cellStyles.empty}>--</span>;
  }

  // Status pill
  if (key === 'status' && typeof value === 'string') {
    const sc = statusColors[value];
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
        {value.linked.map((t: string, i: number) => (
          <span key={t}>
            {i > 0 && ', '}
            <span style={cellStyles.link} onClick={(e) => { e.stopPropagation(); onNavigate(t); }}>{t}</span>
          </span>
        ))}
      </span>
    );
  }

  // Other objects
  if (typeof value === 'object' && value !== null) {
    const json = JSON.stringify(value);
    const display = json.length > 50 ? json.slice(0, 47) + '...' : json;
    return <span style={cellStyles.mono}>{display}</span>;
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

  const scopeDepth = scope.split('.').length;

  // Load records
  useEffect(() => {
    if (!ready) return;
    getStateByPrefix(scope + '.').then((states) => {
      const direct = states.filter((s) => {
        const parts = s.target.split('.');
        return parts.length === scopeDepth + 1 && !s.value?._alias;
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
    <div style={styles.container}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarLeft}>
          <div style={styles.scopeName}>{formatScopeName(scope)}</div>
          <span style={styles.recordCount}>{filtered.length} of {records.length} records</span>
        </div>
        <div style={styles.toolbarRight}>
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
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              {columns.map((col, i) => (
                <th key={col.key} style={{
                  ...styles.th,
                  ...(i === 0 ? styles.stickyCol : {}),
                }}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={columns.length} style={styles.emptyRow}>
                  {records.length === 0 ? 'No records in this scope' : 'No records match the current filters'}
                </td>
              </tr>
            )}
            {filtered.map((rec) => {
              const isActive = rec.target === activeRecord;
              return (
                <tr
                  key={rec.target}
                  style={isActive ? styles.rowActive : undefined}
                  onClick={() => onSelectRecord(rec.target)}
                  onMouseEnter={(e) => {
                    if (!isActive) (e.currentTarget as HTMLElement).style.background = '#f4f3f0';
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) (e.currentTarget as HTMLElement).style.background = '';
                  }}
                >
                  {columns.map((col, i) => (
                    <td key={col.key} style={{
                      ...styles.td,
                      ...(i === 0 ? styles.stickyCol : {}),
                      ...(isActive && i === 0 ? { background: '#eef5fd' } : {}),
                    }}>
                      {renderCell(rec.value?.[col.key], col.key, onSelectRecord)}
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

  return (
    <div style={{ position: 'relative' }}>
      <button
        style={styles.toolbarBtn}
        onClick={() => setOpen(!open)}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M1 3h14M3 8h10M5 13h6" />
        </svg>
        Segments
      </button>
      {open && (
        <>
          <div style={styles.backdrop} onClick={() => setOpen(false)} />
          <div style={styles.dropdown}>
            <div style={styles.dropdownTitle}>Saved Segments</div>
            {Object.entries(segments).map(([name, seg]) => (
              <div
                key={name}
                style={styles.dropdownItem}
                onClick={() => { onApply(seg); setOpen(false); }}
              >
                <span style={{ fontWeight: 500 }}>{name}</span>
                <span style={{ fontSize: 10, color: '#aba69e' }}>
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

const cellStyles: Record<string, React.CSSProperties> = {
  empty: { color: '#aba69e' },
  link: {
    color: '#7c5cbf',
    cursor: 'pointer',
    textDecoration: 'underline',
    textDecorationColor: '#d4d0f0',
  },
  mono: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: '#7a756d',
  },
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: '#fff',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 24px',
    borderBottom: '1px solid #e5e2dd',
    background: '#fff',
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
    color: '#1a1816',
  },
  recordCount: {
    fontSize: 12,
    color: '#aba69e',
    fontFamily: "'JetBrains Mono', monospace",
  },
  toolbarBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 500,
    border: '1px solid #e5e2dd',
    borderRadius: 6,
    background: '#fff',
    color: '#2c2a26',
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
    background: '#fff',
    border: '1px solid #e5e2dd',
    borderRadius: 8,
    boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
    zIndex: 100,
    overflow: 'hidden',
  },
  dropdownTitle: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: '#aba69e',
    padding: '10px 14px 6px',
  },
  dropdownItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 14px',
    fontSize: 13,
    color: '#1a1816',
    cursor: 'pointer',
    borderTop: '1px solid #f0eeeb',
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
    color: '#1a1816',
  } as React.CSSProperties,
  th: {
    position: 'sticky' as const,
    top: 0,
    background: '#faf9f7',
    padding: '10px 16px',
    textAlign: 'left' as const,
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    color: '#aba69e',
    fontFamily: "'JetBrains Mono', monospace",
    borderBottom: '2px solid #e5e2dd',
    borderRight: '1px solid #e5e2dd',
    whiteSpace: 'nowrap' as const,
    zIndex: 2,
    minWidth: 120,
  },
  td: {
    padding: '12px 16px',
    borderBottom: '1px solid #e5e2dd',
    borderRight: '1px solid #f0eeeb',
    verticalAlign: 'top' as const,
    background: '#fff',
    maxWidth: 300,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  stickyCol: {
    position: 'sticky' as const,
    left: 0,
    zIndex: 1,
    background: '#fff',
    boxShadow: '2px 0 4px rgba(0,0,0,0.04)',
    minWidth: 180,
  },
  rowActive: {
    background: '#eef5fd',
  } as React.CSSProperties,
  emptyRow: {
    padding: '40px 16px',
    textAlign: 'center' as const,
    color: '#aba69e',
    fontSize: 13,
  },
};
