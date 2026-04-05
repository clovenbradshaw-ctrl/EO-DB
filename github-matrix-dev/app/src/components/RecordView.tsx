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
import { HashCohort } from './HashCohort';
import { RecCycleMap } from './RecCycleMap';
import { CadenceBadge } from './CadenceBadge';
import { GraphRoleBadge } from './GraphRoleBadge';
import { TypeBadge } from './TypeSelector';
import { ElementHistory } from './ElementHistory';
import { RedactedCell } from './RedactedCell';
import { useTheme, type Theme } from '../theme';
import { formatName } from './scope-picker-utils';
import type { ResolvedPermissions } from '../permissions/types';

interface RecordViewProps {
  target: string;
  onNavigate: (target: string) => void;
  permissions?: ResolvedPermissions | null;
  profileFields?: string[];
}

export function RecordView({ target, onNavigate, permissions, profileFields }: RecordViewProps) {
  const horizon = useEoStore((s) => s.horizon);
  const ready = useEoStore((s) => s.ready);
  const [data, setData] = useState<HorizonResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  useEffect(() => {
    if (!ready) return; // store is hydrating — keep loading, retry when ready flips true
    let cancelled = false;
    setLoading(true);
    setError(null);
    horizon(target, { signals: true })
      .then((result) => {
        if (cancelled) return;
        if (result && !Array.isArray(result)) {
          setData(result);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[RecordView] horizon failed', err);
        setError(err?.message ?? String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [ready, target, horizon]);

  if (loading) {
    return <div style={s.loading}>Loading record...</div>;
  }

  if (error) {
    return <div style={s.loading}>Failed to load record: {error}</div>;
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
          <div style={s.clientName}>{value.name || formatName(target.split('.').pop() || target)}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {value._type && <TypeBadge type={value._type} />}
            <div style={{ ...s.statusBadge, ...statusStyleMap[statusClass] }}>
              {value.status || 'unknown'}
            </div>
          </div>
        </div>
        <div style={s.meta}>
          <span style={s.metaItem}>
            <span style={s.metaLabel}>Target:</span> {target}
          </span>
          <span style={s.metaItem}>
            <span style={s.metaLabel}>Last modified seq</span> {data.figure.last_seq}
          </span>
          {data.graphMetrics && <GraphRoleBadge metrics={data.graphMetrics} />}
          {data.cadence && <CadenceBadge cadence={data.cadence} />}
          {data.hashCohort && data.hashCohort.length > 0 && (
            <span style={s.metaItem}>
              <span style={{
                fontSize: 10,
                fontFamily: "'JetBrains Mono', monospace",
                background: theme.purpleBg,
                color: theme.purple,
                border: `1px solid ${theme.purpleBorder}`,
                borderRadius: 10,
                padding: '2px 8px',
              }}>
                {data.hashCohort.length} twin{data.hashCohort.length !== 1 ? 's' : ''}
              </span>
            </span>
          )}
          {data.trajectoryFingerprint && (
            <span style={s.metaItem}>
              <span style={{
                fontSize: 10,
                fontFamily: "'JetBrains Mono', monospace",
                background: theme.accentBg,
                color: theme.accent,
                border: `1px solid ${theme.accentBorder}`,
                borderRadius: 10,
                padding: '2px 8px',
              }}>
                {data.trajectoryFingerprint.fingerprint.slice(0, 8)}
              </span>
            </span>
          )}
        </div>
      </div>

      {/* Layer 1: Figure — with redacted field support */}
      <Section title="Current State" subtitle="what this target is" color={theme.accent}>
        {permissions?.redacted_fields && permissions.redacted_fields.length > 0 ? (
          <div>
            <FigureFields figure={data.figure} onNavigate={onNavigate} profileFields={profileFields} />
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {permissions.redacted_fields.map(field => (
                <div key={field} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    color: theme.textMuted,
                    minWidth: 100,
                  }}>{field}</span>
                  <RedactedCell />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <FigureFields figure={data.figure} onNavigate={onNavigate} profileFields={profileFields} />
        )}
      </Section>

      {/* Layer 5: Trajectory */}
      {data.trajectory && data.trajectory.length > 0 && (
        <Section title="Trajectory" subtitle="where this record has been" color={theme.textSecondary}>
          <Trajectory entries={data.trajectory} fingerprint={data.trajectoryFingerprint} cadence={data.cadence} />
        </Section>
      )}

      {/* Edit History */}
      <Section title="Event History" subtitle="changes to this record with revert" color={theme.warning}>
        <ElementHistory target={target} />
      </Section>

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

      {/* Hash Cohort: Structural Twins */}
      {data.hashCohort && data.hashCohort.length > 0 && (
        <Section title="Structural Twins" subtitle="identical transformation journeys" color={theme.purple}>
          <HashCohort targets={data.hashCohort} currentTarget={target} onNavigate={onNavigate} />
        </Section>
      )}

      {/* REC Cycle: Dependency Cycle Visualization */}
      {data.recCycle && (
        <Section title="Dependency Cycle" subtitle="recursive formula resolution" color={theme.danger}>
          <RecCycleMap cycle={data.recCycle} onNavigate={onNavigate} />
        </Section>
      )}
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
