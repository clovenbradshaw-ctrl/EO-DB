import { useState, useMemo } from 'react';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { useTheme, type Theme } from '../theme';
import { EO_SPACE_CONFIG_TYPE } from '../matrix/event-bridge';

interface MatrixRoomsViewerProps {
  client: MatrixClient;
  onBack: () => void;
}

interface RoomSummary {
  roomId: string;
  name: string;
  topic: string | null;
  memberCount: number;
  isEoSpace: boolean;
  spaceName: string | null;
  joinRule: string | null;
  roomVersion: string | null;
  timelineLength: number;
  lastActivity: number;
  creator: string | null;
  encryption: boolean;
}

function summarizeRoom(room: Room): RoomSummary {
  const state = room.currentState;

  // EO-DB space detection
  const configEvent = state.getStateEvents(EO_SPACE_CONFIG_TYPE, '');
  const spaceConfig = configEvent?.getContent();
  const isEoSpace = !!(spaceConfig?.name && spaceConfig?.rooms?.main);

  // Join rule
  const joinRuleEvent = state.getStateEvents('m.room.join_rules', '');
  const joinRule = joinRuleEvent?.getContent()?.join_rule ?? null;

  // Room version / creator
  const createEvent = state.getStateEvents('m.room.create', '');
  const roomVersion = createEvent?.getContent()?.room_version ?? null;
  const creator = createEvent?.getContent()?.creator ?? createEvent?.getSender?.() ?? null;

  // Topic
  const topicEvent = state.getStateEvents('m.room.topic', '');
  const topic = topicEvent?.getContent()?.topic ?? null;

  // Encryption
  const encEvent = state.getStateEvents('m.room.encryption', '');

  // Last activity
  const timeline = room.getLiveTimeline().getEvents();
  const lastEvent = timeline.length > 0 ? timeline[timeline.length - 1] : null;

  return {
    roomId: room.roomId,
    name: room.name || room.roomId,
    topic,
    memberCount: room.getJoinedMembers().length,
    isEoSpace,
    spaceName: isEoSpace ? spaceConfig.name : null,
    joinRule,
    roomVersion,
    timelineLength: timeline.length,
    lastActivity: lastEvent ? lastEvent.getTs() : 0,
    creator,
    encryption: !!encEvent,
  };
}

export function MatrixRoomsViewer({ client, onBack }: MatrixRoomsViewerProps) {
  const { theme } = useTheme();
  const [filter, setFilter] = useState('');
  const [expandedRoom, setExpandedRoom] = useState<string | null>(null);
  const s = styles(theme);

  const rooms = useMemo(() => {
    const allRooms = client.getRooms();
    return allRooms
      .map(summarizeRoom)
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }, [client]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return rooms;
    const q = filter.toLowerCase();
    return rooms.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      r.roomId.toLowerCase().includes(q) ||
      (r.spaceName?.toLowerCase().includes(q)) ||
      (r.topic?.toLowerCase().includes(q)),
    );
  }, [rooms, filter]);

  const eoCount = rooms.filter((r) => r.isEoSpace).length;

  return (
    <div style={s.container}>
      <div style={s.inner}>
        <button onClick={onBack} style={s.backBtn}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8.5 3L4.5 7L8.5 11" />
          </svg>
          Settings
        </button>

        <div style={s.title}>Matrix Rooms</div>
        <div style={s.subtitle}>
          {rooms.length} room{rooms.length !== 1 ? 's' : ''} joined
          {eoCount > 0 && ` \u00b7 ${eoCount} EO-DB space${eoCount !== 1 ? 's' : ''}`}
        </div>

        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name, room ID, or topic..."
          style={s.filterInput}
        />

        {filtered.length === 0 ? (
          <div style={s.emptyNote}>
            {filter ? 'No matching rooms' : 'No rooms found'}
          </div>
        ) : (
          filtered.map((room) => (
            <RoomRow
              key={room.roomId}
              room={room}
              expanded={expandedRoom === room.roomId}
              onToggle={() => setExpandedRoom(expandedRoom === room.roomId ? null : room.roomId)}
              theme={theme}
            />
          ))
        )}
      </div>
    </div>
  );
}

function RoomRow({ room, expanded, onToggle, theme }: {
  room: RoomSummary;
  expanded: boolean;
  onToggle: () => void;
  theme: Theme;
}) {
  const lastActivityStr = room.lastActivity
    ? new Date(room.lastActivity).toISOString().replace('T', ' ').slice(0, 19)
    : 'no activity';

  return (
    <div style={{
      borderBottom: `1px solid ${theme.borderLight}`,
      padding: '10px 0',
    }}>
      <div
        onClick={onToggle}
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

        {/* Status dot */}
        <div style={{
          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
          background: room.isEoSpace ? '#22c55e' : theme.textMuted,
          boxShadow: room.isEoSpace ? '0 0 4px #22c55e' : 'none',
        }} />

        {/* Room name */}
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          fontWeight: 600,
          color: theme.text,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' as const,
          flex: 1,
          minWidth: 0,
        }}>
          {room.name}
        </span>

        {/* Badges */}
        {room.isEoSpace && (
          <span style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            fontWeight: 700,
            color: '#22c55e',
            background: 'rgba(34,197,94,0.1)',
            padding: '2px 6px',
            borderRadius: 3,
            flexShrink: 0,
          }}>
            EO-DB
          </span>
        )}
        {room.encryption && (
          <span style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            color: theme.textMuted,
            background: theme.bgMuted,
            padding: '2px 6px',
            borderRadius: 3,
            flexShrink: 0,
          }}>
            E2EE
          </span>
        )}

        {/* Member count */}
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          color: theme.textMuted,
          flexShrink: 0,
        }}>
          {room.memberCount} member{room.memberCount !== 1 ? 's' : ''}
        </span>
      </div>

      {expanded && (
        <div style={{
          marginTop: 8,
          padding: 12,
          background: theme.bgMuted,
          borderRadius: 4,
          border: `1px solid ${theme.border}`,
        }}>
          <DetailField label="Room ID" value={room.roomId} theme={theme} />
          <DetailField label="Name" value={room.name} theme={theme} />
          {room.topic && <DetailField label="Topic" value={room.topic} theme={theme} />}
          {room.spaceName && <DetailField label="EO-DB Space" value={room.spaceName} theme={theme} />}
          <DetailField label="Members" value={String(room.memberCount)} theme={theme} />
          <DetailField label="Join Rule" value={room.joinRule ?? 'unknown'} theme={theme} />
          <DetailField label="Room Version" value={room.roomVersion ?? 'unknown'} theme={theme} />
          <DetailField label="Encrypted" value={room.encryption ? 'Yes' : 'No'} theme={theme} />
          <DetailField label="Timeline Events" value={String(room.timelineLength)} theme={theme} />
          <DetailField label="Last Activity" value={lastActivityStr} theme={theme} />
          {room.creator && <DetailField label="Creator" value={room.creator} theme={theme} />}
        </div>
      )}
    </div>
  );
}

function DetailField({ label, value, theme }: { label: string; value: string; theme: Theme }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '130px 1fr',
      padding: '3px 0',
      gap: 12,
      alignItems: 'baseline',
    }}>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: theme.textMuted }}>
        {label}
      </span>
      <span style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
        color: theme.text,
        wordBreak: 'break-all' as const,
        minWidth: 0,
      }}>
        {value}
      </span>
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
      marginBottom: 12,
    },
    emptyNote: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textMuted,
      fontStyle: 'italic',
      padding: '16px 0',
    },
  };
}
