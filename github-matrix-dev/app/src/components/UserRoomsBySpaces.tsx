import { useState, useMemo } from 'react';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { useTheme, type Theme } from '../theme';
import { EO_SPACE_CONFIG_TYPE } from '../matrix/event-bridge';
import type { SpaceConfig } from '../permissions/types';
import { powerLevelToRole, ROLE_LABELS, type AccessRole } from '../permissions/types';

interface UserRoomsBySpacesProps {
  client: MatrixClient;
  onBack: () => void;
}

interface RoomInfo {
  roomId: string;
  name: string;
  memberCount: number;
  encryption: boolean;
  userRole: AccessRole;
  roomType: 'main' | 'restricted' | 'governance' | null;
  lastActivity: number;
}

interface SpaceGroup {
  spaceName: string;
  spaceTarget: string;
  rooms: RoomInfo[];
  ownerUserId: string;
  memberCount: number;
}

function getRoomInfo(room: Room, userId: string): RoomInfo {
  const state = room.currentState;

  // User's role from power levels
  const plEvent = state.getStateEvents('m.room.power_levels', '');
  const users = plEvent?.getContent()?.users || {};
  const userPl = typeof users[userId] === 'number' ? users[userId] : (plEvent?.getContent()?.users_default ?? 0);
  const userRole = powerLevelToRole(userPl);

  // Encryption
  const encEvent = state.getStateEvents('m.room.encryption', '');

  // Last activity
  const timeline = room.getLiveTimeline().getEvents();
  const lastEvent = timeline.length > 0 ? timeline[timeline.length - 1] : null;

  return {
    roomId: room.roomId,
    name: room.name || room.roomId,
    memberCount: room.getJoinedMembers().length,
    encryption: !!encEvent,
    userRole,
    roomType: null,
    lastActivity: lastEvent ? lastEvent.getTs() : 0,
  };
}

function groupRoomsBySpaces(client: MatrixClient): { spaces: SpaceGroup[]; ungrouped: RoomInfo[] } {
  const rooms = client.getRooms();
  const userId = client.getUserId() || '';

  // First pass: find all space configs and map room IDs to spaces
  const roomToSpace = new Map<string, { spaceName: string; spaceTarget: string; roomType: 'main' | 'restricted' | 'governance'; ownerUserId: string }>();
  const spaceNames = new Map<string, { ownerUserId: string; memberCount: number }>();

  for (const room of rooms) {
    const configEvent = room.currentState.getStateEvents(EO_SPACE_CONFIG_TYPE, '');
    if (!configEvent) continue;

    const config = configEvent.getContent() as SpaceConfig;
    if (!config?.name || !config?.rooms?.main) continue;

    const spaceTarget = `space_${config.name.toLowerCase().replace(/\s+/g, '_')}`;

    // Owner from power levels
    let ownerUserId = '';
    const plEvent = room.currentState.getStateEvents('m.room.power_levels', '');
    if (plEvent) {
      const users = plEvent.getContent()?.users || {};
      for (const [uid, level] of Object.entries(users)) {
        if ((level as number) >= 100) {
          ownerUserId = uid;
          break;
        }
      }
    }

    if (!spaceNames.has(spaceTarget)) {
      spaceNames.set(spaceTarget, { ownerUserId, memberCount: room.getJoinedMembers().length });
    }

    // Map all rooms in this space config
    roomToSpace.set(config.rooms.main, { spaceName: config.name, spaceTarget, roomType: 'main', ownerUserId });
    if (config.rooms.restricted) {
      roomToSpace.set(config.rooms.restricted, { spaceName: config.name, spaceTarget, roomType: 'restricted', ownerUserId });
    }
    if (config.rooms.governance) {
      roomToSpace.set(config.rooms.governance, { spaceName: config.name, spaceTarget, roomType: 'governance', ownerUserId });
    }
    // The room containing the config itself is governance (or main if no governance room)
    if (!roomToSpace.has(room.roomId)) {
      roomToSpace.set(room.roomId, { spaceName: config.name, spaceTarget, roomType: 'governance', ownerUserId });
    }
  }

  // Second pass: group rooms
  const spaceGroupMap = new Map<string, SpaceGroup>();
  const ungrouped: RoomInfo[] = [];

  for (const room of rooms) {
    const info = getRoomInfo(room, userId);
    const spaceRef = roomToSpace.get(room.roomId);

    if (spaceRef) {
      info.roomType = spaceRef.roomType;

      if (!spaceGroupMap.has(spaceRef.spaceTarget)) {
        const meta = spaceNames.get(spaceRef.spaceTarget);
        spaceGroupMap.set(spaceRef.spaceTarget, {
          spaceName: spaceRef.spaceName,
          spaceTarget: spaceRef.spaceTarget,
          rooms: [],
          ownerUserId: meta?.ownerUserId || spaceRef.ownerUserId,
          memberCount: meta?.memberCount || 0,
        });
      }
      spaceGroupMap.get(spaceRef.spaceTarget)!.rooms.push(info);
    } else {
      ungrouped.push(info);
    }
  }

  // Sort spaces by name, rooms within spaces by type order
  const typeOrder = { main: 0, restricted: 1, governance: 2 };
  const spaces = Array.from(spaceGroupMap.values())
    .sort((a, b) => a.spaceName.localeCompare(b.spaceName))
    .map(space => ({
      ...space,
      rooms: space.rooms.sort((a, b) => (typeOrder[a.roomType || 'main'] ?? 3) - (typeOrder[b.roomType || 'main'] ?? 3)),
    }));

  // Sort ungrouped by last activity
  ungrouped.sort((a, b) => b.lastActivity - a.lastActivity);

  return { spaces, ungrouped };
}

