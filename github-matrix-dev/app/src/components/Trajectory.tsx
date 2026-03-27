import type { LoggableOperator } from '../db/types';

const OP_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  INS: { bg: '#e8f7ee', color: '#16a34a', border: '#16a34a' },
  DEF: { bg: '#eef5fd', color: '#1a6dd4', border: '#1a6dd4' },
  CON: { bg: '#f3f0fa', color: '#7c5cbf', border: '#7c5cbf' },
  SEG: { bg: '#fce8f0', color: '#d9487a', border: '#d9487a' },
  SYN: { bg: '#f3f0fa', color: '#7c5cbf', border: '#7c5cbf' },
  EVA: { bg: '#eef8f5', color: '#0e8a6e', border: '#0e8a6e' },
  REC: { bg: '#fef6ed', color: '#c2700a', border: '#c2700a' },
};

interface TrajectoryProps {
  ops: LoggableOperator[];
}

export function Trajectory({ ops }: TrajectoryProps) {
  return (
    <div style={styles.row}>
      {ops.map((op, i) => {
        const c = OP_COLORS[op] || OP_COLORS.DEF;
        return (
          <div key={i} style={styles.nodeWrap}>
            {i > 0 && <div style={styles.connector} />}
            <div style={styles.node}>
              <div style={{
                ...styles.dot,
                background: c.bg,
                color: c.color,
                borderColor: c.border,
              }}>
                {op}
              </div>
              <div style={styles.label}>{op}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: { display: 'flex', alignItems: 'center', padding: '4px 0' },
  nodeWrap: { display: 'flex', alignItems: 'center' },
  connector: { width: 24, height: 2, background: '#d4d0ca', flexShrink: 0 },
  node: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
  dot: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 7,
    fontWeight: 600,
    border: '2px solid',
  },
  label: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 8,
    color: '#aba69e',
    marginTop: 4,
    whiteSpace: 'nowrap' as const,
  },
};
