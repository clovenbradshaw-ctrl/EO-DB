import { useState, useEffect, useRef } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { EoState } from '../db/types';
import {
  type AccessRole,
  type FieldAssignment,
  type UserTypeDefinition,
  type UserTypeAssignment,
  type FieldTypeVisibility,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  ROLE_POWER_LEVELS,
  powerLevelToRole,
} from '../permissions/types';
import { resolvePermissionsFromSharing } from '../permissions/resolve';
import { FieldPermissions } from './FieldPermissions';
import { SpaceInvite } from './SpaceInvite';
import { inviteToRoom } from '../permissions/room-topology';
import { UserTypeManager } from './UserTypeManager';
import { UserTypeBadge } from './UserTypeBadge';

interface ShareEntry {
  user_id: string;
  access: Exclude<AccessRole, 'owner'>;
  added_by: string;
  added_at: string;
}

interface SpaceMembersProps {
  spaceTarget: string;
  currentUserId: string;
  onClose: () => void;
  /** Matrix client for user discovery and room invitations */
  matrixClient?: MatrixClient | null;
  /** The main Matrix room ID for this space (used for room-level invites) */
  mainRoomId?: string | null;
}

/** All non-owner roles available in the role picker. */
const ROLE_OPTIONS_5: { value: Exclude<AccessRole, 'owner'>; label: string; desc: string; pl: number }[] = [
  { value: 'admin',   label: 'Full access', desc: 'Manage people (PL 50)', pl: 50 },
  { value: 'editor',  label: 'Can edit',    desc: 'Edit any record (PL 25)', pl: 25 },
  { value: 'creator', label: 'Can add',     desc: 'Add & edit own (PL 10)', pl: 10 },
  { value: 'viewer',  label: 'Can view',    desc: 'View data only (PL 0)', pl: 0 },
];

