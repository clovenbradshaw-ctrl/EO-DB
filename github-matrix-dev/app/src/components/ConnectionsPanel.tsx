/**
 * ConnectionsPanel — renders CON edges as inline mini-tables grouped by entity type.
 *
 * Each connection group is a table with configurable columns:
 *   - ID column (always visible, click to navigate)
 *   - Fields from the connected entity (resolved from its DEF state)
 *   - Edge metadata columns (edge_type, edge created, edge seq) — italicized headers
 *
 * Column configuration is passed in from the parent (stored as a DEF on
 * scope._schema._detail_layout). The gear toggle and column picker live
 * in the parent RecordView to coordinate across all sections.
 *
 * Performance: renders the table shell with IDs immediately from _edges,
 * then resolves field values in a single parallel batch. No waterfall.
 */

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import { formatName } from './scope-picker-utils';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConnectionColumnDef {
  key: string;           // field key on the connected entity, or "_edge.type" / "_edge.seq" / "_edge.created"
  label?: string;        // display label override
  isEdgeMeta?: boolean;  // true for edge metadata columns (italicized headers)
}

export interface ConnectionSectionConfig {
  entity: string;        // collection type key (e.g. "cases", "documents")
  columns: ConnectionColumnDef[];
  hidden?: boolean;
}

interface ConnectionsPanelProps {
  edges: Array<{ dest: string; edge_type?: string; seq?: number; ts?: string }>;
  onNavigate: (target: string) => void;
  /** Per-group column config from detail layout. If absent, uses defaults. */
  sectionConfigs?: ConnectionSectionConfig[];
  /** When true, shows "+ col" buttons and column remove (×) buttons */
  editMode?: boolean;
  onAddColumn?: (entity: string) => void;
  onRemoveColumn?: (entity: string, columnKey: string) => void;
  onToggleHidden?: (entity: string) => void;
}

interface ResolvedRow {
  dest: string;
  entityId: string;
  edge_type?: string;
  edge_seq?: number;
  edge_created?: string;
  fields: Record<string, any>;
  loading: boolean;
}

interface ConnectionGroup {
  type: string;
  label: string;
  color: string;
  rows: ResolvedRow[];
  columns: ConnectionColumnDef[];
  hidden: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  cases: '#16a34a',
  clients: '#c2700a',
  attorneys: '#7c5cbf',
  documents: '#8b6834',
  billing: '#1a6dd4',
  billing_accounts: '#1a6dd4',
  contacts: '#c2700a',
  matters: '#0e8a6e',
  tasks: '#1a6dd4',
  events: '#d9487a',
  notes: '#7c5cbf',
};

function getTypeColor(type: string): string {
  return TYPE_COLORS[type.toLowerCase()] || '#7a756d';
}

/** Default columns when no layout config exists for a connection type */
const DEFAULT_COLUMNS: ConnectionColumnDef[] = [
  { key: 'name', label: 'Name' },
];

