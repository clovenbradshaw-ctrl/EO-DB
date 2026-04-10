/**
 * OnlineUsers — header widget showing which peers are live in the current space.
 *
 * Subscribes to a Presence instance (Matrix to-device heartbeats) and renders
 * an avatar stack with a hover-popover of names. Click toggles the popover.
 */

import { useEffect, useRef, useState } from 'react';
import type { Presence, PresenceUser, PresenceLocation } from '../matrix/presence';
import { useTheme, type Theme } from '../theme';

interface OnlineUsersProps {
  presence: Presence | null;
  /** The current user's ID — rendered inline so the viewer can see themselves. */
  selfUserId?: string | null;
  selfDisplayName?: string | null;
  /**
   * When false, peers are hidden entirely — only the current user is shown
   * and the popover says "you're the only one here". Lets a user opt out of
   * seeing other people's presence without logging out.
   */
  showPeers?: boolean;
}

const MAX_VISIBLE_AVATARS = 4;

export function OnlineUsers({ presence, selfUserId, selfDisplayName, showPeers = true }: OnlineUsersProps) {
  const { theme } = useTheme();
  const [peers, setPeers] = useState<PresenceUser[]>([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!presence) {
      setPeers([]);
      return;
    }
    const unsub = presence.subscribe(setPeers);
    return unsub;
  }, [presence]);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  // Build the rendered list: self first, then peers (unless peers are hidden
  // by the viewer's "show other users" preference).
  const all: PresenceUser[] = [];
  if (selfUserId) {
    all.push({
      userId: selfUserId,
      displayName: selfDisplayName ?? selfUserId,
      devices: [],
      lastSeen: Date.now(),
      location: null,
    });
  }
  if (showPeers) {
    all.push(...peers.filter((p) => p.userId !== selfUserId));
  }

  const total = all.length;
  const visible = all.slice(0, MAX_VISIBLE_AVATARS);
  const overflow = total - visible.length;
  const s = makeStyles(theme);

  if (!presence) return null;

  return (
    <div ref={wrapRef} style={s.wrap}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={s.trigger}
        title={`${total} online`}
        aria-label={`${total} users online`}
      >
        <div style={s.stack}>
          {visible.map((u, i) => (
            <div
              key={u.userId}
              style={{
                ...s.avatar,
                marginLeft: i === 0 ? 0 : -8,
                zIndex: visible.length - i,
                background: avatarColor(u.userId, theme),
                borderColor: u.userId === selfUserId ? theme.accent : theme.bgCard,
              }}
            >
              {initial(u.displayName || u.userId)}
            </div>
          ))}
          {overflow > 0 && (
            <div style={{ ...s.avatar, ...s.avatarOverflow, marginLeft: -8 }}>
              +{overflow}
            </div>
          )}
        </div>
        <span style={s.dot} />
        <span style={s.count}>{total}</span>
      </button>

      {open && (
        <div style={s.popover}>
          <div style={s.popoverHeader}>
            {showPeers
              ? `${total} ${total === 1 ? 'person' : 'people'} here`
              : 'peer presence hidden'}
          </div>
          <div style={s.popoverList}>
            {all.map((u) => (
              <div key={u.userId} style={s.row}>
                <div
                  style={{
                    ...s.avatarSmall,
                    background: avatarColor(u.userId, theme),
                    borderColor: u.userId === selfUserId ? theme.accent : 'transparent',
                  }}
                >
                  {initial(u.displayName || u.userId)}
                </div>
                <div style={s.rowText}>
                  <div style={s.rowName}>
                    {u.displayName || u.userId}
                    {u.userId === selfUserId && <span style={s.youTag}> you</span>}
                  </div>
                  <div style={s.rowMeta}>
                    {u.userId === selfUserId
                      ? 'this device'
                      : `${u.devices.length} ${u.devices.length === 1 ? 'device' : 'devices'} \u00B7 ${relative(u.lastSeen)}`}
                  </div>
                  {u.userId !== selfUserId && u.location && (
                    <div style={s.rowLocation}>{formatLocation(u.location)}</div>
                  )}
                </div>
                <span style={s.greenDot} title="online" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── helpers ───────────────────────────────────────────────────────────────

function initial(name: string): string {
  const stripped = name.startsWith('@') ? name.slice(1) : name;
  return (stripped.charAt(0) || '?').toUpperCase();
}

/**
 * Render a peer location as a discreet one-liner. We intentionally show
 * only the most specific segment the peer has shared — a scope is more
 * informative than a view, a record is more informative than a scope.
 */
function formatLocation(loc: PresenceLocation): string {
  if (loc.record) {
    const leaf = loc.record.split('.').pop() || loc.record;
    return `on ${leaf}`;
  }
  if (loc.scope) {
    const leaf = loc.scope.split('.').pop() || loc.scope;
    return `in ${leaf}`;
  }
  if (loc.view) {
    return `viewing ${loc.view}`;
  }
  return '';
}

function relative(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 20_000) return 'just now';
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}

// Deterministic pastel from userId so each peer keeps a stable color.
function avatarColor(userId: string, theme: Theme): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const sat = theme.mode === 'dark' ? 45 : 55;
  const lum = theme.mode === 'dark' ? 45 : 65;
  return `hsl(${hue}, ${sat}%, ${lum}%)`;
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    wrap: { position: 'relative' as const, display: 'inline-block' },
    trigger: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '4px 10px 4px 4px',
      borderRadius: 999,
      border: `1px solid ${t.border}`,
      background: t.bgCard,
      color: t.text,
      cursor: 'pointer',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
    },
    stack: { display: 'inline-flex', alignItems: 'center' },
    avatar: {
      width: 22,
      height: 22,
      borderRadius: '50%',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#fff',
      fontSize: 10,
      fontWeight: 600,
      border: `2px solid ${t.bgCard}`,
      boxSizing: 'border-box' as const,
    },
    avatarOverflow: {
      background: t.bgMuted,
      color: t.textSecondary,
      fontSize: 9,
    },
    dot: {
      display: 'inline-block',
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: '#10b981',
      boxShadow: '0 0 0 2px rgba(16,185,129,0.25)',
    },
    count: { color: t.textSecondary, fontSize: 11 },
    popover: {
      position: 'absolute' as const,
      top: 'calc(100% + 6px)',
      right: 0,
      minWidth: 240,
      maxWidth: 320,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      zIndex: 1000,
      overflow: 'hidden' as const,
    },
    popoverHeader: {
      padding: '8px 12px',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
      color: t.textSecondary,
      borderBottom: `1px solid ${t.border}`,
      background: t.bg,
    },
    popoverList: {
      maxHeight: 320,
      overflowY: 'auto' as const,
    },
    row: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 12px',
      borderBottom: `1px solid ${t.border}`,
    },
    avatarSmall: {
      width: 28,
      height: 28,
      borderRadius: '50%',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#fff',
      fontSize: 12,
      fontWeight: 600,
      border: '2px solid transparent',
      boxSizing: 'border-box' as const,
      flexShrink: 0,
    },
    rowText: { flex: 1, minWidth: 0 },
    rowName: {
      fontSize: 13,
      color: t.text,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    rowMeta: {
      fontSize: 10,
      color: t.textSecondary,
      fontFamily: "'JetBrains Mono', monospace",
    },
    rowLocation: {
      fontSize: 10,
      color: t.accent,
      fontFamily: "'JetBrains Mono', monospace",
      opacity: 0.8,
      marginTop: 1,
    },
    youTag: { color: t.accent, fontSize: 10, marginLeft: 4 },
    greenDot: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: '#10b981',
      flexShrink: 0,
    },
  };
}
