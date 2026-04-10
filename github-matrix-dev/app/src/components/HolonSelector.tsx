import { useMemo, useState } from 'react';
import { useTheme, type Theme } from '../theme';

/**
 * HolonSelector — lightweight tri-state tree selector built from a flat list
 * of dot-path node ids. Used inside the GraphView node modal to let users
 * select single nodes or whole subtrees, then apply that selection as a filter.
 */

interface HolonNode {
  segment: string;
  fullPath: string;
  children: HolonNode[];
  /** True if this path is an actual node in the graph (not just an intermediate segment). */
  isGraphNode: boolean;
  /** Recursive count of graph-node descendants (including self). */
  subtreeCount: number;
}

export interface HolonSelectorProps {
  /** The root scope to restrict the tree to. Typically the parent table of the clicked node. */
  rootScope: string;
  /** All graph-visible node paths. Only these + their ancestors appear in the tree. */
  nodes: string[];
  /** Controlled set of selected fullPaths. A selected path implies its whole subtree. */
  selectedPaths: Set<string>;
  onChange: (next: Set<string>) => void;
}

/** Build a trie rooted at `rootScope` that contains every node in `nodes` that descends from it. */
function buildHolonTree(nodes: string[], rootScope: string): HolonNode {
  const prefix = rootScope + '.';
  const paths = new Set<string>();
  const graphNodeSet = new Set<string>();

  // Include every path under the root plus rootScope itself if it's present.
  for (const n of nodes) {
    if (n === rootScope || n.startsWith(prefix)) {
      graphNodeSet.add(n);
      // Add all ancestors within the subtree so the trie is connected.
      const parts = n.split('.');
      const rootParts = rootScope.split('.').length;
      for (let i = rootParts; i <= parts.length; i++) {
        paths.add(parts.slice(0, i).join('.'));
      }
    }
  }

  // Parent -> sorted child segments
  const childrenMap = new Map<string, Set<string>>();
  for (const p of paths) {
    const parts = p.split('.');
    if (p === rootScope) continue;
    const parent = parts.slice(0, -1).join('.');
    if (!childrenMap.has(parent)) childrenMap.set(parent, new Set());
    childrenMap.get(parent)!.add(p);
  }

  function build(path: string): HolonNode {
    const seg = path.split('.').pop() || path;
    const kidPaths = childrenMap.get(path);
    const children: HolonNode[] = kidPaths
      ? [...kidPaths].sort().map(build)
      : [];
    const isGraphNode = graphNodeSet.has(path);
    const subtreeCount =
      (isGraphNode ? 1 : 0) +
      children.reduce((sum, c) => sum + c.subtreeCount, 0);
    return { segment: seg, fullPath: path, children, isGraphNode, subtreeCount };
  }

  return build(rootScope);
}

/** Collect every graph-node descendant fullPath under `node` (including self if it's a graph node). */
function collectSubtreeNodes(node: HolonNode, out: Set<string>) {
  if (node.isGraphNode) out.add(node.fullPath);
  for (const c of node.children) collectSubtreeNodes(c, out);
}

type CheckState = 'on' | 'off' | 'mixed';

/** Compute a node's tri-state from the selection set. */
function computeCheckState(node: HolonNode, selected: Set<string>): CheckState {
  const leaves = new Set<string>();
  collectSubtreeNodes(node, leaves);
  if (leaves.size === 0) return 'off';
  let hit = 0;
  for (const l of leaves) if (selected.has(l)) hit++;
  if (hit === 0) return 'off';
  if (hit === leaves.size) return 'on';
  return 'mixed';
}

