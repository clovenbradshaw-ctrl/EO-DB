/**
 * RecCycleMap — visualizes a dependency cycle that triggered REC auto-generation.
 * Shows the circular dependency chain as an SVG diagram with convergence/oscillation status.
 */
import type { RecCycleInfo } from '../db/types';
import { useTheme, type Theme } from '../theme';

interface RecCycleMapProps {
  cycle: RecCycleInfo;
  onNavigate: (target: string) => void;
}

export function RecCycleMap({ cycle, onNavigate }: RecCycleMapProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const { participants, result, edges, triggeringSeq } = cycle;
  const converged = result.converged;
  const statusColor = converged ? theme.success : theme.warning;
  const statusLabel = converged ? 'Converged' : 'Oscillating';

  // Layout participants in a circle
  const CX = 140, CY = 100, RADIUS = 70;
  const positions = participants.map((_, i) => {
    const angle = (i / participants.length) * Math.PI * 2 - Math.PI / 2;
    return { x: CX + Math.cos(angle) * RADIUS, y: CY + Math.sin(angle) * RADIUS };
  });

  return (
    <div>
      {/* Status bar */}
      <div style={s.statusBar}>
        <span style={{ ...s.statusDot, background: statusColor }} />
        <span style={{ ...s.statusLabel, color: statusColor }}>{statusLabel}</span>
        <span style={s.statusDetail}>
          {result.iterations} iteration{result.iterations !== 1 ? 's' : ''}
          {result.cycle_length ? ` | period ${result.cycle_length}` : ''}
        </span>
        {triggeringSeq !== undefined && (
          <span style={s.triggerBadge}>triggered by #{triggeringSeq}</span>
        )}
      </div>

      <div style={s.layout}>
        {/* SVG cycle diagram */}
        <svg viewBox="0 0 280 200" style={s.svg}>
          <defs>
            <marker id="cycle-arrow" viewBox="0 0 10 10" refX="28" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={statusColor} fillOpacity="0.7" />
            </marker>
          </defs>

          {/* Edges */}
          {edges.map((e, i) => {
            const si = participants.indexOf(e.source);
            const di = participants.indexOf(e.dest);
            if (si < 0 || di < 0) return null;
            const sp = positions[si];
            const dp = positions[di];
            const midX = (sp.x + dp.x) / 2 + (CY - (sp.y + dp.y) / 2) * 0.3;
            const midY = (sp.y + dp.y) / 2 + ((sp.x + dp.x) / 2 - CX) * 0.3;
            return (
              <path
                key={i}
                d={`M${sp.x},${sp.y} Q${midX},${midY} ${dp.x},${dp.y}`}
                fill="none"
                stroke={statusColor}
                strokeWidth={1.5}
                strokeOpacity={0.6}
                markerEnd="url(#cycle-arrow)"
              />
            );
          })}

          {/* Nodes */}
          {participants.map((p, i) => {
            const pos = positions[i];
            const label = p.split('.').pop() || p;
            return (
              <g key={p} onClick={() => onNavigate(p)} style={{ cursor: 'pointer' }}>
                <circle
                  cx={pos.x} cy={pos.y} r={22}
                  fill={converged ? theme.successBg : theme.warningBg}
                  stroke={statusColor}
                  strokeWidth={1.5}
                />
                <text
                  x={pos.x} y={pos.y + 1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={statusColor}
                  fontFamily="JetBrains Mono, monospace"
                  fontSize={8}
                  fontWeight="600"
                >
                  {label.length > 8 ? label.slice(0, 7) + '…' : label}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Convergence/Oscillation detail */}
        <div style={s.detail}>
          {converged && result.stable_state && (
            <div>
              <div style={s.detailTitle}>Stable State</div>
              <pre style={s.detailPre}>
                {JSON.stringify(result.stable_state, null, 2)}
              </pre>
            </div>
          )}
          {!converged && result.cycle_length && result.states && (
            <div>
              <div style={s.detailTitle}>
                Oscillation — cycles through {result.cycle_length} state{result.cycle_length !== 1 ? 's' : ''}
              </div>
              {result.states.slice(0, 3).map((state, i) => (
                <div key={i} style={s.orbitState}>
                  <span style={s.orbitIndex}>Phase {i + 1}</span>
                  <pre style={s.detailPre}>{JSON.stringify(state, null, 2)}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    statusBar: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 12,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      flexShrink: 0,
    },
    statusLabel: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fontWeight: 600,
    },
    statusDetail: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.textMuted,
    },
    triggerBadge: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      color: t.textMuted,
      background: t.bgMuted,
      borderRadius: 3,
      padding: '1px 5px',
      border: `1px solid ${t.border}`,
    },
    layout: {
      display: 'flex',
      gap: 16,
      alignItems: 'flex-start',
    },
    svg: {
      width: 280,
      height: 200,
      flexShrink: 0,
    },
    detail: {
      flex: 1,
      minWidth: 0,
    },
    detailTitle: {
      fontSize: 10,
      fontWeight: 600,
      color: t.textSecondary,
      marginBottom: 6,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
    },
    detailPre: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.textSecondary,
      background: t.bgMuted,
      borderRadius: 4,
      padding: 8,
      margin: 0,
      border: `1px solid ${t.border}`,
      whiteSpace: 'pre-wrap' as const,
      wordBreak: 'break-all' as const,
      maxHeight: 120,
      overflowY: 'auto' as const,
    },
    orbitState: {
      marginBottom: 8,
    },
    orbitIndex: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      color: t.warning,
      fontWeight: 600,
      marginBottom: 2,
      display: 'block',
    },
  };
}
