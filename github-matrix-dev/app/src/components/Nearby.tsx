import type { NearbyEntry } from '../db/types';

interface NearbyProps {
  entries: NearbyEntry[];
  onNavigate: (target: string) => void;
}

export function Nearby({ entries, onNavigate }: NearbyProps) {
  return (
    <div style={styles.grid}>
      {entries.map((n) => (
        <div key={n.target} style={styles.card} onClick={() => onNavigate(n.target)}>
          <div style={styles.name}>{n.target}</div>
          <div style={styles.reason}>distance: {n.distance}</div>
          <div style={styles.tags}>
            {n.shared.map((s, i) => (
              <span key={i} style={styles.tag}>{s}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  card: {
    padding: '14px 16px',
    background: '#fff',
    border: '1px solid #bce5d9',
    borderRadius: 8,
    cursor: 'pointer',
  },
  name: { fontWeight: 500, fontSize: 13, color: '#1a1816', marginBottom: 4 },
  reason: { fontSize: 10, color: '#7a756d', marginBottom: 6 },
  tags: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  tag: {
    padding: '1px 6px',
    borderRadius: 3,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9,
    background: '#eef8f5',
    color: '#0e8a6e',
    border: '1px solid #bce5d9',
  },
};
