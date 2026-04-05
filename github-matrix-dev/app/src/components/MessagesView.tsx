/**
 * MessagesView — Matrix-backed messaging with message preservation.
 *
 * Messages flow through Matrix rooms normally. "Preserving" a message:
 *   1. INS the message content into the EO DB as a record
 *   2. Inherits the encryption scope of the source Matrix room
 *      (users without room access can't read content OR metadata)
 *   3. Optionally creates CON edges to other records (always reversible via NUL)
 *
 * The preserved record target follows the pattern:
 *   {scope}.preserved.{messageId}
 *
 * Encryption inheritance:
 *   - The room's encryption rule (from governance room state) is applied to
 *     the preserved record via DEF at {target}._encryption
 *   - This means the same access list that controls who can read the Matrix
 *     room also controls who can read the preserved record + its metadata
 *   - Users without access see nothing — not the content, not the metadata,
 *     not even the fact that a preserved record exists (the target path itself
 *     is encrypted in the log via the room's encryption scope)
 */
import { useState, useRef, useEffect, useCallback, type CSSProperties } from 'react';
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { useTheme, type Theme } from '../theme';
import { useEoStore } from '../store/eo-store';
import type { EoEventInput, EoState } from '../db/types';
import { searchUsers, listAllHomeserverUsers, type DiscoveredUser } from '../matrix/user-discovery';
import { findOrCreateDirectMessage } from '../matrix/dm';

// ─── Types ───────────────────────────────────────────────────────────────────

interface MatrixMessage {
  id: string;
  roomId: string;
  sender: string;
  senderName: string;
  body: string;
  timestamp: number;
  /** If preserved, the EO target path where this message was INS'd */
  preservedTarget?: string;
  /** Edges to other records created during preservation */
  edges?: Array<{ target: string; edgeType: string }>;
}

interface MatrixRoom {
  id: string;
  name: string;
  type: 'channel' | 'dm';
  encrypted: boolean;
  members: string[];
  unread: number;
  /** The encryption scope inherited by preserved messages */
  encryptionScope?: string;
}

interface PreserveDialogState {
  message: MatrixMessage | null;
  visible: boolean;
  linkTarget: string;
  edgeType: string;
  edges: Array<{ target: string; edgeType: string }>;
  preserving: boolean;
}

// ─── Operator colors (shared with log view) ─────────────────────────────────

const OP_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  INS: { bg: '#DCFCE7', text: '#166534', border: '#22C55E' },
  CON: { bg: '#E0E7FF', text: '#3730A3', border: '#6366F1' },
  NUL: { bg: '#FEF3C7', text: '#92400E', border: '#F59E0B' },
  DEF: { bg: '#FFF7ED', text: '#9A3412', border: '#F97316' },
};

// ─── Component ───────────────────────────────────────────────────────────────

interface MessagesViewProps {
  /** Current scope (table/collection path) for preserved record targets */
  scope: string | null;
  /** Current user's Matrix user ID */
  userId?: string;
  /** Optional Matrix room ID to auto-select (e.g. from a DM link) */
  activeRoomId?: string | null;
  /** Active Matrix client (required for real send/receive) */
  matrixClient?: MatrixClient | null;
}

/** Convert a Matrix timeline event into our UI message shape. */
function toMatrixMessage(ev: MatrixEvent, roomId: string, room: Room | null): MatrixMessage | null {
  const type = ev.getType();
  // 'm.room.encrypted' events are shown with a placeholder until decryption lands
  if (type !== 'm.room.message' && type !== 'm.room.encrypted') return null;
  const content = ev.getContent() as { body?: string; msgtype?: string };
  const sender = ev.getSender() ?? '';
  const member = room && sender ? room.getMember(sender) : null;
  const senderName = member?.name || (sender.startsWith('@') ? sender.slice(1).split(':')[0] : sender);
  const isEncryptedPending = type === 'm.room.encrypted' && !content.body;
  return {
    id: ev.getId() ?? `${ev.getTs()}_${sender}`,
    roomId,
    sender,
    senderName,
    body: isEncryptedPending ? '[decrypting…]' : String(content.body ?? ''),
    timestamp: ev.getTs() ?? Date.now(),
  };
}

function listDirectRoomIds(client: MatrixClient): Set<string> {
  const set = new Set<string>();
  try {
    const ev = client.getAccountData('m.direct');
    if (!ev) return set;
    const map = ev.getContent() as Record<string, string[]>;
    for (const ids of Object.values(map ?? {})) {
      for (const id of ids ?? []) set.add(id);
    }
  } catch {
    /* no direct map yet */
  }
  return set;
}

