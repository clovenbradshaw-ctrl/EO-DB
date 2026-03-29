import { useState, useEffect, useMemo, useCallback } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { EoEvent } from '../db/types';

const NODE_COLORS = ['#4ade80', '#38bdf8', '#a78bfa', '#34d399', '#fb923c', '#f472b6'];

interface Edge { source: string; dest: string }
interface NodePos { x: number; y: number }

export function GraphView() {
  const { theme } = useTheme();
  const recentEvents = useEoStore((s) => s.recentEvents);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const s = styles(theme);

  // Extract CON edges
  const { nodes, edges } = useMemo(() => {
    const nodesSet = new Set<string>();
    const edgeList: Edge[] = [];
    recentEvents
      .filter((e) => e.op === 'CON')
      .forEach((e) => {
        const source = e.target.split('.').slice(0, 3).join('.');
        if (e.operand?.added) {
          (e.operand.added as string[]).forEach((dest) => {
            nodesSet.add(source);
            nodesSet.add(dest);
            edgeList.push({ source, dest });
          });
        }
      });
    return { nodes: Array.from(nodesSet), edges: edgeList };
  }, [recentEvents]);

  // Layout: circular
  const CX = 400, CY = 280, RADIUS = 180;
  const positions = useMemo(() => {
    const pos: Record<string, NodePos> = {};
    nodes.forEach((n, i) => {
      const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
      pos[n] = { x: CX + Math.cos(angle) * RADIUS, y: CY + Math.sin(angle) * RADIUS };
    });
    return pos;
  }, [nodes]);

  const toggleHighlight = useCallback((name: string) => {
    setHighlighted((h) => (h === name ? null : name));
  }, []);

  if (nodes.length === 0) {
    return (
      <div style={s.empty}>
        <div style={{ fontSize: 14, color: theme.textSecondary, fontWeight: 300 }}>No graph data yet</div>
        <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>
          CON events create edges between targets. Compose a CON event to see the graph.
        </div>
      </div>
    );
  }

  return (
    <div style={s.container}>
      {/* Sidebar: node list */}
      <aside style={s.sidebar}>
        <div style={s.sidebarTitle}>Nodes ({nodes.length})</div>
        {nodes.map((n, i) => {
          const label = n.split('.').pop() || n;
          const isActive = highlighted === n;
          return (
            <button
              key={n}
              onClick={() => toggleHighlight(n)}
              style={{
                ...s.nodeItem,
                background: isActive ? theme.bgActive : 'transparent',
              }}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: NODE_COLORS[i % NODE_COLORS.length], flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{label}</span>
            </button>
          );
        })}
        <div style={{ ...s.sidebarTitle, marginTop: 16 }}>Edges ({edges.length})</div>
        {edges.slice(0, 20).map((e, i) => (
          <div key={i} style={s.edgeItem}>
            <span style={{ color: theme.accent }}>{e.source.split('.').pop()}</span>
            <span style={{ color: theme.textMuted }}>&rarr;</span>
            <span style={{ color: theme.accent }}>{e.dest.split('.').pop()}</span>
          </div>
        ))}
        {edges.length > 20 && <div style={{ ...s.edgeItem, color: theme.textMuted }}>...+{edges.length - 20} more</div>}
      </aside>

      {/* SVG graph */}
      <div style={s.graphArea}>
        <svg viewBox="0 0 800 560" style={{ width: '100%', height: '100%' }}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="35" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#a78bfa" fillOpacity="0.6" />
            </marker>
          </defs>

          {/* Edges */}
          {edges.map((e, i) => {
            const sp = positions[e.source];
            const dp = positions[e.dest];
            if (!sp || !dp) return null;
            const midX = (sp.x + dp.x) / 2;
            const midY = (sp.y + dp.y) / 2 - 20;
            const connected = !highlighted || e.source === highlighted || e.dest === highlighted;
            return (
              <path
                key={i}
                d={`M${sp.x},${sp.y} Q${midX},${midY} ${dp.x},${dp.y}`}
                fill="none"
                stroke="#a78bfa"
                strokeWidth={connected && highlighted ? 2 : 1.5}
                strokeOpacity={highlighted ? (connected ? 0.8 : 0.08) : 0.5}
                markerEnd="url(#arrow)"
              />
            );
          })}

          {/* Nodes */}
          {nodes.map((n, i) => {
            const p = positions[n];
            const c = NODE_COLORS[i % NODE_COLORS.length];
            const label = n.split('.').pop() || n;
            const isSelected = n === highlighted;
            const opacity = highlighted ? (isSelected ? 1 : 0.2) : 1;
            const r = isSelected ? 32 : 28;
            return (
              <g key={n} onClick={() => toggleHighlight(n)} style={{ cursor: 'pointer' }}>
                <circle
                  cx={p.x} cy={p.y} r={r}
                  fill={`${c}15`}
                  stroke={c}
                  strokeWidth={isSelected ? 2.5 : 1.5}
                  strokeOpacity={opacity}
                  fillOpacity={opacity}
                />
                <text
                  x={p.x} y={p.y + 1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={c}
                  fontFamily="JetBrains Mono, monospace"
                  fontSize={isSelected ? 10 : 9}
                  fontWeight="600"
                  fillOpacity={opacity}
                >
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function styles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: { display: 'flex', flex: 1, overflow: 'hidden' },
    sidebar: {
      width: 220,
      borderRight: `1px solid ${t.border}`,
      background: t.bgCard,
      overflowY: 'auto',
      padding: '12px 0',
    },
    sidebarTitle: {
      padding: '4px 14px 8px',
      fontSize: 9,
      fontWeight: 700,
      fontFamily: "'JetBrains Mono', monospace",
      textTransform: 'uppercase' as const,
      letterSpacing: '0.08em',
      color: t.textMuted,
    },
    nodeItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      padding: '6px 14px',
      border: 'none',
      background: 'transparent',
      color: t.text,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      cursor: 'pointer',
      textAlign: 'left' as const,
    },
    edgeItem: {
      display: 'flex',
      gap: 6,
      padding: '3px 14px',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
    },
    graphArea: {
      flex: 1,
      background: t.bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
    },
    empty: {
      display: 'flex',
      flexDirection: 'column' as const,
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      flex: 1,
    },
  };
}