export function UserRoomsBySpaces({ client, onBack }: UserRoomsBySpacesProps) {
  const { theme } = useTheme();
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const [showUngrouped, setShowUngrouped] = useState(false);
  const s = styles(theme);

  const { spaces, ungrouped } = useMemo(() => groupRoomsBySpaces(client), [client]);

  const totalRooms = spaces.reduce((sum: number, sp: SpaceGroup) => sum + sp.rooms.length, 0) + ungrouped.length;

  function toggleSpace(spaceTarget: string) {
    setExpandedSpaces((prev: Set<string>) => {
      const next = new Set(prev);
      if (next.has(spaceTarget)) next.delete(spaceTarget);
      else next.add(spaceTarget);
      return next;
    });
  }

  return (
    <div style={s.container}>
      <div style={s.inner}>
        <button onClick={onBack} style={s.backBtn}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8.5 3L4.5 7L8.5 11" />
          </svg>
          Settings
        </button>

        <div style={s.title}>Rooms by Space</div>
        <div style={s.subtitle}>
          {totalRooms} room{totalRooms !== 1 ? 's' : ''} across {spaces.length} space{spaces.length !== 1 ? 's' : ''}
          {ungrouped.length > 0 && ` + ${ungrouped.length} other`}
        </div>

        {spaces.length === 0 && ungrouped.length === 0 && (
          <div style={s.emptyNote}>No rooms found</div>
        )}

        {/* Space groups */}
        {spaces.map((space: SpaceGroup) => {
          const isExpanded = expandedSpaces.has(space.spaceTarget);
          return (
            <div key={space.spaceTarget} style={s.spaceCard}>
              <div
                onClick={() => toggleSpace(space.spaceTarget)}
                style={s.spaceHeader}
              >
                <svg
                  width="10" height="10" viewBox="0 0 10 10" fill="none"
                  stroke={theme.textMuted} strokeWidth="1.5" strokeLinecap="round"
                  style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}
                >
                  <path d="M3.5 2L6.5 5L3.5 8" />
                </svg>

                <div style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  background: '#22c55e',
                  boxShadow: '0 0 4px #22c55e',
                }} />

                <span style={s.spaceName}>{space.spaceName}</span>

                <span style={s.badge}>
                  {space.rooms.length} room{space.rooms.length !== 1 ? 's' : ''}
                </span>

                <span style={s.memberBadge}>
                  {space.memberCount} member{space.memberCount !== 1 ? 's' : ''}
                </span>
              </div>

              {isExpanded && (
                <div style={s.roomList}>
                  {space.rooms.map((room: RoomInfo) => (
                    <RoomRow key={room.roomId} room={room} theme={theme} />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Ungrouped rooms */}
        {ungrouped.length > 0 && (
          <div style={{ ...s.spaceCard, marginTop: 16 }}>
            <div
              onClick={() => setShowUngrouped(!showUngrouped)}
              style={s.spaceHeader}
            >
              <svg
                width="10" height="10" viewBox="0 0 10 10" fill="none"
                stroke={theme.textMuted} strokeWidth="1.5" strokeLinecap="round"
                style={{ transform: showUngrouped ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}
              >
                <path d="M3.5 2L6.5 5L3.5 8" />
              </svg>

              <div style={{
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                background: theme.textMuted,
              }} />

              <span style={s.spaceName}>Other Rooms</span>

              <span style={s.badge}>
                {ungrouped.length} room{ungrouped.length !== 1 ? 's' : ''}
              </span>
            </div>

            {showUngrouped && (
              <div style={s.roomList}>
                {ungrouped.map((room: RoomInfo) => (
                  <RoomRow key={room.roomId} room={room} theme={theme} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RoomRow({ room, theme }: { room: RoomInfo; theme: Theme }) {
  const [expanded, setExpanded] = useState(false);

  const typeLabel = room.roomType
    ? { main: 'Main', restricted: 'Restricted', governance: 'Governance' }[room.roomType]
    : null;

  const typeColor = room.roomType
    ? { main: theme.accent, restricted: theme.warning, governance: theme.purple }[room.roomType]
    : null;

  return (
    <div style={{ borderBottom: `1px solid ${theme.borderLight}`, padding: '8px 0' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
      >
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          fontWeight: 500,
          color: theme.text,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' as const,
          flex: 1,
          minWidth: 0,
        }}>
          {room.name}
        </span>

        {typeLabel && (
          <span style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            fontWeight: 600,
            color: typeColor!,
            background: `${typeColor!}15`,
            padding: '2px 6px',
            borderRadius: 3,
            flexShrink: 0,
          }}>
            {typeLabel}
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

        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9,
          color: theme.textMuted,
          flexShrink: 0,
        }}>
          {ROLE_LABELS[room.userRole]}
        </span>
      </div>

      {expanded && (
        <div style={{
          marginTop: 6,
          padding: 10,
          background: theme.bgMuted,
          borderRadius: 4,
          border: `1px solid ${theme.border}`,
        }}>
          <DetailRow label="Room ID" value={room.roomId} theme={theme} />
          <DetailRow label="Your role" value={`${ROLE_LABELS[room.userRole]} (${room.userRole})`} theme={theme} />
          <DetailRow label="Members" value={String(room.memberCount)} theme={theme} />
          <DetailRow label="Encrypted" value={room.encryption ? 'Yes' : 'No'} theme={theme} />
          {room.roomType && <DetailRow label="Room type" value={typeLabel!} theme={theme} />}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, theme }: { label: string; value: string; theme: Theme }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '100px 1fr',
      padding: '2px 0',
      gap: 8,
    }}>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.textMuted }}>{label}</span>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.text, wordBreak: 'break-all' as const }}>{value}</span>
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
    emptyNote: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textMuted,
      fontStyle: 'italic',
      padding: '16px 0',
    },
    spaceCard: {
      borderRadius: 6,
      border: `1px solid ${t.border}`,
      padding: '0 12px',
      marginBottom: 8,
      background: t.bgCard,
    },
    spaceHeader: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      cursor: 'pointer',
      padding: '12px 0',
    },
    spaceName: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      fontWeight: 600,
      color: t.text,
      flex: 1,
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    badge: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      fontWeight: 600,
      color: t.accent,
      background: t.accentBg,
      padding: '2px 6px',
      borderRadius: 3,
      flexShrink: 0,
    },
    memberBadge: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      color: t.textMuted,
      flexShrink: 0,
    },
    roomList: {
      borderTop: `1px solid ${t.borderLight}`,
      paddingLeft: 24,
    },
  };
}
