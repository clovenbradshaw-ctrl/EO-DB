import type { NearbyEntry } from '../db/types';
import { useTheme, type Theme } from '../theme';

interface NearbyProps {
  entries: NearbyEntry[];
  onNavigate: (target: string) => void;
}

export function Nearby({ entries, onNavigate }: NearbyProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <div style={s.grid}>
      {entries.map((n) => (
        <div key={n.target} style={s.card} onClick={() => onNavigate(n.target)}>
          <div style={s.name}>{n.target}</div>
          <div style={s.reason}>distance: {n.distance}</div>
          <div style={s.tags}>
            {n.shared.map((sh, i) => (
              <span key={i} style={s.tag}>{sh}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
    card: {
      padding: '14px 16px',
      background: t.bgCard,
      border: `1px solid ${t.tealBorder}`,
      borderRadius: 8,
      cursor: 'pointer',
    },
    name: { fontWeight: 500, fontSize: 13, color: t.textHeading, marginBottom: 4 },
    reason: { fontSize: 10, color: t.textSecondary, marginBottom: 6 },
    tags: { display: 'flex', flexWrap: 'wrap', gap: 4 },
    tag: {
      padding: '1px 6px',
      borderRadius: 3,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      background: t.tealBg,
      color: t.teal,
      border: `1px solid ${t.tealBorder}`,
    },
  };
}
