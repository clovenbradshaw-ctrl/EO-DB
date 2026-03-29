/**
 * Six-layer Horizon record view — the core CRM display.
 * Renders: Figure, Trajectory, Grounds, Nearby, Governance, Signals
 */

import { useEffect, useState } from 'react';
import type { HorizonResponse } from '../db/types';
import { useEoStore } from '../store/eo-store';
import { FigureFields } from './FigureFields';
import { Trajectory } from './Trajectory';
import { Grounds } from './Grounds';
import { Nearby } from './Nearby';
import { Governance } from './Governance';
import { Signals } from './Signals';

interface RecordViewProps {
  target: string;
  onNavigate: (target: string) => void;
}

export function RecordView({ target, onNavigate }: RecordViewProps) {
  const horizon = useEoStore((s) => s.horizon);
  const [data, setData] = useState<HorizonResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    horizon(target, { signals: true }).then((result) => {
      if (cancelled) return;
      if (result && !Array.isArray(result)) {
        setData(result);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [target, horizon]);

  if (loading) {
    return <div style={styles.loading}>Loading record...</div>;
  }

  if (!data || !data.figure) {
    return <div style={styles.loading}>Record not found</div>;
  }

  const value = data.figure.value || {};
  const statusClass = value.status === 'active' ? 'active' : value.status === 'archived' ? 'archived' : 'pending';

  return (
    <div style={styles.container}>
      {/* Record Header */}
      <div style={styles.header}>
        <div style={styles.headerTop}>
          <div style={styles.clientName}>{value.name || target}</div>
          <div style={{ ...styles.statusBadge, ...statusStyles[statusClass] }}>
            {value.status || 'unknown'}
          </div>
        </div>
        <div style={styles.meta}>
          <span style={styles.metaItem}>
            <span style={styles.metaLabel}>Target:</span> {target}
          </span>
          <span style={styles.metaItem}>
            <span style={styles.metaLabel}>Last op:</span> {data.figure.last_op}
          </span>
          <span style={styles.metaItem}>
            <span style={styles.metaLabel}>Agent:</span> {data.figure.last_agent}
          </span>
        </div>
      </div>

      {/* Layer 1: Figure */}
      <Section title="Client Record" subtitle="what this target is" color="#1a6dd4">
        <FigureFields figure={data.figure} onNavigate={onNavigate} />
      </Section>

      {/* Layer 5: Trajectory */}
      {data.trajectory && data.trajectory.length > 0 && (
        <Section title="Trajectory" subtitle="where this record has been" color="#7a756d">
          <Trajectory entries={data.trajectory} />
        </Section>
      )}

      {/* Layer 2: Grounds */}
      {data.grounds && data.grounds.length > 0 && (
        <Section title="Context" subtitle="conditions that apply here" color="#7c5cbf">
          <Grounds entries={data.grounds} />
        </Section>
      )}

      {/* Layer 3: Nearby */}
      {data.nearby && data.nearby.length > 0 && (
        <Section title="Similar Records" subtitle="nearby in the key-space" color="#0e8a6e">
          <Nearby entries={data.nearby} onNavigate={onNavigate} />
        </Section>
      )}

      {/* Layer 4: Governance */}
      {data.governance && data.governance.length > 0 && (
        <Section title="Governance" subtitle="rules that apply to this record" color="#8b6834">
          <Governance entries={data.governance} />
        </Section>
      )}

      {/* Layer 6: Signals */}
      <Section title="Patterns" subtitle="what the database sees across similar records" color="#c2700a">
        <Signals entries={data.signals || []} />
      </Section>
    </div>
  );
}

function Section({ title, subtitle, color, children }: {
  title: string;
  subtitle: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div style={styles.section}>
      <div style={{ ...styles.sectionEdge, background: color }} />
      <div style={styles.sectionHeader}>
        <div style={{ ...styles.sectionTitle, color }}>
          {title} <span style={styles.sectionSubtitle}>— {subtitle}</span>
        </div>
      </div>
      {children}
    </div>
  );
}

const statusStyles: Record<string, React.CSSProperties> = {
  active: { background: '#e8f7ee', color: '#16643a', border: '1px solid #b8e4ca' },
  archived: { background: '#eceae6', color: '#aba69e', border: '1px solid #d4d0ca', textDecoration: 'line-through' },
  pending: { background: '#fef6e8', color: '#8a6d20', border: '1px solid #eedcaa' },
};

const styles: Record<string, React.CSSProperties> = {
  container: { background: '#faf9f7' },
  loading: { padding: 40, textAlign: 'center', color: '#7a756d', fontSize: 14 },
  header: {
    padding: '28px 36px 24px',
    background: '#fff',
    borderBottom: '1px solid #e5e2dd',
  },
  headerTop: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  clientName: {
    fontFamily: "'Source Serif 4', Georgia, serif",
    fontSize: 28,
    fontWeight: 600,
    color: '#1a1816',
  },
  statusBadge: {
    padding: '4px 12px',
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 500,
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: 20,
    marginTop: 8,
    fontSize: 12,
    color: '#7a756d',
  },
  metaItem: { display: 'flex', alignItems: 'center', gap: 4 },
  metaLabel: { color: '#aba69e' },
  section: {
    padding: '24px 36px',
    borderBottom: '1px solid #e5e2dd',
    position: 'relative' as const,
  },
  sectionEdge: {
    position: 'absolute' as const,
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
  },
  sectionHeader: { marginBottom: 16 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: 1,
  },
  sectionSubtitle: {
    fontSize: 10,
    fontWeight: 300,
    color: '#aba69e',
    textTransform: 'none' as const,
    letterSpacing: 0,
  },
};
