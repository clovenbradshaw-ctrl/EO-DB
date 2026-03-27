import type { GroundEntry } from '../db/types';

const ICONS: Record<string, string> = {
  regulatoryHold: '\u26a0',
  defaultRegion: '\u25c9',
  timezone: '\u25f7',
  firm: '\u2b21',
};

interface GroundsProps {
  entries: GroundEntry[];
}

export function Grounds({ entries }: GroundsProps) {
  return (
    <div style={styles.row}>
      {entries.map((g, i) => {
        const isWarning = g.key === 'regulatoryHold' && g.value === true;
        return (
          <div key={i} style={{
            ...styles.chip,
            ...(isWarning ? styles.warning : {}),
          }}>
            <div style={{
              ...styles.icon,
              ...(isWarning ? styles.warningIcon : {}),
            }}>
              {ICONS[g.key] || '\u25ce'}
            </div>
            <div style={styles.text}>
              <div style={styles.key}>{g.key}</div>
              <div style={{
                ...styles.val,
                ...(isWarning ? { color: '#d9487a', fontWeight: 500 } : {}),
              }}>
                {String(g.value)}
              </div>
              <div style={styles.from}>{g.source} (distance: {g.distance})</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: { display: 'flex', flexWrap: 'wrap', gap: 10 },
  chip: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    background: '#fff',
    border: '1px solid #d9d0ee',
    borderRadius: 8,
    minWidth: 160,
  },
  warning: { borderColor: '#d9487a', background: '#fdf2f5' },
  icon: {
    width: 32,
    height: 32,
    borderRadius: 6,
    background: '#f3f0fa',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    flexShrink: 0,
  },
  warningIcon: { background: '#fdf2f5', color: '#d9487a' },
  text: { flex: 1 },
  key: { fontSize: 10, color: '#7a756d', fontWeight: 500 },
  val: { fontSize: 13, color: '#1a1816', fontWeight: 400 },
  from: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 8,
    color: '#aba69e',
  },
};
