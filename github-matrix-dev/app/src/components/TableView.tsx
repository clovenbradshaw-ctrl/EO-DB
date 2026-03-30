import { useEffect, useState, useMemo } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import { deriveColumns, type ColumnDef } from './filter-types';
import { useTheme, type Theme } from '../theme';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { TypeSelector, TypeBadge } from './TypeSelector';

interface TableViewProps {
  scope: string;
  onSelectRecord: (target: string) => void;
  onViewHistory?: (target: string) => void;
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
    return <span style={{ color: t.textMuted, fontStyle: 'italic' }}>{'\u2014'}</span>;
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

export function TableView({ scope, onSelectRecord, onViewHistory, activeRecord, session }: TableViewProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const dispatch = useEoStore((s) => s.dispatch);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);

  const [records, setRecords] = useState<EoState[]>([]);
  const [filterText, setFilterText] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: string } | null>(null);
  const [typeSelector, setTypeSelector] = useState<{ x: number; y: number; target: string; currentType?: string } | null>(null);
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

  // Reset filter when scope changes
  useEffect(() => {
    setFilterText('');
  }, [scope]);

  const entityColumns = useMemo(() => deriveColumns(records), [records]);
  const columns = useMemo<ColumnDef[]>(() => [
    { key: '_record', label: 'record', type: 'text' as const },
    ...entityColumns.map(c => ({ ...c, label: c.label.toLowerCase() })),
  ], [entityColumns]);

  const filtered = useMemo(() => {
    if (!filterText) return records;
    const q = filterText.toLowerCase();
    return records.filter((rec) => {
      const target = rec.target.toLowerCase();
      if (target.includes(q)) return true;
      if (rec.value) {
        return Object.values(rec.value).some(v =>
          v != null && String(v).toLowerCase().includes(q)
        );
      }
      return false;
    });
  }, [records, filterText]);

  function handleContextMenu(e: React.MouseEvent, target: string) {
    e.preventDefault();
    e.stopPropagation();
    const rec = records.find((r) => r.target === target);
    setContextMenu({ x: e.clientX, y: e.clientY, target });
  }

  function getContextMenuItems(target: string): ContextMenuItem[] {
    const rec = records.find((r) => r.target === target);
    return [
      {
        label: rec?.value?._type ? `Change type (${rec.value._type})` : 'Set page type...',
        onClick: () => {
          setTypeSelector({
            x: contextMenu!.x,
            y: contextMenu!.y,
            target,
            currentType: rec?.value?._type,
          });
          setContextMenu(null);
        },
      },
      {
        label: 'View history',
        onClick: () => {
          onViewHistory?.(target);
          onSelectRecord(target);
        },
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Copy target path',
        onClick: () => navigator.clipboard.writeText(target),
      },
    ];
  }

  async function handleTypeChange(target: string, type: string) {
    try {
      await dispatch({
        op: 'DEF',
        target,
        operand: { _type: type || undefined },
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
    } catch { /* ignore */ }
    setTypeSelector(null);
  }

  return (
    <div style={s.container}>
      {/* Toolbar */}
      <div style={s.toolbar}>
        <div style={s.toolbarLeft}>
          <div style={s.scopeName}>{formatScopeName(scope)}</div>
          <span style={s.recordCount}>{filtered.length} records</span>
        </div>
        <div style={s.toolbarRight}>
          <input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Filter\u2026"
            style={s.filterInput}
          />
        </div>
      </div>

      {/* Table */}
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key} style={s.th}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={columns.length} style={s.emptyRow}>
                  {records.length === 0 ? 'No records in this scope' : 'No records match the current filter'}
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
                  onContextMenu={(e) => handleContextMenu(e, rec.target)}
                  onMouseEnter={(e) => {
                    if (!isActive) (e.currentTarget as HTMLElement).style.background = theme.bgHover;
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) (e.currentTarget as HTMLElement).style.background = '';
                  }}
                >
                  {columns.map((col) => (
                    <td key={col.key} style={s.td}>
                      {col.key === '_record'
                        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span style={{
                              fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                              color: theme.accent, cursor: 'pointer',
                            }}>{rec.target.split('.').pop()}</span>
                            {rec.value?._type && <TypeBadge type={rec.value._type} />}
                          </span>
                        : renderCell(rec.value?.[col.key], col.key, onSelectRecord, theme)
                      }
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Right-click context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.target)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Type selector popover */}
      {typeSelector && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onClick={() => setTypeSelector(null)}
          />
          <div style={{
            position: 'fixed',
            left: typeSelector.x,
            top: typeSelector.y,
            zIndex: 9999,
            background: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: 8,
            boxShadow: `0 8px 30px ${theme.shadow}`,
          }}>
            <TypeSelector
              currentType={typeSelector.currentType}
              onSelect={(type) => handleTypeChange(typeSelector.target, type)}
              onClose={() => setTypeSelector(null)}
            />
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
      padding: '12px 20px',
      borderBottom: `0.5px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
    },
    toolbarLeft: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    toolbarRight: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    scopeName: {
      fontSize: 14,
      fontWeight: 500,
      color: t.textHeading,
    },
    recordCount: {
      fontSize: 12,
      color: t.textMuted,
      background: t.bgMuted,
      padding: '1px 6px',
      borderRadius: 4,
    },
    filterInput: {
      width: 140,
      height: 28,
      fontSize: 12,
      padding: '0 8px',
      border: `0.5px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgCard,
      color: t.text,
      outline: 'none',
    },
    tableWrap: {
      flex: 1,
      overflowX: 'auto',
      overflowY: 'auto',
    },
    table: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 12,
      color: t.textHeading,
    } as React.CSSProperties,
    th: {
      position: 'sticky' as const,
      top: 0,
      background: t.bgCard,
      padding: '10px 8px 10px 0',
      paddingLeft: 20,
      textAlign: 'left' as const,
      fontSize: 11,
      fontWeight: 400,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.3px',
      color: t.textMuted,
      borderBottom: `0.5px solid ${t.border}`,
      whiteSpace: 'nowrap' as const,
      zIndex: 2,
    },
    td: {
      padding: '10px 8px 10px 0',
      paddingLeft: 20,
      borderBottom: `0.5px solid ${t.borderLight}`,
      verticalAlign: 'middle' as const,
      background: t.bgCard,
      maxWidth: 300,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    rowActive: {
      background: t.accentBg,
    } as React.CSSProperties,
    emptyRow: {
      padding: '40px 16px',
      textAlign: 'center' as const,
      color: t.textMuted,
      fontSize: 12,
    },
  };
}
