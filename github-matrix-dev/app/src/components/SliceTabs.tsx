import { useState, useEffect } from 'react';
import { useSliceStore } from '../store/slice-store';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { SLICE_TYPE_META, type SavedSlice, type TableSliceConfig, type SliceType } from './slice-types';
import { deriveColumns, type ColumnDef } from './filter-types';
import { formatName } from './scope-picker-utils';
import type { UserTypeDefinition } from '../permissions/types';

// Injected stylesheet for the Chrome-style tab strip. Uses CSS custom
// properties (set inline on the strip container) so hover states can adapt
// to the current theme without re-injection. Idempotent.
const SLICE_TABS_STYLE_ID = 'eo-slice-tabs-style';
if (typeof document !== 'undefined' && !document.getElementById(SLICE_TABS_STYLE_ID)) {
  const el = document.createElement('style');
  el.id = SLICE_TABS_STYLE_ID;
  el.textContent = `
    .eo-slice-tabs-strip::-webkit-scrollbar { display: none; }
    .eo-tab {
      transition: background 140ms ease, color 140ms ease;
    }
    .eo-tab:hover:not(.eo-tab-active) {
      background: var(--eo-tab-hover-bg);
      color: var(--eo-tab-hover-color);
    }
    .eo-tab-group-actions .eo-tab-action {
      opacity: 0;
      transition: opacity 140ms ease, background 140ms ease, color 140ms ease;
    }
    .eo-tab-group:hover .eo-tab-group-actions .eo-tab-action,
    .eo-tab-group-actions .eo-tab-action.eo-tab-action--visible {
      opacity: 0.85;
    }
    .eo-tab-group-actions .eo-tab-action:hover {
      opacity: 1 !important;
      background: var(--eo-tab-action-hover-bg) !important;
      color: var(--eo-tab-action-hover-color) !important;
    }
    .eo-tab-add {
      transition: background 140ms ease, color 140ms ease;
    }
    .eo-tab-add:hover {
      background: var(--eo-tab-hover-bg);
      color: var(--eo-tab-hover-color);
    }
  `;
  document.head.appendChild(el);
}

interface SliceTabsProps {
  /** All scopes that have open tabs */
  openScopes: string[];
  /** Currently active/selected scope */
  activeScope: string;
  /** Callback when user clicks a tab from a different collection */
  onSelectScope: (scope: string) => void;
  /** Callback when user closes all tabs for a collection */
  onCloseScope: (scope: string) => void;
  session: { userId: string };
  /** Currently active user type ID (for filtering type-scoped slices) */
  activeUserType?: string | null;
  /** All user type definitions for the current space (for the type selector UI) */
  userTypeDefinitions?: UserTypeDefinition[];
  /** Whether the current user is admin+ (can set type visibility on slices) */
  canManageSlices?: boolean;
}

