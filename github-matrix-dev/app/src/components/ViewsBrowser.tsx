import { useEffect, useState, useMemo, useRef } from 'react';
import { useEoStore } from '../store/eo-store';
import { useViewStore } from '../store/view-store';
import { VIEW_TYPE_META, type SavedView, type TableViewConfig, type ViewType } from './view-types';
import { formatName } from './scope-picker-utils';
import { useTheme, type Theme } from '../theme';

interface ViewsBrowserProps {
  /** Current scope (object path). If null, the panel shows a "select an object" state. */
  scope: string | null;
  /** Number of records under the current scope (shown in the pinned chip). */
  recordCount: number;
  /** Matrix user ID — required for attributing created views. */
  userId: string;
  onBack: () => void;
  onSelectView: (view: SavedView) => void;
}

export function ViewsBrowser({ scope, recordCount, userId, onBack, onSelectView }: ViewsBrowserProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const dispatch = useEoStore((s) => s.dispatch);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const registerSavedViews = useViewStore((s) => s.registerSavedViews);
  const savedViews = useViewStore((s) => s.savedViews);
  const sig = useViewStore((s) => (scope ? s.getSig(scope) : null));
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const hasLoadedOnce = useRef(false);

  // --- Create-view popover state ---
  const [showCreate, setShowCreate] = useState(false);
  const [newViewName, setNewViewName] = useState('');
  const [newViewType, setNewViewType] = useState<ViewType>('grid');
  const [newViewVisibility, setNewViewVisibility] = useState<'private' | 'shared'>('private');
  const [creating, setCreating] = useState(false);

  // Load saved views for the current scope only
  useEffect(() => {
    if (!ready || !scope) {
      setLoading(false);
      return;
    }
    if (!hasLoadedOnce.current) setLoading(true);

    getStateByPrefix(`${scope}._views.`).then((states) => {
      const viewDepth = scope.split('.').length + 2; // scope._views.viewId
      const views: SavedView[] = states
        .filter(
          (st) =>
            st.target.split('.').length === viewDepth &&
            st.value?.name &&
            !st.value?._deleted,
        )
        .map((st) => ({
          id: st.target.split('.').pop()!,
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
        }));
      if (views.length > 0) {
        registerSavedViews(views);
      }
      hasLoadedOnce.current = true;
      setLoading(false);
    });
  }, [ready, lastSeq, getStateByPrefix, scope, registerSavedViews]);

  // Reset loaded flag when scope changes
  useEffect(() => {
    hasLoadedOnce.current = false;
  }, [scope]);

  // Views belonging to the current scope, filtered by search query
  const { personalViews, collaborativeViews } = useMemo(() => {
    if (!scope) return { personalViews: [], collaborativeViews: [] };
    const q = query.trim().toLowerCase();
    const all = Object.values(savedViews).filter(
      (v) => v.scope === scope && (!q || v.name.toLowerCase().includes(q)),
    );
    all.sort((a, b) => a.name.localeCompare(b.name));
    return {
      personalViews: all.filter((v) => v.visibility === 'private'),
      collaborativeViews: all.filter((v) => v.visibility === 'shared'),
    };
  }, [savedViews, scope, query]);

  // Synthetic default grid view (always shown under personal)
  function makeDefaultView(s: string): SavedView {
    return {
      id: '',
      name: 'Grid view',
      scope: s,
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

  const defaultMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return !q || 'grid view'.includes(q);
  }, [query]);

  function resetCreateForm() {
    setNewViewName('');
    setNewViewType('grid');
    setNewViewVisibility('private');
  }

  async function handleCreateView() {
    if (!scope || !newViewName.trim() || creating) return;
    setCreating(true);
    const viewId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const now = new Date().toISOString();
    const config: TableViewConfig = {
      columnOrder: [],
      columnWidths: {},
      hiddenColumns: [],
      sorts: [],
      filters: [],
      filterConjunction: 'AND',
      showLastUpdated: true,
    };
    const name = newViewName.trim();
    try {
      await dispatch({
        op: 'INS',
        target: `${scope}._views.${viewId}`,
        operand: {
          name,
          viewType: newViewType,
          config,
          visibility: newViewVisibility,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        },
        agent: `user:${userId}`,
        ts: now,
        acquired_ts: now,
        client_event_id: crypto.randomUUID(),
      });
      const savedView: SavedView = {
        id: viewId,
        name,
        scope,
        viewType: newViewType,
        config,
        visibility: newViewVisibility,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      };
      registerSavedViews([savedView]);
      setShowCreate(false);
      resetCreateForm();
      onSelectView(savedView);
    } catch (err) {
      console.error('[ViewsBrowser] Failed to create view:', err);
      // Still register the view optimistically — the fold may have succeeded
      // even if a downstream step (e.g. Matrix send) threw.
      const savedView: SavedView = {
        id: viewId,
        name,
        scope,
        viewType: newViewType,
        config,
        visibility: newViewVisibility,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      };
      registerSavedViews([savedView]);
      setShowCreate(false);
      resetCreateForm();
      onSelectView(savedView);
    } finally {
      setCreating(false);
    }
  }

  const scopeLabel = scope ? formatName(scope.split('.').pop() || scope) : '';
  const activeViewId = sig?.activeViewId ?? null;
  const defaultIsActive = scope != null && activeViewId == null;

  function renderViewRow(view: SavedView, isActive: boolean) {
    const vtMeta = VIEW_TYPE_META[(view.viewType || 'grid') as ViewType];
    const isPrivate = view.visibility === 'private';
    return (
      <div
        key={view.id || '__default__'}
        style={{ ...s.viewItem, ...(isActive ? s.viewItemActive : {}) }}
        onClick={() => onSelectView(view)}
      >
        <span style={{ ...s.viewIcon, ...(isActive ? { color: theme.accent } : {}) }}>
          {isPrivate ? '\uD83D\uDD12' : vtMeta.icon}
        </span>
        <span style={s.viewName}>{view.name}</span>
        <span style={s.viewBadge}>
          {isPrivate ? 'private' : vtMeta.label.toLowerCase()}
        </span>
      </div>
    );
  }

  return (
    <div style={s.container}>
      {/* Header: back arrow + title */}
      <div style={s.header}>
        <button onClick={onBack} style={s.backBtn} title="Back to navigation">
          {'\u2190'}
        </button>
        <span style={s.title}>Views</span>
      </div>

      {/* Search */}
      <div style={s.searchWrap}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a view\u2026"
          style={s.searchInput}
        />
      </div>

      {/* Scrollable list */}
      <div style={s.scroll}>
        {!scope ? (
          <div style={s.empty}>
            <span style={{ opacity: 0.4, fontSize: 18 }}>{'\u229E'}</span>
            <span>No object selected</span>
            <span style={{ fontSize: 10, color: theme.textMuted, textAlign: 'center' }}>
              Go back and select an object to browse its views.
            </span>
          </div>
        ) : loading ? (
          <div style={s.empty}>Loading\u2026</div>
        ) : (
          <>
            {/* Personal views */}
            <div style={s.sectionLabel}>Personal views</div>
            {defaultMatches && renderViewRow(makeDefaultView(scope), defaultIsActive)}
            {personalViews.map((v) => renderViewRow(v, v.id === activeViewId))}
            {!defaultMatches && personalViews.length === 0 && (
              <div style={s.sectionEmpty}>No matches</div>
            )}

            {/* Collaborative views */}
            {(collaborativeViews.length > 0 || query.trim() === '') && (
              <>
                <div style={{ ...s.sectionLabel, marginTop: 12 }}>Collaborative views</div>
                {collaborativeViews.length > 0 ? (
                  collaborativeViews.map((v) => renderViewRow(v, v.id === activeViewId))
                ) : (
                  <div style={s.sectionEmpty}>None yet</div>
                )}
              </>
            )}

            {/* Create a view — inline like Airtable */}
            {!showCreate ? (
              <button
                style={s.createBtn}
                onClick={() => setShowCreate(true)}
                title="Create a new view for this object"
              >
                + Create a view
              </button>
            ) : (
              <div style={s.inlineCreateForm}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: theme.textHeading }}>
                  New view
                </div>
                <input
                  autoFocus
                  value={newViewName}
                  onChange={(e) => setNewViewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateView();
                    if (e.key === 'Escape') { setShowCreate(false); resetCreateForm(); }
                  }}
                  placeholder="View name\u2026"
                  style={s.nameInput}
                />
                <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' as const }}>
                  {(Object.keys(VIEW_TYPE_META) as ViewType[]).map((vt) => {
                    const meta = VIEW_TYPE_META[vt];
                    const active = newViewType === vt;
                    return (
                      <button
                        key={vt}
                        onClick={() => setNewViewType(vt)}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '4px 8px', fontSize: 11, fontWeight: active ? 600 : 400,
                          border: `1px solid ${active ? theme.accent : theme.border}`,
                          borderRadius: 4, cursor: 'pointer',
                          background: active ? theme.accentBg : 'transparent',
                          color: active ? theme.accent : theme.textSecondary,
                        }}
                      >
                        <span style={{ fontSize: 12 }}>{meta.icon}</span>
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    style={newViewVisibility === 'private' ? s.visBtnActive : s.visBtn}
                    onClick={() => setNewViewVisibility('private')}
                  >
                    {'\uD83D\uDD12'} Private
                  </button>
                  <button
                    style={newViewVisibility === 'shared' ? s.visBtnActive : s.visBtn}
                    onClick={() => setNewViewVisibility('shared')}
                  >
                    {'\uD83D\uDD13'} Shared
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                  <button
                    style={s.inlineCancelBtn}
                    onClick={() => { setShowCreate(false); resetCreateForm(); }}
                  >
                    Cancel
                  </button>
                  <button
                    style={(!newViewName.trim() || creating) ? s.modalCreateBtnDisabled : s.modalCreateBtn}
                    onClick={handleCreateView}
                    disabled={!newViewName.trim() || creating}
                  >
                    {creating ? 'Creating\u2026' : 'Create view'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Pinned scope chip at bottom */}
      {scope && (
        <div style={s.scopeChipWrap}>
          <div style={s.scopeChip}>
            <span style={s.scopeChipName}>{scopeLabel}</span>
            <span style={s.scopeChipSep}>{'\u00B7'}</span>
            <span style={s.scopeChipMeta}>{recordCount} records</span>
          </div>
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
      minHeight: 0,
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '12px 14px 10px',
      flexShrink: 0,
    },
    backBtn: {
      background: 'none',
      border: 'none',
      color: t.text,
      cursor: 'pointer',
      fontSize: 16,
      lineHeight: 1,
      padding: '4px 6px',
      borderRadius: 4,
      display: 'flex',
      alignItems: 'center',
    },
    title: {
      fontSize: 14,
      fontWeight: 600,
      color: t.textHeading,
      flex: 1,
    },
    searchWrap: {
      padding: '0 12px 10px',
      flexShrink: 0,
    },
    searchInput: {
      width: '100%',
      padding: '6px 10px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: t.bgMuted,
      color: t.text,
      outline: 'none',
      boxSizing: 'border-box',
    } as React.CSSProperties,
    scroll: {
      flex: 1,
      overflowY: 'auto',
      padding: '4px 0 8px',
      minHeight: 0,
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
    sectionLabel: {
      fontSize: 10,
      fontWeight: 600,
      color: t.textMuted,
      letterSpacing: '0.5px',
      textTransform: 'uppercase' as const,
      padding: '8px 16px 4px',
    },
    sectionEmpty: {
      padding: '4px 16px 4px',
      fontSize: 11,
      color: t.textMuted,
      fontStyle: 'italic' as const,
    },
    viewItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 12px',
      margin: '0 6px',
      cursor: 'pointer',
      borderRadius: 6,
      fontSize: 12,
      color: t.text,
      transition: 'background 0.1s',
    } as React.CSSProperties,
    viewItemActive: {
      background: t.accentBg,
      color: t.accent,
      fontWeight: 500,
    } as React.CSSProperties,
    viewIcon: {
      fontSize: 12,
      opacity: 0.7,
      flexShrink: 0,
      width: 14,
      textAlign: 'center' as const,
      color: 'inherit',
    },
    viewName: {
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
      color: 'inherit',
    },
    viewBadge: {
      fontSize: 10,
      color: t.textMuted,
      flexShrink: 0,
      fontFamily: "'JetBrains Mono', monospace",
    },
    createBtn: {
      display: 'block',
      margin: '12px 12px 4px',
      padding: '6px 10px',
      background: 'none',
      border: 'none',
      color: t.accent,
      cursor: 'pointer',
      fontSize: 12,
      fontWeight: 500,
      textAlign: 'left' as const,
      borderRadius: 4,
    },
    scopeChipWrap: {
      padding: '8px 12px 12px',
      borderTop: `1px solid ${t.border}`,
      flexShrink: 0,
    },
    scopeChip: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 10px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      fontSize: 11,
    },
    scopeChipName: {
      fontFamily: "'JetBrains Mono', monospace",
      color: t.text,
      fontWeight: 500,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    scopeChipSep: {
      color: t.textMuted,
      flexShrink: 0,
    },
    scopeChipMeta: {
      color: t.textMuted,
      flexShrink: 0,
    },
    inlineCreateForm: {
      margin: '8px 12px 4px',
      padding: 12,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
    },
    inlineCancelBtn: {
      flex: 1,
      padding: '8px 0',
      fontSize: 12,
      fontWeight: 500,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: 'transparent',
      color: t.textSecondary,
      cursor: 'pointer',
    },
    nameInput: {
      width: '100%',
      height: 32,
      fontSize: 12,
      padding: '0 8px',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgCard,
      color: t.text,
      outline: 'none',
      boxSizing: 'border-box' as const,
    },
    visBtn: {
      flex: 1,
      padding: '6px 0',
      fontSize: 11,
      fontWeight: 500,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
    },
    visBtnActive: {
      flex: 1,
      padding: '6px 0',
      fontSize: 11,
      fontWeight: 600,
      border: `1px solid ${t.accent}`,
      borderRadius: 4,
      background: t.accentBg,
      color: t.accent,
      cursor: 'pointer',
    },
    modalCreateBtn: {
      width: '100%',
      marginTop: 12,
      padding: '8px 0',
      fontSize: 12,
      fontWeight: 600,
      border: `1px solid ${t.accent}`,
      borderRadius: 6,
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
    },
    modalCreateBtnDisabled: {
      width: '100%',
      marginTop: 12,
      padding: '8px 0',
      fontSize: 12,
      fontWeight: 600,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: t.bgMuted,
      color: t.textMuted,
      cursor: 'not-allowed',
      opacity: 0.6,
    },
  };
}
