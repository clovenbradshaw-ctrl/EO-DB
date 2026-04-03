import { useState, useEffect } from 'react';
import { useViewStore } from '../store/view-store';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import type { SavedView, TableViewConfig } from './view-types';

interface ViewTabsProps {
  scope: string;
  session: { userId: string };
}

export function ViewTabs({ scope, session }: ViewTabsProps) {
  const viewStore = useViewStore();
  const dispatch = useEoStore((s) => s.dispatch);
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const sig = viewStore.getSig(scope);
  const savedViews = viewStore.getViewsForScope(scope);

  const [showNameInput, setShowNameInput] = useState(false);
  const [newViewName, setNewViewName] = useState('');
  const [newViewVisibility, setNewViewVisibility] = useState<'private' | 'shared'>('private');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; viewId: string } | null>(null);

  // Load saved views from DB
  useEffect(() => {
    if (!ready) return;
    getStateByPrefix(`${scope}._views.`).then((states) => {
      const viewDepth = scope.split('.').length + 2; // scope._views.viewId
      const views: SavedView[] = states
        .filter((st) => st.target.split('.').length === viewDepth && st.value?.name)
        .map((st) => ({
          id: st.target.split('.').pop()!,
          name: st.value.name,
          scope,
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
      viewStore.registerSavedViews(views);
    });
  }, [ready, lastSeq, getStateByPrefix, scope, viewStore]);

  async function handleSaveNew() {
    if (!newViewName.trim()) return;
    const viewId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const config = sig.config;
    const now = new Date().toISOString();

    try {
      await dispatch({
        op: 'INS',
        target: `${scope}._views.${viewId}`,
        operand: {
          name: newViewName.trim(),
          config,
          visibility: newViewVisibility,
          createdBy: session.userId,
          createdAt: now,
          updatedAt: now,
        },
        agent: `user:${session.userId}`,
        ts: now,
        acquired_ts: now,
        client_event_id: crypto.randomUUID(),
      });

      const savedView: SavedView = {
        id: viewId,
        name: newViewName.trim(),
        scope,
        config,
        visibility: newViewVisibility,
        createdBy: session.userId,
        createdAt: now,
        updatedAt: now,
      };
      viewStore.registerSavedViews([savedView]);
      viewStore.markSaved(scope, viewId);
    } catch { /* ignore */ }

    setShowNameInput(false);
    setNewViewName('');
  }

  async function handleUpdateView() {
    if (!sig.activeViewId) return;
    const now = new Date().toISOString();
    try {
      await dispatch({
        op: 'DEF',
        target: `${scope}._views.${sig.activeViewId}`,
        operand: {
          config: sig.config,
          updatedAt: now,
        },
        agent: `user:${session.userId}`,
        ts: now,
        acquired_ts: now,
      });
      // Update in-memory saved view
      const existing = viewStore.savedViews[sig.activeViewId];
      if (existing) {
        viewStore.registerSavedViews([{ ...existing, config: sig.config, updatedAt: now }]);
      }
      viewStore.markSaved(scope, sig.activeViewId);
    } catch { /* ignore */ }
  }

  async function handleDeleteView(viewId: string) {
    try {
      await dispatch({
        op: 'DEF',
        target: `${scope}._views.${viewId}`,
        operand: { _deleted: true },
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
    } catch { /* ignore */ }
    viewStore.removeSavedView(viewId);
    if (sig.activeViewId === viewId) {
      viewStore.resetToDefault(scope);
    }
  }

  async function handleRename(viewId: string) {
    if (!renameValue.trim()) { setRenaming(null); return; }
    const now = new Date().toISOString();
    try {
      await dispatch({
        op: 'DEF',
        target: `${scope}._views.${viewId}`,
        operand: { name: renameValue.trim(), updatedAt: now },
        agent: `user:${session.userId}`,
        ts: now,
        acquired_ts: now,
      });
      const existing = viewStore.savedViews[viewId];
      if (existing) {
        viewStore.registerSavedViews([{ ...existing, name: renameValue.trim(), updatedAt: now }]);
      }
    } catch { /* ignore */ }
    setRenaming(null);
  }

  async function handleDuplicate(viewId: string) {
    const source = viewStore.savedViews[viewId];
    if (!source) return;
    const newId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const now = new Date().toISOString();
    const newName = `${source.name} (copy)`;
    try {
      await dispatch({
        op: 'INS',
        target: `${scope}._views.${newId}`,
        operand: {
          name: newName,
          config: source.config,
          visibility: source.visibility,
          createdBy: session.userId,
          createdAt: now,
          updatedAt: now,
        },
        agent: `user:${session.userId}`,
        ts: now,
        acquired_ts: now,
        client_event_id: crypto.randomUUID(),
      });
      viewStore.registerSavedViews([{
        ...source, id: newId, name: newName, createdBy: session.userId, createdAt: now, updatedAt: now,
      }]);
    } catch { /* ignore */ }
  }

  async function handleToggleVisibility(viewId: string) {
    const view = viewStore.savedViews[viewId];
    if (!view) return;
    const newVis = view.visibility === 'private' ? 'shared' : 'private';
    const now = new Date().toISOString();
    try {
      await dispatch({
        op: 'DEF',
        target: `${scope}._views.${viewId}`,
        operand: { visibility: newVis, updatedAt: now },
        agent: `user:${session.userId}`,
        ts: now,
        acquired_ts: now,
      });
      viewStore.registerSavedViews([{ ...view, visibility: newVis, updatedAt: now }]);
    } catch { /* ignore */ }
  }

  function getCtxMenuItems(viewId: string): ContextMenuItem[] {
    const view = viewStore.savedViews[viewId];
    if (!view) return [];
    return [
      {
        label: 'Rename',
        onClick: () => { setRenaming(viewId); setRenameValue(view.name); setCtxMenu(null); },
      },
      {
        label: 'Duplicate',
        onClick: () => { handleDuplicate(viewId); setCtxMenu(null); },
      },
      {
        label: view.visibility === 'private' ? 'Make shared' : 'Make private',
        onClick: () => { handleToggleVisibility(viewId); setCtxMenu(null); },
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Delete view',
        onClick: () => { handleDeleteView(viewId); setCtxMenu(null); },
      },
    ];
  }

  return (
    <div style={s.container}>
      {/* Default view tab */}
      <button
        style={sig.activeViewId === null ? s.tabActive : s.tab}
        onClick={() => viewStore.resetToDefault(scope)}
      >
        {'\u25A6'} Grid view
      </button>

      {/* Saved view tabs */}
      {savedViews.filter((v) => !viewStore.savedViews[v.id]?.scope || viewStore.savedViews[v.id]?.scope === scope).map((view) => (
        <button
          key={view.id}
          style={sig.activeViewId === view.id ? s.tabActive : s.tab}
          onClick={() => viewStore.activateView(scope, view)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu({ x: e.clientX, y: e.clientY, viewId: view.id });
          }}
        >
          {renaming === view.id ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename(view.id);
                if (e.key === 'Escape') setRenaming(null);
              }}
              onBlur={() => handleRename(view.id)}
              onClick={(e) => e.stopPropagation()}
              style={s.renameInput}
            />
          ) : (
            <>
              {view.visibility === 'private' && <span style={{ marginRight: 4, fontSize: 10 }}>{'\uD83D\uDD12'}</span>}
              {view.name}
              {sig.activeViewId === view.id && sig.dirty && (
                <span style={s.dirtyDot} title="Unsaved changes" />
              )}
            </>
          )}
        </button>
      ))}

      {/* Save / Update button */}
      {sig.dirty && (
        sig.activeViewId ? (
          <button style={s.saveBtn} onClick={handleUpdateView}>
            Save
          </button>
        ) : (
          <button style={s.saveBtn} onClick={() => setShowNameInput(true)}>
            Save as view
          </button>
        )
      )}

      {/* New view button */}
      <button style={s.addBtn} onClick={() => setShowNameInput(true)} title="Create new view">
        +
      </button>

      {/* New view name input popover */}
      {showNameInput && (
        <>
          <div style={s.overlay} onClick={() => setShowNameInput(false)} />
          <div style={s.popover}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: theme.textHeading }}>
              New view
            </div>
            <input
              autoFocus
              value={newViewName}
              onChange={(e) => setNewViewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveNew(); if (e.key === 'Escape') setShowNameInput(false); }}
              placeholder="View name..."
              style={s.nameInput}
            />
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
            <button style={s.createBtn} onClick={handleSaveNew} disabled={!newViewName.trim()}>
              Create view
            </button>
          </div>
        </>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={getCtxMenuItems(ctxMenu.viewId)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

// --- Styles ---

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  const tabBase: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 500,
    border: 'none',
    borderBottom: '2px solid transparent',
    background: 'none',
    color: t.textMuted,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    position: 'relative',
  };

  return {
    container: {
      display: 'flex',
      alignItems: 'center',
      gap: 0,
      padding: '0 16px',
      borderBottom: `0.5px solid ${t.border}`,
      background: t.bgCard,
      overflowX: 'auto',
      flexShrink: 0,
    },
    tab: tabBase,
    tabActive: {
      ...tabBase,
      color: t.accent,
      borderBottomColor: t.accent,
      fontWeight: 600,
    },
    dirtyDot: {
      display: 'inline-block',
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: t.accent,
      marginLeft: 4,
    },
    addBtn: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 24,
      height: 24,
      fontSize: 14,
      fontWeight: 600,
      border: 'none',
      borderRadius: 4,
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
      marginLeft: 4,
    },
    saveBtn: {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '4px 10px',
      fontSize: 11,
      fontWeight: 600,
      border: `1px solid ${t.accent}`,
      borderRadius: 4,
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
      marginLeft: 8,
      whiteSpace: 'nowrap',
    },
    overlay: {
      position: 'fixed' as const,
      inset: 0,
      zIndex: 9998,
    },
    popover: {
      position: 'absolute' as const,
      top: '100%',
      left: 16,
      zIndex: 9999,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      padding: 16,
      boxShadow: `0 8px 30px ${t.shadow}`,
      minWidth: 220,
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
    createBtn: {
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
    renameInput: {
      fontSize: 12,
      fontWeight: 500,
      border: `1px solid ${t.accent}`,
      borderRadius: 3,
      padding: '2px 6px',
      background: t.bgCard,
      color: t.text,
      outline: 'none',
      width: 100,
    },
  };
}