function loadRoomsFromClient(client: MatrixClient): MatrixRoom[] {
  const directIds = listDirectRoomIds(client);
  const joined = client.getRooms().filter((r) => r.getMyMembership() === 'join');
  return joined.map((r) => {
    const isDm = directIds.has(r.roomId);
    let encrypted = false;
    try { encrypted = client.isRoomEncrypted(r.roomId); } catch { /* ignore */ }
    return {
      id: r.roomId,
      name: r.name || (isDm ? 'Direct Message' : r.roomId),
      type: isDm ? 'dm' as const : 'channel' as const,
      encrypted,
      members: [],
      unread: r.getUnreadNotificationCount() ?? 0,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function MessagesView({ scope, userId, activeRoomId: initialRoomId, matrixClient }: MessagesViewProps) {
  const { theme } = useTheme();
  const dispatch = useEoStore((s) => s.dispatch);
  const ready = useEoStore((s) => s.ready);

  const [rooms, setRooms] = useState<MatrixRoom[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(initialRoomId ?? null);
  const [messages, setMessages] = useState<Record<string, MatrixMessage[]>>({});
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [preserve, setPreserve] = useState<PreserveDialogState>({
    message: null, visible: false, linkTarget: '', edgeType: 'references',
    edges: [], preserving: false,
  });

  // ─── Load rooms from Matrix client + keep in sync ───────────────────────
  useEffect(() => {
    if (!matrixClient) { setRooms([]); return; }
    const refresh = () => setRooms(loadRoomsFromClient(matrixClient));
    refresh();
    const onRoom = () => refresh();
    const onMembership = () => refresh();
    const onAccountData = (ev: MatrixEvent) => {
      if (ev.getType() === 'm.direct') refresh();
    };
    matrixClient.on('Room' as any, onRoom);
    matrixClient.on('Room.myMembership' as any, onMembership);
    matrixClient.on('Room.name' as any, onRoom);
    matrixClient.on('accountData' as any, onAccountData);
    return () => {
      matrixClient.off('Room' as any, onRoom);
      matrixClient.off('Room.myMembership' as any, onMembership);
      matrixClient.off('Room.name' as any, onRoom);
      matrixClient.off('accountData' as any, onAccountData);
    };
  }, [matrixClient]);

  // When a deep-linked roomId arrives, select it once it's in the list
  useEffect(() => {
    if (initialRoomId) setActiveRoomId(initialRoomId);
  }, [initialRoomId]);

  // Auto-select first room when nothing selected
  useEffect(() => {
    if (activeRoomId || rooms.length === 0) return;
    setActiveRoomId(rooms[0].id);
  }, [rooms, activeRoomId]);

  // ─── Load timeline + subscribe to new events for active room ────────────
  useEffect(() => {
    if (!matrixClient || !activeRoomId) return;
    const room = matrixClient.getRoom(activeRoomId);
    if (!room) return;

    const initial = room.getLiveTimeline().getEvents()
      .map((ev) => toMatrixMessage(ev, activeRoomId, room))
      .filter((m): m is MatrixMessage => m !== null);
    setMessages((prev) => ({ ...prev, [activeRoomId]: initial }));

    const onTimeline = (ev: MatrixEvent, tRoom: Room | undefined, _toStart: boolean | undefined, removed: boolean, data: any) => {
      if (removed) return;
      if (tRoom?.roomId !== activeRoomId) return;
      if (!data?.liveEvent) return; // only live events, not backfill
      const msg = toMatrixMessage(ev, activeRoomId, tRoom);
      if (!msg) return;
      setMessages((prev) => {
        const list = prev[activeRoomId] ?? [];
        if (list.some((m) => m.id === msg.id)) return prev;
        return { ...prev, [activeRoomId]: [...list, msg] };
      });
    };
    const onDecrypted = (ev: MatrixEvent) => {
      if (ev.getRoomId() !== activeRoomId) return;
      const tRoom = matrixClient.getRoom(activeRoomId);
      const msg = toMatrixMessage(ev, activeRoomId, tRoom);
      if (!msg) return;
      setMessages((prev) => {
        const list = prev[activeRoomId] ?? [];
        const idx = list.findIndex((m) => m.id === msg.id);
        if (idx < 0) return { ...prev, [activeRoomId]: [...list, msg] };
        const next = [...list];
        next[idx] = msg;
        return { ...prev, [activeRoomId]: next };
      });
    };
    matrixClient.on('Room.timeline' as any, onTimeline);
    matrixClient.on('Event.decrypted' as any, onDecrypted);
    return () => {
      matrixClient.off('Room.timeline' as any, onTimeline);
      matrixClient.off('Event.decrypted' as any, onDecrypted);
    };
  }, [matrixClient, activeRoomId]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeRoom = rooms.find((r) => r.id === activeRoomId) ?? null;
  const roomMessages = activeRoomId ? (messages[activeRoomId] ?? []) : [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeRoomId, roomMessages.length]);

  // ─── Send message (real Matrix send; SDK encrypts automatically for E2EE rooms) ──
  const sendMessage = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !matrixClient || !activeRoomId || sending) return;
    setSending(true);
    setSendError(null);
    const prevText = text;
    setInputText('');
    try {
      await matrixClient.sendMessage(activeRoomId, {
        msgtype: 'm.text',
        body: prevText,
      } as any);
    } catch (e: any) {
      setSendError(e?.message || 'Failed to send message');
      setInputText(prevText);
    } finally {
      setSending(false);
    }
  }, [inputText, matrixClient, activeRoomId, sending]);

  // ─── Start a new direct message with a homeserver user ──────────────────
  const startDirectMessage = useCallback(async (otherUserId: string) => {
    if (!matrixClient) return;
    const roomId = await findOrCreateDirectMessage(matrixClient, otherUserId);
    // refresh rooms list immediately so the new DM appears
    setRooms(loadRoomsFromClient(matrixClient));
    setActiveRoomId(roomId);
    setNewDmOpen(false);
  }, [matrixClient]);

  // ─── Preserve message → INS into DB ────────────────────────────────────
  const preserveMessage = useCallback(async (msg: MatrixMessage, edges: Array<{ target: string; edgeType: string }>) => {
    if (!ready) return;

    const targetBase = scope ? `${scope}.preserved` : 'preserved';
    const target = `${targetBase}.${msg.id}`;
    const now = new Date().toISOString();

    // 1. INS the message content as a record
    //    The operand contains the full message payload.
    //    Encryption is inherited from the source room's encryption scope —
    //    the DEF at {target}._encryption mirrors the room's access list,
    //    so users without room access can't read content OR metadata.
    const insEvent: EoEventInput = {
      op: 'INS',
      target,
      operand: {
        body: msg.body,
        sender: msg.sender,
        senderName: msg.senderName,
        timestamp: msg.timestamp,
        sourceRoom: msg.roomId,
        preservedAt: now,
      },
      agent: userId ?? '@local:localhost',
      ts: now,
      acquired_ts: now,
      level: 1,
      meta: {
        source: 'message_preserve',
        roomId: msg.roomId,
        encrypted: activeRoom?.encrypted ?? false,
      },
    };
    await dispatch(insEvent);

    // 2. If the source room has an encryption scope, mirror it to the
    //    preserved record so the same access rules apply.
    //    This DEF at {target}._encryption ensures that:
    //    - Content is encrypted with the room's key
    //    - Metadata (target path, timestamps, sender) is also scoped
    //    - Users without room membership see NOTHING — not even that
    //      a preserved record exists
    if (activeRoom?.encrypted && activeRoom.encryptionScope) {
      const defEvent: EoEventInput = {
        op: 'DEF',
        target: `${target}._encryption`,
        operand: {
          scope: 'record',
          inherits_from: activeRoom.encryptionScope,
          source_room: msg.roomId,
          // The encryption access list is the room's member list.
          // Access resolution walks up: record._encryption → room scope → table scope
          // Most restrictive wins (AND-gated across levels).
        },
        agent: 'system',
        ts: now,
        acquired_ts: now,
      };
      await dispatch(defEvent);
    }

    // 3. Create CON edges to linked records (always reversible via NUL)
    for (const edge of edges) {
      const conEvent: EoEventInput = {
        op: 'CON',
        target,
        operand: {
          dest: edge.target,
          edge_type: edge.edgeType,
        },
        agent: userId ?? '@local:localhost',
        ts: now,
        acquired_ts: now,
      };
      await dispatch(conEvent);
    }

    // Mark the message as preserved in local state
    setMessages((prev) => {
      const roomMsgs = prev[msg.roomId] ?? [];
      return {
        ...prev,
        [msg.roomId]: roomMsgs.map((m) =>
          m.id === msg.id
            ? { ...m, preservedTarget: target, edges }
            : m
        ),
      };
    });
  }, [ready, scope, userId, activeRoom, dispatch]);

  // ─── Unpreserve (NUL the record — reversible) ─────────────────────────
  const unpreserveMessage = useCallback(async (msg: MatrixMessage) => {
    if (!ready || !msg.preservedTarget) return;
    const now = new Date().toISOString();

    // NUL the preserved record — this doesn't delete it, it marks it as
    // nullified. The original message stays in the Matrix room untouched.
    // NUL is always reversible — you can re-preserve the same message.
    const nulEvent: EoEventInput = {
      op: 'NUL',
      target: msg.preservedTarget,
      operand: { reason: 'unpreserved by user' },
      agent: userId ?? '@local:localhost',
      ts: now,
      acquired_ts: now,
    };
    await dispatch(nulEvent);

    setMessages((prev) => {
      const roomMsgs = prev[msg.roomId] ?? [];
      return {
        ...prev,
        [msg.roomId]: roomMsgs.map((m) =>
          m.id === msg.id
            ? { ...m, preservedTarget: undefined, edges: undefined }
            : m
        ),
      };
    });
  }, [ready, userId, dispatch]);

  // ─── Styles ─────────────────────────────────────────────────────────────
  const s = buildStyles(theme);

  return (
    <div style={s.container}>
      {/* ── Room list sidebar ── */}
      <div style={s.roomList}>
        <div style={s.roomListHeader}>
          <span style={{ fontSize: 14, fontWeight: 600, color: theme.textHeading }}>Messages</span>
        </div>
        <div style={s.roomListBody}>
          <div style={s.sectionLabel}>Channels</div>
          {rooms.filter((r) => r.type === 'channel').map((room) => (
            <button
              key={room.id}
              onClick={() => setActiveRoomId(room.id)}
              style={{
                ...s.roomItem,
                ...(room.id === activeRoomId ? s.roomItemActive : {}),
              }}
            >
              <span style={{ color: theme.textMuted, fontSize: 14, width: 18, textAlign: 'center' as const }}>#</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{room.name}</span>
              {room.encrypted && <span style={{ fontSize: 10, opacity: 0.5 }}>E2EE</span>}
              {room.unread > 0 && <span style={s.unreadBadge}>{room.unread}</span>}
            </button>
          ))}
          <div style={{ ...s.sectionLabel, marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 4 }}>
            <span>Direct Messages</span>
            {matrixClient && (
              <button
                onClick={() => setNewDmOpen(true)}
                title="Start a new direct message"
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  color: theme.textMuted, fontSize: 16, lineHeight: 1, padding: '0 4px',
                  fontWeight: 600,
                }}
              >+</button>
            )}
          </div>
          {rooms.filter((r) => r.type === 'dm').length === 0 && matrixClient && (
            <div style={{ padding: '6px 10px', fontSize: 11, color: theme.textMuted }}>
              No DMs yet. Click + to start one.
            </div>
          )}
          {rooms.filter((r) => r.type === 'dm').map((room) => (
            <button
              key={room.id}
              onClick={() => setActiveRoomId(room.id)}
              style={{
                ...s.roomItem,
                ...(room.id === activeRoomId ? s.roomItemActive : {}),
              }}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{room.name}</span>
              {room.encrypted && <span style={{ fontSize: 10, opacity: 0.5 }}>E2EE</span>}
              {room.unread > 0 && <span style={s.unreadBadge}>{room.unread}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── Chat area ── */}
      <div style={s.chatArea}>
        {/* Chat header */}
        <div style={s.chatHeader}>
          {activeRoom ? (
            <>
              <span style={{ fontSize: 14, color: theme.textMuted }}>{activeRoom.type === 'dm' ? '' : '#'}</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: theme.textHeading }}>{activeRoom.name}</span>
              {activeRoom.encrypted && (
                <span style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 3,
                  background: theme.accentBg, color: theme.accent, fontWeight: 500,
                }}>E2EE</span>
              )}
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: 'var(--mono, monospace)' }}>{activeRoom.id}</span>
            </>
          ) : (
            <span style={{ fontSize: 13, color: theme.textMuted }}>
              {matrixClient ? 'Select or start a conversation' : 'Matrix not connected'}
            </span>
          )}
        </div>

        {/* Messages */}
        <div style={s.messageList}>
          {roomMessages.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: theme.textMuted, fontSize: 13 }}>
              No messages yet. Start a conversation.
            </div>
          )}
          {roomMessages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              theme={theme}
              onPreserve={() => setPreserve({ message: msg, visible: true, linkTarget: '', edgeType: 'references', edges: [], preserving: false })}
              onUnpreserve={() => unpreserveMessage(msg)}
            />
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Composer */}
        <div style={s.composer}>
          {sendError && (
            <div style={{
              padding: '6px 10px', marginBottom: 6, borderRadius: 6,
              background: theme.dangerBg, color: theme.danger, fontSize: 11,
              border: `1px solid ${theme.danger}`,
            }}>{sendError}</div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <input
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }}
              placeholder={activeRoom ? `Message ${activeRoom.name}...` : 'Select a room to message'}
              disabled={!activeRoom || !matrixClient}
              style={s.composerInput}
            />
            <button
              onClick={() => void sendMessage()}
              disabled={!inputText.trim() || !activeRoom || !matrixClient || sending}
              style={{
                ...s.sendButton,
                background: (inputText.trim() && activeRoom && !sending) ? theme.accent : theme.border,
                color: (inputText.trim() && activeRoom && !sending) ? '#fff' : theme.textMuted,
                cursor: (inputText.trim() && activeRoom && !sending) ? 'pointer' : 'default',
              }}
            >{sending ? 'Sending…' : 'Send'}</button>
          </div>
        </div>
      </div>

      {/* ── New DM picker ── */}
      {newDmOpen && matrixClient && (
        <NewDmPicker
          theme={theme}
          matrixClient={matrixClient}
          onPick={startDirectMessage}
          onClose={() => setNewDmOpen(false)}
        />
      )}

      {/* ── Preserve dialog ── */}
      {preserve.visible && preserve.message && (
        <PreserveDialog
          theme={theme}
          state={preserve}
          roomEncrypted={activeRoom?.encrypted ?? false}
          onAddEdge={() => {
            if (!preserve.linkTarget.trim()) return;
            setPreserve((p) => ({
              ...p,
              edges: [...p.edges, { target: p.linkTarget.trim(), edgeType: p.edgeType }],
              linkTarget: '',
            }));
          }}
          onRemoveEdge={(i) => {
            setPreserve((p) => ({
              ...p,
              edges: p.edges.filter((_, idx) => idx !== i),
            }));
          }}
          onChangeLinkTarget={(v) => setPreserve((p) => ({ ...p, linkTarget: v }))}
          onChangeEdgeType={(v) => setPreserve((p) => ({ ...p, edgeType: v }))}
          onConfirm={async () => {
            if (!preserve.message) return;
            setPreserve((p) => ({ ...p, preserving: true }));
            await preserveMessage(preserve.message, preserve.edges);
            setPreserve({ message: null, visible: false, linkTarget: '', edgeType: 'references', edges: [], preserving: false });
          }}
          onCancel={() => setPreserve({ message: null, visible: false, linkTarget: '', edgeType: 'references', edges: [], preserving: false })}
        />
      )}
    </div>
  );
}

