import { useEffect, useState, useMemo, useRef } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import type { FilterDefinition } from './filter-types';
import { useTheme, type Theme } from '../theme';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { TypeSelector, TypeBadge } from './TypeSelector';
import { buildTree, formatName, type TreeNode } from './scope-picker-utils';
import { useSliceStore } from '../store/slice-store';
import { Modal } from './Modal';
import { usePanelPosition } from '../hooks/usePanelPosition';
import { SLICE_TYPE_META, createDefaultConfig, type SliceType, type SavedSlice } from './slice-types';

function navCacheKey(prefix: string): string {
  return `eo-nav-cache:${prefix}`;
}

interface HolonNavProps {
  selectedScope: string | null;
  onSelectScope: (scope: string) => void;
  onSelectSegment?: (scope: string, segment: FilterDefinition) => void;
  /** Prefix to scope which records are loaded. Empty string = all records. */
  statePrefix?: string;
  /** Matrix user ID — needed for creating slices. */
  userId?: string;
}

export function HolonNav({ selectedScope, onSelectScope, onSelectSegment, statePrefix = '', userId }: HolonNavProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const getState = useEoStore((s) => s.getState);
  const dispatch = useEoStore((s) => s.dispatch);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const [allStates, setAllStates] = useState<EoState[]>(() => {
    try {
      const raw = localStorage.getItem(navCacheKey(statePrefix));
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const prevStatesKeyRef = useRef<string>('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: string } | null>(null);
  const [typeSelector, setTypeSelector] = useState<{ x: number; y: number; target: string; currentType?: string } | null>(null);
  const [renaming, setRenaming] = useState<{ target: string; currentName: string } | null>(null);
  /** When set, only this top-level entity type is shown (drill-down mode) */
  const [focusedEntity, setFocusedEntity] = useState<string | null>(null);
  const sliceStore = useSliceStore();

  // --- Create-slice inline form state ---
  const [showCreateSlice, setShowCreateSlice] = useState(false);
  const [newSliceName, setNewSliceName] = useState('');
  const [newSliceType, setNewSliceType] = useState<SliceType>('grid');
  const [newSliceVisibility, setNewSliceVisibility] = useState<'private' | 'shared'>('shared');
  const [creating, setCreating] = useState(false);
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const typeSelectorPos = usePanelPosition({
    open: !!typeSelector,
    placement: 'bottom-start',
    virtualAnchor: typeSelector ? { x: typeSelector.x, y: typeSelector.y } : null,
    estimatedWidth: 220,
    estimatedHeight: 280,
  });

  useEffect(() => {
    if (!ready) return; // keep cached allStates when not ready
    getStateByPrefix(statePrefix).then((states) => {
      const key = states.map(s => s.target + ':' + s.last_seq).join('|');
      if (key !== prevStatesKeyRef.current) {
        prevStatesKeyRef.current = key;
        setAllStates(states);
        try { localStorage.setItem(navCacheKey(statePrefix), JSON.stringify(states)); } catch { /* quota */ }
      }
    });
  }, [ready, lastSeq, getStateByPrefix, statePrefix]);

  // Reset expansion and drill-down when space changes; hydrate from cache
  useEffect(() => {
    setExpanded(new Set());
    setFocusedEntity(null);
    setShowCreateSlice(false);
    try {
      const raw = localStorage.getItem(navCacheKey(statePrefix));
      if (raw) setAllStates(JSON.parse(raw));
      else setAllStates([]);
    } catch { setAllStates([]); }
  }, [statePrefix]);

  const tree = useMemo(() => buildTree(allStates, statePrefix), [allStates, statePrefix]);

  // Auto-expand root on first load
  useEffect(() => {
    if (tree.length > 0 && expanded.size === 0) {
      setExpanded(new Set(tree.map(n => n.fullPath)));
    }
  }, [tree, expanded.size]);

  // When entering drill-down mode, auto-expand the focused entity
  useEffect(() => {
    if (focusedEntity) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(focusedEntity);
        return next;
      });
    }
  }, [focusedEntity]);

  function toggleExpand(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function handleContextMenu(e: React.MouseEvent, fullPath: string) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, target: fullPath });
  }

  function openTypeSelector(target: string, x: number, y: number) {
    const state = allStates.find((s) => s.target === target);
    setTypeSelector({ x, y, target, currentType: state?.value?._type });
    setContextMenu(null);
  }

  async function handleRename(target: string, newName: string) {
    try {
      await dispatch({
        op: 'DEF',
        target,
        operand: { name: newName || undefined },
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
    } catch { /* ignore */ }
    setRenaming(null);
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

  function resetCreateForm() {
    setNewSliceName('');
    setNewSliceType('grid');
    setNewSliceVisibility('shared');
    setShowCreateSlice(false);
  }

  async function handleCreateSlice() {
    if (!focusedEntity || !newSliceName.trim() || creating || !userId) return;
    setCreating(true);
    const sliceId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const now = new Date().toISOString();
    const config = createDefaultConfig();
    const name = newSliceName.trim();
    try {
      await dispatch({
        op: 'INS',
        target: `${focusedEntity}._slices.${sliceId}`,
        operand: {
          name,
          sliceType: newSliceType,
          config,
          visibility: newSliceVisibility,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        },
        agent: `user:${userId}`,
        ts: now,
        acquired_ts: now,
        client_event_id: crypto.randomUUID(),
      });
    } catch (err) {
      console.error('[HolonNav] Failed to create slice:', err);
    }
    const savedSlice: SavedSlice = {
      id: sliceId,
      name,
      scope: focusedEntity,
      sliceType: newSliceType,
      config,
      visibility: newSliceVisibility,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };
    sliceStore.registerSavedSlices([savedSlice]);
    sliceStore.activateSlice(focusedEntity, savedSlice);
    onSelectScope(focusedEntity);
    resetCreateForm();
    setCreating(false);
  }

  function getContextMenuItems(target: string): ContextMenuItem[] {
    const state = allStates.find((s) => s.target === target);
    const currentName = state?.value?.name || '';
    return [
      {
        label: currentName ? `Rename (${currentName})` : 'Set display name...',
        onClick: () => {
          setRenaming({ target, currentName });
          setContextMenu(null);
        },
      },
      {
        label: state?.value?._type ? `Change type (${state.value._type})` : 'Set page type...',
        onClick: () => openTypeSelector(target, contextMenu!.x, contextMenu!.y),
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Copy target path',
        onClick: () => navigator.clipboard.writeText(target),
      },
    ];
  }

  function resolveDisplayName(node: TreeNode, parentDisplayField?: string): string {
    // 1. Explicit name on the node itself (set via DEF or manual rename)
    if (node.state?.value?.name) return node.state.value.name;
    // 2. Parent's _displayField tells us which field to use from this node's fields
    if (parentDisplayField && node.state?.value?.fields) {
      const fieldVal = node.state.value.fields[parentDisplayField];
      if (fieldVal != null) return String(fieldVal);
    }
    // 3. Fallback to formatted segment name
    return formatName(node.segment);
  }

  function renderNode(node: TreeNode, depth: number, parentDisplayField?: string, isTopLevel?: boolean) {
    const isActive = selectedScope === node.fullPath;
    const isExpanded = expanded.has(node.fullPath);
    const hasChildren = node.children.length > 0;

    return (
      <div key={node.fullPath}>
        <div
          style={{
            ...s.item,
            paddingLeft: 12 + depth * 16,
            ...(isActive ? s.itemActive : {}),
          }}
          onClick={() => {
            onSelectScope(node.fullPath);
            // Default to grid view when clicking a collection
            sliceStore.resetToDefault(node.fullPath);
            sliceStore.openScope(node.fullPath);
            // Drill-down: clicking a top-level entity focuses it
            if (isTopLevel && !focusedEntity) {
              setFocusedEntity(node.fullPath);
            }
          }}
          onContextMenu={(e) => handleContextMenu(e, node.fullPath)}
        >
          {/* Expand/collapse chevron */}
          <span
            style={s.chevron}
            onClick={(e) => {
              e.stopPropagation();
              if (hasChildren) toggleExpand(node.fullPath);
            }}
          >
            {hasChildren ? (isExpanded ? '\u25BE' : '\u25B8') : '\u00A0\u00A0'}
          </span>

          <span style={s.name}>
            {resolveDisplayName(node, parentDisplayField)}
          </span>

          {/* Type badge */}
          {(() => {
            const type = node.state?.value?._type;
            return type ? <TypeBadge type={type} /> : null;
          })()}

          {node.childCount > 0 && (
            <span style={s.count}>{node.childCount}</span>
          )}
          {node.conCount > 0 && (
            <span style={s.countCon}>{node.conCount} CON</span>
          )}
          {node.segCount > 0 && (
            <span style={s.countSeg}>{node.segCount} SEG</span>
          )}
          {node.recCount > 0 && (
            <span style={s.countRec}>{node.recCount} REC</span>
          )}
          {node.derivedCount > 0 && (
            <span style={s.countDerived}>{node.derivedCount} L2+</span>
          )}
        </div>

        {/* Saved segments */}
        {isExpanded && node.segments && Object.entries(node.segments).map(([name, seg]) => (
          <div
            key={`seg:${name}`}
            style={{
              ...s.segItem,
              paddingLeft: 28 + depth * 16,
            }}
            onClick={() => onSelectSegment?.(node.fullPath, seg)}
          >
            <span style={s.segIcon}>
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M1 3h14M3 8h10M5 13h6" />
              </svg>
            </span>
            <span style={s.segName}>{name}</span>
          </div>
        ))}

        {/* Built-in Grid view */}
        {isExpanded && (() => {
          const sig = sliceStore.getSig(node.fullPath);
          const isGridActive = sig.activeSliceId === null && selectedScope === node.fullPath;
          return (
            <div
              style={{
                ...s.segItem,
                paddingLeft: 28 + depth * 16,
                ...(isGridActive ? { color: theme.accent, fontWeight: 600 } : {}),
              }}
              onClick={() => {
                sliceStore.resetToDefault(node.fullPath);
                onSelectScope(node.fullPath);
              }}
            >
              <span style={{ marginRight: 4, fontSize: 10, opacity: 0.6 }}>{SLICE_TYPE_META.grid.icon}</span>
              <span style={s.segName}>Grid view</span>
            </div>
          );
        })()}

        {/* Saved slices */}
        {isExpanded && (() => {
          const slices = sliceStore.getSlicesForScope(node.fullPath);
          if (slices.length === 0) return null;
          const sig = sliceStore.getSig(node.fullPath);
          return slices.map((slice) => (
            <div
              key={`slice:${slice.id}`}
              style={{
                ...s.segItem,
                paddingLeft: 28 + depth * 16,
                ...(sig.activeSliceId === slice.id ? { color: theme.accent, fontWeight: 600 } : {}),
              }}
              onClick={() => {
                sliceStore.activateSlice(node.fullPath, slice);
                onSelectScope(node.fullPath);
              }}
            >
              <span style={{ marginRight: 4, fontSize: 10, opacity: 0.6 }}>
                {slice.visibility === 'private' ? '\uD83D\uDD12' : '\u25A6'}
              </span>
              <span style={s.segName}>{slice.name}</span>
            </div>
          ));
        })()}

        {/* Children — pass this node's _displayField so children can resolve names */}
        {isExpanded && node.children.map(child =>
          renderNode(child, depth + 1, node.state?.value?._displayField, false)
        )}
      </div>
    );
  }

  // Find the focused top-level node
  const focusedNode = focusedEntity ? tree.find(n => n.fullPath === focusedEntity) : null;

  return (
    <div style={s.container}>
      <div style={s.scroll}>
        {allStates.length === 0 && (
          <div style={s.empty}>
            <span style={{ opacity: 0.4, fontSize: 18, marginBottom: 4 }}>{'\u2B1A'}</span>
            No objects yet
          </div>
        )}

        {/* Drill-down mode: show back button + focused entity only */}
        {focusedNode ? (
          <>
            <div
              style={{
                ...s.item,
                paddingLeft: 12,
                color: theme.textMuted,
                fontSize: 11,
                gap: 4,
              }}
              onClick={() => setFocusedEntity(null)}
            >
              <span style={{ fontSize: 10 }}>{'\u2190'}</span>
              <span>All records</span>
            </div>
            {renderNode(focusedNode, 0, undefined, false)}

            {/* + New slice button / inline form */}
            {!showCreateSlice ? (
              <div
                style={{
                  ...s.segItem,
                  paddingLeft: 28,
                  color: theme.accent,
                  fontWeight: 500,
                  marginTop: 4,
                }}
                onClick={() => setShowCreateSlice(true)}
              >
                <span style={{ fontSize: 12, opacity: 0.8 }}>+</span>
                <span style={s.segName}>New slice</span>
              </div>
            ) : (
              <div style={s.createSliceForm}>
                <input
                  autoFocus
                  value={newSliceName}
                  onChange={(e) => setNewSliceName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateSlice();
                    if (e.key === 'Escape') resetCreateForm();
                  }}
                  placeholder="Slice name..."
                  style={s.createSliceInput}
                />
                <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' as const }}>
                  {(Object.keys(SLICE_TYPE_META) as SliceType[]).map((vt) => {
                    const meta = SLICE_TYPE_META[vt];
                    const active = newSliceType === vt;
                    return (
                      <button
                        key={vt}
                        onClick={() => setNewSliceType(vt)}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 3,
                          padding: '3px 7px', fontSize: 10, fontWeight: active ? 600 : 400,
                          border: `1px solid ${active ? theme.accent : theme.border}`,
                          borderRadius: 4, cursor: 'pointer',
                          background: active ? theme.accentBg : 'transparent',
                          color: active ? theme.accent : theme.textSecondary,
                        }}
                      >
                        <span style={{ fontSize: 11 }}>{meta.icon}</span>
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button
                    style={newSliceVisibility === 'private' ? s.createSliceVisBtnActive : s.createSliceVisBtn}
                    onClick={() => setNewSliceVisibility('private')}
                  >
                    {'\uD83D\uDD12'} Private
                  </button>
                  <button
                    style={newSliceVisibility === 'shared' ? s.createSliceVisBtnActive : s.createSliceVisBtn}
                    onClick={() => setNewSliceVisibility('shared')}
                  >
                    {'\uD83D\uDD13'} Shared
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button style={s.createSliceCancelBtn} onClick={resetCreateForm}>Cancel</button>
                  <button
                    style={(!newSliceName.trim() || creating) ? s.createSliceSubmitBtnDisabled : s.createSliceSubmitBtn}
                    onClick={handleCreateSlice}
                    disabled={!newSliceName.trim() || creating}
                  >
                    {creating ? 'Creating...' : 'Create'}
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          tree.map(node => renderNode(node, 0, undefined, true))
        )}
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
          <div ref={typeSelectorPos.panelRef} style={{
            ...typeSelectorPos.style,
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

      {/* Rename dialog */}
      <Modal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title="Rename"
        width={320}
      >
        {renaming && (
          <>
            <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 4 }}>Display name</div>
            <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 8, fontFamily: "'JetBrains Mono', monospace" }}>
              {renaming.target}
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              const input = (e.target as HTMLFormElement).elements.namedItem('displayName') as HTMLInputElement;
              handleRename(renaming.target, input.value.trim());
            }}>
              <input
                name="displayName"
                autoFocus
                defaultValue={renaming.currentName}
                placeholder="Enter display name..."
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: 13,
                  border: `1px solid ${theme.border}`,
                  borderRadius: 4,
                  background: theme.bg,
                  color: theme.text,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setRenaming(null)}
                  style={{
                    padding: '4px 12px',
                    fontSize: 12,
                    border: `1px solid ${theme.border}`,
                    borderRadius: 4,
                    background: 'transparent',
                    color: theme.text,
                    cursor: 'pointer',
                  }}
                >Cancel</button>
                <button
                  type="submit"
                  style={{
                    padding: '4px 12px',
                    fontSize: 12,
                    border: 'none',
                    borderRadius: 4,
                    background: theme.accent,
                    color: '#fff',
                    cursor: 'pointer',
                  }}
                >Save</button>
              </div>
            </form>
          </>
        )}
      </Modal>
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      minHeight: 0,
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 16px 8px',
    },
    title: {
      fontWeight: 600, fontSize: 10, color: t.textMuted,
      textTransform: 'uppercase' as const, letterSpacing: '0.5px',
    },
    objectCount: {
      fontSize: 10,
      color: t.textMuted,
      background: t.bgMuted,
      padding: '1px 6px',
      borderRadius: 8,
      fontFamily: "'JetBrains Mono', monospace",
    },
    scroll: { flex: 1, overflowY: 'auto', padding: '2px 0' },
    empty: {
      display: 'flex',
      flexDirection: 'column' as const,
      alignItems: 'center',
      gap: 4,
      padding: '24px 16px',
      fontSize: 12,
      color: t.textMuted,
    },
    item: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      padding: '6px 16px',
      cursor: 'pointer',
      fontSize: 12,
      transition: 'background 0.1s',
    } as React.CSSProperties,
    itemActive: {
      background: t.accentBg,
      color: t.accent,
      borderRadius: 6,
      fontWeight: 500,
    } as React.CSSProperties,
    chevron: {
      fontSize: 10,
      color: t.textMuted,
      width: 14,
      flexShrink: 0,
      cursor: 'pointer',
      userSelect: 'none' as const,
      transition: 'color 0.1s',
    },
    name: {
      fontWeight: 'inherit' as any,
      color: 'inherit',
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    count: {
      fontSize: 10,
      color: t.textMuted,
      flexShrink: 0,
      fontFamily: "'JetBrains Mono', monospace",
    },
    countCon: {
      fontSize: 9,
      color: t.accent,
      background: t.accentBg,
      padding: '1px 6px',
      borderRadius: 8,
      flexShrink: 0,
      fontWeight: 500,
    },
    countSeg: {
      fontSize: 9,
      color: t.warning,
      background: t.warningBg,
      padding: '1px 6px',
      borderRadius: 8,
      flexShrink: 0,
      fontWeight: 500,
    },
    countRec: {
      fontSize: 9,
      color: t.danger,
      background: t.dangerBg,
      padding: '1px 6px',
      borderRadius: 8,
      flexShrink: 0,
      fontWeight: 500,
    },
    countDerived: {
      fontSize: 9,
      color: t.teal,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.tealBg,
      padding: '1px 6px',
      borderRadius: 8,
      flexShrink: 0,
      border: `1px dashed ${t.tealBorder}`,
    },
    segItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 16px',
      cursor: 'pointer',
      fontSize: 11,
      color: t.purple,
      transition: 'background 0.1s',
    } as React.CSSProperties,
    segIcon: {
      display: 'flex',
      alignItems: 'center',
      color: t.purple,
      flexShrink: 0,
      opacity: 0.7,
    },
    segName: {
      fontWeight: 500,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    createSliceForm: {
      margin: '6px 12px 4px',
      padding: 10,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
    },
    createSliceInput: {
      width: '100%',
      height: 28,
      fontSize: 11,
      padding: '0 8px',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgCard,
      color: t.text,
      outline: 'none',
      boxSizing: 'border-box' as const,
    },
    createSliceVisBtn: {
      flex: 1,
      padding: '4px 0',
      fontSize: 10,
      fontWeight: 500,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
    },
    createSliceVisBtnActive: {
      flex: 1,
      padding: '4px 0',
      fontSize: 10,
      fontWeight: 600,
      border: `1px solid ${t.accent}`,
      borderRadius: 4,
      background: t.accentBg,
      color: t.accent,
      cursor: 'pointer',
    },
    createSliceCancelBtn: {
      flex: 1,
      padding: '5px 0',
      fontSize: 11,
      fontWeight: 500,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: 'transparent',
      color: t.textSecondary,
      cursor: 'pointer',
    },
    createSliceSubmitBtn: {
      flex: 1,
      padding: '5px 0',
      fontSize: 11,
      fontWeight: 600,
      border: 'none',
      borderRadius: 4,
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
    },
    createSliceSubmitBtnDisabled: {
      flex: 1,
      padding: '5px 0',
      fontSize: 11,
      fontWeight: 600,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgMuted,
      color: t.textMuted,
      cursor: 'not-allowed',
      opacity: 0.6,
    },
  };
}
