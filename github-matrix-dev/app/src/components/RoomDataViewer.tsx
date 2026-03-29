import { useState, useEffect } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { RoomDataSnapshot } from '../matrix/sync-manager';

interface RoomDataViewerProps {
  onBack: () => void;
}

export function RoomDataViewer({ onBack }: RoomDataViewerProps) {
  const { theme } = useTheme();
  const syncManager = useEoStore((s) => s.syncManager);
  const [data, setData] = useState<RoomDataSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    overview: true,
    members: false,
    timeline: false,
    state: false,
  });

  useEffect(() => {
    if (!syncManager) {
      setError('Sync manager not connected');
      return;
    }
    try {
      const roomData = syncManager.getRoomData();
      if (!roomData) {
        setError('Room not found — sync may not be initialized yet');
        return;
      }
      setData(roomData);
    } catch (e: any) {
      setError(e.message);
    }
  }, [syncManager]);

  function toggleSection(key: string) {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const s = styles(theme);

  return (
    <div style={s.container}>
      <div style={s.inner}>
        {/* Back button */}
        <button onClick={onBack} style={s.backBtn}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8.5 3L4.5 7L8.5 11" />
          </svg>
          Settings
        </button>

        <div style={s.title}>Room Data</div>
        <div style={s.subtitle}>Raw Matrix room state and timeline</div>

        {error && (
          <div style={s.errorBox}>{error}</div>
        )}

        {data && (
          <>
            {/* Overview */}
            <CollapsibleSection
              title="Overview"
              expanded={expandedSections.overview}
              onToggle={() => toggleSection('overview')}
              theme={theme}
            >
              <RawField label="Room ID" value={data.roomId} theme={theme} />
              <RawField label="Room Alias" value={data.roomAlias} theme={theme} />
              <RawField label="Name" value={data.name ?? '(none)'} theme={theme} />
              <RawField label="Topic" value={data.topic ?? '(none)'} theme={theme} />
              <RawField label="Room Version" value={data.roomVersion ?? 'unknown'} theme={theme} />
              <RawField label="Join Rule" value={data.joinRule ?? 'unknown'} theme={theme} />
              <RawField label="History Visibility" value={data.historyVisibility ?? 'unknown'} theme={theme} />
              <RawField label="Encryption" value={data.encryptionEnabled ? `Enabled (${data.encryptionAlgorithm})` : 'Disabled'} theme={theme} />
              <RawField label="Members" value={String(data.memberCount)} theme={theme} />
              <RawField label="Timeline Events" value={String(data.timelineLength)} theme={theme} />
            </CollapsibleSection>

            {/* Members */}
            <CollapsibleSection
              title={`Members (${data.memberCount})`}
              expanded={expandedSections.members}
              onToggle={() => toggleSection('members')}
              theme={theme}
            >
              {data.members.length === 0 ? (
                <div style={s.emptyNote}>No members found</div>
              ) : (
                data.members.map((m, i) => (
                  <div key={i} style={s.memberRow}>
                    <span style={s.memberId}>{m.userId}</span>
                    <span style={s.memberMeta}>
                      {m.displayName && <span>{m.displayName}</span>}
                      <span style={s.badge}>{m.membership}</span>
                    </span>
                  </div>
                ))
              )}
            </CollapsibleSection>

            {/* Timeline */}
            <CollapsibleSection
              title={`Timeline (last ${data.timeline.length})`}
              expanded={expandedSections.timeline}
              onToggle={() => toggleSection('timeline')}
              theme={theme}
            >
              {data.timeline.length === 0 ? (
                <div style={s.emptyNote}>No timeline events</div>
              ) : (
                data.timeline.map((ev, i) => (
                  <TimelineEvent key={i} event={ev} theme={theme} />
                ))
              )}
            </CollapsibleSection>

            {/* State Events */}
            <CollapsibleSection
              title={`State Events (${data.stateEvents.length})`}
              expanded={expandedSections.state}
              onToggle={() => toggleSection('state')}
              theme={theme}
            >
              {data.stateEvents.length === 0 ? (
                <div style={s.emptyNote}>No state events</div>
              ) : (
                data.stateEvents.map((ev, i) => (
                  <StateEvent key={i} event={ev} theme={theme} />
                ))
              )}
            </CollapsibleSection>

            {/* Raw JSON dump */}
            <CollapsibleSection
              title="Raw JSON"
              expanded={false}
              onToggle={() => toggleSection('raw')}
              theme={theme}
            >
              {expandedSections.raw && (
                <pre style={s.rawJson}>{JSON.stringify(data, null, 2)}</pre>
              )}
            </CollapsibleSection>
          </>
        )}
      </div>
    </div>
  );
}

