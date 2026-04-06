/**
 * WhisperChat — ephemeral P2P messaging UI.
 *
 * All messages flow over encrypted WebRTC DataChannel. Nothing is stored
 * on Matrix, IndexedDB, or anywhere persistent. When this component
 * unmounts, the conversation is gone.
 *
 * This is pure SIG — real-time, ephemeral, not logged.
 */

import { useState, useRef, useEffect, useCallback, type CSSProperties } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { useTheme, type Theme } from '../theme';
import {
  WhisperChannel,
  WhisperManager,
  type WhisperMessage,
  type WhisperState,
  type WhisperInvitation,
  type WhisperEventHandlers,
} from '../matrix/whisper';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WhisperChatProps {
  client: MatrixClient;
  /** When set, initiates a whisper to this peer. */
  peerUserId?: string;
  peerDeviceId?: string;
  /** Callback when the user closes the whisper panel. */
  onClose: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function WhisperChat({ client, peerUserId, peerDeviceId, onClose }: WhisperChatProps) {
  const { theme } = useTheme();
  const [messages, setMessages] = useState<WhisperMessage[]>([]);
  const [input, setInput] = useState('');
  const [channelState, setChannelState] = useState<WhisperState>('idle');
  const [peerTyping, setPeerTyping] = useState(false);
  const [invitation, setInvitation] = useState<WhisperInvitation | null>(null);
  const channelRef = useRef<WhisperChannel | null>(null);
  const managerRef = useRef<WhisperManager | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const myUserId = client.getUserId() || '';

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Build event handlers for the whisper channel
  const makeHandlers = useCallback((): WhisperEventHandlers => ({
    onMessage: (msg) => setMessages(prev => [...prev, msg]),
    onTyping: (active) => setPeerTyping(active),
    onRead: () => { /* Could mark messages as read in UI */ },
    onStateChange: (state) => setChannelState(state),
  }), []);

  // Initialize whisper manager for incoming invitations
  useEffect(() => {
    const manager = new WhisperManager(client);
    managerRef.current = manager;

    manager.start((inv) => {
      // If we already have an active channel, ignore new invitations
      if (channelRef.current && channelRef.current.state === 'connected') return;
      setInvitation(inv);
    });

    return () => {
      manager.destroy();
      managerRef.current = null;
    };
  }, [client]);

  // Auto-invite if peer is specified
  useEffect(() => {
    if (!peerUserId || !peerDeviceId || !managerRef.current) return;
    if (channelRef.current) return; // already connected

    const manager = managerRef.current;
    const handlers = makeHandlers();

    manager.invite(peerUserId, peerDeviceId, handlers).then(channel => {
      channelRef.current = channel;
    }).catch(e => {
      console.warn('[EO-DB] Whisper invite failed:', e);
      setChannelState('disconnected');
    });
  }, [peerUserId, peerDeviceId, makeHandlers]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (channelRef.current) {
        channelRef.current.close();
        channelRef.current = null;
      }
    };
  }, []);

  // Accept an incoming invitation
  const handleAccept = useCallback(async () => {
    if (!invitation || !managerRef.current) return;
    const handlers = makeHandlers();
    try {
      const channel = await managerRef.current.acceptInvitation(invitation, handlers);
      channelRef.current = channel;
      setInvitation(null);
    } catch (e) {
      console.warn('[EO-DB] Whisper accept failed:', e);
      setInvitation(null);
    }
  }, [invitation, makeHandlers]);

  // Decline an incoming invitation
  const handleDecline = useCallback(async () => {
    if (!invitation || !managerRef.current) return;
    await managerRef.current.declineInvitation(invitation);
    setInvitation(null);
  }, [invitation]);

  // Send a message
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !channelRef.current) return;
    const msg = await channelRef.current.send(text);
    if (msg) {
      setMessages(prev => [...prev, msg]);
    }
    setInput('');
  }, [input]);

  // Typing indicator
  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    if (channelRef.current && value.length > 0) {
      channelRef.current.sendTyping(true);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => {
        channelRef.current?.sendTyping(false);
      }, 3000);
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const s = styles(theme);
  const peerName = peerUserId?.split(':')[0]?.replace('@', '') || invitation?.fromUserId?.split(':')[0]?.replace('@', '') || 'Peer';

  return (
    <div style={s.container}>
      {/* Header */}
      <div style={s.header}>
        <div style={s.headerLeft}>
          <div style={s.headerDot(channelState)} />
          <span style={s.headerTitle}>Whisper with {peerName}</span>
          <span style={s.headerState}>
            {channelState === 'idle' ? 'waiting' : channelState}
          </span>
        </div>
        <button onClick={onClose} style={s.closeButton}>x</button>
      </div>

      {/* Ephemeral notice */}
      <div style={s.notice}>
        This conversation is not stored anywhere. It exists only between connected devices.
      </div>

      {/* Incoming invitation */}
      {invitation && !channelRef.current && (
        <div style={s.invitationBar}>
          <span>{invitation.fromUserId.split(':')[0].replace('@', '')} wants to whisper</span>
          <button onClick={handleAccept} style={s.acceptButton}>Accept</button>
          <button onClick={handleDecline} style={s.declineButton}>Decline</button>
        </div>
      )}

      {/* Messages */}
      <div style={s.messageList}>
        {messages.map((msg) => {
          const isMe = msg.sender === myUserId;
          return (
            <div key={msg.id} style={s.messageRow(isMe)}>
              <div style={s.messageBubble(isMe, theme)}>
                {!isMe && (
                  <div style={s.messageSender}>{msg.sender.split(':')[0].replace('@', '')}</div>
                )}
                <div style={s.messageText}>{msg.text}</div>
                <div style={s.messageTime}>
                  {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          );
        })}
        {peerTyping && (
          <div style={s.typingIndicator}>
            {peerName} is typing...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={s.inputArea}>
        <input
          type="text"
          value={input}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={channelState === 'connected' ? 'Type a message...' : 'Waiting for connection...'}
          disabled={channelState !== 'connected'}
          style={s.input}
        />
        <button
          onClick={handleSend}
          disabled={channelState !== 'connected' || !input.trim()}
          style={s.sendButton}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

function styles(theme: Theme) {
  return {
    container: {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: theme.bg,
      borderLeft: `1px solid ${theme.border}`,
      fontFamily: "'Outfit', sans-serif",
    } as CSSProperties,

    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 14px',
      borderBottom: `1px solid ${theme.border}`,
      background: theme.bgCard,
    } as CSSProperties,

    headerLeft: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    } as CSSProperties,

    headerDot: (state: WhisperState): CSSProperties => ({
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: state === 'connected' ? theme.success
        : state === 'connecting' ? theme.warning
        : theme.danger,
      flexShrink: 0,
    }),

    headerTitle: {
      fontSize: 13,
      fontWeight: 600,
      color: theme.text,
    } as CSSProperties,

    headerState: {
      fontSize: 10,
      color: theme.textSecondary,
      fontFamily: "'JetBrains Mono', monospace",
    } as CSSProperties,

    closeButton: {
      background: 'none',
      border: 'none',
      color: theme.textSecondary,
      cursor: 'pointer',
      fontSize: 14,
      fontFamily: "'JetBrains Mono', monospace",
      padding: '2px 6px',
    } as CSSProperties,

    notice: {
      padding: '6px 14px',
      fontSize: 10,
      color: theme.textSecondary,
      background: theme.warningBg,
      borderBottom: `1px solid ${theme.warningBorder}`,
      fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: 0.2,
    } as CSSProperties,

    invitationBar: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 14px',
      background: theme.accentBg,
      borderBottom: `1px solid ${theme.accentBorder}`,
      fontSize: 12,
      color: theme.text,
    } as CSSProperties,

    acceptButton: {
      background: theme.success,
      color: '#fff',
      border: 'none',
      borderRadius: 6,
      padding: '4px 12px',
      fontSize: 11,
      fontWeight: 600,
      cursor: 'pointer',
    } as CSSProperties,

    declineButton: {
      background: 'none',
      border: `1px solid ${theme.border}`,
      borderRadius: 6,
      padding: '4px 12px',
      fontSize: 11,
      color: theme.textSecondary,
      cursor: 'pointer',
    } as CSSProperties,

    messageList: {
      flex: 1,
      overflowY: 'auto',
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    } as CSSProperties,

    messageRow: (isMe: boolean): CSSProperties => ({
      display: 'flex',
      justifyContent: isMe ? 'flex-end' : 'flex-start',
    }),

    messageBubble: (isMe: boolean, t: Theme): CSSProperties => ({
      maxWidth: '70%',
      padding: '8px 12px',
      borderRadius: 12,
      background: isMe ? t.accent : t.bgCard,
      color: isMe ? '#fff' : t.text,
      border: isMe ? 'none' : `1px solid ${t.border}`,
      fontSize: 13,
    }),

    messageSender: {
      fontSize: 10,
      fontWeight: 600,
      color: theme.accent,
      marginBottom: 2,
    } as CSSProperties,

    messageText: {
      wordBreak: 'break-word',
      lineHeight: 1.4,
    } as CSSProperties,

    messageTime: {
      fontSize: 9,
      opacity: 0.6,
      textAlign: 'right',
      marginTop: 2,
      fontFamily: "'JetBrains Mono', monospace",
    } as CSSProperties,

    typingIndicator: {
      fontSize: 11,
      color: theme.textSecondary,
      fontStyle: 'italic',
      padding: '4px 0',
    } as CSSProperties,

    inputArea: {
      display: 'flex',
      gap: 8,
      padding: '10px 14px',
      borderTop: `1px solid ${theme.border}`,
      background: theme.bgCard,
    } as CSSProperties,

    input: {
      flex: 1,
      padding: '8px 12px',
      borderRadius: 8,
      border: `1px solid ${theme.border}`,
      background: theme.bg,
      color: theme.text,
      fontSize: 13,
      fontFamily: "'Outfit', sans-serif",
      outline: 'none',
    } as CSSProperties,

    sendButton: {
      padding: '8px 16px',
      borderRadius: 8,
      border: 'none',
      background: theme.accent,
      color: '#fff',
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer',
      opacity: 1,
    } as CSSProperties,
  };
}
