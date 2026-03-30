/**
 * CadenceBadge — compact badge showing a target's temporal event rhythm.
 */
import type { CadenceInfo } from '../db/types';
import { useTheme } from '../theme';

interface CadenceBadgeProps {
  cadence: CadenceInfo;
}

const CADENCE_COLORS: Record<string, { bg: string; fg: string }> = {
  burst: { bg: 'rgba(239,68,68,0.12)', fg: '#ef4444' },
  periodic: { bg: 'rgba(34,197,94,0.12)', fg: '#22c55e' },
  dormant: { bg: 'rgba(148,163,184,0.12)', fg: '#94a3b8' },
  steady: { bg: 'rgba(59,130,246,0.12)', fg: '#3b82f6' },
  sparse: { bg: 'rgba(148,163,184,0.08)', fg: '#94a3b8' },
};

export function CadenceBadge({ cadence }: CadenceBadgeProps) {
  const colors = CADENCE_COLORS[cadence.classification] || CADENCE_COLORS.sparse;

  return (
    <span
      title={cadence.description}
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
      {cadence.classification}
    </span>
  );
}
