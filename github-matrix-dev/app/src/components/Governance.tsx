import type { GovernanceEntry } from '../db/types';

const SCOPE_ICONS: Record<string, string> = {
  direct: '\u22a8',
  collection: '\u0192',
  ancestor: '|',
};

interface GovernanceProps {
  entries: GovernanceEntry[];
}

export function Governance({ entries }: GovernanceProps) {
  return (
    <div style={styles.list}>
      {entries.map((r, i) => (
        <div key={i} style={styles.rule}>
          <div style={styles.icon}>{SCOPE_ICONS[r.scope] || '\u22a8'}</div>
          <div style={styles.text}>
            <div style={styles.desc}>
              {r.formula
                ? `Formula: ${typeof r.formula === 'string' ? r.formula : JSON.stringify(r.formula)}`
                : `Strategy: ${r.strategy || 'default'}`}
            </div>
            <div style={styles.scope}>
              {r.scope} scope · {r.target} · {r.mode || 'fold'}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  rule: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '10px 14px',
    background: '#fff',
    border: '1px solid #e5d5b8',
    borderRadius: 8,
  },
  icon: {
    width: 28,
    height: 28,
    borderRadius: 6,
    background: '#faf5ed',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    flexShrink: 0,
    marginTop: 2,
  },
  text: { flex: 1 },
  desc: { fontSize: 12, color: '#2c2a26', fontWeight: 400 },
  scope: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9,
    color: '#aba69e',
    marginTop: 2,
  },
};
