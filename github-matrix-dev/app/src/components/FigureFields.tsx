import type { EoState } from '../db/types';

interface FigureFieldsProps {
  figure: EoState;
  onNavigate: (target: string) => void;
}

export function FigureFields({ figure, onNavigate }: FigureFieldsProps) {
  const value = figure.value;
  if (!value || typeof value !== 'object') {
    return <div style={styles.mono}>{JSON.stringify(value)}</div>;
  }

  const entries = Object.entries(value).filter(([k]) => !k.startsWith('_'));

  return (
    <div style={styles.grid}>
      {entries.map(([key, val]) => (
        <div key={key} style={styles.cell}>
          <div style={styles.label}>
            {key}
            {value._computed && key === '_computed' && (
              <span style={styles.evaBadge}>EVA</span>
            )}
          </div>
          <div style={styles.value}>
            {typeof val === 'object' && val !== null
              ? renderObjectValue(val, onNavigate)
              : String(val)}
          </div>
        </div>
      ))}
    </div>
  );
}

function renderObjectValue(val: any, onNavigate: (t: string) => void): React.ReactNode {
  // CON linked array
  if (val.linked && Array.isArray(val.linked)) {
    return (
      <div>
        {val.linked.map((t: string) => (
          <div
            key={t}
            onClick={() => onNavigate(t)}
            style={styles.link}
          >
            {t}
          </div>
        ))}
      </div>
    );
  }
  return <span style={styles.mono}>{JSON.stringify(val, null, 1)}</span>;
}

const styles: Record<string, React.CSSProperties> = {
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 0,
  },
  cell: {
    padding: '14px 16px',
    border: '1px solid #e5e2dd',
    margin: '-1px 0 0 -1px',
    background: '#fff',
  },
  label: {
    fontSize: 10,
    fontWeight: 500,
    color: '#aba69e',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.3,
    marginBottom: 4,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  value: {
    fontSize: 14,
    color: '#1a1816',
    fontWeight: 400,
  },
  link: {
    color: '#7c5cbf',
    cursor: 'pointer',
    fontSize: 13,
  },
  mono: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: '#7a756d',
  },
  evaBadge: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 8,
    color: '#0e8a6e',
    padding: '1px 4px',
    borderRadius: 2,
    background: '#eef8f5',
    border: '1px solid #bce5d9',
  },
};
