/**
 * SpaceInvite — search-as-you-type user discovery for inviting
 * members to an EO-DB space via the Matrix user directory.
 *
 * Replaces the plain text input with a combo-box that searches
 * the homeserver's user directory as the admin types, showing
 * avatar, display name, and Matrix ID for each match.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { useTheme, type Theme } from '../theme';
import {
  searchUsers,
  resolveUserProfile,
  type DiscoveredUser,
} from '../matrix/user-discovery';

type AccessLevel = 'read' | 'write' | 'admin';

interface SpaceInviteProps {
  matrixClient: MatrixClient;
  /** Matrix user IDs already in the space (owner + members) — hidden from results */
  existingMemberIds: string[];
  /** Called when the user selects someone to invite */
  onInvite: (userId: string) => void;
  /** Whether the invite action is currently in-flight */
  inviting?: boolean;
}

export function SpaceInvite({
  matrixClient,
  existingMemberIds,
  onInvite,
  inviting,
}: SpaceInviteProps) {
  const { theme } = useTheme();
  const mono = "'JetBrains Mono', monospace";

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DiscoveredUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const existingSet = new Set(existingMemberIds);

  const doSearch = useCallback(
    async (term: string) => {
      if (term.length < 1) {
        setResults([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        // If it looks like a full Matrix ID, also try a direct profile resolve
        const isFullId = /^@[^:]+:.+$/.test(term);
        const [searchResults, directProfile] = await Promise.all([
          searchUsers(matrixClient, term, 10),
          isFullId ? resolveUserProfile(matrixClient, term) : Promise.resolve(null),
        ]);

        // Merge: put direct profile first if not already in search results
        let merged = [...searchResults];
        if (directProfile && !merged.some((r) => r.userId === directProfile.userId)) {
          merged.unshift(directProfile);
        }

        // Filter out existing members
        merged = merged.filter((u) => !existingSet.has(u.userId));

        setResults(merged);
        setSelectedIdx(-1);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [matrixClient, existingMemberIds.join(',')],
  );

  function handleInputChange(value: string) {
    setQuery(value);
    setFocused(true);

    // Debounce the search (300ms)
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 300);
  }

  function handleSelect(user: DiscoveredUser) {
    onInvite(user.userId);
    setQuery('');
    setResults([]);
    setFocused(false);
    inputRef.current?.blur();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!focused || results.length === 0) {
      // Allow direct entry via Enter if it looks like a valid Matrix ID
      if (e.key === 'Enter' && /^@[^:]+:.+$/.test(query.trim())) {
        onInvite(query.trim());
        setQuery('');
        setResults([]);
        return;
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIdx((prev) => Math.min(prev + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIdx((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIdx >= 0 && selectedIdx < results.length) {
          handleSelect(results[selectedIdx]);
        } else if (/^@[^:]+:.+$/.test(query.trim())) {
          onInvite(query.trim());
          setQuery('');
          setResults([]);
        }
        break;
      case 'Escape':
        setFocused(false);
        setSelectedIdx(-1);
        break;
    }
  }

  const showDropdown = focused && (results.length > 0 || loading || (query.length > 0 && !loading));

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1 }}>
      {/* Search input */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        background: theme.bg,
        border: `1px solid ${focused ? theme.accent : theme.border}`,
        borderRadius: 8,
        padding: '0 10px',
        transition: 'border-color 0.15s',
      }}>
        {/* Search icon */}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, opacity: 0.4 }}>
          <circle cx="6" cy="6" r="4.5" stroke={theme.textMuted} strokeWidth="1.2" />
          <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" stroke={theme.textMuted} strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          style={{
            flex: 1,
            padding: '8px 8px',
            background: 'transparent',
            border: 'none',
            color: theme.text,
            fontFamily: mono,
            fontSize: 11,
            outline: 'none',
          }}
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => { setFocused(true); if (query.length > 0) doSearch(query); }}
          onKeyDown={handleKeyDown}
          placeholder="Search users or enter @user:server..."
          disabled={inviting}
        />
        {loading && (
          <div style={{
            width: 14, height: 14,
            border: `2px solid ${theme.border}`,
            borderTop: `2px solid ${theme.accent}`,
            borderRadius: '50%',
            animation: 'eo-spin 0.6s linear infinite',
          }} />
        )}
      </div>

      {/* Dropdown results */}
      {showDropdown && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          marginTop: 4,
          background: theme.bgCard,
          border: `1px solid ${theme.border}`,
          borderRadius: 8,
          boxShadow: `0 8px 24px ${theme.shadow}`,
          maxHeight: 280,
          overflowY: 'auto',
          zIndex: 200,
        }}>
          {results.length === 0 && !loading && query.length > 0 && (
            <div style={{
              padding: '12px 14px',
              fontFamily: mono,
              fontSize: 11,
              color: theme.textMuted,
              textAlign: 'center',
            }}>
              {/^@[^:]+:.+$/.test(query.trim()) ? (
                <div>
                  <div style={{ marginBottom: 4 }}>No matching users found</div>
                  <div style={{ fontSize: 10, color: theme.textSecondary }}>
                    Press Enter to invite <strong>{query.trim()}</strong> directly
                  </div>
                </div>
              ) : (
                'No users found. Try a name or @user:server'
              )}
            </div>
          )}

          {results.map((user, idx) => (
            <UserResultRow
              key={user.userId}
              theme={theme}
              user={user}
              isSelected={idx === selectedIdx}
              matrixClient={matrixClient}
              onClick={() => handleSelect(user)}
              onMouseEnter={() => setSelectedIdx(idx)}
            />
          ))}
        </div>
      )}

      {/* Spinner keyframes */}
      <style>{`
        @keyframes eo-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

/* ---- Individual user result row ---- */

function UserResultRow({
  theme,
  user,
  isSelected,
  matrixClient,
  onClick,
  onMouseEnter,
}: {
  theme: Theme;
  user: DiscoveredUser;
  isSelected: boolean;
  matrixClient: MatrixClient;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  const mono = "'JetBrains Mono', monospace";
  const localpart = user.userId.startsWith('@')
    ? user.userId.slice(1).split(':')[0]
    : user.userId;
  const homeserver = user.userId.includes(':')
    ? user.userId.split(':')[1]
    : '';

  // Resolve avatar URL from MXC
  const avatarHttpUrl = user.avatarUrl
    ? matrixClient.mxcUrlToHttp(user.avatarUrl, 32, 32, 'crop') ?? undefined
    : undefined;

  // Avatar color from hash
  let hash = 0;
  for (let i = 0; i < user.userId.length; i++) {
    hash = user.userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [theme.accent, theme.purple, theme.teal, theme.gold, theme.warning];
  const avatarColor = colors[((hash % colors.length) + colors.length) % colors.length];

  return (
    <button
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '8px 14px',
        background: isSelected ? theme.bgHover : 'transparent',
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left' as const,
        fontFamily: mono,
        transition: 'background 0.1s',
      }}
    >
      {/* Avatar */}
      {avatarHttpUrl ? (
        <img
          src={avatarHttpUrl}
          alt=""
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            flexShrink: 0,
            objectFit: 'cover',
          }}
        />
      ) : (
        <div style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: `${avatarColor}18`,
          color: avatarColor,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          fontWeight: 600,
          flexShrink: 0,
        }}>
          {user.displayName.charAt(0).toUpperCase()}
        </div>
      )}

      {/* Name + ID */}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 12,
          fontWeight: 500,
          color: theme.text,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' as const,
        }}>
          {user.displayName}
        </div>
        <div style={{
          fontSize: 10,
          color: theme.textMuted,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' as const,
        }}>
          @{localpart}
          {homeserver && <span style={{ opacity: 0.6 }}>:{homeserver}</span>}
        </div>
      </div>

      {/* Invite hint */}
      <div style={{
        fontSize: 10,
        color: theme.accent,
        flexShrink: 0,
        opacity: isSelected ? 1 : 0,
        transition: 'opacity 0.1s',
      }}>
        invite
      </div>
    </button>
  );
}