// ─── New DM picker ────────────────────────────────────────────────────────

function NewDmPicker({ theme, matrixClient, onPick, onClose }: {
  theme: Theme;
  matrixClient: MatrixClient;
  onPick: (userId: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [all, setAll] = useState<DiscoveredUser[]>([]);
  const [results, setResults] = useState<DiscoveredUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listAllHomeserverUsers(matrixClient, 200)
      .then((u) => { if (!cancelled) setAll(u); })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [matrixClient]);

  function onQueryChange(v: string) {
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (v.trim().length < 1) { setResults([]); return; }
      try {
        const r = await searchUsers(matrixClient, v, 50);
        setResults(r);
      } catch { /* ignore */ }
    }, 200);
  }

  const list = query.trim() ? results : all;

  async function handlePick(userId: string) {
    setStarting(userId);
    try { await onPick(userId); } finally { setStarting(null); }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460, maxHeight: '70vh', background: theme.bgCard, borderRadius: 12,
          border: `1px solid ${theme.border}`, boxShadow: theme.shadowOverlay,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '14px 18px', borderBottom: `1px solid ${theme.border}`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: theme.textHeading }}>New Direct Message</span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 16, color: theme.textMuted, padding: 4,
          }}>x</button>
        </div>
        <div style={{ padding: '10px 18px', borderBottom: `1px solid ${theme.border}` }}>
          <input
            autoFocus
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search by name or @user:server..."
            style={{
              width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6,
              border: `1px solid ${theme.border}`, background: theme.bg, color: theme.text,
              fontSize: 12, outline: 'none', fontFamily: 'var(--mono, monospace)',
            }}
          />
        </div>
        <div style={{ overflow: 'auto', padding: '6px 10px', flex: 1 }}>
          {loading && (
            <div style={{ padding: 20, textAlign: 'center', color: theme.textMuted, fontSize: 12 }}>Loading users…</div>
          )}
          {!loading && list.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: theme.textMuted, fontSize: 12 }}>
              {query.trim() ? `No users match "${query}".` : 'No users found.'}
            </div>
          )}
          {list.map((u) => {
            const localpart = u.userId.startsWith('@') ? u.userId.slice(1).split(':')[0] : u.userId;
            const isStarting = starting === u.userId;
            return (
              <button
                key={u.userId}
                onClick={() => handlePick(u.userId)}
                disabled={isStarting}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  padding: '8px 10px', border: 'none', borderRadius: 6,
                  background: isStarting ? theme.bgMuted : 'transparent',
                  color: theme.text, textAlign: 'left' as const,
                  cursor: isStarting ? 'default' : 'pointer', fontSize: 12,
                  fontFamily: 'var(--mono, monospace)',
                }}
                onMouseEnter={(e) => { if (!isStarting) (e.currentTarget.style.background = theme.bgHover); }}
                onMouseLeave={(e) => { if (!isStarting) (e.currentTarget.style.background = 'transparent'); }}
              >
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: theme.accentBg, color: theme.accent,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 700, flexShrink: 0,
                }}>
                  {(u.displayName || localpart).charAt(0).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.displayName || localpart}</div>
                  <div style={{ fontSize: 10, color: theme.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.userId}</div>
                </div>
                {isStarting && <span style={{ fontSize: 10, color: theme.textMuted }}>Opening…</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Message bubble with preserve action ─────────────────────────────────────

function MessageBubble({
  msg, theme, onPreserve, onUnpreserve,
}: {
  msg: MatrixMessage;
  theme: Theme;
  onPreserve: () => void;
  onUnpreserve: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const preserved = !!msg.preservedTarget;
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', gap: 10, padding: '8px 20px', position: 'relative',
        background: preserved ? OP_COLORS.INS.bg + '40' : hovered ? theme.bgHover : 'transparent',
        borderLeft: preserved ? `3px solid ${OP_COLORS.INS.border}` : '3px solid transparent',
        transition: 'background 0.1s',
      }}
    >
      {/* Avatar */}
      <div style={{
        width: 32, height: 32, minWidth: 32, borderRadius: 6,
        background: theme.accentBg, color: theme.accent,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 700, fontFamily: 'var(--sans, sans-serif)',
      }}>
        {msg.senderName.slice(0, 2).toUpperCase()}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: theme.textHeading }}>{msg.senderName}</span>
          <span style={{ fontSize: 11, color: theme.textMuted }}>{time}</span>
          {preserved && (
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 4, fontWeight: 700,
              letterSpacing: 0.5, fontFamily: 'var(--mono, monospace)',
              background: OP_COLORS.INS.bg, color: OP_COLORS.INS.text,
              border: `1px solid ${OP_COLORS.INS.border}`,
            }}>PRESERVED</span>
          )}
          {msg.edges && msg.edges.length > 0 && (
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 4, fontWeight: 600,
              fontFamily: 'var(--mono, monospace)',
              background: OP_COLORS.CON.bg, color: OP_COLORS.CON.text,
              border: `1px solid ${OP_COLORS.CON.border}`,
            }}>{msg.edges.length} edge{msg.edges.length > 1 ? 's' : ''}</span>
          )}

          {/* Actions (on hover) */}
          {hovered && (
            <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
              {!preserved ? (
                <button
                  onClick={onPreserve}
                  title="Preserve — INS into database with room encryption"
                  style={{
                    padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                    border: `1px solid ${OP_COLORS.INS.border}`, cursor: 'pointer',
                    background: OP_COLORS.INS.bg, color: OP_COLORS.INS.text,
                    fontFamily: 'var(--mono, monospace)',
                  }}
                >Preserve</button>
              ) : (
                <button
                  onClick={onUnpreserve}
                  title="Unpreserve — NUL the record (reversible)"
                  style={{
                    padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                    border: `1px solid ${OP_COLORS.NUL.border}`, cursor: 'pointer',
                    background: OP_COLORS.NUL.bg, color: OP_COLORS.NUL.text,
                    fontFamily: 'var(--mono, monospace)',
                  }}
                >Unpreserve</button>
              )}
            </div>
          )}
        </div>
        <div style={{ fontSize: 13, color: theme.text, lineHeight: 1.5 }}>{msg.body}</div>

        {/* Preserved metadata */}
        {preserved && msg.preservedTarget && (
          <div style={{
            marginTop: 6, padding: '4px 8px', borderRadius: 4,
            background: theme.bgMuted, fontSize: 11, fontFamily: 'var(--mono, monospace)',
            color: theme.textMuted, display: 'flex', flexWrap: 'wrap' as const, gap: 8,
          }}>
            <span>target: {msg.preservedTarget}</span>
            {msg.edges?.map((e, i) => (
              <span key={i} style={{ color: OP_COLORS.CON.text }}>
                CON {e.edgeType} → {e.target}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Preserve dialog ─────────────────────────────────────────────────────────

function PreserveDialog({
  theme, state, roomEncrypted,
  onAddEdge, onRemoveEdge, onChangeLinkTarget, onChangeEdgeType,
  onConfirm, onCancel,
}: {
  theme: Theme;
  state: PreserveDialogState;
  roomEncrypted: boolean;
  onAddEdge: () => void;
  onRemoveEdge: (i: number) => void;
  onChangeLinkTarget: (v: string) => void;
  onChangeEdgeType: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const msg = state.message;
  if (!msg) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 480, maxHeight: '80vh', background: theme.bgCard, borderRadius: 12,
        border: `1px solid ${theme.border}`, boxShadow: theme.shadowOverlay,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: `1px solid ${theme.border}`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700,
            background: OP_COLORS.INS.bg, color: OP_COLORS.INS.text,
            border: `1px solid ${OP_COLORS.INS.border}`,
            fontFamily: 'var(--mono, monospace)',
          }}>INS</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: theme.textHeading }}>Preserve Message</span>
          <div style={{ flex: 1 }} />
          <button onClick={onCancel} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 16, color: theme.textMuted, padding: 4,
          }}>x</button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, overflow: 'auto', flex: 1 }}>
          {/* Message preview */}
          <div style={{
            padding: '12px 14px', borderRadius: 8, background: theme.bgMuted,
            border: `1px solid ${theme.borderLight}`, marginBottom: 16,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: theme.textHeading }}>{msg.senderName}</span>
              <span style={{ fontSize: 10, color: theme.textMuted }}>
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div style={{ fontSize: 13, color: theme.text, lineHeight: 1.5 }}>{msg.body}</div>
          </div>

          {/* Encryption notice */}
          <div style={{
            padding: '10px 14px', borderRadius: 8, marginBottom: 16,
            background: roomEncrypted ? theme.accentBg : theme.warningBg,
            border: `1px solid ${roomEncrypted ? theme.accentBorder : theme.warningBorder}`,
            fontSize: 12, lineHeight: 1.5,
            color: roomEncrypted ? theme.accent : theme.warning,
          }}>
            {roomEncrypted ? (
              <>
                <strong>Encrypted preservation.</strong> This record will inherit the room's
                encryption scope. Only users with access to this Matrix room can read
                the preserved content, metadata, or even see that it exists.
              </>
            ) : (
              <>
                <strong>Unencrypted room.</strong> This message will be preserved as a
                readable record. To restrict access, move the conversation to an
                encrypted room first.
              </>
            )}
          </div>

          {/* Edge linking */}
          <div style={{ marginBottom: 12 }}>
            <div style={{
              fontSize: 12, fontWeight: 600, color: theme.textSecondary,
              marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span style={{
                fontSize: 10, padding: '1px 5px', borderRadius: 3, fontWeight: 700,
                background: OP_COLORS.CON.bg, color: OP_COLORS.CON.text,
                border: `1px solid ${OP_COLORS.CON.border}`,
                fontFamily: 'var(--mono, monospace)',
              }}>CON</span>
              Link to records (optional, always reversible)
            </div>

            {/* Existing edges */}
            {state.edges.map((edge, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                borderRadius: 6, background: theme.bgMuted, marginBottom: 4,
                border: `1px solid ${theme.borderLight}`,
              }}>
                <span style={{
                  fontSize: 10, padding: '1px 5px', borderRadius: 3,
                  background: OP_COLORS.CON.bg, color: OP_COLORS.CON.text,
                  fontFamily: 'var(--mono, monospace)', fontWeight: 600,
                }}>{edge.edgeType}</span>
                <span style={{ fontSize: 12, fontFamily: 'var(--mono, monospace)', color: theme.text, flex: 1 }}>
                  {edge.target}
                </span>
                <button onClick={() => onRemoveEdge(i)} style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 12, color: theme.textMuted, padding: '2px 4px',
                }}>x</button>
              </div>
            ))}

            {/* Add edge */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                value={state.edgeType}
                onChange={(e) => onChangeEdgeType(e.target.value)}
                style={{
                  padding: '6px 8px', borderRadius: 6, border: `1px solid ${theme.border}`,
                  fontSize: 12, background: theme.bgCard, color: theme.text,
                  fontFamily: 'var(--mono, monospace)', outline: 'none',
                }}
              >
                <option value="references">references</option>
                <option value="supports">supports</option>
                <option value="contradicts">contradicts</option>
                <option value="follows_up">follows_up</option>
                <option value="related_to">related_to</option>
              </select>
              <input
                value={state.linkTarget}
                onChange={(e) => onChangeLinkTarget(e.target.value)}
                placeholder="Record target (e.g. tblClients.rec_abc123)"
                style={{
                  flex: 1, padding: '6px 10px', borderRadius: 6,
                  border: `1px solid ${theme.border}`, fontSize: 12,
                  fontFamily: 'var(--mono, monospace)', outline: 'none',
                  background: theme.bgCard, color: theme.text,
                }}
              />
              <button
                onClick={onAddEdge}
                disabled={!state.linkTarget.trim()}
                style={{
                  padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                  border: `1px solid ${state.linkTarget.trim() ? OP_COLORS.CON.border : theme.border}`,
                  background: state.linkTarget.trim() ? OP_COLORS.CON.bg : theme.bgMuted,
                  color: state.linkTarget.trim() ? OP_COLORS.CON.text : theme.textMuted,
                  cursor: state.linkTarget.trim() ? 'pointer' : 'default',
                }}
              >+ Edge</button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 20px', borderTop: `1px solid ${theme.border}`,
          display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          <button onClick={onCancel} style={{
            padding: '8px 16px', borderRadius: 6, border: `1px solid ${theme.border}`,
            background: theme.bgCard, color: theme.textSecondary, fontSize: 13,
            fontWeight: 500, cursor: 'pointer',
          }}>Cancel</button>
          <button
            onClick={onConfirm}
            disabled={state.preserving}
            style={{
              padding: '8px 16px', borderRadius: 6, border: 'none',
              background: OP_COLORS.INS.border, color: '#fff', fontSize: 13,
              fontWeight: 600, cursor: state.preserving ? 'wait' : 'pointer',
              opacity: state.preserving ? 0.7 : 1,
            }}
          >
            {state.preserving ? 'Preserving...' : 'Preserve'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

function buildStyles(theme: Theme): Record<string, CSSProperties> {
  return {
    container: {
      flex: 1, display: 'flex', overflow: 'hidden',
    },
    roomList: {
      width: 240, borderRight: `1px solid ${theme.border}`, background: theme.bg,
      display: 'flex', flexDirection: 'column', flexShrink: 0,
    },
    roomListHeader: {
      padding: '14px 16px', borderBottom: `1px solid ${theme.border}`,
    },
    roomListBody: {
      flex: 1, overflow: 'auto', padding: 8,
    },
    sectionLabel: {
      fontSize: 10, fontWeight: 600, color: theme.textMuted,
      letterSpacing: 1, padding: '8px 8px 4px', textTransform: 'uppercase' as const,
    },
    roomItem: {
      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
      padding: '7px 8px', border: 'none', borderRadius: 6, cursor: 'pointer',
      fontSize: 13, textAlign: 'left' as const, background: 'transparent',
      color: theme.text, fontWeight: 400,
    },
    roomItemActive: {
      background: theme.bgActive, color: theme.accent, fontWeight: 600,
    },
    unreadBadge: {
      fontSize: 10, padding: '1px 5px', borderRadius: 8,
      background: theme.danger, color: '#fff', fontWeight: 700,
      fontFamily: 'var(--mono, monospace)',
    },
    chatArea: {
      flex: 1, display: 'flex', flexDirection: 'column' as const, background: theme.bgCard,
    },
    chatHeader: {
      padding: '12px 20px', borderBottom: `1px solid ${theme.border}`,
      display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
    },
    messageList: {
      flex: 1, overflow: 'auto', paddingTop: 8, paddingBottom: 8,
    },
    composer: {
      padding: '12px 20px', borderTop: `1px solid ${theme.border}`, flexShrink: 0,
    },
    composerInput: {
      flex: 1, padding: '10px 14px', border: `1px solid ${theme.border}`,
      borderRadius: 8, fontSize: 13, outline: 'none', background: theme.bgCard,
      color: theme.text,
    },
    sendButton: {
      padding: '10px 16px', borderRadius: 8, border: 'none',
      fontSize: 13, fontWeight: 500, transition: 'all 0.15s',
    },
  };
}
