import { useEffect, useState, useMemo } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import type { FilterDefinition } from './filter-types';
import { useTheme, type Theme } from '../theme';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { TypeSelector, TypeBadge } from './TypeSelector';
import { buildTree, formatName, type TreeNode } from './scope-picker-utils';

interface HolonNavProps {
  selectedScope: string | null;
  onSelectScope: (scope: string) => void;
  onSelectSegment?: (scope: string, segment: FilterDefinition) => void;
  /** Prefix to scope which records are loaded. Empty string = all records. */
  statePrefix?: string;
}

export function HolonNav({ selectedScope, onSelectScope, onSelectSegment, statePrefix = '' }: HolonNavProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const getState = useEoStore((s) => s.getState);
  const dispatch = useEoStore((s) => s.dispatch);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const [allStates, setAllStates] = useState<EoState[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: string } | null>(null);
  const [typeSelector, setTypeSelector] = useState<{ x: number; y: number; target: string; currentType?: string } | null>(null);
  const [renaming, setRenaming] = useState<{ target: string; currentName: string } | null>(null);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  useEffect(() => {
    if (!ready) return;
    getStateByPrefix(statePrefix).then(setAllStates);
  }, [ready, lastSeq, getStateByPrefix, statePrefix]);

  // Reset expansion when space changes
  useEffect(() => {
    setExpanded(new Set());
  }, [statePrefix]);

  const tree = useMemo(() => buildTree(allStates, statePrefix), [allStates, statePrefix]);

  // Auto-expand root on first load
  useEffect(() => {
    if (tree.length > 0 && expanded.size === 0) {
      setExpanded(new Set(tree.map(n => n.fullPath)));
    }
  }, [tree, expanded.size]);

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

  function renderNode(node: TreeNode, depth: number, parentDisplayField?: string) {
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
          onClick={() => onSelectScope(node.fullPath)}
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

        {/* Children — pass this node's _displayField so children can resolve names */}
        {isExpanded && node.children.map(child =>
          renderNode(child, depth + 1, node.state?.value?._displayField)
        )}
      </div>
    );
  }

  return (
    <div style={s.container}>
      <div style={s.header}>
        <span style={s.title}>OBJECTS</span>
      </div>
      <div style={s.scroll}>
        {allStates.length === 0 && (
          <div style={s.empty}>No objects yet</div>
        )}
        {tree.map(node => renderNode(node, 0))}
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

      {/* Rename popover */}
      {renaming && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onClick={() => setRenaming(null)}
          />
          <div style={{
            position: 'fixed',
            left: '50%',
            top: '30%',
            transform: 'translateX(-50%)',
            zIndex: 9999,
            background: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: 8,
            boxShadow: `0 8px 30px ${theme.shadow}`,
            padding: 16,
            minWidth: 280,
          }}>
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
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRenaming(null);
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
          </div>
        </>
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
      minHeight: 0,
    },
    header: {
      padding: '0 16px 8px',
      paddingTop: 12,
    },
    title: {
      fontWeight: 500, fontSize: 11, color: t.textMuted,
      textTransform: 'uppercase' as const, letterSpacing: '0.5px',
    },
    scroll: { flex: 1, overflowY: 'auto' },
    empty: { padding: 16, fontSize: 12, color: t.textMuted },
    item: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '5px 16px',
      cursor: 'pointer',
      fontSize: 12,
    } as React.CSSProperties,
    itemActive: {
      background: t.accentBg,
      color: t.accent,
      borderRadius: 4,
      margin: '0 8px',
      padding: '5px 8px',
      fontWeight: 500,
    } as React.CSSProperties,
    chevron: {
      fontSize: 10,
      color: t.textMuted,
      width: 14,
      flexShrink: 0,
      cursor: 'pointer',
      userSelect: 'none' as const,
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
      float: 'right' as const,
    },
    countCon: {
      fontSize: 9,
      color: '#185FA5',
      background: '#E6F1FB',
      padding: '1px 5px',
      borderRadius: 4,
      flexShrink: 0,
    },
    countSeg: {
      fontSize: 9,
      color: '#E65100',
      background: '#FFF3E0',
      padding: '1px 5px',
      borderRadius: 4,
      flexShrink: 0,
    },
    countRec: {
      fontSize: 9,
      color: '#A32D2D',
      background: '#FCEBEB',
      padding: '1px 5px',
      borderRadius: 4,
      flexShrink: 0,
    },
    countDerived: {
      fontSize: 9,
      color: '#0ea5e9',
      fontFamily: "'JetBrains Mono', monospace",
      background: 'rgba(14,165,233,0.12)',
      padding: '1px 5px',
      borderRadius: 8,
      flexShrink: 0,
      borderStyle: 'dashed' as const,
      border: '1px dashed rgba(14,165,233,0.3)',
    },
    segItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 16px',
      cursor: 'pointer',
      fontSize: 11,
      color: t.purple,
    } as React.CSSProperties,
    segIcon: {
      display: 'flex',
      alignItems: 'center',
      color: t.danger,
      flexShrink: 0,
    },
    segName: {
      fontWeight: 500,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
  };
}
