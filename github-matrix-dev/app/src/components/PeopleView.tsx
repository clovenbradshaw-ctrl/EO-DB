/**
 * PeopleView — browse all users on the homeserver.
 *
 * Default: shows all discoverable users (via directory search + joined-room
 * members). Typing in the search box narrows the list via Matrix's user
 * directory search. Each row offers a "Message" action that starts (or
 * resumes) a direct message with that user.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { useTheme, type Theme } from '../theme';
import {
  searchUsers,
  listAllHomeserverUsers,
  type DiscoveredUser,
} from '../matrix/user-discovery';
import { findOrCreateDirectMessage } from '../matrix/dm';

interface PeopleViewProps {
  matrixClient: MatrixClient;
  /** Called after a DM room is created/found so the caller can navigate to it. */
  onOpenDirectMessage?: (roomId: string, userId: string) => void;
}

export function PeopleView({ matrixClient, onOpenDirectMessage }: PeopleViewProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const [query, setQuery] = useState('');
  const [allUsers, setAllUsers] = useState<DiscoveredUser[]>([]);
  const [searchResults, setSearchResults] = useState<DiscoveredUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Initial load of all discoverable users
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listAllHomeserverUsers(matrixClient, 200)
      .then((users) => {
        if (!cancelled) setAllUsers(users);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || 'Failed to load users');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [matrixClient]);

  // Debounced search
  const doSearch = useCallback(async (term: string) => {
    if (term.trim().length < 1) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      const results = await searchUsers(matrixClient, term, 50);
      setSearchResults(results);
    } finally {
      setSearching(false);
    }
  }, [matrixClient]);

  function handleQueryChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 250);
  }

  async function handleMessage(user: DiscoveredUser) {
    setStarting(user.userId);
    setError(null);
    try {
      const roomId = await findOrCreateDirectMessage(matrixClient, user.userId);
      onOpenDirectMessage?.(roomId, user.userId);
    } catch (e: any) {
      setError(`Failed to start conversation with ${user.displayName}: ${e?.message || e}`);
    } finally {
      setStarting(null);
    }
  }

  // Local filter on the default list for instant feedback while typing
  const activeList: DiscoveredUser[] = query.trim().length > 0
    ? searchResults
    : allUsers;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div style={s.title}>People</div>
        <div style={s.subtitle}>
          Everyone on your homeserver. Start a conversation or invite someone to a space.
        </div>
      </div>

      <div style={s.searchBar}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, opacity: 0.4 }}>
          <circle cx="6" cy="6" r="4.5" stroke={theme.textMuted} strokeWidth="1.2" />
          <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" stroke={theme.textMuted} strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <input
          style={s.searchInput}
          placeholder="Search by name or @user:server..."
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
        />
        {(loading || searching) && <div style={s.spinner} />}
      </div>

      {error && <div style={s.error}>{error}</div>}

      {!loading && activeList.length === 0 && (
        <div style={s.empty}>
          {query.trim().length > 0
            ? `No users match "${query}".`
            : 'No discoverable users yet. Once members join spaces they will appear here.'}
        </div>
      )}

      <div style={s.list}>
        {activeList.map((user) => (
          <UserRow
            key={user.userId}
            user={user}
            matrixClient={matrixClient}
            theme={theme}
            starting={starting === user.userId}
            onMessage={() => handleMessage(user)}
          />
        ))}
      </div>

      <style>{`
        @keyframes eo-spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function UserRow({
  user,
  matrixClient,
  theme,
  starting,
  onMessage,
}: {
  user: DiscoveredUser;
  matrixClient: MatrixClient;
  theme: Theme;
  starting: boolean;
  onMessage: () => void;
}) {
  const mono = "'JetBrains Mono', monospace";
  const localpart = user.userId.startsWith('@')
    ? user.userId.slice(1).split(':')[0]
    : user.userId;
  const homeserver = user.userId.includes(':') ? user.userId.split(':')[1] : '';

  const avatarHttpUrl = user.avatarUrl
    ? matrixClient.mxcUrlToHttp(user.avatarUrl, 40, 40, 'crop') ?? undefined
    : undefined;

  let hash = 0;
  for (let i = 0; i < user.userId.length; i++) {
    hash = user.userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [theme.accent, theme.purple, theme.teal, theme.gold, theme.warning];
  const avatarColor = colors[((hash % colors.length) + colors.length) % colors.length];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        border: `1px solid ${theme.border}`,
        borderRadius: 10,
        background: theme.bgCard,
        fontFamily: mono,
      }}
    >
      {avatarHttpUrl ? (
        <img
          src={avatarHttpUrl}
          alt=""
          style={{ width: 36, height: 36, borderRadius: '50%', flexShrink: 0, objectFit: 'cover' }}
        />
      ) : (
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: `${avatarColor}18`, color: avatarColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, fontWeight: 600, flexShrink: 0,
        }}>
          {user.displayName.charAt(0).toUpperCase()}
        </div>
      )}

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 13, fontWeight: 500, color: theme.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {user.displayName}
        </div>
        <div style={{
          fontSize: 10, color: theme.textMuted,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          @{localpart}{homeserver && <span style={{ opacity: 0.6 }}>:{homeserver}</span>}
        </div>
      </div>

      <button
        onClick={onMessage}
        disabled={starting}
        style={{
          padding: '6px 12px',
          background: starting ? theme.bgMuted : theme.accent,
          color: starting ? theme.textMuted : '#fff',
          border: 'none',
          borderRadius: 6,
          cursor: starting ? 'default' : 'pointer',
          fontFamily: mono,
          fontSize: 11,
          fontWeight: 500,
          flexShrink: 0,
        }}
      >
        {starting ? 'Opening…' : 'Message'}
      </button>
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  const mono = "'JetBrains Mono', monospace";
  return {
    container: {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      padding: '20px 24px',
      gap: 16,
      overflow: 'auto',
      fontFamily: mono,
    },
    header: { display: 'flex', flexDirection: 'column', gap: 4 },
    title: { fontSize: 18, fontWeight: 600, color: t.textHeading },
    subtitle: { fontSize: 11, color: t.textMuted },
    searchBar: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '0 12px',
      background: t.bg,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
    },
    searchInput: {
      flex: 1,
      padding: '10px 0',
      background: 'transparent',
      border: 'none',
      color: t.text,
      fontFamily: mono,
      fontSize: 12,
      outline: 'none',
    },
    spinner: {
      width: 14, height: 14,
      border: `2px solid ${t.border}`,
      borderTop: `2px solid ${t.accent}`,
      borderRadius: '50%',
      animation: 'eo-spin 0.6s linear infinite',
    },
    list: { display: 'flex', flexDirection: 'column', gap: 6 },
    empty: {
      padding: '32px 12px',
      textAlign: 'center',
      color: t.textMuted,
      fontSize: 12,
    },
    error: {
      padding: '10px 12px',
      background: t.dangerBg,
      color: t.danger,
      border: `1px solid ${t.danger}`,
      borderRadius: 8,
      fontSize: 11,
    },
  };
}
