import { useState, useEffect } from 'react';
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

const ACCESS_LABELS: Record<AccessLevel, string> = {
  read: 'Read',
  write: 'Write',
  admin: 'Admin',
};

const ACCESS_DESC: Record<AccessLevel, string> = {
  read: 'Can view data',
  write: 'Can view and edit data',
  admin: 'Full access, can manage members',
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

  // Load space state
  useEffect(() => {
    loadSpace();
  }, [spaceTarget]);

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
      setAddSuccess(`Added ${formatUserId(targetId)}`);
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

  return (
    <div style={s.container}>
      {/* Header */}
      <div style={s.header}>
        <div>
          <div style={s.headerTitle}>Members &middot; {spaceName}</div>
          <div style={s.headerSub}>{spaceTarget}</div>
        </div>
        <button style={s.closeBtn} onClick={onClose}>&times;</button>
      </div>

      {/* Owner */}
      <div style={s.section}>
        <div style={s.sectionLabel}>OWNER</div>
        <div style={s.memberRow}>
          <div style={s.memberInfo}>
            <div style={s.memberAvatar}>{formatUserId(owner).charAt(0).toUpperCase()}</div>
            <div>
              <div style={s.memberName}>{formatUserId(owner)}</div>
              <div style={s.memberServer}>{formatHomeserver(owner)}</div>
            </div>
          </div>
          <div style={s.ownerBadge}>Owner</div>
        </div>
      </div>

      {/* Members list */}
      <div style={s.section}>
        <div style={s.sectionLabel}>
          MEMBERS ({members.length})
        </div>
        {members.length === 0 && (
          <div style={s.emptyMsg}>No members yet. Add someone by their Matrix ID.</div>
        )}
        {members.map((m) => (
          <div key={m.user_id} style={s.memberRow}>
            <div style={s.memberInfo}>
              <div style={s.memberAvatar}>{formatUserId(m.user_id).charAt(0).toUpperCase()}</div>
              <div>
                <div style={s.memberName}>{formatUserId(m.user_id)}</div>
                <div style={s.memberServer}>{formatHomeserver(m.user_id)}</div>
              </div>
            </div>
            <div style={s.memberActions}>
              {canManageMembers() ? (
                <>
                  <select
                    style={s.accessSelect}
                    value={m.access}
                    onChange={(e) => handleChangeAccess(m.user_id, e.target.value as AccessLevel)}
                  >
                    <option value="read">Read</option>
                    <option value="write">Write</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button
                    style={s.removeBtn}
                    onClick={() => handleRemoveMember(m.user_id)}
                    title="Remove member"
                  >
                    &times;
                  </button>
                </>
              ) : (
                <span style={s.accessBadge}>{ACCESS_LABELS[m.access]}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Add member */}
      {canManageMembers() && (
        <div style={s.section}>
          <div style={s.sectionLabel}>ADD MEMBER</div>
          <div style={s.addRow}>
            <input
              style={s.input}
              value={newMatrixId}
              onChange={(e) => setNewMatrixId(e.target.value)}
              placeholder="@user:homeserver.com"
              onKeyDown={(e) => e.key === 'Enter' && handleAddMember()}
            />
            <select
              style={s.accessSelect}
              value={newAccess}
              onChange={(e) => setNewAccess(e.target.value as AccessLevel)}
            >
              <option value="read">Read</option>
              <option value="write">Write</option>
              <option value="admin">Admin</option>
            </select>
            <button style={s.addBtn} onClick={handleAddMember}>
              Add
            </button>
          </div>
          <div style={s.accessHint}>{ACCESS_DESC[newAccess]}</div>
          {addError && <div style={{ ...s.feedback, color: theme.danger }}>{addError}</div>}
          {addSuccess && <div style={{ ...s.feedback, color: theme.success }}>{addSuccess}</div>}
        </div>
      )}
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
      borderRadius: 8,
      overflow: 'hidden',
      maxHeight: 520,
    },
    header: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      padding: '14px 16px 10px',
      borderBottom: `1px solid ${t.border}`,
    },
    headerTitle: {
      fontFamily: mono,
      fontSize: 13,
      fontWeight: 600,
      color: t.text,
    },
    headerSub: {
      fontFamily: mono,
      fontSize: 10,
      color: t.textMuted,
      marginTop: 2,
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      color: t.textMuted,
      fontSize: 18,
      cursor: 'pointer',
      padding: '0 2px',
      fontFamily: mono,
    },

    section: {
      padding: '10px 16px',
      borderBottom: `1px solid ${t.border}`,
    },
    sectionLabel: {
      fontFamily: mono,
      fontSize: 9,
      fontWeight: 700,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.08em',
      color: t.textMuted,
      marginBottom: 8,
    },

    memberRow: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '6px 0',
    },
    memberInfo: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
    },
    memberAvatar: {
      width: 28,
      height: 28,
      borderRadius: '50%',
      background: t.accentBg,
      color: t.accent,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: mono,
      fontSize: 12,
      fontWeight: 600,
      flexShrink: 0,
    },
    memberName: {
      fontFamily: mono,
      fontSize: 12,
      color: t.text,
      fontWeight: 500,
    },
    memberServer: {
      fontFamily: mono,
      fontSize: 10,
      color: t.textMuted,
    },
    memberActions: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },

    ownerBadge: {
      fontFamily: mono,
      fontSize: 10,
      fontWeight: 600,
      color: t.accent,
      background: t.accentBg,
      padding: '2px 8px',
      borderRadius: 4,
    },
    accessBadge: {
      fontFamily: mono,
      fontSize: 10,
      color: t.textSecondary,
      background: t.bgMuted,
      padding: '2px 8px',
      borderRadius: 4,
    },
    accessSelect: {
      fontFamily: mono,
      fontSize: 10,
      color: t.text,
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      padding: '3px 6px',
      cursor: 'pointer',
      outline: 'none',
    },
    removeBtn: {
      background: 'none',
      border: 'none',
      color: t.textMuted,
      fontSize: 16,
      cursor: 'pointer',
      padding: '0 4px',
      fontFamily: mono,
      lineHeight: 1,
    },

    addRow: {
      display: 'flex',
      gap: 6,
      alignItems: 'center',
    },
    input: {
      flex: 1,
      padding: '6px 8px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      color: t.text,
      fontFamily: mono,
      fontSize: 11,
      outline: 'none',
    },
    addBtn: {
      padding: '6px 12px',
      background: t.accent,
      color: '#fff',
      border: 'none',
      borderRadius: 4,
      fontFamily: mono,
      fontSize: 10,
      fontWeight: 600,
      cursor: 'pointer',
    },
    accessHint: {
      fontFamily: mono,
      fontSize: 9,
      color: t.textMuted,
      marginTop: 4,
    },
    feedback: {
      fontFamily: mono,
      fontSize: 10,
      marginTop: 4,
    },
    emptyMsg: {
      fontFamily: mono,
      fontSize: 11,
      color: t.textMuted,
      padding: '8px 0',
    },
  };
}
