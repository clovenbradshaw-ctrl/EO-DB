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
      {entries.map((n) => {
        // Separate field traits from graph traits
        const fieldTraits = n.shared.filter(sh => !sh.startsWith('linked:'));
        const graphTraits = n.shared.filter(sh => sh.startsWith('linked:'));
        const label = n.target.split('.').pop() || n.target;

        return (
          <div key={n.target} style={s.card} onClick={() => onNavigate(n.target)}>
            <div style={s.name}>{label}</div>
            <div style={s.targetPath}>{n.target}</div>
            <div style={s.reason}>distance: {n.distance}</div>
            {fieldTraits.length > 0 && (
              <div style={s.traitSection}>
                <div style={s.traitLabel}>fields</div>
                <div style={s.tags}>
                  {fieldTraits.map((sh, i) => (
                    <span key={i} style={s.tag}>{sh}</span>
                  ))}
                </div>
              </div>
            )}
            {graphTraits.length > 0 && (
              <div style={s.traitSection}>
                <div style={{ ...s.traitLabel, color: theme.purple }}>connections</div>
                <div style={s.tags}>
                  {graphTraits.map((sh, i) => (
                    <span key={i} style={s.graphTag}>
                      {sh.replace('linked:', '')}
                    </span>
                  ))}
                </div>
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
      border: `1px solid ${t.tealBorder}`,
      borderRadius: 8,
      cursor: 'pointer',
    },
    name: { fontWeight: 600, fontSize: 13, color: t.textHeading, marginBottom: 1 },
    targetPath: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      color: t.textMuted,
      marginBottom: 4,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    reason: { fontSize: 10, color: t.textSecondary, marginBottom: 6 },
    traitSection: { marginBottom: 4 },
    traitLabel: {
      fontSize: 8,
      fontWeight: 600,
      color: t.teal,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
      marginBottom: 2,
    },
    tags: { display: 'flex', flexWrap: 'wrap' as const, gap: 4 },
    tag: {
      padding: '1px 6px',
      borderRadius: 3,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      background: t.tealBg,
      color: t.teal,
      border: `1px solid ${t.tealBorder}`,
    },
    graphTag: {
      padding: '1px 6px',
      borderRadius: 3,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      background: t.purpleBg,
      color: t.purple,
      border: `1px solid ${t.purpleBorder}`,
    },
  };
}
