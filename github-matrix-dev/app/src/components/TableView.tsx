import { useEffect, useState, useMemo } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import { deriveColumns, buildFieldNameMap, buildFieldNameMapFromSchema, hasFieldsSubObject, getFieldValue, type ColumnDef } from './filter-types';
import { type TimeScrubberFilter, applyTimeScrubber } from './time-scrubber-utils';
import { useTheme, type Theme } from '../theme';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { TypeSelector, TypeBadge } from './TypeSelector';
import { RedactedCell, LockIcon, LockedCell } from './RedactedCell';
import type { ResolvedPermissions } from '../permissions/types';

interface TableViewProps {
  scope: string;
  onSelectRecord: (target: string) => void;
  onViewHistory?: (target: string) => void;
  activeRecord?: string | null;
  session: { userId: string };
  timeScrubberFilter?: TimeScrubberFilter;
  permissions?: ResolvedPermissions | null;
}

function formatRelativeTime(ts: string): string {
  const now = Date.now();
  const then = new Date(ts).getTime();
  const diff = now - then;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
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

export function TableView({ scope, onSelectRecord, onViewHistory, activeRecord, session, timeScrubberFilter, permissions }: TableViewProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const getState = useEoStore((s) => s.getState);
  const dispatch = useEoStore((s) => s.dispatch);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);

  const [records, setRecords] = useState<EoState[]>([]);
  const [fieldNameMap, setFieldNameMap] = useState<Map<string, string>>(new Map());
  const [scopeName, setScopeName] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: string } | null>(null);
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number; key: string; label: string } | null>(null);
  const [renameCol, setRenameCol] = useState<{ key: string; value: string } | null>(null);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [typeSelector, setTypeSelector] = useState<{ x: number; y: number; target: string; currentType?: string } | null>(null);
  const [showLastUpdated, setShowLastUpdated] = useState(true);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const scopeDepth = scope.split('.').length;

  // Load records and field metadata
  useEffect(() => {
    if (!ready) return;
    getStateByPrefix(scope + '.').then((states) => {
      const direct = states
        .filter((st) => {
          const parts = st.target.split('.');
          if (parts.length !== scopeDepth + 1 || st.value?._alias) return false;
          // Hide internal entities (e.g. _schema)
          const segment = parts[parts.length - 1];
          if (segment.startsWith('_')) return false;
          return true;
        })
        .map((st) => {
          // When fields is an array of DEFs ({id,name,type}), flatten into
          // a fields object keyed by name so each field renders as a column.
          const f = st.value?.fields;
          if (Array.isArray(f) && f.length > 0 && f[0]?.name) {
            const expanded: Record<string, any> = {};
            for (const field of f) {
              expanded[field.name] = field.type ?? '';
            }
            return { ...st, value: { ...st.value, fields: expanded } };
          }
          return st;
        });
      setRecords(direct);
    });
    // Fetch field metadata: prefer per-field schema entities, fall back to array on table state
    getStateByPrefix(scope + '._schema.').then((schemaStates) => {
      // Filter to direct children of _schema only
      const schemaDepth = scope.split('.').length + 2; // scope._schema.fieldId
      const fieldStates = schemaStates.filter(
        (st) => st.target.split('.').length === schemaDepth && !st.value?._alias,
      );
      if (fieldStates.length > 0) {
        setFieldNameMap(buildFieldNameMapFromSchema(fieldStates));
      } else {
        // Fallback: read field metadata from table state array
        getState(scope).then((scopeState) => {
          const fields = scopeState?.value?.fields;
          if (Array.isArray(fields)) {
            setFieldNameMap(buildFieldNameMap(fields));
          } else {
            setFieldNameMap(new Map());
          }
        });
      }
    });
    // Fetch scope display name
    getState(scope).then((scopeState) => {
      setScopeName(scopeState?.value?.name ?? null);
    });
  }, [ready, lastSeq, getStateByPrefix, getState, scope, scopeDepth]);

  // Reset filter when scope changes
  useEffect(() => {
    setFilterText('');
  }, [scope]);

  // Detect if records use the Airtable-style fields sub-object
  const useFieldsSub = useMemo(() => hasFieldsSubObject(records), [records]);

  const entityColumns = useMemo(() => deriveColumns(records, fieldNameMap), [records, fieldNameMap]);
  const columns = useMemo<ColumnDef[]>(() => {
    const all = [
      { key: '_record', label: 'record', type: 'text' as const },
      ...entityColumns,
      ...(showLastUpdated ? [{ key: '_last_updated', label: 'last updated', type: 'text' as const }] : []),
    ];
    if (hiddenColumns.size === 0) return all;
    return all.filter((col) => !hiddenColumns.has(col.key));
  }, [entityColumns, hiddenColumns, showLastUpdated]);

  const filtered = useMemo(() => {
    let result = records;

    // Text filter
    if (filterText) {
      const q = filterText.toLowerCase();
      result = result.filter((rec) => {
        const target = rec.target.toLowerCase();
        if (target.includes(q)) return true;
        if (rec.value) {
          const source = useFieldsSub && rec.value.fields && typeof rec.value.fields === 'object'
            ? rec.value.fields
            : rec.value;
          return Object.values(source).some(v =>
            v != null && String(v).toLowerCase().includes(q)
          );
        }
        return false;
      });
    }
    // Time scrubber filter
    if (timeScrubberFilter) {
      result = applyTimeScrubber(result, timeScrubberFilter, useFieldsSub);
    }

    if (sortConfig) {
      result = [...result].sort((a, b) => {
        const aVal = sortConfig.key === '_record'
          ? (a.value?.name || a.target.split('.').pop() || '')
          : getFieldValue(a, sortConfig.key, useFieldsSub);
        const bVal = sortConfig.key === '_record'
          ? (b.value?.name || b.target.split('.').pop() || '')
          : getFieldValue(b, sortConfig.key, useFieldsSub);
        const aStr = aVal != null ? String(aVal) : '';
        const bStr = bVal != null ? String(bVal) : '';
        const aNum = Number(aStr);
        const bNum = Number(bStr);
        const cmp = (!isNaN(aNum) && !isNaN(bNum) && aStr !== '' && bStr !== '')
          ? aNum - bNum
          : aStr.localeCompare(bStr);
        return sortConfig.direction === 'asc' ? cmp : -cmp;
      });
    }
    return result;
  }, [records, filterText, useFieldsSub, timeScrubberFilter, sortConfig]);

  function handleColumnContextMenu(e: React.MouseEvent, col: ColumnDef) {
    e.preventDefault();
    e.stopPropagation();
    setColumnMenu({ x: e.clientX, y: e.clientY, key: col.key, label: col.label });
    setContextMenu(null);
  }

  function getColumnMenuItems(colKey: string, colLabel: string): ContextMenuItem[] {
    const isSorted = sortConfig?.key === colKey;
    const items: ContextMenuItem[] = [
      {
        label: 'Rename column',
        onClick: () => {
          setRenameCol({ key: colKey, value: colLabel });
          setColumnMenu(null);
        },
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: `Sort ascending${isSorted && sortConfig?.direction === 'asc' ? ' (active)' : ''}`,
        onClick: () => setSortConfig({ key: colKey, direction: 'asc' }),
      },
      {
        label: `Sort descending${isSorted && sortConfig?.direction === 'desc' ? ' (active)' : ''}`,
        onClick: () => setSortConfig({ key: colKey, direction: 'desc' }),
      },
      ...(isSorted ? [{
        label: 'Remove sort',
        onClick: () => setSortConfig(null),
      }] : []),
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Filter by this column',
        onClick: () => setFilterText(`${colLabel}:`),
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Hide column',
        onClick: () => setHiddenColumns((prev) => new Set([...prev, colKey])),
        disabled: colKey === '_record',
      },
    ];
    if (hiddenColumns.size > 0) {
      items.push({
        label: `Show all columns (${hiddenColumns.size} hidden)`,
        onClick: () => setHiddenColumns(new Set()),
      });
    }
    return items;
  }

  async function handleColumnRename(fieldKey: string, newLabel: string) {
    const schemaTarget = `${scope}._schema.${fieldKey}`;
    try {
      await dispatch({
        op: 'DEF',
        target: schemaTarget,
        operand: { _label: newLabel },
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      // Update local field name map immediately
      setFieldNameMap((prev) => {
        const next = new Map(prev);
        next.set(fieldKey, newLabel);
        return next;
      });
    } catch { /* ignore */ }
    setRenameCol(null);
  }

  function handleContextMenu(e: React.MouseEvent, target: string) {
    e.preventDefault();
    e.stopPropagation();
    const rec = records.find((r) => r.target === target);
    setContextMenu({ x: e.clientX, y: e.clientY, target });
  }

  function getContextMenuItems(target: string): ContextMenuItem[] {
    const rec = records.find((r) => r.target === target);
    const canEdit = permissions ? permissions.can_edit_any_record || permissions.can_edit_own_records : true;
    const items: ContextMenuItem[] = [];

    if (canEdit) {
      items.push({
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
      });
    }

    items.push({
      label: 'View history',
      onClick: () => {
        onViewHistory?.(target);
        onSelectRecord(target);
      },
    });
    items.push({ label: '', onClick: () => {}, separator: true });
    items.push({
      label: 'Copy target path',
      onClick: () => navigator.clipboard.writeText(target),
    });

    return items;
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
          <div style={s.scopeName}>{scopeName || formatScopeName(scope)}</div>
          <span style={s.recordCount}>{filtered.length} records</span>
        </div>
        <div style={s.toolbarRight}>
          <button
            onClick={() => setShowLastUpdated(!showLastUpdated)}
            style={{
              ...s.toggleBtn,
              background: showLastUpdated ? theme.accentBg : 'transparent',
              color: showLastUpdated ? theme.accent : theme.textMuted,
              border: `1px solid ${showLastUpdated ? theme.accentBorder : theme.border}`,
            }}
            title={showLastUpdated ? 'Hide last updated column' : 'Show last updated column'}
          >
            Last updated
          </button>
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
              {columns.map((col) => {
                const isLocked = permissions?.locked_fields?.includes(col.key);
                const isRedacted = permissions?.redacted_fields?.includes(col.key);
                return (
                  <th
                    key={col.key}
                    style={{ ...s.th, cursor: 'context-menu', userSelect: 'none' }}
                    onContextMenu={(e) => handleColumnContextMenu(e, col)}
                  >
                    {renameCol?.key === col.key ? (
                      <input
                        autoFocus
                        defaultValue={renameCol.value}
                        style={{
                          fontSize: 11, fontWeight: 400, border: `1px solid ${theme.accent}`,
                          borderRadius: 3, padding: '2px 4px', background: theme.bgCard,
                          color: theme.text, outline: 'none', width: '100%',
                          textTransform: 'none' as const,
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleColumnRename(col.key, (e.target as HTMLInputElement).value);
                          if (e.key === 'Escape') setRenameCol(null);
                        }}
                        onBlur={(e) => handleColumnRename(col.key, e.target.value)}
                      />
                    ) : (
                      <span>
                        {isLocked && <LockIcon />}
                        {col.label}
                        {sortConfig?.key === col.key && (
                          <span style={{ marginLeft: 4, fontSize: 10 }}>
                            {sortConfig.direction === 'asc' ? '\u25B4' : '\u25BE'}
                          </span>
                        )}
                      </span>
                    )}
                  </th>
                );
              })}
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
                  {columns.map((col) => {
                    const isRedacted = permissions?.redacted_fields?.includes(col.key);
                    const isLocked = permissions?.locked_fields?.includes(col.key);
                    return (
                      <td key={col.key} style={s.td}>
                        {isRedacted
                          ? <RedactedCell />
                          : col.key === '_record'
                          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <span style={{
                                fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                                color: theme.accent, cursor: 'pointer',
                              }}>{rec.value?.name || rec.target.split('.').pop()}</span>
                              {rec.value?._type && <TypeBadge type={rec.value._type} />}
                            </span>
                          : col.key === '_last_updated'
                          ? <span style={{
                              fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                              color: theme.textSecondary,
                            }}>{rec.last_ts ? formatRelativeTime(rec.last_ts) : '\u2014'}</span>
                          : isLocked
                          ? <LockedCell>{renderCell(getFieldValue(rec, col.key, useFieldsSub), col.key, onSelectRecord, theme)}</LockedCell>
                          : renderCell(getFieldValue(rec, col.key, useFieldsSub), col.key, onSelectRecord, theme)
                        }
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Right-click context menu (rows) */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.target)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Right-click context menu (columns) */}
      {columnMenu && (
        <ContextMenu
          x={columnMenu.x}
          y={columnMenu.y}
          items={getColumnMenuItems(columnMenu.key, columnMenu.label)}
          onClose={() => setColumnMenu(null)}
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
    toggleBtn: {
      height: 28,
      fontSize: 11,
      padding: '0 10px',
      borderRadius: 4,
      cursor: 'pointer',
      fontWeight: 500,
      whiteSpace: 'nowrap' as const,
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