export function HolonSelector({ rootScope, nodes, selectedPaths, onChange }: HolonSelectorProps) {
  const { theme } = useTheme();
  const s = styles(theme);
  const tree = useMemo(() => buildHolonTree(nodes, rootScope), [nodes, rootScope]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootScope]));

  function toggleExpand(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleCheck(node: HolonNode) {
    const subtree = new Set<string>();
    collectSubtreeNodes(node, subtree);
    if (subtree.size === 0) return;
    const state = computeCheckState(node, selectedPaths);
    const next = new Set(selectedPaths);
    if (state === 'on') {
      for (const p of subtree) next.delete(p);
    } else {
      for (const p of subtree) next.add(p);
    }
    onChange(next);
  }

  if (tree.subtreeCount === 0) {
    return (
      <div style={s.empty}>
        No graph nodes under <code>{rootScope}</code>.
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <span>Holon selection</span>
        {selectedPaths.size > 0 && (
          <button onClick={() => onChange(new Set())} style={s.clearBtn}>
            clear
          </button>
        )}
      </div>
      <div style={s.tree}>
        <HolonRow
          node={tree}
          depth={0}
          expanded={expanded}
          onToggleExpand={toggleExpand}
          onToggleCheck={toggleCheck}
          selectedPaths={selectedPaths}
          s={s}
          theme={theme}
        />
      </div>
    </div>
  );
}

interface HolonRowProps {
  node: HolonNode;
  depth: number;
  expanded: Set<string>;
  onToggleExpand: (path: string) => void;
  onToggleCheck: (node: HolonNode) => void;
  selectedPaths: Set<string>;
  s: Record<string, React.CSSProperties>;
  theme: Theme;
}

function HolonRow({
  node,
  depth,
  expanded,
  onToggleExpand,
  onToggleCheck,
  selectedPaths,
  s,
  theme,
}: HolonRowProps) {
  const isOpen = expanded.has(node.fullPath);
  const state = computeCheckState(node, selectedPaths);
  const hasChildren = node.children.length > 0;

  return (
    <>
      <div style={{ ...s.row, paddingLeft: 8 + depth * 14 }}>
        {hasChildren ? (
          <button onClick={() => onToggleExpand(node.fullPath)} style={s.caret} aria-label={isOpen ? 'Collapse' : 'Expand'}>
            {isOpen ? '\u25BE' : '\u25B8'}
          </button>
        ) : (
          <span style={s.caretSpacer} />
        )}
        <button
          onClick={() => onToggleCheck(node)}
          style={{
            ...s.checkbox,
            background:
              state === 'on' ? theme.accent : state === 'mixed' ? theme.bgHover : 'transparent',
            borderColor: state === 'off' ? theme.border : theme.accent,
          }}
          aria-label={`Check ${node.segment}`}
        >
          {state === 'on' && '\u2713'}
          {state === 'mixed' && '\u2013'}
        </button>
        <span
          style={{
            ...s.label,
            color: node.isGraphNode ? theme.text : theme.textMuted,
            fontStyle: node.isGraphNode ? 'normal' : 'italic',
          }}
        >
          {node.segment}
        </span>
        <span style={s.count}>
          {node.isGraphNode && node.children.length === 0
            ? 'node'
            : `${node.subtreeCount}`}
        </span>
      </div>
      {isOpen &&
        node.children.map((c) => (
          <HolonRow
            key={c.fullPath}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            onToggleCheck={onToggleCheck}
            selectedPaths={selectedPaths}
            s={s}
            theme={theme}
          />
        ))}
    </>
  );
}

/** Expand a selection of fullPaths into the concrete set of graph-visible node ids. */
export function expandHolonSelection(paths: Set<string>, allNodes: string[]): Set<string> {
  if (paths.size === 0) return new Set();
  const out = new Set<string>();
  for (const p of paths) {
    for (const n of allNodes) {
      if (n === p || n.startsWith(p + '.')) out.add(n);
    }
  }
  return out;
}

function styles(t: Theme): Record<string, React.CSSProperties> {
  return {
    wrap: {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      minHeight: 0,
      maxHeight: 360,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      overflow: 'hidden',
      background: t.bgCard,
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '6px 10px',
      fontSize: 9,
      fontWeight: 700,
      fontFamily: "'JetBrains Mono', monospace",
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      color: t.textMuted,
      borderBottom: `1px solid ${t.border}`,
    },
    clearBtn: {
      background: 'none',
      border: 'none',
      fontSize: 9,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      cursor: 'pointer',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    },
    tree: {
      flex: 1,
      overflowY: 'auto',
      padding: '4px 0',
    },
    row: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '3px 8px 3px 0',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
    },
    caret: {
      background: 'none',
      border: 'none',
      color: t.textMuted,
      fontSize: 9,
      cursor: 'pointer',
      padding: 0,
      width: 12,
      textAlign: 'center',
    },
    caretSpacer: {
      display: 'inline-block',
      width: 12,
    },
    checkbox: {
      width: 13,
      height: 13,
      borderRadius: 2,
      border: `1px solid ${t.border}`,
      cursor: 'pointer',
      color: '#fff',
      fontSize: 9,
      lineHeight: '11px',
      textAlign: 'center',
      padding: 0,
      flexShrink: 0,
    },
    label: {
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    count: {
      fontSize: 9,
      color: t.textMuted,
      textTransform: 'uppercase',
    },
    empty: {
      padding: 16,
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      textAlign: 'center',
    },
  };
}
