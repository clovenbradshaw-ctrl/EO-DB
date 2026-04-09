import type { SignalEntry } from '../db/types';
import { useTheme, type Theme } from '../theme';

interface SignalsProps {
  entries: SignalEntry[];
}

export function Signals({ entries }: SignalsProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  // Separate the population-count summary from field signals
  const countEntry = entries.find(e => e.measure === 'count');
  const fieldEntries = entries.filter(e => e.measure !== 'count');

  if (fieldEntries.length === 0) {
    return <div style={s.none}>No notable patterns detected across this population</div>;
  }

  return (
    <div style={s.row}>
      {fieldEntries.map((sig, i) => {
        const hasZScore = sig.value && typeof sig.value === 'object' && 'z_score' in sig.value;
        const isOutlier = sig.value?.isOutlier === true;
        return (
          <div key={i} style={{ ...s.card, borderColor: isOutlier ? theme.warningBorder : theme.borderLight }}>
            {isOutlier && <div style={s.ephemeral}>SIG</div>}
            <div style={s.desc}>{sig.description}</div>
            {hasZScore && (
              <div style={s.viz}>
                <div style={s.barContainer}>
                  <div style={{
                    ...s.barFill,
                    width: `${Math.min(95, Math.abs(sig.value.z_score) * 25 + 30)}%`,
                    background: isOutlier ? theme.barFill : theme.textMuted,
                    opacity: isOutlier ? 1 : 0.45,
                  }} />
                </div>
              </div>
            )}
            <div style={s.stats}>
              {sig.value && typeof sig.value === 'object' && 'target_value' in sig.value && (
                <span style={s.stat}><b>{sig.value.target_value}</b> this record</span>
              )}
              {sig.value && typeof sig.value === 'object' && 'population_mean' in sig.value && (
                <span style={s.stat}><b>{Math.round(sig.value.population_mean)}</b> avg</span>
              )}
              <span style={s.stat}><b>{sig.n}</b> in population</span>
            </div>
          </div>
        );
      })}
      {countEntry && (
        <div style={s.countRow}>
          <span style={s.countLabel}>{countEntry.description}</span>
        </div>
      )}
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    row: { display: 'flex', flexDirection: 'column', gap: 10 },
    none: { fontSize: 12, color: t.textMuted, fontStyle: 'italic', padding: '8px 0' },
    card: {
      padding: '14px 16px',
      background: t.bgCard,
      border: `1px solid ${t.warningBorder}`,
      borderRadius: 8,
      position: 'relative' as const,
    },
    ephemeral: {
      position: 'absolute' as const,
      top: 10,
      right: 12,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 8,
      color: t.warning,
      opacity: 0.5,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
    },
    desc: { fontSize: 13, color: t.text, fontWeight: 400, marginBottom: 8, maxWidth: '80%' },
    viz: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 },
    barContainer: {
      flex: 1,
      height: 6,
      background: t.barBg,
      borderRadius: 3,
      overflow: 'hidden',
    },
    barFill: {
      height: '100%',
      borderRadius: 3,
      background: t.barFill,
    },
    stats: { display: 'flex', gap: 16, fontSize: 11 },
    stat: { color: t.textSecondary },
    countRow: {
      padding: '6px 2px',
      borderTop: `1px solid ${t.borderDivider}`,
      marginTop: 2,
    },
    countLabel: {
      fontSize: 11,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
  };
}
