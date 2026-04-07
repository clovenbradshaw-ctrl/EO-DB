import type { NearbyEntry, SimilarityDimensions } from '../db/types';
import { useTheme, type Theme } from '../theme';

interface NearbyProps {
  entries: NearbyEntry[];
  onNavigate: (target: string) => void;
}

const DIM_LABELS: Array<{ key: keyof SimilarityDimensions; label: string; color: (t: Theme) => string }> = [
  { key: 'hash', label: 'hash', color: (t) => t.purple },
  { key: 'trajectory', label: 'trajectory', color: (t) => t.warning },
  { key: 'state', label: 'state', color: (t) => t.teal },
  { key: 'connections', label: 'connections', color: (t) => t.accent },
];

export function Nearby({ entries, onNavigate }: NearbyProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <div style={s.grid}>
      {entries.map((n) => {
        const label = n.target.split('.').pop() || n.target;
        const pct = Math.round((n.score ?? 0) * 100);

        return (
          <div key={n.target} style={s.card} onClick={() => onNavigate(n.target)}>
            <div style={s.topRow}>
              <div style={s.name}>{label}</div>
              <div style={s.score}>{pct}%</div>
            </div>
            <div style={s.targetPath}>{n.target}</div>
            {n.dimensions && (
              <div style={s.dims}>
                {DIM_LABELS.map(({ key, label: dimLabel, color }) => {
                  const val = n.dimensions[key];
                  if (val === undefined || val === false) return null;
                  const strength = val === true ? 1 : val;
                  const dimColor = color(theme);
                  return (
                    <div key={key} style={s.dimRow}>
                      <span style={{ ...s.dimLabel, color: dimColor }}>{dimLabel}</span>
                      <div style={s.barTrack}>
                        <div style={{
                          ...s.barFill,
                          width: `${Math.round(strength * 100)}%`,
                          background: dimColor,
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
    card: {
      padding: '14px 16px',
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      cursor: 'pointer',
    },
    topRow: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
    },
    name: { fontWeight: 600, fontSize: 13, color: t.textHeading },
    score: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fontWeight: 600,
      color: t.teal,
    },
    targetPath: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      color: t.textMuted,
      marginBottom: 8,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    dims: { display: 'flex', flexDirection: 'column' as const, gap: 3 },
    dimRow: { display: 'flex', alignItems: 'center', gap: 6 },
    dimLabel: {
      fontSize: 8,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
      width: 68,
      flexShrink: 0,
    },
    barTrack: {
      flex: 1,
      height: 4,
      borderRadius: 2,
      background: t.bgMuted,
    },
    barFill: {
      height: 4,
      borderRadius: 2,
      minWidth: 2,
      transition: 'width 0.2s ease',
    },
  };
}