function CollapsibleSection({ title, expanded, onToggle, children, theme }: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  theme: Theme;
}) {
  return (
    <div style={{
      borderBottom: `1px solid ${theme.border}`,
      padding: '12px 0',
    }}>
      <button onClick={onToggle} style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase' as const,
        letterSpacing: '0.08em',
        color: theme.textMuted,
      }}>
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
        >
          <path d="M3.5 2L6.5 5L3.5 8" />
        </svg>
        {title}
      </button>
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function RawField({ label, value, theme }: { label: string; value: string; theme: Theme }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      padding: '3px 0',
      gap: 12,
    }}>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.textMuted, flexShrink: 0 }}>
        {label}
      </span>
      <span style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        color: theme.text,
        textAlign: 'right' as const,
        wordBreak: 'break-all' as const,
      }}>
        {value}
      </span>
    </div>
  );
}

function TimelineEvent({ event, theme }: {
  event: { eventId: string; type: string; sender: string; ts: number; content: any };
  theme: Theme;
}) {
  const [expanded, setExpanded] = useState(false);
  const ts = new Date(event.ts).toISOString();

  return (
    <div style={{
      padding: '6px 0',
      borderBottom: `1px solid ${theme.borderLight}`,
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
        }}
      >
        <svg
          width="8" height="8" viewBox="0 0 10 10" fill="none"
          stroke={theme.textMuted} strokeWidth="1.5" strokeLinecap="round"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}
        >
          <path d="M3.5 2L6.5 5L3.5 8" />
        </svg>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9,
          color: theme.accent,
          flexShrink: 0,
        }}>
          {event.type}
        </span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9,
          color: theme.textMuted,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' as const,
        }}>
          {event.sender}
        </span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 8,
          color: theme.textMuted,
          marginLeft: 'auto',
          flexShrink: 0,
        }}>
          {ts.slice(11, 19)}
        </span>
      </div>
      {expanded && (
        <pre style={{
          marginTop: 4,
          padding: 8,
          background: theme.bgMuted,
          borderRadius: 4,
          border: `1px solid ${theme.border}`,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9,
          color: theme.text,
          overflow: 'auto',
          maxHeight: 300,
          whiteSpace: 'pre-wrap' as const,
          wordBreak: 'break-all' as const,
        }}>
          {JSON.stringify(event.content, null, 2)}
        </pre>
      )}
    </div>
  );
}

function StateEvent({ event, theme }: {
  event: { type: string; stateKey: string; sender: string; content: any };
  theme: Theme;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      padding: '6px 0',
      borderBottom: `1px solid ${theme.borderLight}`,
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
        }}
      >
        <svg
          width="8" height="8" viewBox="0 0 10 10" fill="none"
          stroke={theme.textMuted} strokeWidth="1.5" strokeLinecap="round"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}
        >
          <path d="M3.5 2L6.5 5L3.5 8" />
        </svg>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9,
          color: theme.purple,
          flexShrink: 0,
        }}>
          {event.type}
        </span>
        {event.stateKey && (
          <span style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 8,
            color: theme.textMuted,
            background: theme.bgMuted,
            padding: '1px 4px',
            borderRadius: 2,
          }}>
            {event.stateKey}
          </span>
        )}
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9,
          color: theme.textMuted,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' as const,
          marginLeft: 'auto',
        }}>
          {event.sender}
        </span>
      </div>
      {expanded && (
        <pre style={{
          marginTop: 4,
          padding: 8,
          background: theme.bgMuted,
          borderRadius: 4,
          border: `1px solid ${theme.border}`,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9,
          color: theme.text,
          overflow: 'auto',
          maxHeight: 300,
          whiteSpace: 'pre-wrap' as const,
          wordBreak: 'break-all' as const,
        }}>
          {JSON.stringify(event.content, null, 2)}
        </pre>
      )}
    </div>
  );
}

function styles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      flex: 1,
      overflowY: 'auto',
      display: 'flex',
      justifyContent: 'center',
      padding: '8px 16px 40px',
    },
    inner: {
      width: '100%',
      maxWidth: 560,
    },
    backBtn: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.accent,
      padding: '8px 0',
    },
    title: {
      fontFamily: "'Source Serif 4', Georgia, serif",
      fontSize: 18,
      fontWeight: 600,
      color: t.textHeading,
      marginTop: 4,
    },
    subtitle: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.textMuted,
      marginBottom: 12,
    },
    errorBox: {
      padding: '10px 12px',
      background: t.dangerBg,
      border: `1px solid ${t.dangerBorder}`,
      borderRadius: 4,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.dangerText,
    },
    emptyNote: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.textMuted,
      fontStyle: 'italic',
    },
    memberRow: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '4px 0',
      borderBottom: `1px solid ${t.borderLight}`,
    },
    memberId: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.text,
    },
    memberMeta: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      color: t.textMuted,
    },
    badge: {
      padding: '1px 5px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 3,
      fontSize: 8,
      fontWeight: 600,
    },
    rawJson: {
      padding: 10,
      background: t.bgMuted,
      borderRadius: 4,
      border: `1px solid ${t.border}`,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      color: t.text,
      overflow: 'auto',
      maxHeight: 500,
      whiteSpace: 'pre-wrap' as const,
      wordBreak: 'break-all' as const,
    },
  };
}
