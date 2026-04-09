import { useState, useEffect, useMemo } from 'react';
import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { RoomDataSnapshot } from '../matrix/sync-manager';
import { getDataRoom } from '../matrix/event-bridge';

interface RoomDataViewerProps {
  onBack: () => void;
  matrixClient?: MatrixClient | null;
  roomId?: string | null;
}

const EO_EVENT_TYPE = 'com.eo-db.event';

const OP_COLORS: Record<string, string> = {
  NUL: '#FBBF24',
  SIG: '#5B9BD5',
  INS: '#22c55e',
  SEG: '#60A5FA',
  CON: '#8b5cf6',
  SYN: '#C084FC',
  DEF: '#FB923C',
  EVA: '#06b6d4',
  REC: '#F472B6',
};

export function RoomDataViewer({ onBack, matrixClient, roomId }: RoomDataViewerProps) {
  const { theme } = useTheme();
  const lastSeq = useEoStore((s) => s.lastSeq);
  const [data, setData] = useState<RoomDataSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    overview: true,
    members: false,
    eoEvents: true,
    systemEvents: false,
    state: false,
    raw: false,
  });

  useEffect(() => {
    if (!matrixClient || !roomId) {
      setError('No Matrix connection — running in local-only mode. Room data is only available when connected to a Matrix homeserver. Local store has ' + lastSeq + ' event(s).');
      return;
    }
    try {
      const room = matrixClient.getRoom(roomId);
      if (!room) {
        setError('Room not found — sync may not be initialized yet');
        return;
      }

      const currentState = room.currentState;
      const stateEvents: RoomDataSnapshot['stateEvents'] = [];
      for (const evMap of Object.values(currentState.events as Map<string, Map<string, MatrixEvent>> | Record<string, Record<string, MatrixEvent>>)) {
        const entries = evMap instanceof Map ? evMap.values() : Object.values(evMap);
        for (const ev of entries) {
          stateEvents.push({
            type: ev.getType(),
            stateKey: ev.getStateKey() ?? '',
            sender: ev.getSender() ?? '',
            content: ev.getContent(),
          });
        }
      }

      const members = room.getJoinedMembers().map((m: any) => ({
        userId: m.userId,
        displayName: m.name || null,
        membership: m.membership,
      }));

      const allTimelineEvents = room.getLiveTimeline().getEvents();
      const timeline = allTimelineEvents.slice(-100).map((ev: MatrixEvent) => ({
        eventId: ev.getId() ?? '',
        type: ev.getType(),
        sender: ev.getSender() ?? '',
        ts: ev.getTs(),
        content: ev.getContent(),
      }));

      const encryptionEvent = currentState.getStateEvents('m.room.encryption', '');
      const joinRuleEvent = currentState.getStateEvents('m.room.join_rules', '');
      const historyEvent = currentState.getStateEvents('m.room.history_visibility', '');
      const createEvent = currentState.getStateEvents('m.room.create', '');

      setData({
        roomId,
        roomAlias: getDataRoom(),
        name: room.name || null,
        topic: (currentState.getStateEvents('m.room.topic', '') as any)?.getContent()?.topic ?? null,
        memberCount: members.length,
        members,
        encryptionEnabled: !!encryptionEvent,
        encryptionAlgorithm: encryptionEvent?.getContent()?.algorithm ?? null,
        timelineLength: allTimelineEvents.length,
        timeline,
        stateEvents,
        roomVersion: createEvent?.getContent()?.room_version ?? null,
        joinRule: joinRuleEvent?.getContent()?.join_rule ?? null,
        historyVisibility: historyEvent?.getContent()?.history_visibility ?? null,
      });
    } catch (e: any) {
      setError(e.message);
    }
  }, [matrixClient, roomId, lastSeq]);

  const { eoEvents, systemEvents } = useMemo(() => {
    if (!data) return { eoEvents: [], systemEvents: [] };
    return {
      eoEvents: data.timeline.filter((ev) => ev.type === EO_EVENT_TYPE),
      systemEvents: data.timeline.filter((ev) => ev.type !== EO_EVENT_TYPE),
    };
  }, [data]);

  const filteredEoEvents = useMemo(() => {
    if (!filter.trim()) return eoEvents;
    const q = filter.toLowerCase();
    return eoEvents.filter((ev) => {
      const c = ev.content || {};
      const searchable = [c.op, c.target, JSON.stringify(c.operand || {}), c.client_event_id || '']
        .join(' ')
        .toLowerCase();
      return searchable.includes(q);
    });
  }, [eoEvents, filter]);

  function toggleSection(key: string) {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const s = styles(theme);

  return (
    <div style={s.container}>
      <div style={s.inner}>
        <button onClick={onBack} style={s.backBtn}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8.5 3L4.5 7L8.5 11" />
          </svg>
          Settings
        </button>

        <div style={s.title}>Room Data</div>
        <div style={s.subtitle}>Raw Matrix room state and timeline</div>

        {error && <div style={s.errorBox}>{error}</div>}

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
              <RawField label="EO Events" value={String(eoEvents.length)} theme={theme} />
              <RawField label="System Events" value={String(systemEvents.length)} theme={theme} />
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

            {/* EO Events */}
            <CollapsibleSection
              title={`EO Events (${eoEvents.length})`}
              expanded={expandedSections.eoEvents}
              onToggle={() => toggleSection('eoEvents')}
              theme={theme}
            >
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by target, op, status..."
                style={s.filterInput}
              />
              {filteredEoEvents.length === 0 ? (
                <div style={s.emptyNote}>
                  {filter ? 'No matching events' : 'No EO events'}
                </div>
              ) : (
                filteredEoEvents.map((ev, i) => (
                  <EoEvent key={i} event={ev} theme={theme} />
                ))
              )}
            </CollapsibleSection>

            {/* System Events */}
            <CollapsibleSection
              title={`System Events (${systemEvents.length})`}
              expanded={expandedSections.systemEvents}
              onToggle={() => toggleSection('systemEvents')}
              theme={theme}
            >
              {systemEvents.length === 0 ? (
                <div style={s.emptyNote}>No system events</div>
              ) : (
                systemEvents.map((ev, i) => (
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
              expanded={expandedSections.raw}
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
      padding: '14px 0',
    }}>
      <button onClick={onToggle} style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12,
        fontWeight: 700,
        textTransform: 'uppercase' as const,
        letterSpacing: '0.08em',
        color: theme.textMuted,
      }}>
        <svg
          width="12" height="12" viewBox="0 0 10 10" fill="none"
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
      display: 'grid',
      gridTemplateColumns: '160px 1fr',
      padding: '4px 0',
      gap: 16,
      alignItems: 'baseline',
    }}>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: theme.textMuted }}>
        {label}
      </span>
      <span style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12,
        color: theme.text,
        wordBreak: 'break-all' as const,
        minWidth: 0,
      }}>
        {value}
      </span>
    </div>
  );
}

