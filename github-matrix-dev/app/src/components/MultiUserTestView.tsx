/**
 * Multi-User Connectivity Test
 *
 * Real Matrix to-device messaging test between connected accounts.
 * Sends actual `com.eo-db.test.ping` messages via `sendToDevice` to every
 * joined member in the current space room and listens for incoming ones.
 *
 * Replaces the old fake Alice/Bob in-memory event bus simulation.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { Presence, PresenceUser } from '../matrix/presence';
import { testEventTypes } from '../lib/matrix-domain';
import { useTheme, type Theme } from '../theme';
import { EO_SPACE_CONFIG_TYPE } from '../matrix/event-bridge';

const TEST_PING_TYPE = testEventTypes().ping;

/**
 * Collect all room IDs that belong to the same space as `roomId`.
 * Handles the case where duplicate rooms exist for the same space —
 * messages from any of them should be accepted.
 */
function findSpaceRoomIds(client: MatrixClient, roomId: string): Set<string> {
  const set = new Set<string>([roomId]);
  const myRoom = client.getRoom(roomId);
  if (!myRoom) return set;
  const myConfig = myRoom.currentState?.getStateEvents?.(EO_SPACE_CONFIG_TYPE, '');
  if (!myConfig) return set;
  const myName = (myConfig.getContent() as any)?.name;
  if (!myName) return set;

  for (const room of client.getRooms()) {
    const config = room.currentState?.getStateEvents?.(EO_SPACE_CONFIG_TYPE, '');
    if (!config) continue;
    const name = (config.getContent() as any)?.name;
    if (name === myName) {
      set.add(room.roomId);
      const rooms = (config.getContent() as any)?.rooms;
      if (rooms?.main) set.add(rooms.main);
    }
  }
  return set;
}

/** Build the Map<userId, Map<deviceId, content>> structure for sendToDevice. */
function toDeviceContent(userId: string, deviceId: string, content: Record<string, any>) {
  const inner = new Map<string, Record<string, any>>();
  inner.set(deviceId, content);
  const outer = new Map<string, Map<string, Record<string, any>>>();
  outer.set(userId, inner);
  return outer;
}

interface ReceivedMessage {
  id: number;
  sender: string;
  device: string;
  message: string;
  sentTs: number;
  receivedTs: number;
  fresh: boolean;
}

interface MemberInfo {
  userId: string;
  displayName: string | null;
}

interface MultiUserTestViewProps {
  matrixClient: MatrixClient | null;
  roomId: string | null;
  presence: Presence | null;
}

