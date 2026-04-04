import { useEffect, useState, useMemo } from 'react';
import { useEoStore } from '../store/eo-store';
import { useViewStore } from '../store/view-store';
import { VIEW_TYPE_META, type SavedView, type ViewType } from './view-types';
import { formatName } from './scope-picker-utils';
import { useTheme, type Theme } from '../theme';

interface ViewsBrowserProps {
  onBack: () => void;
  onSelectView: (view: SavedView) => void;
}

export function ViewsBrowser({ onBack, onSelectView }: ViewsBrowserProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const viewStore = useViewStore();
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const [expanded, setExpanded] = useState<Set<ViewType>>(new Set(['grid']));
  const [loading, setLoading] = useState(true);

  // Bulk-load all saved views across all scopes
  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    getStateByPrefix('').then((states) => {
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
        viewStore.registerSavedViews(views);
      }
      setLoading(false);
    });
  }, [ready, lastSeq, getStateByPrefix, viewStore]);

  // Group saved views by viewType
  const grouped = useMemo(() => {
    const allViews = Object.values(viewStore.savedViews);
    const map = new Map<ViewType, SavedView[]>();
    for (const vt of Object.keys(VIEW_TYPE_META) as ViewType[]) {
      map.set(vt, []);
    }
    for (const view of allViews) {
      const type = (view.viewType || 'grid') as ViewType;
      const list = map.get(type);
      if (list) {
        list.push(view);
      } else {
        map.get('grid')!.push(view);
      }
    }
    // Sort each group by name
    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return map;
  }, [viewStore.savedViews]);

  function toggleFolder(vt: ViewType) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(vt)) next.delete(vt);
      else next.add(vt);
      return next;
    });
  }

  const totalViews = Object.values(viewStore.savedViews).length;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <button onClick={onBack} style={s.backBtn}>{'\u2190'} Back</button>
        <span style={s.title}>Saved Views</span>
      </div>

      {loading ? (
        <div style={s.empty}>Loading views...</div>
      ) : totalViews === 0 ? (
        <div style={s.empty}>
          <span style={{ opacity: 0.4, fontSize: 18 }}>{'\u25A6'}</span>
          <span>No saved views yet</span>
          <span style={{ fontSize: 10, color: theme.textMuted }}>
            Save a view from the table toolbar
          </span>
        </div>
      ) : (
        <div style={s.scroll}>
          {(Object.keys(VIEW_TYPE_META) as ViewType[]).map((vt) => {
            const meta = VIEW_TYPE_META[vt];
            const views = grouped.get(vt) || [];
            const isExpanded = expanded.has(vt);
            const isEmpty = views.length === 0;

            return (
              <div key={vt}>
                <div
                  style={{
                    ...s.folder,
                    ...(isEmpty ? { opacity: 0.5 } : {}),
                  }}
                  onClick={() => !isEmpty && toggleFolder(vt)}
                >
                  <span style={s.chevron}>
                    {isEmpty ? '\u00A0\u00A0' : isExpanded ? '\u25BE' : '\u25B8'}
                  </span>
                  <span style={s.folderIcon}>{meta.icon}</span>
                  <span style={s.folderLabel}>{meta.label}</span>
                  <span style={s.folderCount}>({views.length})</span>
                </div>

                {isExpanded && views.map((view) => (
                  <div
                    key={view.id}
                    style={s.viewItem}
                    onClick={() => onSelectView(view)}
                  >
                    <div style={s.viewName}>
                      {view.visibility === 'private' && (
                        <span style={{ marginRight: 4, fontSize: 10 }}>{'\uD83D\uDD12'}</span>
                      )}
                      {view.name}
                    </div>
                    <div style={s.viewScope}>
                      {formatName(view.scope.split('.').pop() || view.scope)}
                    </div>
                  </div>
                ))}
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
    folder: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '8px 12px',
      cursor: 'pointer',
      fontSize: 12,
      fontWeight: 500,
      color: t.textHeading,
      userSelect: 'none',
    },
    chevron: {
      fontSize: 10,
      width: 12,
      flexShrink: 0,
      color: t.textMuted,
    },
    folderIcon: {
      fontSize: 13,
      opacity: 0.7,
    },
    folderLabel: {
      flex: 1,
    },
    folderCount: {
      fontSize: 10,
      color: t.textMuted,
      fontWeight: 400,
    },
    viewItem: {
      padding: '6px 12px 6px 36px',
      cursor: 'pointer',
      borderRadius: 4,
      margin: '0 4px',
      transition: 'background 0.1s',
    },
    viewName: {
      fontSize: 12,
      fontWeight: 500,
      color: t.text,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    viewScope: {
      fontSize: 10,
      color: t.textMuted,
      marginTop: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  };
}