function EoEvent({ event, theme }: {
  event: { eventId: string; type: string; sender: string; ts: number; content: any };
  theme: Theme;
}) {
  const [expanded, setExpanded] = useState(false);
  const c = event.content || {};
  const op = c.op || '?';
  const target = c.target || '';
  const operand = c.operand || {};
  const seq = c.seq != null ? c.seq : '';
  const ts = new Date(event.ts).toISOString();
  const sender = event.sender.replace(/@([^:]+):.*/, '$1');
  const opColor = OP_COLORS[op] || theme.textMuted;

  const fieldPairs = Object.entries(operand).slice(0, 4);

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
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          fontWeight: 700,
          color: opColor,
          width: 32,
          flexShrink: 0,
        }}>
          {op}
        </span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: theme.accent,
          flexShrink: 0,
          maxWidth: 280,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' as const,
        }} title={target}>
          {target}
        </span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          color: theme.textMuted,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' as const,
        }}>
          {fieldPairs.map(([k, v], i) => (
            <span key={k}>
              {i > 0 && <span style={{ color: theme.border, margin: '0 5px' }}>|</span>}
              <span style={{ color: theme.textMuted }}>{k}:</span>
              <span style={{ color: theme.text }}>{String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 40)}</span>
            </span>
          ))}
        </span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          color: theme.textMuted,
          flexShrink: 0,
        }}>
          {seq ? `#${seq}` : ''}
        </span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          color: theme.textMuted,
          flexShrink: 0,
        }}>
          {ts.slice(11, 19)}
        </span>
      </div>
      {expanded && (
        <div style={{
          marginTop: 6,
          padding: 12,
          background: theme.bgMuted,
          borderRadius: 4,
          border: `1px solid ${theme.border}`,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          overflow: 'auto',
          maxHeight: 260,
        }}>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' as const, marginBottom: 8 }}>
            <span><span style={{ color: theme.textMuted }}>op</span> <span style={{ color: opColor, fontWeight: 600 }}>{op}</span></span>
            <span><span style={{ color: theme.textMuted }}>target</span> <span style={{ color: theme.accent }}>{target}</span></span>
            <span><span style={{ color: theme.textMuted }}>seq</span> <span style={{ color: theme.text }}>{seq}</span></span>
            <span><span style={{ color: theme.textMuted }}>sender</span> <span style={{ color: theme.textMuted }}>{sender}</span></span>
            <span><span style={{ color: theme.textMuted }}>ts</span> <span style={{ color: theme.textMuted }}>{ts}</span></span>
          </div>
          <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 8, marginTop: 4 }}>
            <div style={{ color: theme.textMuted, fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: '0.5px', marginBottom: 6 }}>
              Operand
            </div>
            {Object.keys(operand).length > 0 ? (
              Object.entries(operand).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', gap: 10, padding: '3px 0' }}>
                  <span style={{ color: theme.textMuted, flexShrink: 0 }}>{k}</span>
                  <span style={{ color: theme.text, wordBreak: 'break-all' as const }}>
                    {typeof v === 'string' ? v : JSON.stringify(v)}
                  </span>
                </div>
              ))
            ) : (
              <span style={{ color: theme.textMuted, fontStyle: 'italic' }}>empty</span>
            )}
          </div>
          {c.client_event_id && (
            <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 6, marginTop: 6, color: theme.textMuted, fontSize: 10 }}>
              event_id: {c.client_event_id}
            </div>
          )}
        </div>
      )}
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
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke={theme.textMuted} strokeWidth="1.5" strokeLinecap="round"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}
        >
          <path d="M3.5 2L6.5 5L3.5 8" />
        </svg>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: theme.accent,
          flexShrink: 0,
        }}>
          {event.type}
        </span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: theme.textMuted,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' as const,
        }}>
          {event.sender}
        </span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          color: theme.textMuted,
          marginLeft: 'auto',
          flexShrink: 0,
        }}>
          {ts.slice(11, 19)}
        </span>
      </div>
      {expanded && (
        <pre style={{
          marginTop: 6,
          padding: 12,
          background: theme.bgMuted,
          borderRadius: 4,
          border: `1px solid ${theme.border}`,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
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
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke={theme.textMuted} strokeWidth="1.5" strokeLinecap="round"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}
        >
          <path d="M3.5 2L6.5 5L3.5 8" />
        </svg>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: theme.purple,
          flexShrink: 0,
        }}>
          {event.type}
        </span>
        {event.stateKey && (
          <span style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            color: theme.textMuted,
            background: theme.bgMuted,
            padding: '2px 6px',
            borderRadius: 2,
          }}>
            {event.stateKey}
          </span>
        )}
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
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
          marginTop: 6,
          padding: 12,
          background: theme.bgMuted,
          borderRadius: 4,
          border: `1px solid ${theme.border}`,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
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
      padding: '12px 24px 40px',
    },
    inner: {
      width: '100%',
      maxWidth: 840,
    },
    backBtn: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12,
      color: t.accent,
      padding: '8px 0',
    },
    title: {
      fontFamily: "'Source Serif 4', Georgia, serif",
      fontSize: 22,
      fontWeight: 600,
      color: t.textHeading,
      marginTop: 4,
    },
    subtitle: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textMuted,
      marginBottom: 16,
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
    filterInput: {
      width: '100%',
      padding: '8px 12px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      color: t.text,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12,
      outline: 'none',
      marginBottom: 10,
    },
    emptyNote: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textMuted,
      fontStyle: 'italic',
    },
    memberRow: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '6px 0',
      borderBottom: `1px solid ${t.borderLight}`,
    },
    memberId: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12,
      color: t.text,
    },
    memberMeta: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textMuted,
    },
    badge: {
      padding: '2px 6px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 3,
      fontSize: 10,
      fontWeight: 600,
    },
    rawJson: {
      padding: 12,
      background: t.bgMuted,
      borderRadius: 4,
      border: `1px solid ${t.border}`,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.text,
      overflow: 'auto',
      maxHeight: 500,
      whiteSpace: 'pre-wrap' as const,
      wordBreak: 'break-all' as const,
    },
  };
}
