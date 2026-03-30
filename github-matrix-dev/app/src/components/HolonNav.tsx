import { useEffect, useState, useMemo } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import type { FilterDefinition } from './filter-types';
import { useTheme, type Theme } from '../theme';

interface HolonNavProps {
  selectedScope: string | null;
  onSelectScope: (scope: string) => void;
  onSelectSegment?: (scope: string, segment: FilterDefinition) => void;
  /** Prefix to scope which records are loaded. Empty string = all records. */
  statePrefix?: string;
}

interface TreeNode {
  segment: string;       // just this level's name (e.g. "tblClients")
  fullPath: string;      // full dot-path (e.g. "app.tblClients")
  children: TreeNode[];
  childCount: number;    // number of direct children with state
  conCount: number;      // children whose last_op is CON
  segCount: number;      // children whose last_op is SEG
  recCount: number;      // children whose last_op is REC
  segments?: Record<string, FilterDefinition>;
}

function formatName(segment: string): string {
  // Strip tbl/rec/fld prefixes, add spaces before capitals
  let name = segment.replace(/^(tbl|rec|fld)/, '');
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  return name || segment;
}

function buildTree(states: EoState[]): TreeNode[] {
  const pathSet = new Map<string, { childPaths: Set<string>; state?: EoState }>();

  for (const s of states) {
    if (s.value?._alias) continue;
    const parts = s.target.split('.');

    // Register every prefix level
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('.');
      if (!pathSet.has(path)) {
        pathSet.set(path, { childPaths: new Set() });
      }
    }

    // Register this target's state at its path
    const entry = pathSet.get(s.target)!;
    entry.state = s;

    // Register as child of parent
    if (parts.length > 1) {
      const parentPath = parts.slice(0, -1).join('.');
      pathSet.get(parentPath)!.childPaths.add(s.target);
    }
  }

  function buildNode(fullPath: string): TreeNode {
    const entry = pathSet.get(fullPath)!;
    const segment = fullPath.split('.').pop()!;
    const childPaths = [...entry.childPaths].sort();
    const children = childPaths
      .filter(cp => pathSet.has(cp))
      .map(cp => buildNode(cp));

    const segments = entry.state?.value?._segments as Record<string, FilterDefinition> | undefined;

    // Count children by operator type
    let conCount = 0;
    let segCount = 0;
    let recCount = 0;
    for (const cp of entry.childPaths) {
      const childEntry = pathSet.get(cp);
      if (childEntry?.state) {
        const op = childEntry.state.last_op;
        if (op === 'CON') conCount++;
        else if (op === 'SEG') segCount++;
        else if (op === 'REC') recCount++;
      }
    }

    return {
      segment,
      fullPath,
      children,
      childCount: entry.childPaths.size,
      conCount,
      segCount,
      recCount,
      segments,
    };
  }

  // Find root nodes (depth 1)
  const roots: TreeNode[] = [];
  for (const [path] of pathSet) {
    if (!path.includes('.')) {
      roots.push(buildNode(path));
    }
  }
  return roots;
}

export function HolonNav({ selectedScope, onSelectScope, onSelectSegment, statePrefix = '' }: HolonNavProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const [allStates, setAllStates] = useState<EoState[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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

  const tree = useMemo(() => buildTree(allStates), [allStates]);

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

  function renderNode(node: TreeNode, depth: number) {
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

          <span style={s.name}>{formatName(node.segment)}</span>

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

        {/* Children */}
        {isExpanded && node.children.map(child => renderNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <div style={s.container}>
      <div style={s.header}>
        <span style={s.title}>Objects</span>
      </div>
      <div style={s.scroll}>
        {allStates.length === 0 && (
          <div style={s.empty}>No objects yet</div>
        )}
        {tree.map(node => renderNode(node, 0))}
      </div>
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
    },
    header: {
      padding: '16px 18px',
      borderBottom: `1px solid ${t.border}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    title: { fontWeight: 600, fontSize: 13, color: t.textHeading },
    scroll: { flex: 1, overflowY: 'auto' },
    empty: { padding: 18, fontSize: 13, color: t.textMuted },
    item: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '10px 12px',
      cursor: 'pointer',
      borderBottom: `1px solid ${t.borderLight}`,
      transition: 'background .1s',
      fontSize: 13,
    } as React.CSSProperties,
    itemActive: {
      background: t.accentBg,
      borderLeft: `3px solid ${t.accent}`,
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
      fontWeight: 500,
      color: t.textHeading,
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    count: {
      fontSize: 10,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.bgMuted,
      padding: '1px 6px',
      borderRadius: 8,
      flexShrink: 0,
    },
    countCon: {
      fontSize: 9,
      color: '#a855f7',
      fontFamily: "'JetBrains Mono', monospace",
      background: 'rgba(168,85,247,0.12)',
      padding: '1px 5px',
      borderRadius: 8,
      flexShrink: 0,
    },
    countSeg: {
      fontSize: 9,
      color: '#f97316',
      fontFamily: "'JetBrains Mono', monospace",
      background: 'rgba(249,115,22,0.12)',
      padding: '1px 5px',
      borderRadius: 8,
      flexShrink: 0,
    },
    countRec: {
      fontSize: 9,
      color: '#ef4444',
      fontFamily: "'JetBrains Mono', monospace",
      background: 'rgba(239,68,68,0.12)',
      padding: '1px 5px',
      borderRadius: 8,
      flexShrink: 0,
    },
    segItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 12px',
      cursor: 'pointer',
      fontSize: 11,
      color: t.purple,
      borderBottom: `1px solid ${t.borderLight}`,
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