export function SpaceMembers({ spaceTarget, currentUserId, onClose, matrixClient, mainRoomId }: SpaceMembersProps) {
  const { theme } = useTheme();
  const s = styles(theme);
  const dispatch = useEoStore((st) => st.dispatch);
  const getState = useEoStore((st) => st.getState);
  const getStateByPrefix = useEoStore((st) => st.getStateByPrefix);

  const [spaceState, setSpaceState] = useState<EoState | null>(null);
  const [members, setMembers] = useState<ShareEntry[]>([]);
  const [owner, setOwner] = useState<string>('');
  const [loading, setLoading] = useState(true);

  // Add member form
  const [newMatrixId, setNewMatrixId] = useState('');
  const [newAccess, setNewAccess] = useState<Exclude<AccessRole, 'owner'>>('viewer');
  /** Persona IDs to tag the invited user with on invite. */
  const [inviteTypeIds, setInviteTypeIds] = useState<string[]>([]);
  const [addError, setAddError] = useState('');
  const [addSuccess, setAddSuccess] = useState('');
  const [inviting, setInviting] = useState(false);

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

    // Derive available fields from schema states under this space.
    // Schema fields are stored at {spaceTarget}.{scope}._schema.{fieldKey}
    // We collect all direct field-key targets (no further sub-paths).
    const schemaMarker = '._schema.';
    const allSpaceStates = await getStateByPrefix(spaceTarget + '.');
    const fieldKeySet = new Set<string>();
    for (const s of allSpaceStates) {
      const idx = s.target.indexOf(schemaMarker);
      if (idx === -1) continue;
      const remainder = s.target.slice(idx + schemaMarker.length);
      // Only direct field entries — skip sub-paths like .type, .constraint.*, .resolve
      if (remainder && !remainder.includes('.')) {
        fieldKeySet.add(remainder);
      }
    }
    if (fieldKeySet.size > 0) {
      setAvailableFields([...fieldKeySet].sort());
    }

    setLoading(false);
  }

  // Field assignments state (stored in space value)
  const [fieldAssignments, setFieldAssignments] = useState<FieldAssignment[]>([]);
  const [availableFields, setAvailableFields] = useState<string[]>([]);

  // User type state
  const [userTypeDefinitions, setUserTypeDefinitions] = useState<UserTypeDefinition[]>([]);
  const [userTypeAssignments, setUserTypeAssignments] = useState<UserTypeAssignment[]>([]);
  const [fieldTypeVisibility, setFieldTypeVisibility] = useState<FieldTypeVisibility[]>([]);

  const currentUserRole = getCurrentUserRole();
  const currentPermissions = resolvePermissionsFromSharing(
    currentUserId,
    owner,
    members,
    fieldAssignments,
    userTypeAssignments,
    fieldTypeVisibility,
    null,
    userTypeDefinitions,
  );

  // Load field assignments and user types from space state
  useEffect(() => {
    if (spaceState?.value?._field_assignments) {
      setFieldAssignments(spaceState.value._field_assignments);
    }
    if (spaceState?.value?._user_type_definitions) {
      setUserTypeDefinitions(spaceState.value._user_type_definitions);
    }
    if (spaceState?.value?._user_type_assignments) {
      setUserTypeAssignments(spaceState.value._user_type_assignments);
    }
    if (spaceState?.value?._field_type_visibility) {
      setFieldTypeVisibility(spaceState.value._field_type_visibility);
    }
  }, [spaceState]);

  function getCurrentUserRole(): AccessRole {
    if (currentUserId === owner) return 'owner';
    const entry = members.find(m => m.user_id === currentUserId);
    return entry?.access ?? 'viewer';
  }

  function getUserRole(userId: string): AccessRole {
    if (userId === owner) return 'owner';
    const entry = members.find(m => m.user_id === userId);
    return entry?.access ?? 'viewer';
  }

  function canManageMembers(): boolean {
    return currentPermissions.can_manage_members;
  }

  async function handleUpdateFieldAssignments(updated: FieldAssignment[]) {
    try {
      await dispatch({
        op: 'DEF',
        target: spaceTarget,
        operand: { _field_assignments: updated },
        agent: currentUserId,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setFieldAssignments(updated);
    } catch (e: any) {
      setAddError('Failed to update field permissions: ' + e.message);
    }
  }

  async function handleUpdateUserTypeDefinitions(updated: UserTypeDefinition[]) {
    try {
      // When deleting types, also clean up assignments and field visibility
      const removedIds = userTypeDefinitions
        .filter(t => !updated.some(u => u.id === t.id))
        .map(t => t.id);

      let cleanedAssignments = userTypeAssignments;
      let cleanedVisibility = fieldTypeVisibility;

      if (removedIds.length > 0) {
        cleanedAssignments = userTypeAssignments.map(a => ({
          ...a,
          type_ids: a.type_ids.filter(id => !removedIds.includes(id)),
        })).filter(a => a.type_ids.length > 0);

        cleanedVisibility = fieldTypeVisibility.map(fv => ({
          ...fv,
          visible_to_types: fv.visible_to_types.filter(id => !removedIds.includes(id)),
        })).filter(fv => fv.visible_to_types.length > 0);
      }

      await dispatch({
        op: 'DEF',
        target: spaceTarget,
        operand: {
          _user_type_definitions: updated,
          ...(removedIds.length > 0 ? {
            _user_type_assignments: cleanedAssignments,
            _field_type_visibility: cleanedVisibility,
          } : {}),
        },
        agent: currentUserId,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setUserTypeDefinitions(updated);
      if (removedIds.length > 0) {
        setUserTypeAssignments(cleanedAssignments);
        setFieldTypeVisibility(cleanedVisibility);
      }
    } catch (e: any) {
      setAddError('Failed to update user types: ' + e.message);
    }
  }

  async function handleUpdateUserTypeAssignment(userId: string, typeIds: string[]) {
    const existing = userTypeAssignments.find(a => a.user_id === userId);
    let updated: UserTypeAssignment[];
    if (typeIds.length === 0) {
      updated = userTypeAssignments.filter(a => a.user_id !== userId);
    } else if (existing) {
      updated = userTypeAssignments.map(a =>
        a.user_id === userId ? { ...a, type_ids: typeIds } : a
      );
    } else {
      updated = [...userTypeAssignments, { user_id: userId, type_ids: typeIds }];
    }
    try {
      await dispatch({
        op: 'DEF',
        target: spaceTarget,
        operand: { _user_type_assignments: updated },
        agent: currentUserId,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setUserTypeAssignments(updated);
    } catch (e: any) {
      setAddError('Failed to update type assignment: ' + e.message);
    }
  }

  function getUserTypeIds(userId: string): string[] {
    return userTypeAssignments.find(a => a.user_id === userId)?.type_ids ?? [];
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

    await addMemberById(targetId, newAccess, inviteTypeIds);
  }

  /**
   * Add a member by Matrix user ID — dispatches EO sharing, persona
   * assignment (if `typeIds` is non-empty), and a Matrix room invite.
   *
   * The sharing update and persona assignment are written to the same DEF
   * event so the invited user shows up with their persona tags immediately.
   */
  async function addMemberById(
    targetId: string,
    access: Exclude<AccessRole, 'owner'> = newAccess,
    typeIds: string[] = inviteTypeIds,
  ) {
    setAddError('');
    setAddSuccess('');
    setInviting(true);

    const newEntry: ShareEntry = {
      user_id: targetId,
      access,
      added_by: currentUserId,
      added_at: new Date().toISOString(),
    };

    const updatedSharing = [...members, newEntry];

    // Build next persona-assignment state if caller specified any tags.
    const trimmedTypeIds = typeIds.filter((id) => userTypeDefinitions.some((d) => d.id === id));
    const willAssignPersonas = trimmedTypeIds.length > 0;
    const updatedAssignments: UserTypeAssignment[] = willAssignPersonas
      ? (() => {
          const existing = userTypeAssignments.find((a) => a.user_id === targetId);
          if (existing) {
            const merged = Array.from(new Set([...existing.type_ids, ...trimmedTypeIds]));
            return userTypeAssignments.map((a) =>
              a.user_id === targetId ? { ...a, type_ids: merged } : a,
            );
          }
          return [...userTypeAssignments, { user_id: targetId, type_ids: trimmedTypeIds }];
        })()
      : userTypeAssignments;

    try {
      // 1. Update the EO sharing list (and persona assignments together if needed)
      await dispatch({
        op: 'DEF',
        target: spaceTarget,
        operand: {
          _sharing: updatedSharing,
          ...(willAssignPersonas ? { _user_type_assignments: updatedAssignments } : {}),
        },
        agent: currentUserId,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setMembers(updatedSharing);
      if (willAssignPersonas) setUserTypeAssignments(updatedAssignments);

      // 2. Send a Matrix room invitation so the user discovers the space
      if (matrixClient && mainRoomId) {
        try {
          await inviteToRoom(matrixClient, mainRoomId, targetId);
        } catch (matrixErr: any) {
          // Non-fatal: the EO sharing entry is already saved.
          // Common case: user is already in the room, or invite PL insufficient.
          console.warn('[EO-DB] Matrix invite failed (sharing saved):', matrixErr.message || matrixErr);
        }
      }

      setNewMatrixId('');
      const personaNote = willAssignPersonas
        ? ` as ${trimmedTypeIds
            .map((id) => userTypeDefinitions.find((d) => d.id === id)?.label ?? id)
            .join(', ')}`
        : '';
      setAddSuccess(`${formatUserId(targetId)} invited${personaNote}`);
      setTimeout(() => setAddSuccess(''), 3000);
    } catch (e: any) {
      setAddError('Failed: ' + e.message);
    } finally {
      setInviting(false);
    }
  }

  async function handleChangeAccess(userId: string, newRole: Exclude<AccessRole, 'owner'>) {
    const updated = members.map((m) =>
      m.user_id === userId ? { ...m, access: newRole } : m
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

      <div style={s.body}>
      {/* Invite bar */}
      {canManageMembers() && (
        <div style={s.inviteSection}>
          <div style={s.inviteRow}>
            {matrixClient ? (
              <SpaceInvite
                matrixClient={matrixClient}
                existingMemberIds={[owner, ...members.map((m) => m.user_id)]}
                onInvite={(userId) => addMemberById(userId, newAccess, inviteTypeIds)}
                inviting={inviting}
              />
            ) : (
              <input
                style={s.inviteInput}
                value={newMatrixId}
                onChange={(e) => { setNewMatrixId(e.target.value); setAddError(''); }}
                placeholder="Add people by Matrix ID..."
                onKeyDown={(e) => e.key === 'Enter' && handleAddMember()}
              />
            )}
            <RolePicker
              theme={theme}
              value={newAccess}
              onChange={setNewAccess}
              compact
            />
            {userTypeDefinitions.length > 0 && (
              <PersonaPicker
                theme={theme}
                typeDefinitions={userTypeDefinitions}
                selected={inviteTypeIds}
                onChange={setInviteTypeIds}
              />
            )}
            {!matrixClient && (
              <button
                style={{
                  ...s.inviteBtn,
                  opacity: newMatrixId.trim() ? 1 : 0.5,
                }}
                onClick={handleAddMember}
              >
                Invite
              </button>
            )}
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
          userTypeIds={getUserTypeIds(owner)}
          userTypeDefinitions={userTypeDefinitions}
        />

        {/* Member rows */}
        {members.map((m) => {
          const isOpen = openDropdown === m.user_id;
          const memberRole = getUserRole(m.user_id);
          return (
            <PersonRow
              key={m.user_id}
              theme={theme}
              name={formatUserId(m.user_id)}
              server={formatHomeserver(m.user_id)}
              color={avatarColor(m.user_id)}
              role={ROLE_LABELS[memberRole]}
              isYou={m.user_id === currentUserId}
              canManage={canManageMembers()}
              isOpen={isOpen}
              onToggle={() => setOpenDropdown(isOpen ? null : m.user_id)}
              onChangeAccess={(level) => handleChangeAccess(m.user_id, level)}
              onRemove={() => handleRemoveMember(m.user_id)}
              currentAccess={m.access}
              userTypeIds={getUserTypeIds(m.user_id)}
              userTypeDefinitions={userTypeDefinitions}
              onChangeTypes={(typeIds) => handleUpdateUserTypeAssignment(m.user_id, typeIds)}
            />
          );
        })}
      </div>

      {/* Field permissions section */}
      <div style={{ padding: '0 20px 16px' }}>
        <FieldPermissions
          fieldAssignments={fieldAssignments}
          availableFields={availableFields}
          onUpdate={handleUpdateFieldAssignments}
          canManage={currentPermissions.can_set_governance}
          userTypeDefinitions={userTypeDefinitions}
          fieldTypeVisibility={fieldTypeVisibility}
          onUpdateFieldTypeVisibility={async (updated) => {
            try {
              await dispatch({
                op: 'DEF',
                target: spaceTarget,
                operand: { _field_type_visibility: updated },
                agent: currentUserId,
                ts: new Date().toISOString(),
                acquired_ts: new Date().toISOString(),
              });
              setFieldTypeVisibility(updated);
            } catch (e: any) {
              setAddError('Failed to update field type visibility: ' + e.message);
            }
          }}
        />
      </div>

      {/* User type management section */}
      <div style={{ padding: '0 20px 16px' }}>
        <UserTypeManager
          typeDefinitions={userTypeDefinitions}
          availableFields={availableFields}
          onUpdate={handleUpdateUserTypeDefinitions}
          canManage={currentPermissions.can_set_governance}
          members={[
            { user_id: owner, roleLabel: 'Owner' },
            ...members.map((m) => ({
              user_id: m.user_id,
              roleLabel: ROLE_LABELS[m.access],
            })),
          ]}
          userTypeAssignments={userTypeAssignments}
          onUpdateAssignment={handleUpdateUserTypeAssignment}
        />
      </div>
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
  value: Exclude<AccessRole, 'owner'>;
  onChange: (v: Exclude<AccessRole, 'owner'>) => void;
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
          minWidth: 200,
          zIndex: 100,
          overflow: 'hidden',
          padding: '4px 0',
        }}>
          {ROLE_OPTIONS_5.map((opt) => (
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

/* ---- Persona picker for the invite bar ----
 *
 * Lets the admin tag the invited user with one or more personas at
 * invite time. Stores a selected persona-ID list; selecting none is a
 * valid choice (no persona tagging). */

function PersonaPicker({
  theme,
  typeDefinitions,
  selected,
  onChange,
}: {
  theme: Theme;
  typeDefinitions: UserTypeDefinition[];
  selected: string[];
  onChange: (ids: string[]) => void;
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

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  }

  const selectedDefs = selected
    .map((id) => typeDefinitions.find((d) => d.id === id))
    .filter((d): d is UserTypeDefinition => d != null);

  const label = selectedDefs.length === 0
    ? 'No persona'
    : selectedDefs.length === 1
    ? selectedDefs[0].label
    : `${selectedDefs.length} personas`;

  const anchorColor = selectedDefs.length === 1 ? selectedDefs[0].color : null;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        title="Tag the invited user with one or more personas"
        style={{
          fontFamily: mono,
          fontSize: 11,
          color: anchorColor || theme.textSecondary,
          background: anchorColor ? `${anchorColor}14` : theme.bgMuted,
          border: `1px solid ${anchorColor ? `${anchorColor}30` : theme.border}`,
          borderRadius: 6,
          padding: '6px 10px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          whiteSpace: 'nowrap' as const,
        }}
      >
        {anchorColor && (
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: anchorColor, flexShrink: 0,
          }} />
        )}
        {label}
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
          minWidth: 220,
          zIndex: 100,
          overflow: 'hidden',
          padding: '4px 0',
        }}>
          <div style={{
            fontFamily: mono, fontSize: 9, fontWeight: 600,
            color: theme.textMuted, padding: '6px 12px 4px',
            textTransform: 'uppercase' as const, letterSpacing: 0.5,
          }}>
            Tag invited user as
          </div>
          {typeDefinitions.map((def) => {
            const isSelected = selected.includes(def.id);
            return (
              <label
                key={def.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 12px', cursor: 'pointer',
                  background: isSelected ? (def.color ? `${def.color}14` : theme.accentBg) : 'transparent',
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.background = theme.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isSelected ? (def.color ? `${def.color}14` : theme.accentBg) : 'transparent';
                }}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggle(def.id)}
                  style={{ accentColor: def.color || theme.accent, width: 12, height: 12, flexShrink: 0 }}
                />
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: def.color || '#6b7280', flexShrink: 0,
                }} />
                <span style={{
                  fontFamily: mono, fontSize: 11,
                  color: isSelected ? (def.color || theme.accent) : theme.text,
                  fontWeight: isSelected ? 600 : 500,
                }}>
                  {def.label}
                </span>
              </label>
            );
          })}
          {selected.length > 0 && (
            <button
              onClick={() => { onChange([]); }}
              style={{
                fontFamily: mono, fontSize: 10,
                color: theme.textMuted,
                background: 'none', border: 'none',
                borderTop: `1px solid ${theme.border}`,
                cursor: 'pointer',
                padding: '6px 12px', width: '100%',
                textAlign: 'left' as const,
              }}
            >
              Clear selection
            </button>
          )}
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
  userTypeIds,
  userTypeDefinitions,
  onChangeTypes,
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
  onChangeAccess?: (role: Exclude<AccessRole, 'owner'>) => void;
  onRemove?: () => void;
  currentAccess?: Exclude<AccessRole, 'owner'>;
  userTypeIds?: string[];
  userTypeDefinitions?: UserTypeDefinition[];
  onChangeTypes?: (typeIds: string[]) => void;
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
          {/* User type badges */}
          {userTypeIds && userTypeIds.length > 0 && userTypeDefinitions && (
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' as const, marginTop: 2 }}>
              {userTypeIds.map(typeId => {
                const def = userTypeDefinitions.find(d => d.id === typeId);
                if (!def) return null;
                const capHint = def.base_role ? ` · ${ROLE_LABELS[def.base_role]}` : '';
                return (
                  <UserTypeBadge
                    key={typeId}
                    label={def.label + capHint}
                    color={def.color}
                    compact
                  />
                );
              })}
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

        {/* Dropdown — 5-role picker with power levels */}
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
            minWidth: 220,
            zIndex: 100,
            overflow: 'hidden',
            padding: '4px 0',
          }}>
            {ROLE_OPTIONS_5.map((opt) => {
              const isActive = currentAccess === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => onChangeAccess(opt.value)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left' as const,
                    padding: '8px 12px',
                    background: isActive ? theme.accentBg : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: mono,
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.background = theme.bgHover;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isActive ? theme.accentBg : 'transparent';
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{
                        fontSize: 11,
                        fontWeight: 500,
                        color: isActive ? theme.accent : theme.text,
                      }}>{opt.label}</div>
                      <div style={{
                        fontSize: 9,
                        color: theme.textMuted,
                        marginTop: 1,
                      }}>{opt.desc}</div>
                    </div>
                    {isActive && (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M3 7.5L5.5 10L11 4" stroke={theme.accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                </button>
              );
            })}

            {/* User type assignment */}
            {onChangeTypes && userTypeDefinitions && userTypeDefinitions.length > 0 && (
              <>
                <div style={{
                  height: 1,
                  background: theme.border,
                  margin: '4px 0',
                }} />
                <div style={{
                  padding: '6px 12px',
                  fontFamily: mono,
                  fontSize: 10,
                  fontWeight: 600,
                  color: theme.textMuted,
                  textTransform: 'uppercase' as const,
                  letterSpacing: '0.5px',
                }}>
                  User types
                </div>
                {userTypeDefinitions.map((ut) => {
                  const assigned = userTypeIds?.includes(ut.id) ?? false;
                  return (
                    <button
                      key={ut.id}
                      onClick={() => {
                        const current = userTypeIds ?? [];
                        const next = assigned
                          ? current.filter(id => id !== ut.id)
                          : [...current, ut.id];
                        onChangeTypes(next);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        width: '100%',
                        textAlign: 'left' as const,
                        padding: '6px 12px',
                        background: assigned ? `${ut.color || theme.accent}10` : 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        fontFamily: mono,
                        fontSize: 11,
                      }}
                      onMouseEnter={(e) => {
                        if (!assigned) e.currentTarget.style.background = theme.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = assigned ? `${ut.color || theme.accent}10` : 'transparent';
                      }}
                    >
                      <span style={{
                        width: 14, height: 14, borderRadius: 3,
                        border: `1.5px solid ${assigned ? (ut.color || theme.accent) : theme.border}`,
                        background: assigned ? (ut.color || theme.accent) : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                      }}>
                        {assigned && (
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                            <path d="M2 5.5L4 7.5L8 3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </span>
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: ut.color || '#6b7280', flexShrink: 0,
                      }} />
                      <span style={{ color: assigned ? theme.text : theme.textSecondary }}>
                        {ut.label}
                      </span>
                    </button>
                  );
                })}
              </>
            )}

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
              Remove from room
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
      overflow: 'hidden',
      maxHeight: 'min(85vh, 720px)',
      minHeight: 0,
      boxShadow: `0 12px 40px ${t.shadow}`,
    },
    body: {
      display: 'flex',
      flexDirection: 'column' as const,
      flex: 1,
      minHeight: 0,
      overflowY: 'auto' as const,
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
