import { useEffect, useState, useMemo, useRef } from 'react';
import { useEoStore } from '../store/eo-store';
import { useViewStore } from '../store/view-store';
import { VIEW_TYPE_META, type SavedView, type ViewType } from './view-types';
import { buildTree, formatName, type TreeNode } from './scope-picker-utils';
import { useTheme, type Theme } from '../theme';

interface ViewsBrowserProps {
  onBack: () => void;
  onSelectView: (view: SavedView) => void;
}

export function ViewsBrowser({ onBack, onSelectView }: ViewsBrowserProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const registerSavedViews = useViewStore((s) => s.registerSavedViews);
  const savedViews = useViewStore((s) => s.savedViews);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [tables, setTables] = useState<TreeNode[]>([]);
  const hasLoadedOnce = useRef(false);

  // Load tables and saved views
  useEffect(() => {
    if (!ready) return;
    if (!hasLoadedOnce.current) setLoading(true);

    getStateByPrefix('').then((states) => {
      // Build tree to discover tables
      const tree = buildTree(states, '');
      setTables(tree);

      // Auto-expand all tables on first load
      if (!hasLoadedOnce.current) {
        setExpanded(new Set(tree.map((n) => n.fullPath)));
      }

      // Extract saved views
      const viewStates = states.filter(
        (st) => st.target.includes('._views.') && st.value?.name && !st.value?._deleted,
      );
      const views: SavedView[] = viewStates.map((st) => {
        const parts = st.target.split('._views.');
        const scope = parts[0];
        const viewId = parts[1];
        return {
          id: viewId,
          name: st.value.name,
          scope,
          viewType: st.value.viewType || 'grid',
          config: st.value.config || {
            columnOrder: [],
            columnWidths: {},
            hiddenColumns: [],
            sorts: [],
            filters: [],
            filterConjunction: 'AND',
            showLastUpdated: true,
          },
          visibility: st.value.visibility || 'shared',
          createdBy: st.value.createdBy || st.last_agent,
          createdAt: st.value.createdAt || st.last_ts,
          updatedAt: st.value.updatedAt || st.last_ts,
          roomId: st.value.roomId,
        };
      });
      if (views.length > 0) {
        registerSavedViews(views);
      }
      hasLoadedOnce.current = true;
      setLoading(false);
    });
  }, [ready, lastSeq, getStateByPrefix, registerSavedViews]);

  // Group saved views by scope
  const viewsByScope = useMemo(() => {
    const map = new Map<string, SavedView[]>();
    for (const view of Object.values(savedViews)) {
      const list = map.get(view.scope);
      if (list) list.push(view);
      else map.set(view.scope, [view]);
    }
    // Sort each group by name
    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return map;
  }, [savedViews]);

  function toggleTable(fullPath: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  }

  // Create a synthetic "default grid view" SavedView for a scope
  function makeDefaultView(scope: string): SavedView {
    return {
      id: '',
      name: 'Grid view',
      scope,
      viewType: 'grid',
      config: {
        columnOrder: [],
        columnWidths: {},
        hiddenColumns: [],
        sorts: [],
        filters: [],
        filterConjunction: 'AND',
        showLastUpdated: true,
      },
      visibility: 'shared',
      createdBy: '',
      createdAt: '',
      updatedAt: '',
    };
  }

  return (
    <div style={s.container}>
      <div style={s.header}>
        <button onClick={onBack} style={s.backBtn}>{'\u2190'} Back</button>
        <span style={s.title}>Tables</span>
      </div>

      {loading ? (
        <div style={s.empty}>Loading...</div>
      ) : tables.length === 0 ? (
        <div style={s.empty}>
          <span style={{ opacity: 0.4, fontSize: 18 }}>{'\u229E'}</span>
          <span>No tables yet</span>
          <span style={{ fontSize: 10, color: theme.textMuted }}>
            Import data to create tables
          </span>
        </div>
      ) : (
        <div style={s.scroll}>
          {tables.map((node) => {
            const isExpanded = expanded.has(node.fullPath);
            const scopeViews = viewsByScope.get(node.fullPath) || [];

            return (
              <div key={node.fullPath}>
                {/* Table row */}
                <div
                  style={s.tableRow}
                  onClick={() => toggleTable(node.fullPath)}
                >
                  <span style={s.chevron}>
                    {isExpanded ? '\u25BE' : '\u25B8'}
                  </span>
                  <span style={s.tableIcon}>{'\u229E'}</span>
                  <span style={s.tableLabel}>
                    {formatName(node.segment)}
                  </span>
                  {node.childCount > 0 && (
                    <span style={s.badge}>{node.childCount}</span>
                  )}
                </div>

                {/* Views under this table */}
                {isExpanded && (
                  <>
                    {/* Default grid view — always present */}
                    <div
                      style={s.viewItem}
                      onClick={() => onSelectView(makeDefaultView(node.fullPath))}
                    >
                      <span style={s.viewIcon}>{VIEW_TYPE_META.grid.icon}</span>
                      <span style={s.viewName}>Grid view</span>
                    </div>

                    {/* Saved views */}
                    {scopeViews.map((view) => {
                      const vtMeta = VIEW_TYPE_META[(view.viewType || 'grid') as ViewType];
                      return (
                        <div
                          key={view.id}
                          style={s.viewItem}
                          onClick={() => onSelectView(view)}
                        >
                          <span style={s.viewIcon}>{vtMeta.icon}</span>
                          {view.visibility === 'private' && (
                            <span style={{ fontSize: 10, marginRight: 2 }}>{'\uD83D\uDD12'}</span>
                          )}
                          <span style={s.viewName}>{view.name}</span>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      overflow: 'hidden',
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 12px',
      borderBottom: `1px solid ${t.border}`,
      flexShrink: 0,
    },
    backBtn: {
      background: 'none',
      border: 'none',
      color: t.accent,
      cursor: 'pointer',
      fontSize: 12,
      fontWeight: 500,
      padding: '2px 6px',
      borderRadius: 4,
    },
    title: {
      fontSize: 11,
      fontWeight: 600,
      color: t.textHeading,
      letterSpacing: '0.3px',
    },
    scroll: {
      flex: 1,
      overflowY: 'auto',
      padding: '4px 0',
    },
    empty: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      padding: '32px 16px',
      fontSize: 12,
      color: t.textSecondary,
    },
    tableRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '8px 12px',
      cursor: 'pointer',
      fontSize: 12,
      fontWeight: 600,
      color: t.textHeading,
      userSelect: 'none',
    },
    chevron: {
      fontSize: 10,
      width: 12,
      flexShrink: 0,
      color: t.textMuted,
    },
    tableIcon: {
      fontSize: 13,
      opacity: 0.7,
    },
    tableLabel: {
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    badge: {
      fontSize: 10,
      color: t.textMuted,
      fontWeight: 400,
      background: t.border,
      borderRadius: 8,
      padding: '1px 6px',
      minWidth: 18,
      textAlign: 'center',
    },
    viewItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '5px 12px 5px 36px',
      cursor: 'pointer',
      borderRadius: 4,
      margin: '0 4px',
      fontSize: 12,
      fontWeight: 400,
      color: t.text,
      transition: 'background 0.1s',
    },
    viewIcon: {
      fontSize: 11,
      opacity: 0.6,
      flexShrink: 0,
    },
    viewName: {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  };
}
