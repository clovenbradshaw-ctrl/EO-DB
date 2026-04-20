import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import type { FilterDefinition } from './filter-types';
import type { PresenceUser } from '../matrix/presence';
import { useTheme, type Theme } from '../theme';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { TypeSelector, TypeBadge } from './TypeSelector';
import { buildTree, formatName, type TreeNode } from './scope-picker-utils';
import { useSliceStore } from '../store/slice-store';
import { Modal } from './Modal';
import { usePanelPosition } from '../hooks/usePanelPosition';
import { SLICE_TYPE_META, createDefaultConfig, type SliceType, type SavedSlice } from './slice-types';

// ---------------------------------------------------------------------------
// Nav Folders — client-side grouping of top-level tables
// ---------------------------------------------------------------------------

interface NavFolder {
  id: string;
  name: string;
  order: number;          // sort position among folders
  tablePaths: string[];   // fullPaths of tables assigned to this folder
}

interface NavFolderState {
  folders: NavFolder[];
}

function folderStorageKey(prefix: string): string {
  return `eo-nav-folders:${prefix}`;
}

function loadFolders(prefix: string): NavFolderState {
  try {
    const raw = localStorage.getItem(folderStorageKey(prefix));
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { folders: [] };
}

function saveFolders(prefix: string, state: NavFolderState) {
  try {
    localStorage.setItem(folderStorageKey(prefix), JSON.stringify(state));
  } catch { /* quota */ }
}

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
  /** Currently selected record target — highlights the matching leaf node. */
  selectedRecord?: string | null;
  /** Called when the user clicks an inline record leaf. */
  onSelectRecord?: (target: string) => void;
  /**
   * Map of scope fullPath → peers currently viewing that scope. Used to
   * render subtle indicators beside scope nodes. When omitted or empty,
   * no indicators are shown (the viewer has opted out or no peers are live).
   */
  peersByScope?: Map<string, PresenceUser[]>;
}