export function SliceTabs({ openScopes, activeScope, onSelectScope, onCloseScope, session, activeUserType, userTypeDefinitions, canManageSlices }: SliceTabsProps) {
  const sliceStore = useSliceStore();
  // Stable selector for the loader effect — using `sliceStore` directly in
  // useEffect deps causes an infinite loop after a slice is created, because
  // calling registerSavedSlices() inside the effect triggers a store update,
  // which produces a new sliceStore reference, which retriggers the effect.
  const registerSavedSlices = useSliceStore((s) => s.registerSavedSlices);
  const dispatch = useEoStore((s) => s.dispatch);
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  // Use activeScope for operations that need a single scope context
  const scope = activeScope;
  const sig = sliceStore.getSig(scope);
  const savedSlices = sliceStore.getSlicesForScope(scope);

  const [showNameInput, setShowNameInput] = useState(false);
  const [newSliceName, setNewSliceName] = useState('');
  const [newSliceType, setNewSliceType] = useState<SliceType>('grid');
  const [newSliceVisibility, setNewSliceVisibility] = useState<'private' | 'shared'>('shared');
  const [newVisibleToTypes, setNewVisibleToTypes] = useState<string[]>([]);
  const [newReadOnlyForTypes, setNewReadOnlyForTypes] = useState<string[]>([]);
  const [newKanbanField, setNewKanbanField] = useState('');
  const [newCalendarField, setNewCalendarField] = useState('');
  const [scopeColumns, setScopeColumns] = useState<ColumnDef[]>([]);
  const [fieldUniqueCounts, setFieldUniqueCounts] = useState<Record<string, number>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sliceId: string } | null>(null);
  const [scopeCtxMenu, setScopeCtxMenu] = useState<{ x: number; y: number; scope: string } | null>(null);

  // Load saved slices from DB for all open scopes
  useEffect(() => {
    if (!ready) return;
    for (const sc of openScopes) {
      getStateByPrefix(`${sc}._slices.`).then((states) => {
        const sliceDepth = sc.split('.').length + 2; // scope._slices.sliceId
        const slices: SavedSlice[] = states
          .filter((st) => st.target.split('.').length === sliceDepth && st.value?.name)
          .map((st) => ({
            id: st.target.split('.').pop()!,
            name: st.value.name,
            scope: sc,
            sliceType: st.value.sliceType || 'grid',
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
            visibleToTypes: st.value.visibleToTypes,
            readOnlyForTypes: st.value.readOnlyForTypes,
          }));
        if (slices.length > 0) registerSavedSlices(slices);
      });
    }
  }, [ready, lastSeq, getStateByPrefix, openScopes, registerSavedSlices]);

  // Derive available columns for kanban field selection
  useEffect(() => {
    if (!ready || !scope || !showNameInput) return;
    const scopeDepth = scope.split('.').length + 1;
    getStateByPrefix(scope + '.').then((states) => {
      const records = states.filter(
        (st) =>
          st.target.split('.').length === scopeDepth &&
          !st.target.includes('._') &&
          st.value != null,
      );
      setScopeColumns(deriveColumns(records));

      const counts: Record<string, Set<string>> = {};
      for (const rec of records) {
        if (!rec.value || typeof rec.value !== 'object') continue;
        const source = rec.value.fields && typeof rec.value.fields === 'object' && !Array.isArray(rec.value.fields)
          ? rec.value.fields as Record<string, any>
          : rec.value;
        for (const [key, val] of Object.entries(source)) {
          if (key.startsWith('_')) continue;
          if (!counts[key]) counts[key] = new Set();
          if (val != null) counts[key].add(String(val));
        }
      }
      const numericCounts: Record<string, number> = {};
      for (const [key, set] of Object.entries(counts)) {
        numericCounts[key] = set.size;
      }
      setFieldUniqueCounts(numericCounts);
    });
  }, [ready, scope, showNameInput, getStateByPrefix]);

  async function handleSaveNew() {
    if (!newSliceName.trim()) return;
    if (newSliceType === 'kanban' && !newKanbanField) return;
    if (newSliceType === 'calendar' && !newCalendarField) return;
    const sliceId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const config: TableSliceConfig = {
      ...sig.config,
      ...(newSliceType === 'kanban' && newKanbanField ? { kanbanField: newKanbanField } : {}),
      ...(newSliceType === 'calendar' && newCalendarField ? { calendarField: newCalendarField } : {}),
    };
    const now = new Date().toISOString();

    try {
      await dispatch({
        op: 'INS',
        target: `${scope}._slices.${sliceId}`,
        operand: {
          name: newSliceName.trim(),
          sliceType: newSliceType,
          config,
          visibility: newSliceVisibility,
          createdBy: session.userId,
          createdAt: now,
          updatedAt: now,
          ...(newVisibleToTypes.length > 0 ? { visibleToTypes: newVisibleToTypes } : {}),
          ...(newReadOnlyForTypes.length > 0 ? { readOnlyForTypes: newReadOnlyForTypes } : {}),
        },
        agent: `user:${session.userId}`,
        ts: now,
        acquired_ts: now,
        client_event_id: crypto.randomUUID(),
      });

      const savedSlice: SavedSlice = {
        id: sliceId,
        name: newSliceName.trim(),
        scope,
        sliceType: newSliceType,
        config,
        visibility: newSliceVisibility,
        createdBy: session.userId,
        createdAt: now,
        updatedAt: now,
        visibleToTypes: newVisibleToTypes.length > 0 ? newVisibleToTypes : undefined,
        readOnlyForTypes: newReadOnlyForTypes.length > 0 ? newReadOnlyForTypes : undefined,
      };
      sliceStore.registerSavedSlices([savedSlice]);
      sliceStore.markSaved(scope, sliceId);
    } catch (err) {
      console.error('[SliceTabs] Failed to create slice:', err);
      // Still register optimistically — the fold may have succeeded
      const savedSlice: SavedSlice = {
        id: sliceId,
        name: newSliceName.trim(),
        scope,
        sliceType: newSliceType,
        config,
        visibility: newSliceVisibility,
        createdBy: session.userId,
        createdAt: now,
        updatedAt: now,
        visibleToTypes: newVisibleToTypes.length > 0 ? newVisibleToTypes : undefined,
        readOnlyForTypes: newReadOnlyForTypes.length > 0 ? newReadOnlyForTypes : undefined,
      };
      sliceStore.registerSavedSlices([savedSlice]);
      sliceStore.markSaved(scope, sliceId);
    }

    setShowNameInput(false);
    setNewSliceName('');
    setNewSliceType('grid');
    setNewKanbanField('');
    setNewCalendarField('');
    setNewVisibleToTypes([]);
    setNewReadOnlyForTypes([]);
  }

  async function handleUpdateSlice() {
    if (!sig.activeSliceId) return;
    const now = new Date().toISOString();
    try {
      await dispatch({
        op: 'DEF',
        target: `${scope}._slices.${sig.activeSliceId}`,
        operand: {
          config: sig.config,
          updatedAt: now,
        },
        agent: `user:${session.userId}`,
        ts: now,
        acquired_ts: now,
      });
      // Update in-memory saved slice
      const existing = sliceStore.savedSlices[sig.activeSliceId];
      if (existing) {
        sliceStore.registerSavedSlices([{ ...existing, config: sig.config, updatedAt: now }]);
      }
      sliceStore.markSaved(scope, sig.activeSliceId);
    } catch (err) { console.error('[SliceTabs] Failed to update slice:', err); }
  }

  async function handleDeleteSlice(sliceId: string) {
    try {
      await dispatch({
        op: 'DEF',
        target: `${scope}._slices.${sliceId}`,
        operand: { _deleted: true },
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
    } catch (err) { console.error('[SliceTabs] slice op failed:', err); }
    sliceStore.removeSavedSlice(sliceId);
    if (sig.activeSliceId === sliceId) {
      sliceStore.resetToDefault(scope);
    }
  }

  async function handleRename(sliceId: string) {
    if (!renameValue.trim()) { setRenaming(null); return; }
    const now = new Date().toISOString();
    try {
      await dispatch({
        op: 'DEF',
        target: `${scope}._slices.${sliceId}`,
        operand: { name: renameValue.trim(), updatedAt: now },
        agent: `user:${session.userId}`,
        ts: now,
        acquired_ts: now,
      });
      const existing = sliceStore.savedSlices[sliceId];
      if (existing) {
        sliceStore.registerSavedSlices([{ ...existing, name: renameValue.trim(), updatedAt: now }]);
      }
    } catch (err) { console.error('[SliceTabs] slice op failed:', err); }
    setRenaming(null);
  }

  async function handleDuplicate(sliceId: string) {
    const source = sliceStore.savedSlices[sliceId];
    if (!source) return;
    const newId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const now = new Date().toISOString();
    const newName = `${source.name} (copy)`;
    try {
      await dispatch({
        op: 'INS',
        target: `${scope}._slices.${newId}`,
        operand: {
          name: newName,
          sliceType: source.sliceType || 'grid',
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
      sliceStore.registerSavedSlices([{
        ...source, id: newId, name: newName, createdBy: session.userId, createdAt: now, updatedAt: now,
      }]);
    } catch (err) { console.error('[SliceTabs] slice op failed:', err); }
  }

  async function handleToggleVisibility(sliceId: string) {
    const slice = sliceStore.savedSlices[sliceId];
    if (!slice) return;
    const newVis = slice.visibility === 'private' ? 'shared' : 'private';
    const now = new Date().toISOString();
    try {
      await dispatch({
        op: 'DEF',
        target: `${scope}._slices.${sliceId}`,
        operand: { visibility: newVis, updatedAt: now },
        agent: `user:${session.userId}`,
        ts: now,
        acquired_ts: now,
      });
      sliceStore.registerSavedSlices([{ ...slice, visibility: newVis, updatedAt: now }]);
    } catch (err) { console.error('[SliceTabs] slice op failed:', err); }
  }

  function activateSchemaForScope(sc: string) {
    sliceStore.activateSlice(sc, {
      id: '__schema', name: 'Schema', scope: sc, sliceType: 'schema',
      config: { columnOrder: [], columnWidths: {}, hiddenColumns: [], sorts: [], filters: [], filterConjunction: 'AND', showLastUpdated: false },
      visibility: 'shared', createdBy: '', createdAt: '', updatedAt: '',
    });
  }

  function getScopeCtxMenuItems(sc: string): ContextMenuItem[] {
    const scSig = sliceStore.getSig(sc);
    const isSchema = scSig.activeSliceId === '__schema';
    const collectionName = formatName(sc.split('.').pop() || sc);
    return [
      { label: collectionName, onClick: () => {}, header: true },
      {
        label: `${SLICE_TYPE_META.grid.icon} Grid view`,
        onClick: () => {
          if (sc !== activeScope) onSelectScope(sc);
          sliceStore.resetToDefault(sc);
          setScopeCtxMenu(null);
        },
        disabled: scSig.activeSliceId === null,
      },
      {
        label: `${SLICE_TYPE_META.schema.icon} View schema`,
        onClick: () => {
          if (sc !== activeScope) onSelectScope(sc);
          activateSchemaForScope(sc);
          setScopeCtxMenu(null);
        },
        disabled: isSchema,
      },
    ];
  }

  function getCtxMenuItems(sliceId: string): ContextMenuItem[] {
    const slice = sliceStore.savedSlices[sliceId];
    if (!slice) return [];
    return [
      {
        label: 'Rename',
        onClick: () => { setRenaming(sliceId); setRenameValue(slice.name); setCtxMenu(null); },
      },
      {
        label: 'Duplicate',
        onClick: () => { handleDuplicate(sliceId); setCtxMenu(null); },
      },
      {
        label: slice.visibility === 'private' ? 'Make shared' : 'Make private',
        onClick: () => { handleToggleVisibility(sliceId); setCtxMenu(null); },
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Delete slice',
        onClick: () => { handleDeleteSlice(sliceId); setCtxMenu(null); },
      },
    ];
  }

  // CSS custom properties read by the injected stylesheet. Setting them on
  // the strip container lets hover states use the current theme without
  // re-injecting CSS on theme change.
  const stripVars = {
    '--eo-tab-hover-bg': theme.borderLight,
    '--eo-tab-hover-color': theme.textHeading,
    '--eo-tab-action-hover-bg': theme.border,
    '--eo-tab-action-hover-color': theme.textHeading,
  } as React.CSSProperties;

  return (
    <div style={s.wrapper}>
      <div className="eo-slice-tabs-strip" style={{ ...s.container, ...stripVars }}>
        {openScopes.map((sc, idx) => {
          const scSig = sliceStore.getSig(sc);
          const scSavedSlices = sliceStore.getSlicesForScope(sc);
          const collectionName = formatName(sc.split('.').pop() || sc);
          const isActive = sc === activeScope;
          const isPinned = sliceStore.isPinned(sc);

          const handleTabClick = (activateFn: () => void) => {
            if (!isActive) onSelectScope(sc);
            activateFn();
          };

          const groupStyle: React.CSSProperties = {
            ...s.group,
            ...(idx > 0 ? { marginLeft: 6 } : {}),
            ...(!isPinned ? { fontStyle: 'italic' } : {}),
          };

          return (
            <div key={sc} className="eo-tab-group" style={groupStyle}>
              {/* Grid tab — right-click opens schema/slice context menu */}
              <button
                className={`eo-tab${isActive && (scSig.activeSliceId === null || scSig.activeSliceId === '__schema') ? ' eo-tab-active' : ''}`}
                style={isActive && (scSig.activeSliceId === null || scSig.activeSliceId === '__schema') ? s.tabActive : s.tab}
                onClick={() => handleTabClick(() => sliceStore.resetToDefault(sc))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setScopeCtxMenu({ x: e.clientX, y: e.clientY, scope: sc });
                }}
              >
                <span style={s.tabIcon}>
                  {isActive && scSig.activeSliceId === '__schema'
                    ? SLICE_TYPE_META.schema.icon
                    : SLICE_TYPE_META.grid.icon}
                </span>
                <span style={s.tabCollectionLabel}>{collectionName}</span>
                <span style={s.tabSeparator}>/</span>
                <span style={s.tabViewLabel}>
                  {isActive && scSig.activeSliceId === '__schema' ? 'Schema' : 'Grid'}
                </span>
              </button>

              {/* Saved slice tabs — filtered by active user type */}
              {scSavedSlices.filter((v) => {
                if (sliceStore.savedSlices[v.id]?.scope && sliceStore.savedSlices[v.id]?.scope !== sc) return false;
                const vt = v.visibleToTypes;
                if (vt && vt.length > 0 && activeUserType && !vt.includes(activeUserType)) return false;
                return true;
              }).map((slice) => {
                const vtMeta = SLICE_TYPE_META[slice.sliceType || 'grid'];
                const sliceActive = isActive && scSig.activeSliceId === slice.id;
                return (
                  <button
                    key={slice.id}
                    className={`eo-tab${sliceActive ? ' eo-tab-active' : ''}`}
                    style={sliceActive ? s.tabActive : s.tab}
                    onClick={() => handleTabClick(() => sliceStore.activateSlice(sc, slice))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtxMenu({ x: e.clientX, y: e.clientY, sliceId: slice.id });
                    }}
                  >
                    {renaming === slice.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRename(slice.id);
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                        onBlur={() => handleRename(slice.id)}
                        onClick={(e) => e.stopPropagation()}
                        style={s.renameInput}
                      />
                    ) : (
                      <>
                        <span style={s.tabIcon}>{vtMeta.icon}</span>
                        {slice.visibility === 'private' && <span style={s.tabLockIcon}>{'\uD83D\uDD12'}</span>}
                        <span style={s.tabCollectionLabel}>{collectionName}</span>
                        <span style={s.tabSeparator}>/</span>
                        <span style={s.tabViewLabel}>{slice.name}</span>
                        {sliceActive && scSig.dirty && (
                          <span style={s.dirtyDot} title="Unsaved changes" />
                        )}
                      </>
                    )}
                  </button>
                );
              })}

              {/* Pin / Close action buttons — revealed on group hover */}
              <div className="eo-tab-group-actions" style={s.groupActions}>
                <button
                  className={`eo-tab-action${isPinned ? ' eo-tab-action--visible' : ''}`}
                  style={isPinned ? s.pinBtnActive : s.pinBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isPinned) sliceStore.unpinScope(sc);
                    else sliceStore.pinScope(sc);
                  }}
                  title={isPinned ? `Unpin ${collectionName}` : `Pin ${collectionName}`}
                >
                  {'\uD83D\uDCCC'}
                </button>
                {openScopes.length > 1 && (
                  <button
                    className="eo-tab-action"
                    style={s.closeBtn}
                    onClick={(e) => { e.stopPropagation(); onCloseScope(sc); }}
                    title={`Close ${collectionName} tabs`}
                  >
                    {'\u00D7'}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* Save / Update button — only for active scope */}
        {sig.dirty && (
          sig.activeSliceId ? (
            <button style={s.saveBtn} onClick={handleUpdateSlice}>
              Save
            </button>
          ) : (
            <button style={s.saveBtn} onClick={() => setShowNameInput(true)}>
              Save as slice
            </button>
          )
        )}

        {/* New slice button */}
        <button className="eo-tab-add" style={s.addBtn} onClick={() => setShowNameInput(true)} title="Create new slice">
          +
        </button>
      </div>

      {/* New slice name input popover — rendered outside the scrolling container so it isn't clipped */}
      {showNameInput && (
        <>
          <div style={s.overlay} onClick={() => setShowNameInput(false)} />
          <div style={s.popover}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: theme.textHeading }}>
              New slice
            </div>
            <input
              autoFocus
              value={newSliceName}
              onChange={(e) => setNewSliceName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveNew(); if (e.key === 'Escape') setShowNameInput(false); }}
              placeholder="Slice name..."
              style={s.nameInput}
            />
            {/* Slice type selector */}
            <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' as const }}>
              {(Object.keys(SLICE_TYPE_META) as SliceType[])
                .filter((vt) => vt !== 'record') /* record slices are created via the detail panel's Pin button, not here */
                .map((vt) => {
                const meta = SLICE_TYPE_META[vt];
                const active = newSliceType === vt;
                return (
                  <button
                    key={vt}
                    type="button"
                    onClick={() => setNewSliceType(vt)}
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
            {/* Calendar field selection */}
            {newSliceType === 'calendar' && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 500, color: theme.textSecondary, marginBottom: 4 }}>
                  Date field
                </div>
                <select
                  value={newCalendarField}
                  onChange={(e) => setNewCalendarField(e.target.value)}
                  style={{
                    width: '100%',
                    height: 32,
                    fontSize: 12,
                    padding: '0 8px',
                    border: `1px solid ${theme.border}`,
                    borderRadius: 4,
                    background: theme.bgCard,
                    color: theme.text,
                    outline: 'none',
                    boxSizing: 'border-box' as const,
                    cursor: 'pointer',
                  }}
                >
                  <option value="">Select a field{'\u2026'}</option>
                  {scopeColumns
                    .filter((col) => col.type === 'date' || col.type === 'createdTime' || col.type === 'lastModifiedTime')
                    .map((col) => (
                      <option key={col.key} value={col.key}>
                        {col.label}
                      </option>
                    ))}
                </select>
                {scopeColumns.filter((col) => col.type === 'date' || col.type === 'createdTime' || col.type === 'lastModifiedTime').length === 0 && (
                  <div style={{
                    marginTop: 4,
                    padding: '4px 8px',
                    fontSize: 11,
                    color: '#b45309',
                    background: '#fef3c7',
                    border: '1px solid #fde68a',
                    borderRadius: 4,
                  }}>
                    No date fields detected on this table.
                  </div>
                )}
              </div>
            )}
            {/* Kanban field selection */}
            {newSliceType === 'kanban' && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 500, color: theme.textSecondary, marginBottom: 4 }}>
                  Group by field
                </div>
                <select
                  value={newKanbanField}
                  onChange={(e) => setNewKanbanField(e.target.value)}
                  style={{
                    width: '100%',
                    height: 32,
                    fontSize: 12,
                    padding: '0 8px',
                    border: `1px solid ${theme.border}`,
                    borderRadius: 4,
                    background: theme.bgCard,
                    color: theme.text,
                    outline: 'none',
                    boxSizing: 'border-box' as const,
                    cursor: 'pointer',
                  }}
                >
                  <option value="">Select a field{'\u2026'}</option>
                  {scopeColumns.map((col) => (
                    <option key={col.key} value={col.key}>
                      {col.label}{fieldUniqueCounts[col.key] != null ? ` (${fieldUniqueCounts[col.key]} values)` : ''}
                    </option>
                  ))}
                </select>
                {newKanbanField && fieldUniqueCounts[newKanbanField] > 15 && (
                  <div style={{
                    marginTop: 4,
                    padding: '4px 8px',
                    fontSize: 11,
                    color: '#b45309',
                    background: '#fef3c7',
                    border: '1px solid #fde68a',
                    borderRadius: 4,
                  }}>
                    This field has {fieldUniqueCounts[newKanbanField]} unique values. Kanban boards work best with 15 or fewer columns.
                  </div>
                )}
              </div>
            )}
            {/* Visibility */}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                style={newSliceVisibility === 'private' ? s.visBtnActive : s.visBtn}
                onClick={() => setNewSliceVisibility('private')}
              >
                {'\uD83D\uDD12'} Private
              </button>
              <button
                type="button"
                style={newSliceVisibility === 'shared' ? s.visBtnActive : s.visBtn}
                onClick={() => setNewSliceVisibility('shared')}
              >
                {'\uD83D\uDD13'} Shared
              </button>
            </div>
            {/* User type visibility — admin+ only */}
            {canManageSlices && userTypeDefinitions && userTypeDefinitions.length > 0 && (
              <>
                <div style={{ fontSize: 10, fontWeight: 600, marginTop: 10, marginBottom: 4, color: theme.textMuted, textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>
                  Visible to types
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                  {userTypeDefinitions.map((ut) => {
                    const selected = newVisibleToTypes.includes(ut.id);
                    return (
                      <button
                        key={ut.id}
                        type="button"
                        onClick={() => setNewVisibleToTypes(prev =>
                          selected ? prev.filter(id => id !== ut.id) : [...prev, ut.id]
                        )}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 3,
                          padding: '3px 8px', fontSize: 10, fontWeight: selected ? 600 : 400,
                          border: `1px solid ${selected ? (ut.color || theme.accent) : theme.border}`,
                          borderRadius: 10, cursor: 'pointer',
                          background: selected ? `${ut.color || theme.accent}18` : 'transparent',
                          color: selected ? (ut.color || theme.accent) : theme.textSecondary,
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                      >
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: ut.color || '#6b7280' }} />
                        {ut.label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 9, color: theme.textMuted, marginTop: 2 }}>
                  {newVisibleToTypes.length === 0 ? 'All types can see this slice' : `Only selected types see this slice`}
                </div>

                <div style={{ fontSize: 10, fontWeight: 600, marginTop: 8, marginBottom: 4, color: theme.textMuted, textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>
                  Read-only for types
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                  {userTypeDefinitions.map((ut) => {
                    const selected = newReadOnlyForTypes.includes(ut.id);
                    return (
                      <button
                        key={ut.id}
                        type="button"
                        onClick={() => setNewReadOnlyForTypes(prev =>
                          selected ? prev.filter(id => id !== ut.id) : [...prev, ut.id]
                        )}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 3,
                          padding: '3px 8px', fontSize: 10, fontWeight: selected ? 600 : 400,
                          border: `1px solid ${selected ? theme.warning : theme.border}`,
                          borderRadius: 10, cursor: 'pointer',
                          background: selected ? `${theme.warning}18` : 'transparent',
                          color: selected ? theme.warning : theme.textSecondary,
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                      >
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: ut.color || '#6b7280' }} />
                        {ut.label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 9, color: theme.textMuted, marginTop: 2 }}>
                  {newReadOnlyForTypes.length === 0 ? 'No type restrictions' : `Selected types can view but not edit`}
                </div>
              </>
            )}
            <button style={(!newSliceName.trim() || (newSliceType === 'kanban' && !newKanbanField) || (newSliceType === 'calendar' && !newCalendarField)) ? s.createBtnDisabled : s.createBtn} onClick={handleSaveNew} disabled={!newSliceName.trim() || (newSliceType === 'kanban' && !newKanbanField) || (newSliceType === 'calendar' && !newCalendarField)}>
              Create slice
            </button>
          </div>
        </>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={getCtxMenuItems(ctxMenu.sliceId)}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* Scope (grid tab) context menu */}
      {scopeCtxMenu && (
        <ContextMenu
          x={scopeCtxMenu.x}
          y={scopeCtxMenu.y}
          items={getScopeCtxMenuItems(scopeCtxMenu.scope)}
          onClose={() => setScopeCtxMenu(null)}
        />
      )}
    </div>
  );
}

// --- Styles ---

const TAB_HEIGHT = 32;
const TAB_RADIUS = 8;
const STRIP_PADDING_TOP = 6;

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  const tabBase: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 14px',
    height: TAB_HEIGHT,
    minWidth: 0,
    maxWidth: 240,
    fontSize: 12,
    fontWeight: 500,
    border: 'none',
    borderTopLeftRadius: TAB_RADIUS,
    borderTopRightRadius: TAB_RADIUS,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    background: 'transparent',
    color: t.textSecondary,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    position: 'relative' as const,
    outline: 'none',
  };

  return {
    wrapper: {
      position: 'relative' as const,
      flexShrink: 0,
    },
    container: {
      display: 'flex',
      alignItems: 'flex-end',
      gap: 0,
      padding: `${STRIP_PADDING_TOP}px 12px 0 12px`,
      // height = padding-top + tab + border-bottom so the tab row fits exactly
      // inside the content box (box-sizing: border-box).
      height: TAB_HEIGHT + STRIP_PADDING_TOP + 1,
      background: t.bgMuted,
      borderBottom: `1px solid ${t.border}`,
      boxSizing: 'border-box' as const,
      overflowX: 'auto',
      overflowY: 'hidden',
      flexShrink: 0,
      flexWrap: 'nowrap',
      scrollbarWidth: 'none' as const,
      msOverflowStyle: 'none' as const,
    },
    group: {
      display: 'inline-flex',
      alignItems: 'flex-end',
      gap: 0,
      position: 'relative' as const,
    },
    groupActions: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 2,
      height: TAB_HEIGHT,
      paddingLeft: 4,
      paddingRight: 2,
    },
    tab: tabBase,
    tabActive: {
      ...tabBase,
      background: t.bgCard,
      color: t.textHeading,
      fontWeight: 600,
      boxShadow: `inset 1px 0 0 0 ${t.border}, inset -1px 0 0 0 ${t.border}, inset 0 1px 0 0 ${t.border}`,
      zIndex: 2,
    },
    tabIcon: {
      fontSize: 11,
      opacity: 0.75,
      flexShrink: 0,
    },
    tabLockIcon: {
      fontSize: 10,
      marginRight: 2,
      flexShrink: 0,
    },
    tabCollectionLabel: {
      opacity: 0.55,
      fontSize: 10,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      maxWidth: 110,
    },
    tabSeparator: {
      opacity: 0.4,
      fontSize: 11,
    },
    tabViewLabel: {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
    closeBtn: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 18,
      height: 18,
      fontSize: 14,
      lineHeight: 1,
      fontWeight: 500,
      border: 'none',
      borderRadius: '50%',
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
      padding: 0,
      flexShrink: 0,
    },
    pinBtn: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 18,
      height: 18,
      fontSize: 10,
      border: 'none',
      borderRadius: '50%',
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
      padding: 0,
      flexShrink: 0,
      transform: 'rotate(45deg)',
    },
    pinBtnActive: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 18,
      height: 18,
      fontSize: 10,
      border: 'none',
      borderRadius: '50%',
      background: t.accentBg,
      color: t.accent,
      cursor: 'pointer',
      padding: 0,
      flexShrink: 0,
    },
    dirtyDot: {
      display: 'inline-block',
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: t.accent,
      marginLeft: 4,
      flexShrink: 0,
    },
    addBtn: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 26,
      height: 26,
      fontSize: 16,
      fontWeight: 500,
      lineHeight: 1,
      border: 'none',
      borderRadius: '50%',
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
      marginLeft: 6,
      marginBottom: 3,
      padding: 0,
      flexShrink: 0,
    },
    saveBtn: {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '5px 12px',
      fontSize: 11,
      fontWeight: 600,
      border: `1px solid ${t.accent}`,
      borderRadius: 999,
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
      marginLeft: 10,
      marginBottom: 4,
      whiteSpace: 'nowrap',
      flexShrink: 0,
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
    createBtnDisabled: {
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
