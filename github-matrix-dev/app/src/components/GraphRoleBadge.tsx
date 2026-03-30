/**
 * GraphRoleBadge — compact badge showing a target's role in the CON graph.
 */
import type { GraphMetrics } from '../db/types';
import { useTheme } from '../theme';

interface GraphRoleBadgeProps {
  metrics: GraphMetrics;
}

const ROLE_COLORS: Record<string, { bg: string; fg: string }> = {
  hub: { bg: 'rgba(168,85,247,0.12)', fg: '#a855f7' },
  bridge: { bg: 'rgba(234,179,8,0.12)', fg: '#eab308' },
  leaf: { bg: 'rgba(148,163,184,0.08)', fg: '#94a3b8' },
  isolated: { bg: 'rgba(148,163,184,0.05)', fg: '#64748b' },
};

export function GraphRoleBadge({ metrics }: GraphRoleBadgeProps) {
  const colors = ROLE_COLORS[metrics.role] || ROLE_COLORS.leaf;

  return (
    <span
      title={`${metrics.role} | ${metrics.degree} edges (${metrics.inDegree} in, ${metrics.outDegree} out)${metrics.mutualCount > 0 ? ` | ${metrics.mutualCount} mutual` : ''}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 9,
        fontFamily: "'JetBrains Mono', monospace",
        fontWeight: 500,
        background: colors.bg,
        color: colors.fg,
        borderRadius: 10,
        padding: '2px 7px',
      }}
    >
      {metrics.role}
      <span style={{ opacity: 0.6 }}>{metrics.degree}</span>
    </span>
  );
}
