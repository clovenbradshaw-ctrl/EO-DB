/**
 * Six-layer Horizon record view — the core CRM display.
 * Renders: Figure, Trajectory, Grounds, Nearby, Governance, Signals
 */

import { useCallback, useEffect, useState } from 'react';
import type { HorizonResponse, NearbyEntry, SignalEntry, RecCycleInfo, GovernanceEntry } from '../db/types';
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

  // Lazy section state — populated only when the user expands the section.
  const [nearby, setNearby] = useState<NearbyEntry[] | undefined>(undefined);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const [signals, setSignals] = useState<SignalEntry[] | undefined>(undefined);
  const [signalsLoading, setSignalsLoading] = useState(false);
  const [signalsError, setSignalsError] = useState<string | null>(null);
  const [governance, setGovernance] = useState<GovernanceEntry[] | undefined>(undefined);
  const [governanceLoading, setGovernanceLoading] = useState(false);
  const [governanceError, setGovernanceError] = useState<string | null>(null);
  const [hashCohort, setHashCohort] = useState<string[] | undefined>(undefined);
  const [hashLoading, setHashLoading] = useState(false);
  const [hashError, setHashError] = useState<string | null>(null);
  const [recCycle, setRecCycle] = useState<RecCycleInfo | undefined>(undefined);
  const [recCycleLoaded, setRecCycleLoaded] = useState(false);
  const [recCycleLoading, setRecCycleLoading] = useState(false);
  const [recCycleError, setRecCycleError] = useState<string | null>(null);
  const [historyOpened, setHistoryOpened] = useState(false);

  const { theme } = useTheme();
  const s = makeStyles(theme);

  useEffect(() => {
    if (!ready) return; // store is hydrating — keep loading, retry when ready flips true
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Reset per-section lazy state when target changes.
    setNearby(undefined); setNearbyLoading(false); setNearbyError(null);
    setSignals(undefined); setSignalsLoading(false); setSignalsError(null);
    setGovernance(undefined); setGovernanceLoading(false); setGovernanceError(null);
    setHashCohort(undefined); setHashLoading(false); setHashError(null);
    setRecCycle(undefined); setRecCycleLoaded(false); setRecCycleLoading(false); setRecCycleError(null);
    setHistoryOpened(false);

    // Fast path: figure + ancestry + grounds + trajectory only. All expensive
    // sections are opt-in via LazySection.
    horizon(target, {})
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

  // Background fetch for the header twin-count badge. Does not block render.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    horizon(target, { hashCohort: true })
      .then((result) => {
        if (cancelled) return;
        if (result && !Array.isArray(result)) {
          setHashCohort(result.hashCohort ?? []);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[RecordView] background hashCohort failed', err);
      });
    return () => { cancelled = true; };
  }, [ready, target, horizon]);

  const loadNearby = useCallback(async () => {
    if (nearby !== undefined || nearbyLoading) return;
    setNearbyLoading(true); setNearbyError(null);
    try {
      const result = await horizon(target, { nearby: true });
      if (result && !Array.isArray(result)) setNearby(result.nearby ?? []);
    } catch (err: any) {
      console.error('[RecordView] lazy nearby failed', err);
      setNearbyError(err?.message ?? String(err));
    } finally {
      setNearbyLoading(false);
    }
  }, [target, horizon, nearby, nearbyLoading]);

  const loadSignals = useCallback(async () => {
    if (signals !== undefined || signalsLoading) return;
    setSignalsLoading(true); setSignalsError(null);
    try {
      const result = await horizon(target, { signals: true });
      if (result && !Array.isArray(result)) setSignals(result.signals ?? []);
    } catch (err: any) {
      console.error('[RecordView] lazy signals failed', err);
      setSignalsError(err?.message ?? String(err));
    } finally {
      setSignalsLoading(false);
    }
  }, [target, horizon, signals, signalsLoading]);

  const loadGovernance = useCallback(async () => {
    if (governance !== undefined || governanceLoading) return;
    setGovernanceLoading(true); setGovernanceError(null);
    try {
      const result = await horizon(target, { governance: true });
      if (result && !Array.isArray(result)) setGovernance(result.governance ?? []);
    } catch (err: any) {
      console.error('[RecordView] lazy governance failed', err);
      setGovernanceError(err?.message ?? String(err));
    } finally {
      setGovernanceLoading(false);
    }
  }, [target, horizon, governance, governanceLoading]);

  const loadHashCohort = useCallback(async () => {
    // May already be populated by the background effect.
    if (hashCohort !== undefined || hashLoading) return;
    setHashLoading(true); setHashError(null);
    try {
      const result = await horizon(target, { hashCohort: true });
      if (result && !Array.isArray(result)) setHashCohort(result.hashCohort ?? []);
    } catch (err: any) {
      console.error('[RecordView] lazy hashCohort failed', err);
      setHashError(err?.message ?? String(err));
    } finally {
      setHashLoading(false);
    }
  }, [target, horizon, hashCohort, hashLoading]);

  const loadRecCycle = useCallback(async () => {
    if (recCycleLoaded || recCycleLoading) return;
    setRecCycleLoading(true); setRecCycleError(null);
    try {
      const result = await horizon(target, { recCycle: true });
      if (result && !Array.isArray(result)) {
        setRecCycle(result.recCycle);
        setRecCycleLoaded(true);
      }
    } catch (err: any) {
      console.error('[RecordView] lazy recCycle failed', err);
      setRecCycleError(err?.message ?? String(err));
    } finally {
      setRecCycleLoading(false);
    }
  }, [target, horizon, recCycleLoaded, recCycleLoading]);

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
          {hashCohort && hashCohort.length > 0 && (
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
                {hashCohort.length} twin{hashCohort.length !== 1 ? 's' : ''}
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

      {/* Edit History — lazy: full log scan, mount ElementHistory on first expand */}
      <LazySection
        title="Event History"
        subtitle="changes to this record with revert"
        color={theme.warning}
        loaded={historyOpened}
        loading={false}
        error={null}
        onLoad={() => setHistoryOpened(true)}
      >
        {historyOpened && <ElementHistory target={target} />}
      </LazySection>

      {/* Layer 2: Grounds */}
      {data.grounds && data.grounds.length > 0 && (
        <Section title="Context" subtitle="conditions that apply here" color={theme.purple}>
          <Grounds entries={data.grounds} />
        </Section>
      )}

      {/* Layer 3: Nearby — lazy: O(N) edge lookups across the collection */}
      <LazySection
        title="Similar Records"
        subtitle="nearby in the key-space"
        color={theme.teal}
        loaded={nearby !== undefined}
        loading={nearbyLoading}
        error={nearbyError}
        onLoad={loadNearby}
        emptyMessage="No similar records"
      >
        {nearby && nearby.length > 0 && <Nearby entries={nearby} onNavigate={onNavigate} />}
      </LazySection>

      {/* Layer 4: Governance — lazy: EVA registration scan */}
      <LazySection
        title="Governance"
        subtitle="rules that apply to this record"
        color={theme.gold}
        loaded={governance !== undefined}
        loading={governanceLoading}
        error={governanceError}
        onLoad={loadGovernance}
        emptyMessage="No governance rules"
      >
        {governance && governance.length > 0 && <Governance entries={governance} />}
      </LazySection>

      {/* Layer 6: Signals — lazy: full collection scan + population stats */}
      <LazySection
        title="Patterns"
        subtitle="what the database sees across similar records"
        color={theme.warning}
        loaded={signals !== undefined}
        loading={signalsLoading}
        error={signalsError}
        onLoad={loadSignals}
        emptyMessage="No patterns detected"
      >
        {signals && signals.length > 0 && <Signals entries={signals} />}
      </LazySection>

      {/* Hash Cohort: Structural Twins — lazy: collection prefix scan (hydrated by background effect when possible) */}
      <LazySection
        title="Structural Twins"
        subtitle="identical transformation journeys"
        color={theme.purple}
        loaded={hashCohort !== undefined}
        loading={hashLoading}
        error={hashError}
        onLoad={loadHashCohort}
        emptyMessage="No structural twins"
      >
        {hashCohort && hashCohort.length > 0 && (
          <HashCohort targets={hashCohort} currentTarget={target} onNavigate={onNavigate} />
        )}
      </LazySection>

      {/* REC Cycle: Dependency Cycle Visualization — lazy: graph walk */}
      <LazySection
        title="Dependency Cycle"
        subtitle="recursive formula resolution"
        color={theme.danger}
        loaded={recCycleLoaded}
        loading={recCycleLoading}
        error={recCycleError}
        onLoad={loadRecCycle}
        emptyMessage="No dependency cycle"
      >
        {recCycle && <RecCycleMap cycle={recCycle} onNavigate={onNavigate} />}
      </LazySection>
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

function LazySection({
  title, subtitle, color, loaded, loading, error, onLoad, defaultOpen = false,
  emptyMessage = 'No results', children,
}: {
  title: string;
  subtitle: string;
  color: string;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
  defaultOpen?: boolean;
  emptyMessage?: string;
  children: React.ReactNode;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [open, setOpen] = useState(defaultOpen);

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !loading) onLoad();
  };

  const hasContent = children !== undefined && children !== null && children !== false;

  return (
    <div style={s.section}>
      <div style={{ ...s.sectionEdge, background: color }} />
      <div
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggle(); } }}
        style={{ ...s.sectionHeader, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, userSelect: 'none' }}
      >
        <span style={{ fontSize: 10, color: theme.textMuted, width: 10, display: 'inline-block' }}>
          {open ? '▾' : '▸'}
        </span>
        <div style={{ ...s.sectionTitle, color }}>
          {title} <span style={s.sectionSubtitle}>— {subtitle}</span>
          {!loaded && !loading && (
            <span style={{ ...s.sectionSubtitle, marginLeft: 6 }}>(click to load)</span>
          )}
        </div>
      </div>
      {open && loading && (
        <div style={{ fontSize: 11, color: theme.textMuted, padding: '4px 0 0 18px' }}>Loading…</div>
      )}
      {open && error && (
        <div style={{ fontSize: 11, color: theme.danger, padding: '4px 0 0 18px' }}>Failed: {error}</div>
      )}
      {open && loaded && !loading && !error && (
        hasContent ? children : (
          <div style={{ fontSize: 11, color: theme.textMuted, padding: '4px 0 0 18px' }}>{emptyMessage}</div>
        )
      )}
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
