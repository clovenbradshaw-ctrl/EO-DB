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
import { useTheme, type Theme } from '../theme';

interface RecordViewProps {
  target: string;
  onNavigate: (target: string) => void;
}

export function RecordView({ target, onNavigate }: RecordViewProps) {
  const horizon = useEoStore((s) => s.horizon);
  const [data, setData] = useState<HorizonResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const { theme } = useTheme();
  const s = makeStyles(theme);

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
    return <div style={s.loading}>Loading record...</div>;
  }

  if (!data || !data.figure) {
    return <div style={s.loading}>Record not found</div>;
  }

  const value = data.figure.value || {};
  const statusClass = value.status === 'active' ? 'active' : value.status === 'archived' ? 'archived' : 'pending';
  const statusStyleMap: Record<string, React.CSSProperties> = {
    active: { background: theme.statusActive.bg, color: theme.statusActive.color, border: `1px solid ${theme.statusActive.border}` },
    archived: { background: theme.statusArchived.bg, color: theme.statusArchived.color, border: `1px solid ${theme.statusArchived.border}`, textDecoration: 'line-through' },
    pending: { background: theme.statusPending.bg, color: theme.statusPending.color, border: `1px solid ${theme.statusPending.border}` },
  };

  return (
    <div style={s.container}>
      {/* Record Header */}
      <div style={s.header}>
        <div style={s.headerTop}>
          <div style={s.clientName}>{value.name || target}</div>
          <div style={{ ...s.statusBadge, ...statusStyleMap[statusClass] }}>
            {value.status || 'unknown'}
          </div>
        </div>
        <div style={s.meta}>
          <span style={s.metaItem}>
            <span style={s.metaLabel}>Target:</span> {target}
          </span>
          <span style={s.metaItem}>
            <span style={s.metaLabel}>Last op:</span> {data.figure.last_op}
          </span>
          <span style={s.metaItem}>
            <span style={s.metaLabel}>Agent:</span> {data.figure.last_agent}
          </span>
        </div>
      </div>

      {/* Layer 1: Figure */}
      <Section title="Client Record" subtitle="what this target is" color={theme.accent}>
        <FigureFields figure={data.figure} onNavigate={onNavigate} />
      </Section>

      {/* Layer 5: Trajectory */}
      {data.trajectory && data.trajectory.length > 0 && (
        <Section title="Trajectory" subtitle="where this record has been" color={theme.textSecondary}>
          <Trajectory entries={data.trajectory} />
        </Section>
      )}

      {/* Layer 2: Grounds */}
      {data.grounds && data.grounds.length > 0 && (
        <Section title="Context" subtitle="conditions that apply here" color={theme.purple}>
          <Grounds entries={data.grounds} />
        </Section>
      )}

      {/* Layer 3: Nearby */}
      {data.nearby && data.nearby.length > 0 && (
        <Section title="Similar Records" subtitle="nearby in the key-space" color={theme.teal}>
          <Nearby entries={data.nearby} onNavigate={onNavigate} />
        </Section>
      )}

      {/* Layer 4: Governance */}
      {data.governance && data.governance.length > 0 && (
        <Section title="Governance" subtitle="rules that apply to this record" color={theme.gold}>
          <Governance entries={data.governance} />
        </Section>
      )}

      {/* Layer 6: Signals */}
      <Section title="Patterns" subtitle="what the database sees across similar records" color={theme.warning}>
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
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <div style={s.section}>
      <div style={{ ...s.sectionEdge, background: color }} />
      <div style={s.sectionHeader}>
        <div style={{ ...s.sectionTitle, color }}>
          {title} <span style={s.sectionSubtitle}>— {subtitle}</span>
        </div>
      </div>
      {children}
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: { background: t.bg },
    loading: { padding: 40, textAlign: 'center', color: t.textSecondary, fontSize: 14 },
    header: {
      padding: '28px 36px 24px',
      background: t.bgCard,
      borderBottom: `1px solid ${t.border}`,
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
      color: t.textHeading,
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
      color: t.textSecondary,
    },
    metaItem: { display: 'flex', alignItems: 'center', gap: 4 },
    metaLabel: { color: t.textMuted },
    section: {
      padding: '24px 36px',
      borderBottom: `1px solid ${t.border}`,
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
      color: t.textMuted,
      textTransform: 'none' as const,
      letterSpacing: 0,
    },
  };
}