export function HolonNav({ selectedScope, onSelectScope, onSelectSegment, statePrefix = '', userId, selectedRecord, onSelectRecord, peersByScope }: HolonNavProps) {
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
  /** Stack of table paths navigated into; last entry is the current focused table */
  const [navStack, setNavStack] = useState<string[]>([]);
  const focusedEntity = navStack.length > 0 ? navStack[navStack.length - 1] : null;
  const sliceStore = useSliceStore();

  // --- Inline record expansion state ---

  // --- Folder state ---
  const [folderState, setFolderState] = useState<NavFolderState>(() => loadFolders(statePrefix));
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [renamingFolder, setRenamingFolder] = useState<{ id: string; currentName: string } | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<{ x: number; y: number; folderId: string } | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const updateFolders = useCallback((updater: (prev: NavFolderState) => NavFolderState) => {
    setFolderState((prev) => {
      const next = updater(prev);
      saveFolders(statePrefix, next);
      return next;
    });
  }, [statePrefix]);

  // Reset folders when space changes
  useEffect(() => {
    setFolderState(loadFolders(statePrefix));
    setExpandedFolders(new Set());
    setCreatingFolder(false);
  }, [statePrefix]);

  function createFolder(name: string) {
    if (!name.trim()) return;
    const maxOrder = folderState.folders.reduce((m, f) => Math.max(m, f.order), 0);
    updateFolders((prev) => ({
      folders: [...prev.folders, {
        id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
        name: name.trim(),
        order: maxOrder + 1,
        tablePaths: [],
      }],
    }));
    setCreatingFolder(false);
    setNewFolderName('');
  }

  function renameFolder(id: string, name: string) {
    updateFolders((prev) => ({
      folders: prev.folders.map(f => f.id === id ? { ...f, name: name.trim() || f.name } : f),
    }));
    setRenamingFolder(null);
  }

  function deleteFolder(id: string) {
    updateFolders((prev) => ({
      folders: prev.folders.filter(f => f.id !== id),
    }));
  }

  function moveTableToFolder(tablePath: string, folderId: string | null) {
    updateFolders((prev) => ({
      folders: prev.folders.map(f => {
        // Remove from any folder it's currently in
        const without = f.tablePaths.filter(p => p !== tablePath);
        // Add to target folder
        if (f.id === folderId) return { ...f, tablePaths: [...without, tablePath] };
        return { ...f, tablePaths: without };
      }),
    }));
  }

  function toggleFolderExpand(id: string) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
    setNavStack([]);
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
    // Check if this is a top-level node (can be moved to folders)
    const isTopLevel = tree.some(n => n.fullPath === target);
    const currentFolderId = folderState.folders.find(f => f.tablePaths.includes(target))?.id ?? null;

    const folderItems: ContextMenuItem[] = [];
    if (isTopLevel && sortedFolders.length > 0) {
      folderItems.push({ label: '', onClick: () => { /* noop */ }, separator: true } as ContextMenuItem);
      for (const folder of sortedFolders) {
        const isInThisFolder = folder.id === currentFolderId;
        folderItems.push({
          label: `${isInThisFolder ? '\u2713 ' : '\u2003'}${'\uD83D\uDCC1'} ${folder.name}`,
          onClick: () => {
            if (!isInThisFolder) moveTableToFolder(target, folder.id);
            setContextMenu(null);
          },
        });
      }
      if (currentFolderId) {
        folderItems.push({
          label: '\u2003Remove from folder',
          onClick: () => {
            moveTableToFolder(target, null);
            setContextMenu(null);
          },
        });
      }
    }

    return [
      {
        label: `${SLICE_TYPE_META.schema.icon} View schema`,
        onClick: () => {
          sliceStore.openScope(target);
          sliceStore.activateSlice(target, {
            id: '__schema', name: 'Schema', scope: target, sliceType: 'schema',
            config: { columnOrder: [], columnWidths: {}, hiddenColumns: [], sorts: [], filters: [], filterConjunction: 'AND', showLastUpdated: false },
            visibility: 'shared', createdBy: '', createdAt: '', updatedAt: '',
          });
          onSelectScope(target);
          setContextMenu(null);
        },
      },
      { label: '', onClick: () => { /* noop */ }, separator: true },
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
      ...folderItems,
      { label: '', onClick: () => { /* noop */ }, separator: true },
      {
        label: 'Copy target path',
        onClick: () => navigator.clipboard.writeText(target),
      },
    ];
  }

  function getFolderContextMenuItems(folderId: string): ContextMenuItem[] {
    const folder = folderState.folders.find(f => f.id === folderId);
    if (!folder) return [];
    return [
      {
        label: 'Rename folder',
        onClick: () => {
          setRenamingFolder({ id: folderId, currentName: folder.name });
          setFolderContextMenu(null);
        },
      },
      {
        label: 'Delete folder',
        onClick: () => {
          deleteFolder(folderId);
          setFolderContextMenu(null);
        },
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


  function renderNode(node: TreeNode, depth: number, parentDisplayField?: string) {
    const isActive = selectedScope === node.fullPath;
    const isExpanded = expanded.has(node.fullPath);
    const hasChildren = node.children.length > 0;
    const isTopLevel = depth === 0;

    // For top-level nodes, use content-visibility:auto so the browser can skip
    // rendering/layout for items outside the scroll viewport, keeping the sidebar
    // fast even with hundreds of top-level entities.
    const topLevelStyle: React.CSSProperties = isTopLevel && !isActive ? {
      contentVisibility: 'auto' as any,
      containIntrinsicSize: 'auto 32px' as any,
    } : {};

    return (
      <div key={node.fullPath} style={topLevelStyle}>
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
            // Drill-down: navigate into this table
            setNavStack(prev => {
              if (prev[prev.length - 1] === node.fullPath) return prev;
              return [...prev, node.fullPath];
            });
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

          {/* Presence indicator — subtle dot + initials stack when peers are viewing this scope */}
          {(() => {
            const here = peersByScope?.get(node.fullPath);
            if (!here || here.length === 0) return null;
            return <PeerPresenceMark peers={here} theme={theme} />;
          })()}

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


{/* Saved slices — only shown in drill-down mode */}
        {isExpanded && focusedEntity && (() => {
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
          renderNode(child, depth + 1, node.state?.value?._displayField)
        )}
      </div>
    );
  }

  // Find a node at any depth in the tree
  function findNodeInTree(nodes: TreeNode[], fullPath: string): TreeNode | null {
    for (const n of nodes) {
      if (n.fullPath === fullPath) return n;
      if (fullPath.startsWith(n.fullPath + '.')) {
        const found = findNodeInTree(n.children, fullPath);
        if (found) return found;
      }
    }
    return null;
  }

  // Find the focused node (may be at any depth)
  const focusedNode = focusedEntity ? findNodeInTree(tree, focusedEntity) : null;

  // Partition top-level nodes into folders vs ungrouped
  const sortedFolders = useMemo(() =>
    [...folderState.folders].sort((a, b) => a.order - b.order),
    [folderState.folders],
  );

  const allFolderedPaths = useMemo(() => {
    const set = new Set<string>();
    for (const f of folderState.folders) {
      for (const p of f.tablePaths) set.add(p);
    }
    return set;
  }, [folderState.folders]);

  const ungroupedNodes = useMemo(() =>
    tree.filter(n => !allFolderedPaths.has(n.fullPath)),
    [tree, allFolderedPaths],
  );

  function renderFolderHeader(folder: NavFolder) {
    const isFolderExpanded = expandedFolders.has(folder.id);
    const memberNodes = tree.filter(n => folder.tablePaths.includes(n.fullPath));
    return (
      <div key={`folder:${folder.id}`}>
        <div
          style={s.folderHeader}
          onClick={() => toggleFolderExpand(folder.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setFolderContextMenu({ x: e.clientX, y: e.clientY, folderId: folder.id });
          }}
        >
          <span style={s.chevron}>
            {isFolderExpanded ? '\u25BE' : '\u25B8'}
          </span>
          <span style={s.folderIcon}>{'\uD83D\uDCC1'}</span>
          <span style={s.folderName}>{folder.name}</span>
          <span style={s.count}>{memberNodes.length}</span>
        </div>
        {isFolderExpanded && memberNodes.map(node => renderNode(node, 1))}
      </div>
    );
  }

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
              onClick={() => setNavStack(prev => prev.slice(0, -1))}
            >
              <span style={{ fontSize: 10 }}>{'\u2190'}</span>
              <span>{navStack.length > 1 ? 'Back' : 'All records'}</span>
            </div>
            {renderNode(focusedNode, 0)}

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
          <>
            {/* Folders */}
            {sortedFolders.map(folder => renderFolderHeader(folder))}

            {/* + New folder inline form / button */}
            {!creatingFolder ? (
              <div
                style={s.newFolderBtn}
                onClick={() => setCreatingFolder(true)}
              >
                <span style={{ fontSize: 11, opacity: 0.7 }}>+</span>
                <span>New folder</span>
              </div>
            ) : (
              <div style={s.newFolderForm}>
                <input
                  autoFocus
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') createFolder(newFolderName);
                    if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName(''); }
                  }}
                  placeholder="Folder name..."
                  style={s.createSliceInput}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button style={s.createSliceCancelBtn} onClick={() => { setCreatingFolder(false); setNewFolderName(''); }}>Cancel</button>
                  <button
                    style={!newFolderName.trim() ? s.createSliceSubmitBtnDisabled : s.createSliceSubmitBtn}
                    onClick={() => createFolder(newFolderName)}
                    disabled={!newFolderName.trim()}
                  >Create</button>
                </div>
              </div>
            )}

            {/* Divider between folders and ungrouped tables */}
            {sortedFolders.length > 0 && ungroupedNodes.length > 0 && (
              <div style={s.folderDivider} />
            )}

            {/* Ungrouped tables */}
            {ungroupedNodes.map(node => renderNode(node, 0))}
          </>
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

      {/* Folder context menu */}
      {folderContextMenu && (
        <ContextMenu
          x={folderContextMenu.x}
          y={folderContextMenu.y}
          items={getFolderContextMenuItems(folderContextMenu.folderId)}
          onClose={() => setFolderContextMenu(null)}
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

      {/* Rename folder dialog */}
      <Modal
        open={!!renamingFolder}
        onClose={() => setRenamingFolder(null)}
        title="Rename folder"
        width={320}
      >
        {renamingFolder && (
          <form onSubmit={(e) => {
            e.preventDefault();
            const input = (e.target as HTMLFormElement).elements.namedItem('folderName') as HTMLInputElement;
            renameFolder(renamingFolder.id, input.value.trim());
          }}>
            <input
              name="folderName"
              autoFocus
              defaultValue={renamingFolder.currentName}
              placeholder="Folder name..."
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
                onClick={() => setRenamingFolder(null)}
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
    // --- Folder styles ---
    folderHeader: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      padding: '6px 16px 6px 12px',
      cursor: 'pointer',
      fontSize: 11,
      fontWeight: 600,
      color: t.textSecondary,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.3px',
      transition: 'background 0.1s',
    } as React.CSSProperties,
    folderIcon: {
      fontSize: 12,
      flexShrink: 0,
    },
    folderName: {
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    folderDivider: {
      height: 1,
      background: t.borderLight,
      margin: '6px 16px',
    },
    newFolderBtn: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      padding: '5px 16px 5px 12px',
      cursor: 'pointer',
      fontSize: 11,
      color: t.textMuted,
      transition: 'color 0.1s',
    } as React.CSSProperties,
    newFolderForm: {
      margin: '4px 12px',
      padding: 8,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
    },
  };
}

// ---------------------------------------------------------------------------
// PeerPresenceMark — minimal colored dot + initial stack beside a scope node
// ---------------------------------------------------------------------------

const MAX_PRESENCE_INITIALS = 2;

function PeerPresenceMark({ peers, theme }: { peers: PresenceUser[]; theme: Theme }) {
  if (peers.length === 0) return null;
  // Stable order so initials don't reshuffle on every ping.
  const sorted = [...peers].sort((a, b) => a.userId.localeCompare(b.userId));
  const visible = sorted.slice(0, MAX_PRESENCE_INITIALS);
  const overflow = sorted.length - visible.length;
  const title = sorted
    .map((p) => p.displayName || p.userId)
    .join(', ') + (peers.length === 1 ? ' is here' : ' are here');

  return (
    <span
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        marginLeft: 6,
        flexShrink: 0,
      }}
    >
      {visible.map((p, i) => (
        <span
          key={p.userId}
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: presenceHue(p.userId),
            border: `1.5px solid ${theme.bgCard}`,
            color: '#fff',
            fontSize: 8,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginLeft: i === 0 ? 0 : -4,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.08)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {(p.displayName || p.userId).replace(/^@/, '').charAt(0).toUpperCase()}
        </span>
      ))}
      {overflow > 0 && (
        <span
          style={{
            marginLeft: 2,
            fontSize: 9,
            color: theme.textMuted,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

/** Stable pastel hue derived from a userId — matches OnlineUsers' scheme. */
function presenceHue(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 55%, 55%)`;
}
