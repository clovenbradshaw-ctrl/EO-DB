import { useState, useEffect, useRef } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { EoState } from '../db/types';

type AccessLevel = 'read' | 'write' | 'admin';

interface ShareEntry {
  user_id: string;
  access: AccessLevel;
  added_by: string;
  added_at: string;
}

interface SpaceMembersProps {
  spaceTarget: string;
  currentUserId: string;
  onClose: () => void;
}

const ROLE_OPTIONS: { value: AccessLevel; label: string; desc: string }[] = [
  { value: 'read', label: 'Can view', desc: 'View data only' },
  { value: 'write', label: 'Can edit', desc: 'View and edit data' },
  { value: 'admin', label: 'Full access', desc: 'Edit data and manage people' },
];

const ROLE_LABELS: Record<AccessLevel, string> = {
  read: 'Can view',
  write: 'Can edit',
  admin: 'Full access',
};

export function SpaceMembers({ spaceTarget, currentUserId, onClose }: SpaceMembersProps) {
  const { theme } = useTheme();
  const s = styles(theme);
  const dispatch = useEoStore((st) => st.dispatch);
  const getState = useEoStore((st) => st.getState);

  const [spaceState, setSpaceState] = useState<EoState | null>(null);
  const [members, setMembers] = useState<ShareEntry[]>([]);
  const [owner, setOwner] = useState<string>('');
  const [loading, setLoading] = useState(true);

  // Add member form
  const [newMatrixId, setNewMatrixId] = useState('');
  const [newAccess, setNewAccess] = useState<AccessLevel>('read');
  const [addError, setAddError] = useState('');
  const [addSuccess, setAddSuccess] = useState('');

  // Dropdown state
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSpace();
  }, [spaceTarget]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  async function loadSpace() {
    setLoading(true);
    const state = await getState(spaceTarget);
    setSpaceState(state);
    if (state) {
      setOwner(state.last_agent);
      setMembers(state.value?._sharing || []);
    }
    setLoading(false);
  }

  const currentUserAccess = getAccessLevel(currentUserId);

  function getAccessLevel(userId: string): AccessLevel | 'owner' {
    if (userId === owner) return 'owner';
    const entry = members.find((m) => m.user_id === userId);
    return entry?.access || 'read';
  }

  function canManageMembers(): boolean {
    return currentUserId === owner || currentUserAccess === 'admin';
  }

  function formatUserId(userId: string): string {
    if (userId.startsWith('@')) {
      return userId.slice(1).split(':')[0];
    }
    return userId;
  }

  function formatHomeserver(userId: string): string {
    if (userId.includes(':')) {
      return userId.split(':')[1];
    }
    return '';
  }

  function avatarColor(userId: string): string {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = userId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colors = [theme.accent, theme.purple, theme.teal, theme.gold, theme.warning, theme.danger];
    return colors[((hash % colors.length) + colors.length) % colors.length];
  }

  async function handleAddMember() {
    setAddError('');
    setAddSuccess('');
    const targetId = newMatrixId.trim();

    if (!targetId.match(/^@[^:]+:.+$/)) {
      setAddError('Enter a valid Matrix ID (e.g. @user:server.com)');
      return;
    }
    if (targetId === currentUserId) {
      setAddError('Cannot add yourself');
      return;
    }
    if (targetId === owner) {
      setAddError('User is already the owner');
      return;
    }
    if (members.some((m) => m.user_id === targetId)) {
      setAddError('User already has access');
      return;
    }

    const newEntry: ShareEntry = {
      user_id: targetId,
      access: newAccess,
      added_by: currentUserId,
      added_at: new Date().toISOString(),
    };

    const updatedSharing = [...members, newEntry];

    try {
      await dispatch({
        op: 'DEF',
        target: spaceTarget,
        operand: { _sharing: updatedSharing },
        agent: currentUserId,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setMembers(updatedSharing);
      setNewMatrixId('');
      setAddSuccess(`${formatUserId(targetId)} added`);
      setTimeout(() => setAddSuccess(''), 3000);
    } catch (e: any) {
      setAddError('Failed: ' + e.message);
    }
  }

  async function handleChangeAccess(userId: string, newLevel: AccessLevel) {
    const updated = members.map((m) =>
      m.user_id === userId ? { ...m, access: newLevel } : m
    );

    try {
      await dispatch({
        op: 'DEF',
        target: spaceTarget,
        operand: { _sharing: updated },
        agent: currentUserId,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setMembers(updated);
      setOpenDropdown(null);
    } catch (e: any) {
      setAddError('Failed to update: ' + e.message);
    }
  }

  async function handleRemoveMember(userId: string) {
    const updated = members.filter((m) => m.user_id !== userId);

    try {
      await dispatch({
        op: 'DEF',
        target: spaceTarget,
        operand: { _sharing: updated },
        agent: currentUserId,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setMembers(updated);
      setOpenDropdown(null);
    } catch (e: any) {
      setAddError('Failed to remove: ' + e.message);
    }
  }

  const spaceName = spaceState?.value?.name || formatSpaceName(spaceTarget.split('.').pop() || '');

  if (loading) {
    return (
      <div style={s.container}>
        <div style={s.header}>
          <span style={s.headerTitle}>Loading...</span>
          <button style={s.closeBtn} onClick={onClose}>&times;</button>
        </div>
      </div>
    );
  }

  const totalPeople = members.length + 1; // +1 for owner

  return (
    <div style={s.container} ref={dropdownRef}>
      {/* Header */}
      <div style={s.header}>
        <div style={s.headerTitle}>Share "{spaceName}"</div>
        <button style={s.closeBtn} onClick={onClose}>&times;</button>
      </div>

      {/* Invite bar */}
      {canManageMembers() && (
        <div style={s.inviteSection}>
          <div style={s.inviteRow}>
            <input
              style={s.inviteInput}
              value={newMatrixId}
              onChange={(e) => { setNewMatrixId(e.target.value); setAddError(''); }}
              placeholder="Add people by Matrix ID..."
              onKeyDown={(e) => e.key === 'Enter' && handleAddMember()}
            />
            <RolePicker
              theme={theme}
              value={newAccess}
              onChange={setNewAccess}
              compact
            />
            <button
              style={{
                ...s.inviteBtn,
                opacity: newMatrixId.trim() ? 1 : 0.5,
              }}
              onClick={handleAddMember}
            >
              Invite
            </button>
          </div>
          {addError && <div style={s.errorMsg}>{addError}</div>}
          {addSuccess && <div style={s.successMsg}>{addSuccess}</div>}
        </div>
      )}

      {/* People with access */}
      <div style={s.peopleSection}>
        <div style={s.peopleSectionHeader}>
          People with access
          <span style={s.peopleCount}>{totalPeople}</span>
        </div>

        {/* Owner row */}
        <PersonRow
          theme={theme}
          name={formatUserId(owner)}
          server={formatHomeserver(owner)}
          color={avatarColor(owner)}
          role="Owner"
          isYou={owner === currentUserId}
        />

        {/* Member rows */}
        {members.map((m) => {
          const isOpen = openDropdown === m.user_id;
          return (
            <PersonRow
              key={m.user_id}
              theme={theme}
              name={formatUserId(m.user_id)}
              server={formatHomeserver(m.user_id)}
              color={avatarColor(m.user_id)}
              role={ROLE_LABELS[m.access]}
              isYou={m.user_id === currentUserId}
              canManage={canManageMembers()}
              isOpen={isOpen}
              onToggle={() => setOpenDropdown(isOpen ? null : m.user_id)}
              onChangeAccess={(level) => handleChangeAccess(m.user_id, level)}
              onRemove={() => handleRemoveMember(m.user_id)}
              currentAccess={m.access}
            />
          );
        })}
      </div>
    </div>
  );
}

/* ---- Role picker for the invite bar ---- */

function RolePicker({
  theme,
  value,
  onChange,
  compact,
}: {
  theme: Theme;
  value: AccessLevel;
  onChange: (v: AccessLevel) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const mono = "'JetBrains Mono', monospace";

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          fontFamily: mono,
          fontSize: 11,
          color: theme.textSecondary,
          background: theme.bgMuted,
          border: `1px solid ${theme.border}`,
          borderRadius: 6,
          padding: '6px 10px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          whiteSpace: 'nowrap' as const,
        }}
      >
        {ROLE_LABELS[value]}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2.5 4L5 6.5L7.5 4" stroke={theme.textMuted} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: 4,
          background: theme.bgCard,
          border: `1px solid ${theme.border}`,
          borderRadius: 8,
          boxShadow: `0 8px 24px ${theme.shadow}`,
          minWidth: 180,
          zIndex: 100,
          overflow: 'hidden',
          padding: '4px 0',
        }}>
          {ROLE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { onChange(opt.value); setOpen(false); }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left' as const,
                padding: '8px 12px',
                background: opt.value === value ? theme.accentBg : 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: mono,
              }}
              onMouseEnter={(e) => {
                if (opt.value !== value) e.currentTarget.style.background = theme.bgHover;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = opt.value === value ? theme.accentBg : 'transparent';
              }}
            >
              <div style={{
                fontSize: 11,
                fontWeight: 500,
                color: opt.value === value ? theme.accent : theme.text,
              }}>{opt.label}</div>
              <div style={{
                fontSize: 9,
                color: theme.textMuted,
                marginTop: 1,
              }}>{opt.desc}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- Person row ---- */

function PersonRow({
  theme,
  name,
  server,
  color,
  role,
  isYou,
  canManage,
  isOpen,
  onToggle,
  onChangeAccess,
  onRemove,
  currentAccess,
}: {
  theme: Theme;
  name: string;
  server: string;
  color: string;
  role: string;
  isYou?: boolean;
  canManage?: boolean;
  isOpen?: boolean;
  onToggle?: () => void;
  onChangeAccess?: (level: AccessLevel) => void;
  onRemove?: () => void;
  currentAccess?: AccessLevel;
}) {
  const mono = "'JetBrains Mono', monospace";

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 0',
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        {/* Avatar */}
        <div style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: `${color}18`,
          color: color,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: mono,
          fontSize: 13,
          fontWeight: 600,
          flexShrink: 0,
        }}>
          {name.charAt(0).toUpperCase()}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontFamily: mono,
            fontSize: 12,
            fontWeight: 500,
            color: theme.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap' as const,
          }}>
            {name}{isYou && <span style={{ color: theme.textMuted, fontWeight: 400 }}> (you)</span>}
          </div>
          {server && (
            <div style={{
              fontFamily: mono,
              fontSize: 10,
              color: theme.textMuted,
            }}>
              {server}
            </div>
          )}
        </div>
      </div>

      {/* Role button / dropdown */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        {canManage && onToggle ? (
          <button
            onClick={onToggle}
            style={{
              fontFamily: mono,
              fontSize: 11,
              color: theme.textSecondary,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '4px 8px',
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = theme.bgHover}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            {role}
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2.5 4L5 6.5L7.5 4" stroke={theme.textMuted} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        ) : (
          <span style={{
            fontFamily: mono,
            fontSize: 11,
            color: theme.textMuted,
            padding: '4px 8px',
          }}>
            {role}
          </span>
        )}

        {/* Dropdown */}
        {isOpen && onChangeAccess && onRemove && (
          <div style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            background: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: 8,
            boxShadow: `0 8px 24px ${theme.shadow}`,
            minWidth: 180,
            zIndex: 100,
            overflow: 'hidden',
            padding: '4px 0',
          }}>
            {ROLE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onChangeAccess(opt.value)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left' as const,
                  padding: '8px 12px',
                  background: opt.value === currentAccess ? theme.accentBg : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: mono,
                }}
                onMouseEnter={(e) => {
                  if (opt.value !== currentAccess) e.currentTarget.style.background = theme.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = opt.value === currentAccess ? theme.accentBg : 'transparent';
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{
                      fontSize: 11,
                      fontWeight: 500,
                      color: opt.value === currentAccess ? theme.accent : theme.text,
                    }}>{opt.label}</div>
                    <div style={{
                      fontSize: 9,
                      color: theme.textMuted,
                      marginTop: 1,
                    }}>{opt.desc}</div>
                  </div>
                  {opt.value === currentAccess && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M3 7.5L5.5 10L11 4" stroke={theme.accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
              </button>
            ))}

            <div style={{
              height: 1,
              background: theme.border,
              margin: '4px 0',
            }} />

            <button
              onClick={onRemove}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left' as const,
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: mono,
                fontSize: 11,
                fontWeight: 500,
                color: theme.danger,
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = theme.dangerBg}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            >
              Remove access
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function formatSpaceName(segment: string): string {
  let name = segment.replace(/^space_/, '');
  name = name.replace(/_/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function styles(t: Theme): Record<string, React.CSSProperties> {
  const mono = "'JetBrains Mono', monospace";
  return {
    container: {
      display: 'flex',
      flexDirection: 'column' as const,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 12,
      overflow: 'visible',
      maxHeight: 560,
      boxShadow: `0 12px 40px ${t.shadow}`,
    },
    header: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '18px 20px 14px',
      borderBottom: `1px solid ${t.border}`,
    },
    headerTitle: {
      fontFamily: mono,
      fontSize: 14,
      fontWeight: 600,
      color: t.text,
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      color: t.textMuted,
      fontSize: 18,
      cursor: 'pointer',
      padding: '0 2px',
      fontFamily: mono,
      borderRadius: 4,
    },

    inviteSection: {
      padding: '14px 20px',
      borderBottom: `1px solid ${t.border}`,
    },
    inviteRow: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
    },
    inviteInput: {
      flex: 1,
      padding: '8px 12px',
      background: t.bg,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      color: t.text,
      fontFamily: mono,
      fontSize: 11,
      outline: 'none',
    },
    inviteBtn: {
      padding: '8px 16px',
      background: t.accent,
      color: '#fff',
      border: 'none',
      borderRadius: 8,
      fontFamily: mono,
      fontSize: 11,
      fontWeight: 600,
      cursor: 'pointer',
      whiteSpace: 'nowrap' as const,
    },
    errorMsg: {
      fontFamily: mono,
      fontSize: 10,
      color: t.danger,
      marginTop: 6,
    },
    successMsg: {
      fontFamily: mono,
      fontSize: 10,
      color: t.success,
      marginTop: 6,
    },

    peopleSection: {
      padding: '14px 20px 16px',
      overflowY: 'auto' as const,
    },
    peopleSectionHeader: {
      fontFamily: mono,
      fontSize: 11,
      fontWeight: 600,
      color: t.textSecondary,
      marginBottom: 8,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
    peopleCount: {
      fontFamily: mono,
      fontSize: 10,
      fontWeight: 500,
      color: t.textMuted,
      background: t.bgMuted,
      padding: '1px 6px',
      borderRadius: 10,
    },
  };
}
