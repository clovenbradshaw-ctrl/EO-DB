import type { SignalEntry } from '../db/types';

interface SignalsProps {
  entries: SignalEntry[];
}

export function Signals({ entries }: SignalsProps) {
  if (entries.length === 0) {
    return <div style={styles.none}>No notable patterns detected across this population</div>;
  }

  return (
    <div style={styles.row}>
      {entries.map((sig, i) => {
        const hasZScore = sig.value && typeof sig.value === 'object' && 'z_score' in sig.value;
        return (
          <div key={i} style={styles.card}>
            <div style={styles.ephemeral}>SIG</div>
            <div style={styles.desc}>{sig.description}</div>
            {hasZScore && (
              <div style={styles.viz}>
                <div style={styles.barContainer}>
                  <div style={{
                    ...styles.barFill,
                    width: `${Math.min(95, Math.abs(sig.value.z_score) * 25 + 30)}%`,
                  }} />
                </div>
              </div>
            )}
            <div style={styles.stats}>
              {sig.value && typeof sig.value === 'object' && 'target_value' in sig.value && (
                <span style={styles.stat}><b>{sig.value.target_value}</b> this record</span>
              )}
              {sig.value && typeof sig.value === 'object' && 'population_mean' in sig.value && (
                <span style={styles.stat}><b>{Math.round(sig.value.population_mean)}</b> avg</span>
              )}
              <span style={styles.stat}><b>{sig.n}</b> in population</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: { display: 'flex', flexDirection: 'column', gap: 10 },
  none: { fontSize: 12, color: '#aba69e', fontStyle: 'italic', padding: '8px 0' },
  card: {
    padding: '14px 16px',
    background: '#fff',
    border: '1px solid #f0d9b8',
    borderRadius: 8,
    position: 'relative' as const,
  },
  ephemeral: {
    position: 'absolute' as const,
    top: 10,
    right: 12,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 8,
    color: '#c2700a',
    opacity: 0.5,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  desc: { fontSize: 13, color: '#2c2a26', fontWeight: 400, marginBottom: 8, maxWidth: '80%' },
  viz: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 },
  barContainer: {
    flex: 1,
    height: 6,
    background: '#eceae6',
    borderRadius: 3,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 3,
    background: 'linear-gradient(90deg, #eceae6, #c2700a)',
  },
  stats: { display: 'flex', gap: 16, fontSize: 11 },
  stat: { color: '#7a756d' },
};