export function MultiUserTestView({ matrixClient, roomId, presence }: MultiUserTestViewProps) {
  const { theme } = useTheme();
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [received, setReceived] = useState<ReceivedMessage[]>([]);
  const [presenceUsers, setPresenceUsers] = useState<PresenceUser[]>([]);
  const [messageText, setMessageText] = useState('');
  const [lastSendResult, setLastSendResult] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const nextId = useRef(0);

  const myUserId = matrixClient?.getUserId() ?? null;
  const myDeviceId = matrixClient?.getDeviceId() ?? null;

  // All room IDs belonging to this space (handles duplicate rooms).
  const spaceRoomIds = useMemo(() => {
    if (!matrixClient || !roomId) return new Set<string>();
    return findSpaceRoomIds(matrixClient, roomId);
  }, [matrixClient, roomId]);

  // Default message text
  const effectiveMessage = messageText || `hello from ${myUserId ?? 'unknown'}`;

  // Poll room members every 5s
  useEffect(() => {
    if (!matrixClient || !roomId) return;
    function refresh() {
      const room = matrixClient!.getRoom(roomId!);
      if (!room) { setMembers([]); return; }
      const joined = room.getJoinedMembers();
      setMembers(joined.map((m: any) => ({
        userId: m.userId,
        displayName: m.name ?? null,
      })));
    }
    refresh();
    const iv = setInterval(refresh, 5000);
    return () => clearInterval(iv);
  }, [matrixClient, roomId]);

  // Listen for incoming test pings
  useEffect(() => {
    if (!matrixClient) return;
    const handler = (event: MatrixEvent) => {
      if (event.getType() !== TEST_PING_TYPE) return;
      const content = event.getContent() as {
        room_id?: string;
        device?: string;
        ts?: number;
        message?: string;
      };
      // Scope to this space (accept from any room belonging to the same space)
      if (content.room_id && !spaceRoomIds.has(content.room_id)) return;
      const sender = event.getSender();
      if (!sender) return;

      const msg: ReceivedMessage = {
        id: nextId.current++,
        sender,
        device: content.device || '?',
        message: content.message || '',
        sentTs: content.ts || 0,
        receivedTs: Date.now(),
        fresh: true,
      };
      setReceived((prev) => [msg, ...prev].slice(0, 50));

      // Clear fresh flag after 2s
      setTimeout(() => {
        setReceived((prev) =>
          prev.map((m) => (m.id === msg.id ? { ...m, fresh: false } : m)),
        );
      }, 2000);
    };

    matrixClient.on('toDeviceEvent' as any, handler);
    return () => {
      matrixClient.removeListener('toDeviceEvent' as any, handler);
    };
  }, [matrixClient, roomId, spaceRoomIds]);

  // Subscribe to presence
  useEffect(() => {
    if (!presence) { setPresenceUsers([]); return; }
    const unsub = presence.subscribe(setPresenceUsers);
    return unsub;
  }, [presence]);

  // Send test ping to all joined members
  const handleSend = useCallback(async () => {
    if (!matrixClient || !roomId) return;
    setSending(true);
    setLastSendResult(null);

    const room = matrixClient.getRoom(roomId);
    if (!room) {
      setLastSendResult('Room not found in SDK cache');
      setSending(false);
      return;
    }

    const joined = room.getJoinedMembers();
    const peers = joined.filter((m: any) => m.userId !== myUserId);

    if (peers.length === 0) {
      setLastSendResult('No other members in room — nothing sent');
      setSending(false);
      return;
    }

    const payload = {
      room_id: roomId,
      device: myDeviceId,
      ts: Date.now(),
      message: effectiveMessage,
    };

    const sent: string[] = [];
    const failed: string[] = [];
    for (const peer of peers) {
      try {
        await matrixClient.sendToDevice(
          TEST_PING_TYPE,
          toDeviceContent(peer.userId, '*', payload),
        );
        sent.push(peer.userId);
      } catch (e) {
        failed.push(`${peer.userId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    let result = `Sent to ${sent.length} peer${sent.length !== 1 ? 's' : ''}: ${sent.join(', ')}`;
    if (failed.length > 0) {
      result += ` | Failed: ${failed.join('; ')}`;
    }
    setLastSendResult(result);
    setSending(false);
  }, [matrixClient, roomId, myUserId, myDeviceId, effectiveMessage]);

  const s = styles(theme);

  if (!matrixClient) {
    return (
      <div style={s.root}>
        <div style={s.empty}>Matrix client not ready — log in first.</div>
      </div>
    );
  }

  return (
    <div style={s.root}>
      <h2 style={s.title}>Multi-User Connectivity Test</h2>
      <p style={s.subtitle}>
        Sends real <code>com.eo-db.test.ping</code> to-device messages between
        connected accounts via the Matrix homeserver. Open this page in two
        browsers logged into different accounts in the same space.
      </p>

      {/* Section 1: Connection Info */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Connection Info</div>
        <div style={s.infoGrid}>
          <span style={s.infoLabel}>User ID</span>
          <span style={s.infoValue}>{myUserId ?? '—'}</span>
          <span style={s.infoLabel}>Device ID</span>
          <span style={s.infoValue}>{myDeviceId ?? '—'}</span>
          <span style={s.infoLabel}>Room ID</span>
          <span style={s.infoValue}>{roomId ?? <span style={s.warn}>No room — resolve failed</span>}</span>
        </div>

        <div style={s.membersHeader}>
          Joined Members ({members.length})
          {members.length <= 1 && (
            <span style={s.warn}> — no peers visible, to-device will have no recipients</span>
          )}
        </div>
        <div style={s.membersList}>
          {members.length === 0 && <div style={s.muted}>None</div>}
          {members.map((m) => (
            <div key={m.userId} style={s.memberRow}>
              <span style={s.memberName}>{m.displayName || m.userId}</span>
              <span style={s.memberId}>{m.userId}</span>
              {m.userId === myUserId && <span style={s.youBadge}>you</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Section 2: Send */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Send Test Message</div>
        <div style={s.sendRow}>
          <input
            type="text"
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            placeholder={`hello from ${myUserId ?? 'unknown'}`}
            style={s.input}
          />
          <button
            onClick={handleSend}
            disabled={sending || !roomId}
            style={s.sendBtn}
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
        {lastSendResult && (
          <div style={s.sendResult}>{lastSendResult}</div>
        )}
      </div>

      {/* Section 3: Received */}
      <div style={s.section}>
        <div style={s.sectionTitleRow}>
          <span style={s.sectionTitle}>
            Received Messages ({received.length})
          </span>
          {received.length > 0 && (
            <button onClick={() => setReceived([])} style={s.clearBtn}>
              Clear
            </button>
          )}
        </div>
        <div style={s.receivedList}>
          {received.length === 0 && (
            <div style={s.muted}>
              No messages received yet — send a test ping from another client
            </div>
          )}
          {received.map((msg) => {
            const latency = msg.sentTs ? msg.receivedTs - msg.sentTs : null;
            return (
              <div
                key={msg.id}
                style={{
                  ...s.receivedRow,
                  ...(msg.fresh ? s.receivedFresh : {}),
                }}
              >
                <div style={s.receivedMeta}>
                  <span style={s.receivedSender}>{msg.sender}</span>
                  <span style={s.receivedDevice}>device: {msg.device}</span>
                  {latency !== null && (
                    <span style={s.receivedLatency}>{latency}ms</span>
                  )}
                </div>
                <div style={s.receivedMessage}>{msg.message || '(empty)'}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section 4: Presence */}
      <div style={s.section}>
        <div style={s.sectionTitle}>
          Presence Heartbeat ({presenceUsers.length} online)
        </div>
        <div style={s.presenceList}>
          {!presence && <div style={s.muted}>Presence not active</div>}
          {presence && presenceUsers.length === 0 && (
            <div style={s.muted}>No peers detected via presence heartbeat</div>
          )}
          {presenceUsers.map((u) => (
            <div key={u.userId} style={s.presenceRow}>
              <span style={s.greenDot} />
              <span>{u.displayName || u.userId}</span>
              <span style={s.presenceMeta}>
                {u.devices.length} device{u.devices.length !== 1 ? 's' : ''}
                {' · '}
                {Math.max(0, Math.round((Date.now() - u.lastSeen) / 1000))}s ago
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function styles(t: Theme): Record<string, React.CSSProperties> {
  return {
    root: {
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      padding: 20,
      height: '100%',
      overflow: 'auto',
    },
    title: {
      margin: 0,
      fontSize: 18,
      fontWeight: 700,
      color: t.text,
    },
    subtitle: {
      margin: 0,
      fontSize: 12,
      color: t.textSecondary,
      lineHeight: 1.5,
    },
    empty: {
      padding: 40,
      textAlign: 'center',
      color: t.textMuted,
      fontSize: 13,
    },
    section: {
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      padding: 14,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    },
    sectionTitle: {
      fontSize: 11,
      fontWeight: 600,
      color: t.textSecondary,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
    },
    sectionTitleRow: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    infoGrid: {
      display: 'grid',
      gridTemplateColumns: '90px 1fr',
      gap: '4px 10px',
      fontSize: 12,
      fontFamily: "'JetBrains Mono', monospace",
    },
    infoLabel: {
      color: t.textMuted,
      fontWeight: 500,
    },
    infoValue: {
      color: t.text,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    warn: {
      color: '#f59e0b',
      fontWeight: 500,
    },
    membersHeader: {
      fontSize: 12,
      fontWeight: 600,
      color: t.text,
      marginTop: 6,
    },
    membersList: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    },
    memberRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 12,
      fontFamily: "'JetBrains Mono', monospace",
      padding: '4px 8px',
      background: t.bgMuted,
      borderRadius: 4,
    },
    memberName: {
      color: t.text,
      fontWeight: 500,
    },
    memberId: {
      color: t.textMuted,
      fontSize: 10,
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    youBadge: {
      fontSize: 9,
      fontWeight: 600,
      color: t.accent,
      background: t.accentBg,
      padding: '1px 5px',
      borderRadius: 3,
    },
    muted: {
      color: t.textMuted,
      fontSize: 12,
      fontStyle: 'italic',
    },
    sendRow: {
      display: 'flex',
      gap: 8,
    },
    input: {
      flex: 1,
      padding: '6px 10px',
      fontSize: 12,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.bg,
      color: t.text,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      outline: 'none',
    },
    sendBtn: {
      padding: '6px 16px',
      fontSize: 12,
      fontWeight: 600,
      background: t.accentBg,
      color: t.accent,
      border: `1px solid ${t.accentBorder}`,
      borderRadius: 6,
      cursor: 'pointer',
      whiteSpace: 'nowrap' as const,
    },
    sendResult: {
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textSecondary,
      padding: '4px 8px',
      background: t.bgMuted,
      borderRadius: 4,
    },
    clearBtn: {
      fontSize: 10,
      fontWeight: 600,
      color: t.textMuted,
      background: 'transparent',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      padding: '2px 8px',
      cursor: 'pointer',
    },
    receivedList: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      maxHeight: 300,
      overflow: 'auto',
    },
    receivedRow: {
      padding: '6px 8px',
      background: t.bgMuted,
      borderRadius: 4,
      border: `1px solid ${t.borderLight}`,
      transition: 'background 0.3s ease, border-color 0.3s ease',
    },
    receivedFresh: {
      background: 'rgba(16,185,129,0.1)',
      borderColor: '#10b981',
    },
    receivedMeta: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
    },
    receivedSender: {
      color: t.text,
      fontWeight: 600,
    },
    receivedDevice: {
      color: t.textMuted,
      fontSize: 10,
    },
    receivedLatency: {
      color: '#10b981',
      fontWeight: 600,
      fontSize: 10,
    },
    receivedMessage: {
      fontSize: 12,
      color: t.textSecondary,
      marginTop: 2,
      fontFamily: "'JetBrains Mono', monospace",
    },
    presenceList: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    },
    presenceRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 12,
      color: t.text,
      padding: '4px 8px',
      background: t.bgMuted,
      borderRadius: 4,
    },
    greenDot: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: '#10b981',
      flexShrink: 0,
    },
    presenceMeta: {
      color: t.textMuted,
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      marginLeft: 'auto',
    },
  };
}