/** Edge metadata column definitions */
export const EDGE_META_COLUMNS: ConnectionColumnDef[] = [
  { key: '_edge.type', label: 'edge type', isEdgeMeta: true },
  { key: '_edge.created', label: 'edge created', isEdgeMeta: true },
  { key: '_edge.seq', label: 'edge seq', isEdgeMeta: true },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseTarget(target: string): { collection: string; entityId: string } {
  const parts = target.split('.');
  if (parts.length >= 3) {
    return { collection: parts[parts.length - 2], entityId: parts[parts.length - 1] };
  }
  if (parts.length === 2) {
    return { collection: parts[0], entityId: parts[1] };
  }
  return { collection: 'other', entityId: parts[parts.length - 1] };
}

function getEdgeMetaValue(row: ResolvedRow, key: string): any {
  if (key === '_edge.type') return row.edge_type;
  if (key === '_edge.seq') return row.edge_seq;
  if (key === '_edge.created') return row.edge_created;
  return undefined;
}

function formatCellValue(val: any): string {
  if (val === undefined || val === null) return '';
  // Arrays of strings: show short IDs or comma-joined values
  if (Array.isArray(val)) {
    return val.map(v => {
      if (typeof v === 'string' && v.includes('.')) return v.split('.').pop() || v;
      return v != null ? String(v) : '';
    }).filter(Boolean).join(', ');
  }
  // Objects with linked array: show short IDs of linked targets
  if (typeof val === 'object' && val.linked && Array.isArray(val.linked)) {
    return val.linked.map((t: string) => t.split('.').pop() || t).join(', ');
  }
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function ConnectionTable({ group, onNavigate, editMode, onAddColumn, onRemoveColumn }: {
  group: ConnectionGroup;
  onNavigate: (target: string) => void;
  editMode?: boolean;
  onAddColumn?: () => void;
  onRemoveColumn?: (columnKey: string) => void;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [showAll, setShowAll] = useState(false);

  const limit = 5;
  const needsTruncation = group.rows.length > limit;
  const visibleRows = showAll || !needsTruncation ? group.rows : group.rows.slice(0, limit);

  return (
    <div style={s.table}>
      {/* Table header */}
      <div style={{ ...s.tableRow, ...s.tableHeaderRow }}>
        <div style={{ ...s.tableCell, ...s.idCell, ...s.headerCell }}>ID</div>
        {group.columns.map((col) => (
          <div
            key={col.key}
            style={{
              ...s.tableCell,
              ...s.headerCell,
              ...(col.isEdgeMeta ? { fontStyle: 'italic' } : {}),
            }}
          >
            {col.label || formatName(col.key)}
            {editMode && (
              <span
                style={s.removeColBtn}
                onClick={(e) => { e.stopPropagation(); onRemoveColumn?.(col.key); }}
                title="Remove column"
              >
                &times;
              </span>
            )}
          </div>
        ))}
        {editMode && (
          <div
            style={{ ...s.tableCell, ...s.headerCell, ...s.addColCell }}
            onClick={onAddColumn}
          >
            + col
          </div>
        )}
      </div>

      {/* Table rows */}
      {visibleRows.map((row) => (
        <div key={row.dest} style={s.tableRow}>
          <div
            style={{ ...s.tableCell, ...s.idCell, ...s.idLink, color: group.color }}
            onClick={() => onNavigate(row.dest)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') onNavigate(row.dest); }}
          >
            {row.entityId}
          </div>
          {group.columns.map((col) => {
            const val = col.isEdgeMeta
              ? getEdgeMetaValue(row, col.key)
              : row.fields[col.key];
            const display = formatCellValue(val);

            // Status fields get a colored badge
            if (col.key === 'status' && display) {
              return (
                <div key={col.key} style={s.tableCell}>
                  <span style={{
                    ...s.statusBadge,
                    ...(display === 'active' ? { background: theme.successBg, color: theme.success } :
                      display === 'pending' ? { background: theme.warningBg, color: theme.warning } :
                      { background: theme.bgMuted, color: theme.textMuted }),
                  }}>
                    {display}
                  </span>
                </div>
              );
            }

            // Edge type gets a code-style badge
            if (col.key === '_edge.type' && display) {
              return (
                <div key={col.key} style={{ ...s.tableCell, fontStyle: 'italic' }}>
                  <span style={s.edgeTypeBadge}>{display}</span>
                </div>
              );
            }

            return (
              <div key={col.key} style={{
                ...s.tableCell,
                ...(col.isEdgeMeta ? { fontStyle: 'italic', color: theme.textMuted } : {}),
              }}>
                {row.loading && !display ? (
                  <span style={s.loadingDot}>&middot;&middot;&middot;</span>
                ) : display}
              </div>
            );
          })}
          {editMode && <div style={s.tableCell} />}
        </div>
      ))}

      {/* +N more */}
      {needsTruncation && !showAll && (
        <div style={s.moreRow}>
          <button style={s.moreBtn} onClick={() => setShowAll(true)}>
            +{group.rows.length - limit} more
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function ConnectionsPanel({
  edges,
  onNavigate,
  sectionConfigs,
  editMode,
  onAddColumn,
  onRemoveColumn,
  onToggleHidden,
}: ConnectionsPanelProps) {
  const getState = useEoStore((s) => s.getState);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  // Phase 1: Build groups immediately from edges (no async)
  const initialGroups = useMemo(() => {
    const groupMap = new Map<string, ResolvedRow[]>();
    for (const edge of edges) {
      const { collection, entityId } = parseTarget(edge.dest);
      if (!groupMap.has(collection)) groupMap.set(collection, []);
      groupMap.get(collection)!.push({
        dest: edge.dest,
        entityId,
        edge_type: edge.edge_type,
        edge_seq: edge.seq,
        edge_created: edge.ts,
        fields: {},
        loading: true,
      });
    }
    return groupMap;
  }, [edges]);

  // Phase 2: Resolve field values in parallel (non-blocking)
  const [resolvedFields, setResolvedFields] = useState<Map<string, Record<string, any>>>(new Map());

  const resolveAll = useCallback(async () => {
    const results = new Map<string, Record<string, any>>();
    const targets = edges.map(e => e.dest);

    // Batch resolve — all lookups fire in parallel
    const states = await Promise.all(
      targets.map(async (t) => {
        try {
          return await getState(t);
        } catch { return null; }
      }),
    );

    for (let i = 0; i < targets.length; i++) {
      const state = states[i];
      if (state?.value) {
        const fields: Record<string, any> = {};
        for (const [k, v] of Object.entries(state.value)) {
          if (!k.startsWith('_')) fields[k] = v;
        }
        results.set(targets[i], fields);
      }
    }

    setResolvedFields(results);
  }, [edges, getState]);

  useEffect(() => {
    resolveAll();
  }, [resolveAll]);

  // Build final groups with resolved data
  const groups: ConnectionGroup[] = useMemo(() => {
    const configMap = new Map<string, ConnectionSectionConfig>();
    if (sectionConfigs) {
      for (const cfg of sectionConfigs) configMap.set(cfg.entity, cfg);
    }

    const result: ConnectionGroup[] = [];
    for (const [type, rows] of initialGroups) {
      const config = configMap.get(type);
      const columns = config?.columns ?? DEFAULT_COLUMNS;
      const hidden = config?.hidden ?? false;

      // Merge resolved fields into rows
      const mergedRows = rows.map(row => ({
        ...row,
        fields: resolvedFields.get(row.dest) || row.fields,
        loading: !resolvedFields.has(row.dest),
      }));

      result.push({
        type,
        label: formatName(type),
        color: getTypeColor(type),
        rows: mergedRows,
        columns,
        hidden,
      });
    }

    // Sort: largest groups first, hidden at end
    result.sort((a, b) => {
      if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
      return b.rows.length - a.rows.length;
    });

    return result;
  }, [initialGroups, resolvedFields, sectionConfigs]);

  if (groups.length === 0) {
    return <div style={s.empty}>No connections</div>;
  }

  return (
    <div>
      {groups.map((group) => (
        <div key={group.type} style={s.groupContainer}>
          {/* Group header */}
          <div style={s.groupHeader}>
            {editMode && (
              <span style={s.dragHandle} title="Drag to reorder">::</span>
            )}
            {editMode && (
              <span
                style={{ ...s.eyeToggle, opacity: group.hidden ? 0.4 : 1 }}
                onClick={() => onToggleHidden?.(group.type)}
                title={group.hidden ? 'Show section' : 'Hide section'}
                role="button"
                tabIndex={0}
              >
                {group.hidden ? '\u25CB' : '\u25C9'}
              </span>
            )}
            <span style={{ ...s.groupDot, background: group.color }} />
            <span style={{ ...s.groupTitle, color: group.color }}>{group.label}</span>
            <span style={s.groupCount}>{group.rows.length}</span>
            {group.hidden && <span style={s.hiddenLabel}>hidden</span>}
          </div>

          {/* Table or collapsed */}
          {!group.hidden && (
            <ConnectionTable
              group={group}
              onNavigate={onNavigate}
              editMode={editMode}
              onAddColumn={() => onAddColumn?.(group.type)}
              onRemoveColumn={(key) => onRemoveColumn?.(group.type, key)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    empty: {
      fontSize: 12,
      color: t.textMuted,
      padding: '8px 0',
    },
    groupContainer: {
      marginBottom: 16,
    },
    groupHeader: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 8,
    },
    dragHandle: {
      fontSize: 12,
      color: t.textMuted,
      cursor: 'grab',
      fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: -1,
      userSelect: 'none' as const,
    },
    eyeToggle: {
      fontSize: 12,
      cursor: 'pointer',
      color: t.textMuted,
      userSelect: 'none' as const,
    },
    groupDot: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      flexShrink: 0,
    },
    groupTitle: {
      fontSize: 12,
      fontWeight: 600,
    },
    groupCount: {
      fontSize: 10,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    hiddenLabel: {
      fontSize: 9,
      color: t.textMuted,
      fontStyle: 'italic',
    },
    table: {
      width: '100%',
      borderCollapse: 'collapse',
    },
    tableRow: {
      display: 'flex',
      borderBottom: `1px solid ${t.border}`,
    },
    tableHeaderRow: {
      background: t.bgMuted,
    },
    tableCell: {
      flex: 1,
      padding: '6px 10px',
      fontSize: 12,
      color: t.text,
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    idCell: {
      flex: '0 0 90px',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
    },
    headerCell: {
      fontSize: 10,
      fontWeight: 600,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.3,
      display: 'flex',
      alignItems: 'center',
      gap: 4,
    },
    idLink: {
      cursor: 'pointer',
      fontWeight: 500,
    },
    statusBadge: {
      display: 'inline-block',
      padding: '1px 8px',
      borderRadius: 10,
      fontSize: 10,
      fontWeight: 500,
    },
    edgeTypeBadge: {
      fontSize: 9,
      fontFamily: "'JetBrains Mono', monospace",
      fontWeight: 500,
      padding: '1px 5px',
      borderRadius: 3,
      background: t.bgMuted,
      color: t.textSecondary,
      border: `1px solid ${t.border}`,
    },
    loadingDot: {
      color: t.textMuted,
      fontSize: 10,
    },
    addColCell: {
      flex: '0 0 60px',
      color: t.accent,
      cursor: 'pointer',
      fontSize: 10,
      fontWeight: 500,
      justifyContent: 'center',
    },
    removeColBtn: {
      marginLeft: 4,
      color: t.textMuted,
      cursor: 'pointer',
      fontSize: 12,
      lineHeight: 1,
    },
    moreRow: {
      padding: '4px 10px',
    },
    moreBtn: {
      fontSize: 11,
      color: t.accent,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: 0,
      fontFamily: "'JetBrains Mono', monospace",
    },
  };
}
