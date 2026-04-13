/**
 * UserTypeManager — admin panel for defining user types per space.
 *
 * Rendered inside SpaceMembers below field permissions.
 * Only visible to admin+ users.
 */

import { useState, useMemo } from 'react';
import { useTheme, type Theme } from '../theme';
import type { AccessRole, UserTypeDefinition, UserTypeAssignment, HeadlineMetric, PersonaHome, QuickAction, TerminologyKey } from '../permissions/types';
import { ROLE_LABELS, ROLE_DESCRIPTIONS, TERMINOLOGY_KEYS, TERMINOLOGY_DEFAULTS } from '../permissions/types';
import { UserTypeBadge } from './UserTypeBadge';
import { useSliceStore } from '../store/slice-store';

/** Member reference passed to the user-assignment panel. */
export interface PersonaMemberRef {
  user_id: string;
  /** Optional display label (for the owner pill). */
  roleLabel?: string;
}

interface UserTypeManagerProps {
  typeDefinitions: UserTypeDefinition[];
  availableFields: string[];
  onUpdate: (updated: UserTypeDefinition[]) => void;
  canManage: boolean;
  /**
   * All members of the space (owner + share entries) that can be tagged with
   * a persona. When omitted, the "users" panel is hidden.
   */
  members?: PersonaMemberRef[];
  /** Current user-to-persona assignments. */
  userTypeAssignments?: UserTypeAssignment[];
  /** Callback to update the persona assignments for a specific user. */
  onUpdateAssignment?: (userId: string, typeIds: string[]) => void;
}

const DEFAULT_COLORS = [
  '#3b82f6', '#8b5cf6', '#10b981', '#f59e0b',
  '#ef4444', '#ec4899', '#06b6d4', '#84cc16',
];

/** Views that admins can configure per-role. Records is always visible. Multiuser is a testing tool. */
const CONFIGURABLE_VIEWS: { id: string; label: string }[] = [
  { id: 'compose', label: 'Compose' },
  { id: 'import', label: 'Import' },
  { id: 'api', label: 'API Connections' },
  { id: 'people', label: 'People' },
  { id: 'messages', label: 'Messages' },
  { id: 'members', label: 'Members & Roles' },
  { id: 'log', label: 'Log' },
  { id: 'builder', label: 'Builder' },
  { id: 'settings', label: 'Settings' },
];

/** Views that a persona can land on as their home destination. */
const HOME_VIEW_OPTIONS: { id: PersonaHome['view']; label: string }[] = [
  { id: 'records', label: 'Records' },
  { id: 'builder', label: 'Builder page' },
  { id: 'graph', label: 'Graph' },
  { id: 'log', label: 'Log' },
  { id: 'messages', label: 'Messages' },
  { id: 'people', label: 'People' },
  { id: 'members', label: 'Members & Roles' },
  { id: 'api', label: 'API Connections' },
  { id: 'import', label: 'Import' },
  { id: 'compose', label: 'Compose' },
  { id: 'settings', label: 'Settings' },
];

const AGGREGATION_OPTIONS: { value: HeadlineMetric['aggregation']; label: string }[] = [
  { value: 'count', label: 'Count' },
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'count_distinct', label: 'Count distinct' },
];

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

export function UserTypeManager({
  typeDefinitions,
  availableFields,
  onUpdate,
  canManage,
  members,
  userTypeAssignments,
  onUpdateAssignment,
}: UserTypeManagerProps) {
  const { theme } = useTheme();
  const mono = "'JetBrains Mono', monospace";
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_COLORS[0]);
  const [newDescription, setNewDescription] = useState('');
  const [newBaseRole, setNewBaseRole] = useState<Exclude<AccessRole, 'owner'> | ''>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMetrics, setEditMetrics] = useState<HeadlineMetric[]>([]);
  const [editingViewsId, setEditingViewsId] = useState<string | null>(null);
  const [editingHomeId, setEditingHomeId] = useState<string | null>(null);
  const [editingSlicesId, setEditingSlicesId] = useState<string | null>(null);
  const [editingActionsId, setEditingActionsId] = useState<string | null>(null);
  const [editingTermsId, setEditingTermsId] = useState<string | null>(null);
  const [editingUsersId, setEditingUsersId] = useState<string | null>(null);

  const canManageUsers = !!members && !!onUpdateAssignment;

  /** Get the current type_ids for a given user (from assignments prop). */
  function getTypeIdsForUser(userId: string): string[] {
    return userTypeAssignments?.find((a) => a.user_id === userId)?.type_ids ?? [];
  }

  /** Toggle membership of a single user in a single persona. */
  function handleToggleUserInPersona(userId: string, typeId: string) {
    if (!onUpdateAssignment) return;
    const current = getTypeIdsForUser(userId);
    const next = current.includes(typeId)
      ? current.filter((id) => id !== typeId)
      : [...current, typeId];
    onUpdateAssignment(userId, next);
  }

  /** How many members are tagged with a given persona. */
  function countMembersInPersona(typeId: string): number {
    if (!userTypeAssignments) return 0;
    return userTypeAssignments.reduce(
      (n, a) => (a.type_ids.includes(typeId) ? n + 1 : n),
      0,
    );
  }

  // Read saved slices for the default-slice editor. Group by scope.
  const savedSlices = useSliceStore((s) => s.savedSlices);
  const slicesByScope = useMemo(() => {
    const map: Record<string, Array<{ id: string; name: string }>> = {};
    for (const slice of Object.values(savedSlices)) {
      if (!slice.scope) continue;
      if (!map[slice.scope]) map[slice.scope] = [];
      map[slice.scope].push({ id: slice.id, name: slice.name });
    }
    return map;
  }, [savedSlices]);

  if (!canManage && typeDefinitions.length === 0) return null;

  function handleAdd() {
    if (!newLabel.trim()) return;
    const id = slugify(newLabel);
    if (typeDefinitions.some(t => t.id === id)) return;
    const newDef: UserTypeDefinition = {
      id,
      label: newLabel.trim(),
      color: newColor,
      description: newDescription.trim() || undefined,
      base_role: newBaseRole || undefined,
    };
    onUpdate([...typeDefinitions, newDef]);
    setNewLabel('');
    setNewDescription('');
    setNewColor(DEFAULT_COLORS[(typeDefinitions.length + 1) % DEFAULT_COLORS.length]);
    setNewBaseRole('');
    setAdding(false);
  }

  function handleSetBaseRole(typeId: string, role: Exclude<AccessRole, 'owner'> | '') {
    onUpdate(typeDefinitions.map(t =>
      t.id === typeId ? { ...t, base_role: role || undefined } : t
    ));
  }

  function handleDelete(id: string) {
    onUpdate(typeDefinitions.filter(t => t.id !== id));
  }

  function handleStartEditMetrics(def: UserTypeDefinition) {
    setEditingId(def.id);
    setEditMetrics(def.headline_metrics ? [...def.headline_metrics] : []);
  }

  function handleSaveMetrics() {
    if (!editingId) return;
    onUpdate(typeDefinitions.map(t =>
      t.id === editingId
        ? { ...t, headline_metrics: editMetrics.length > 0 ? editMetrics : undefined }
        : t
    ));
    setEditingId(null);
    setEditMetrics([]);
  }

  function handleToggleView(typeId: string, viewId: string) {
    onUpdate(typeDefinitions.map(t => {
      if (t.id !== typeId) return t;
      const cur = t.visible_views;
      if (cur == null) {
        // Currently unrestricted — restrict to all except this view
        const next = CONFIGURABLE_VIEWS.map(v => v.id).filter(v => v !== viewId);
        return { ...t, visible_views: ['records', ...next] };
      }
      if (cur.includes(viewId)) {
        // Uncheck — remove from list
        const next = cur.filter(v => v !== viewId);
        return { ...t, visible_views: next };
      } else {
        // Check — add to list; if now all views checked, remove restriction
        const next = [...cur, viewId];
        const allIds = CONFIGURABLE_VIEWS.map(v => v.id);
        if (allIds.every(v => next.includes(v))) {
          return { ...t, visible_views: undefined };
        }
        return { ...t, visible_views: next };
      }
    }));
  }

  function handleUpdateTerminology(typeId: string, key: TerminologyKey, value: string) {
    onUpdate(typeDefinitions.map(t => {
      if (t.id !== typeId) return t;
      const current = { ...(t.terminology ?? {}) };
      if (value.trim().length === 0) {
        delete current[key];
      } else {
        current[key] = value;
      }
      if (Object.keys(current).length === 0) {
        const { terminology: _tm, ...rest } = t;
        void _tm;
        return rest;
      }
      return { ...t, terminology: current };
    }));
  }

  function handleUpdateQuickActions(typeId: string, actions: QuickAction[]) {
    onUpdate(typeDefinitions.map(t => {
      if (t.id !== typeId) return t;
      if (actions.length === 0) {
        const { quick_actions: _qa, ...rest } = t;
        void _qa;
        return rest;
      }
      return { ...t, quick_actions: actions };
    }));
  }

  function handleUpdateDefaultSlice(typeId: string, scope: string, sliceId: string | null) {
    onUpdate(typeDefinitions.map(t => {
      if (t.id !== typeId) return t;
      const current = { ...(t.default_slices ?? {}) };
      if (sliceId === null) {
        delete current[scope];
      } else {
        current[scope] = sliceId;
      }
      if (Object.keys(current).length === 0) {
        const { default_slices: _ds, ...rest } = t;
        void _ds;
        return rest;
      }
      return { ...t, default_slices: current };
    }));
  }

  function handleUpdateHome(typeId: string, patch: Partial<PersonaHome> | null) {
    onUpdate(typeDefinitions.map(t => {
      if (t.id !== typeId) return t;
      if (patch === null) {
        // Clear home entirely
        const { home: _h, ...rest } = t;
        void _h;
        return rest;
      }
      const current: PersonaHome = t.home ?? { view: 'records' };
      const next: PersonaHome = { ...current, ...patch };
      // Normalize: trim empty strings to undefined so serialized state stays clean
      if (!next.scope) delete next.scope;
      if (!next.builderViewId) delete next.builderViewId;
      if (!next.customPageId) delete next.customPageId;
      return { ...t, home: next };
    }));
  }

  function addMetric() {
    setEditMetrics(prev => [
      ...prev,
      { label: '', field: availableFields[0] || '', aggregation: 'count' as const },
    ]);
  }

  function updateMetric(index: number, patch: Partial<HeadlineMetric>) {
    setEditMetrics(prev => prev.map((m, i) => i === index ? { ...m, ...patch } : m));
  }

  function removeMetric(index: number) {
    setEditMetrics(prev => prev.filter((_, i) => i !== index));
  }

  return (
    <div style={{
      marginTop: 16,
      border: `1px solid ${theme.border}`,
      borderRadius: 8,
      background: theme.bgCard,
      overflow: 'hidden' as const,
      minWidth: 0,
    }}>
      {/* Section header — always visible */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        background: theme.bgMuted,
        borderBottom: `1px solid ${theme.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontFamily: mono, fontSize: 12, fontWeight: 600,
            color: theme.text,
          }}>
            Personas
          </span>
          <span style={{
            fontFamily: mono, fontSize: 10, fontWeight: 500,
            color: theme.textMuted, background: theme.bgCard,
            border: `1px solid ${theme.border}`,
            padding: '1px 7px', borderRadius: 10,
          }}>
            {typeDefinitions.length}
          </span>
        </div>
        {canManage && !adding && (
          <button
            onClick={() => setAdding(true)}
            style={{
              fontFamily: mono, fontSize: 11, fontWeight: 600,
              color: '#fff', background: theme.accent,
              border: 'none', borderRadius: 6,
              padding: '5px 12px', cursor: 'pointer',
            }}
          >
            + Add persona
          </button>
        )}
      </div>

      {/* Table column header row */}
      {typeDefinitions.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(130px, 2fr) 80px minmax(90px, 1.2fr) minmax(120px, 1.6fr) auto',
          gap: 12,
          padding: '8px 14px',
          background: theme.bg,
          borderBottom: `1px solid ${theme.border}`,
          fontFamily: mono,
          fontSize: 9,
          fontWeight: 600,
          color: theme.textMuted,
          textTransform: 'uppercase' as const,
          letterSpacing: 0.5,
        }}>
          <div>Persona</div>
          <div>Capability</div>
          <div>Home</div>
          <div>Overrides</div>
          <div style={{ textAlign: 'right' as const }}>Configure</div>
        </div>
      )}

      {/* Empty state */}
      {typeDefinitions.length === 0 && !adding && (
        <div style={{
          padding: '24px 14px',
          textAlign: 'center' as const,
          fontFamily: mono,
          fontSize: 11,
          color: theme.textMuted,
        }}>
          No personas defined for this space yet.
          {canManage && (
            <>
              <br />
              Click <strong>+ Add persona</strong> to create one — or create a
              new space to auto-seed the default law-firm personas.
            </>
          )}
        </div>
      )}

      <div>
          {/* Existing types */}
          {typeDefinitions.map((def) => (
            <div key={def.id} style={{ borderBottom: `1px solid ${theme.border}` }}>
              {/* Type row — grid layout for table-like columns */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(130px, 2fr) 80px minmax(90px, 1.2fr) minmax(120px, 1.6fr) auto',
                gap: 12,
                alignItems: 'start',
                padding: '10px 14px',
              }}>
              {/* Column 1: Persona name + description */}
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
                <UserTypeBadge label={def.label} color={def.color} />
                {def.description && (
                  <span style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted }}>
                    {def.description}
                  </span>
                )}
              </div>
              {/* Column 2: Capability */}
              <div style={{ display: 'flex', alignItems: 'center' }}>
                {def.base_role ? (
                  <span style={{
                    fontFamily: mono, fontSize: 9,
                    color: def.color || theme.textSecondary,
                    background: def.color ? `${def.color}14` : theme.bgMuted,
                    border: `1px solid ${def.color ? `${def.color}30` : theme.border}`,
                    padding: '2px 6px', borderRadius: 4,
                  }}>
                    {ROLE_LABELS[def.base_role]}
                  </span>
                ) : (
                  <span style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted }}>
                    —
                  </span>
                )}
              </div>
              {/* Column 3: Home */}
              <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                {def.home ? (
                  <span
                    title={`Lands on ${def.home.view}${def.home.scope ? ` / ${def.home.scope}` : ''}`}
                    style={{
                      fontFamily: mono, fontSize: 9,
                      color: def.color || theme.textSecondary,
                      background: def.color ? `${def.color}14` : theme.bgMuted,
                      padding: '2px 6px', borderRadius: 4,
                      overflow: 'hidden' as const,
                      textOverflow: 'ellipsis' as const,
                      whiteSpace: 'nowrap' as const,
                    }}
                  >
                    {def.home.view}{def.home.scope ? ` · ${def.home.scope.split('.').pop()}` : ''}
                  </span>
                ) : (
                  <span style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted }}>
                    —
                  </span>
                )}
              </div>
              {/* Column 4: Overrides (badges) */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' as const }}>
                {def.headline_metrics && def.headline_metrics.length > 0 && (
                  <span style={{
                    fontFamily: mono, fontSize: 9, color: theme.accent,
                    background: theme.accentBg, padding: '1px 5px', borderRadius: 4,
                  }}>
                    {def.headline_metrics.length} metric{def.headline_metrics.length !== 1 ? 's' : ''}
                  </span>
                )}
                {def.visible_views != null && (
                  <span style={{
                    fontFamily: mono, fontSize: 9, color: def.color || theme.textSecondary,
                    background: def.color ? `${def.color}14` : theme.bgMuted,
                    padding: '1px 5px', borderRadius: 4,
                  }}>
                    {def.visible_views.length} views
                  </span>
                )}
                {def.default_slices && Object.keys(def.default_slices).length > 0 && (
                  <span
                    title={`Default slices: ${Object.entries(def.default_slices)
                      .map(([scope, sliceId]) => `${scope} \u2192 ${savedSlices[sliceId]?.name ?? sliceId}`)
                      .join(', ')}`}
                    style={{
                      fontFamily: mono, fontSize: 9, color: def.color || theme.textSecondary,
                      background: def.color ? `${def.color}14` : theme.bgMuted,
                      padding: '1px 5px', borderRadius: 4,
                    }}
                  >
                    {Object.keys(def.default_slices).length} default slice{Object.keys(def.default_slices).length !== 1 ? 's' : ''}
                  </span>
                )}
                {def.quick_actions && def.quick_actions.length > 0 && (
                  <span
                    title={`Quick actions: ${def.quick_actions.map(a => a.label).join(', ')}`}
                    style={{
                      fontFamily: mono, fontSize: 9, color: def.color || theme.textSecondary,
                      background: def.color ? `${def.color}14` : theme.bgMuted,
                      padding: '1px 5px', borderRadius: 4,
                    }}
                  >
                    {def.quick_actions.length} quick action{def.quick_actions.length !== 1 ? 's' : ''}
                  </span>
                )}
                {def.terminology && Object.keys(def.terminology).length > 0 && (
                  <span
                    title={`Terminology overrides: ${Object.entries(def.terminology).map(([k, v]) => `${k}\u2192${v}`).join(', ')}`}
                    style={{
                      fontFamily: mono, fontSize: 9, color: def.color || theme.textSecondary,
                      background: def.color ? `${def.color}14` : theme.bgMuted,
                      padding: '1px 5px', borderRadius: 4,
                    }}
                  >
                    {Object.keys(def.terminology).length} term{Object.keys(def.terminology).length !== 1 ? 's' : ''}
                  </span>
                )}
                {(!def.headline_metrics?.length &&
                  def.visible_views == null &&
                  !(def.default_slices && Object.keys(def.default_slices).length) &&
                  !(def.quick_actions && def.quick_actions.length) &&
                  !(def.terminology && Object.keys(def.terminology).length)) && (
                  <span style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted }}>
                    —
                  </span>
                )}
              </div>
              {/* Column 5: Configure buttons */}
              {canManage ? (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const, justifyContent: 'flex-end' as const }}>
                  {canManageUsers && (
                    <button
                      onClick={() => setEditingUsersId(editingUsersId === def.id ? null : def.id)}
                      title="Manage which members are tagged as this persona"
                      style={{
                        fontFamily: mono, fontSize: 9,
                        color: editingUsersId === def.id ? '#fff' : (def.color || theme.textSecondary),
                        background: editingUsersId === def.id ? (def.color || theme.accent) : 'none',
                        border: 'none', cursor: 'pointer',
                        padding: '2px 6px', borderRadius: 4,
                        display: 'flex', alignItems: 'center', gap: 4,
                      }}
                      onMouseEnter={(e) => {
                        if (editingUsersId !== def.id) e.currentTarget.style.background = theme.bgMuted;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = editingUsersId === def.id ? (def.color || theme.accent) : 'none';
                      }}
                    >
                      users
                      <span style={{
                        fontSize: 8, fontWeight: 600,
                        background: editingUsersId === def.id ? 'rgba(255,255,255,0.25)' : (def.color ? `${def.color}26` : theme.bgMuted),
                        color: editingUsersId === def.id ? '#fff' : (def.color || theme.textSecondary),
                        padding: '0 4px', borderRadius: 6, minWidth: 12, textAlign: 'center' as const,
                      }}>
                        {countMembersInPersona(def.id)}
                      </span>
                    </button>
                  )}
                  <button
                    onClick={() => handleStartEditMetrics(def)}
                    style={{
                      fontFamily: mono, fontSize: 9, color: theme.accent,
                      background: 'none', border: 'none', cursor: 'pointer',
                      padding: '2px 6px', borderRadius: 4,
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = theme.accentBg}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                  >
                    metrics
                  </button>
                  <select
                    value={def.base_role ?? ''}
                    onChange={(e) => handleSetBaseRole(def.id, e.target.value as Exclude<AccessRole, 'owner'> | '')}
                    title="Base capability tier for this role"
                    style={{
                      fontFamily: mono, fontSize: 9,
                      color: def.base_role ? (def.color || theme.textSecondary) : theme.textMuted,
                      background: def.base_role ? (def.color ? `${def.color}14` : theme.bgMuted) : theme.bgCard,
                      border: `1px solid ${def.base_role ? (def.color ? `${def.color}30` : theme.border) : theme.border}`,
                      borderRadius: 4, padding: '1px 4px', cursor: 'pointer',
                    }}
                  >
                    <option value="">capability…</option>
                    <option value="admin">Full access</option>
                    <option value="editor">Can edit</option>
                    <option value="creator">Can add</option>
                    <option value="viewer">Can view</option>
                  </select>
                  <button
                    onClick={() => setEditingViewsId(editingViewsId === def.id ? null : def.id)}
                    style={{
                      fontFamily: mono, fontSize: 9,
                      color: editingViewsId === def.id ? '#fff' : (def.color || theme.textSecondary),
                      background: editingViewsId === def.id ? (def.color || theme.accent) : 'none',
                      border: 'none', cursor: 'pointer',
                      padding: '2px 6px', borderRadius: 4,
                    }}
                    onMouseEnter={(e) => {
                      if (editingViewsId !== def.id) e.currentTarget.style.background = theme.bgMuted;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = editingViewsId === def.id ? (def.color || theme.accent) : 'none';
                    }}
                  >
                    views
                  </button>
                  <button
                    onClick={() => setEditingHomeId(editingHomeId === def.id ? null : def.id)}
                    title="Configure landing destination for this persona"
                    style={{
                      fontFamily: mono, fontSize: 9,
                      color: editingHomeId === def.id ? '#fff' : (def.color || theme.textSecondary),
                      background: editingHomeId === def.id ? (def.color || theme.accent) : 'none',
                      border: 'none', cursor: 'pointer',
                      padding: '2px 6px', borderRadius: 4,
                    }}
                    onMouseEnter={(e) => {
                      if (editingHomeId !== def.id) e.currentTarget.style.background = theme.bgMuted;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = editingHomeId === def.id ? (def.color || theme.accent) : 'none';
                    }}
                  >
                    home
                  </button>
                  <button
                    onClick={() => setEditingSlicesId(editingSlicesId === def.id ? null : def.id)}
                    title="Configure default slices per scope"
                    style={{
                      fontFamily: mono, fontSize: 9,
                      color: editingSlicesId === def.id ? '#fff' : (def.color || theme.textSecondary),
                      background: editingSlicesId === def.id ? (def.color || theme.accent) : 'none',
                      border: 'none', cursor: 'pointer',
                      padding: '2px 6px', borderRadius: 4,
                    }}
                    onMouseEnter={(e) => {
                      if (editingSlicesId !== def.id) e.currentTarget.style.background = theme.bgMuted;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = editingSlicesId === def.id ? (def.color || theme.accent) : 'none';
                    }}
                  >
                    slices
                  </button>
                  <button
                    onClick={() => setEditingActionsId(editingActionsId === def.id ? null : def.id)}
                    title="Configure quick-action buttons for this persona"
                    style={{
                      fontFamily: mono, fontSize: 9,
                      color: editingActionsId === def.id ? '#fff' : (def.color || theme.textSecondary),
                      background: editingActionsId === def.id ? (def.color || theme.accent) : 'none',
                      border: 'none', cursor: 'pointer',
                      padding: '2px 6px', borderRadius: 4,
                    }}
                    onMouseEnter={(e) => {
                      if (editingActionsId !== def.id) e.currentTarget.style.background = theme.bgMuted;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = editingActionsId === def.id ? (def.color || theme.accent) : 'none';
                    }}
                  >
                    actions
                  </button>
                  <button
                    onClick={() => setEditingTermsId(editingTermsId === def.id ? null : def.id)}
                    title="Rename UI labels for this persona"
                    style={{
                      fontFamily: mono, fontSize: 9,
                      color: editingTermsId === def.id ? '#fff' : (def.color || theme.textSecondary),
                      background: editingTermsId === def.id ? (def.color || theme.accent) : 'none',
                      border: 'none', cursor: 'pointer',
                      padding: '2px 6px', borderRadius: 4,
                    }}
                    onMouseEnter={(e) => {
                      if (editingTermsId !== def.id) e.currentTarget.style.background = theme.bgMuted;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = editingTermsId === def.id ? (def.color || theme.accent) : 'none';
                    }}
                  >
                    terms
                  </button>
                  <button
                    onClick={() => handleDelete(def.id)}
                    style={{
                      fontFamily: mono, fontSize: 9, color: theme.danger,
                      background: 'none', border: 'none', cursor: 'pointer',
                      padding: '2px 6px', borderRadius: 4,
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = theme.dangerBg}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                  >
                    remove
                  </button>
                </div>
              ) : (
                <div />
              )}
              </div>
              {/* Users panel — inline, expands when "users" button is clicked */}
              {canManage && canManageUsers && editingUsersId === def.id && (
                <div style={{
                  padding: '10px 12px',
                  background: theme.bgMuted,
                  borderRadius: 6,
                  marginBottom: 6,
                }}>
                  <div style={{
                    fontFamily: mono, fontSize: 10, fontWeight: 600,
                    color: theme.textSecondary, marginBottom: 8,
                  }}>
                    Members tagged as "{def.label}"
                    <span style={{ fontWeight: 400, color: theme.textMuted, marginLeft: 6 }}>
                      (toggle to add or remove this persona from a member)
                    </span>
                  </div>
                  {(!members || members.length === 0) ? (
                    <div style={{ fontFamily: mono, fontSize: 10, color: theme.textMuted }}>
                      No members to assign yet. Invite members from the section above.
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                      {members!.map((m) => {
                        const tagged = getTypeIdsForUser(m.user_id).includes(def.id);
                        const shortId = m.user_id.startsWith('@')
                          ? m.user_id.slice(1).split(':')[0]
                          : m.user_id;
                        return (
                          <label
                            key={m.user_id}
                            title={m.user_id}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 6,
                              padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
                              background: tagged ? (def.color ? `${def.color}12` : theme.accentBg) : theme.bgCard,
                              border: `1px solid ${tagged ? (def.color ? `${def.color}30` : theme.accentBorder) : theme.border}`,
                              minWidth: 0,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={tagged}
                              onChange={() => handleToggleUserInPersona(m.user_id, def.id)}
                              style={{ accentColor: def.color || theme.accent, width: 12, height: 12, flexShrink: 0 }}
                            />
                            <span style={{
                              fontFamily: mono, fontSize: 10,
                              color: tagged ? (def.color || theme.accent) : theme.text,
                              fontWeight: tagged ? 600 : 400,
                              overflow: 'hidden' as const,
                              textOverflow: 'ellipsis' as const,
                              whiteSpace: 'nowrap' as const,
                              minWidth: 0,
                            }}>
                              {shortId}
                            </span>
                            {m.roleLabel && (
                              <span style={{
                                fontFamily: mono, fontSize: 8,
                                color: theme.textMuted,
                                background: theme.bg,
                                padding: '1px 4px', borderRadius: 3,
                                flexShrink: 0,
                              }}>
                                {m.roleLabel}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <div style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted, marginTop: 6 }}>
                    {countMembersInPersona(def.id)} member{countMembersInPersona(def.id) !== 1 ? 's' : ''} in this persona
                  </div>
                </div>
              )}
              {/* Views config panel — inline, expands when "views" button is clicked */}
              {canManage && editingViewsId === def.id && (
                <div style={{
                  padding: '10px 0 10px 8px',
                  background: theme.bgMuted,
                  borderRadius: 6,
                  marginBottom: 6,
                }}>
                  <div style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, color: theme.textSecondary, marginBottom: 8 }}>
                    Visible nav for "{def.label}"
                    <span style={{ fontWeight: 400, color: theme.textMuted, marginLeft: 6 }}>
                      (Records always visible)
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                    {CONFIGURABLE_VIEWS.map(view => {
                      const active = !def.visible_views || def.visible_views.includes(view.id);
                      return (
                        <label key={view.id} style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
                          background: active ? (def.color ? `${def.color}12` : theme.accentBg) : theme.bgCard,
                          border: `1px solid ${active ? (def.color ? `${def.color}30` : theme.accentBorder) : theme.border}`,
                        }}>
                          <input
                            type="checkbox"
                            checked={active}
                            onChange={() => handleToggleView(def.id, view.id)}
                            style={{ accentColor: def.color || theme.accent, width: 12, height: 12 }}
                          />
                          <span style={{
                            fontFamily: mono, fontSize: 10,
                            color: active ? (def.color || theme.accent) : theme.textMuted,
                            fontWeight: active ? 500 : 400,
                          }}>
                            {view.label}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <div style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted, marginTop: 6 }}>
                    {def.visible_views ? `${def.visible_views.length} views enabled` : 'All views visible (no restriction)'}
                  </div>
                </div>
              )}
              {/* Home config panel — inline, expands when "home" button is clicked */}
              {canManage && editingHomeId === def.id && (
                <div style={{
                  padding: '10px 0 10px 8px',
                  background: theme.bgMuted,
                  borderRadius: 6,
                  marginBottom: 6,
                }}>
                  <div style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, color: theme.textSecondary, marginBottom: 8 }}>
                    Landing destination for "{def.label}"
                    <span style={{ fontWeight: 400, color: theme.textMuted, marginLeft: 6 }}>
                      (where this persona lands on space open or persona switch)
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted, minWidth: 50 }}>view</span>
                      <select
                        value={def.home?.view ?? 'records'}
                        onChange={(e) => handleUpdateHome(def.id, { view: e.target.value as PersonaHome['view'] })}
                        style={{
                          fontFamily: mono, fontSize: 10,
                          padding: '4px 6px', background: theme.bgCard,
                          border: `1px solid ${theme.border}`, borderRadius: 4,
                          color: theme.text,
                        }}
                      >
                        {HOME_VIEW_OPTIONS.map(v => (
                          <option key={v.id} value={v.id}>{v.label}</option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted, minWidth: 50 }}>scope</span>
                      <input
                        value={def.home?.scope ?? ''}
                        onChange={(e) => handleUpdateHome(def.id, { scope: e.target.value })}
                        placeholder="tblCases (optional)"
                        style={{
                          flex: 1, fontFamily: mono, fontSize: 10,
                          padding: '4px 6px', background: theme.bgCard,
                          border: `1px solid ${theme.border}`, borderRadius: 4,
                          color: theme.text, outline: 'none',
                        }}
                      />
                    </label>
                    {(def.home?.view === 'builder' || !def.home) && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted, minWidth: 50 }}>page id</span>
                        <input
                          value={def.home?.builderViewId ?? ''}
                          onChange={(e) => handleUpdateHome(def.id, { builderViewId: e.target.value })}
                          placeholder="builder page id (optional)"
                          style={{
                            flex: 1, fontFamily: mono, fontSize: 10,
                            padding: '4px 6px', background: theme.bgCard,
                            border: `1px solid ${theme.border}`, borderRadius: 4,
                            color: theme.text, outline: 'none',
                          }}
                        />
                      </label>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    {def.home && (
                      <button
                        onClick={() => handleUpdateHome(def.id, null)}
                        style={{
                          fontFamily: mono, fontSize: 9, color: theme.danger,
                          background: 'none', border: `1px solid ${theme.border}`,
                          borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
                        }}
                      >
                        clear home
                      </button>
                    )}
                    <span style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted, alignSelf: 'center' }}>
                      {def.home
                        ? `Lands on ${def.home.view}${def.home.scope ? ` / ${def.home.scope}` : ''}`
                        : 'No home set — falls back to Records'}
                    </span>
                  </div>
                </div>
              )}
              {/* Quick actions panel — inline, expands when "actions" button is clicked */}
              {canManage && editingActionsId === def.id && (
                <div style={{
                  padding: '10px 0 10px 8px',
                  background: theme.bgMuted,
                  borderRadius: 6,
                  marginBottom: 6,
                }}>
                  <div style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, color: theme.textSecondary, marginBottom: 8 }}>
                    Quick actions for "{def.label}"
                    <span style={{ fontWeight: 400, color: theme.textMuted, marginLeft: 6 }}>
                      (buttons shown on the records view for matching scopes)
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(def.quick_actions ?? []).map((action, idx) => (
                      <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          value={action.label}
                          onChange={(e) => {
                            const next = [...(def.quick_actions ?? [])];
                            next[idx] = { ...next[idx], label: e.target.value };
                            handleUpdateQuickActions(def.id, next);
                          }}
                          placeholder="Label (e.g. File I-130)"
                          style={{
                            flex: 1, fontFamily: mono, fontSize: 10,
                            padding: '4px 6px', background: theme.bgCard,
                            border: `1px solid ${theme.border}`, borderRadius: 4,
                            color: theme.text, outline: 'none',
                          }}
                        />
                        <input
                          value={action.scope}
                          onChange={(e) => {
                            const next = [...(def.quick_actions ?? [])];
                            next[idx] = { ...next[idx], scope: e.target.value };
                            handleUpdateQuickActions(def.id, next);
                          }}
                          placeholder="scope (e.g. tblCases)"
                          style={{
                            width: 140, fontFamily: mono, fontSize: 10,
                            padding: '4px 6px', background: theme.bgCard,
                            border: `1px solid ${theme.border}`, borderRadius: 4,
                            color: theme.text, outline: 'none',
                          }}
                        />
                        <input
                          value={action.icon ?? ''}
                          onChange={(e) => {
                            const next = [...(def.quick_actions ?? [])];
                            next[idx] = { ...next[idx], icon: e.target.value || undefined };
                            handleUpdateQuickActions(def.id, next);
                          }}
                          placeholder="\u2605"
                          style={{
                            width: 36, fontFamily: mono, fontSize: 11, textAlign: 'center' as const,
                            padding: '4px 4px', background: theme.bgCard,
                            border: `1px solid ${theme.border}`, borderRadius: 4,
                            color: theme.text, outline: 'none',
                          }}
                        />
                        <button
                          onClick={() => {
                            const next = (def.quick_actions ?? []).filter((_, i) => i !== idx);
                            handleUpdateQuickActions(def.id, next);
                          }}
                          title="Remove"
                          style={{
                            fontFamily: mono, fontSize: 11, color: theme.danger,
                            background: 'none', border: 'none', cursor: 'pointer',
                            padding: '0 4px',
                          }}
                        >&times;</button>
                      </div>
                    ))}
                    <button
                      onClick={() => {
                        const next: QuickAction[] = [
                          ...(def.quick_actions ?? []),
                          { label: '', scope: '' },
                        ];
                        handleUpdateQuickActions(def.id, next);
                      }}
                      style={{
                        fontFamily: mono, fontSize: 10, color: theme.accent,
                        background: theme.accentBg, border: `1px solid ${theme.accentBorder}`,
                        borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
                        alignSelf: 'flex-start' as const,
                      }}
                    >
                      + Add quick action
                    </button>
                  </div>
                  <div style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted, marginTop: 6 }}>
                    Template fields (prefilled when the button is clicked) are configured via JSON in a future iteration.
                  </div>
                </div>
              )}
              {/* Terminology panel — inline, expands when "terms" button is clicked */}
              {canManage && editingTermsId === def.id && (
                <div style={{
                  padding: '10px 0 10px 8px',
                  background: theme.bgMuted,
                  borderRadius: 6,
                  marginBottom: 6,
                }}>
                  <div style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, color: theme.textSecondary, marginBottom: 8 }}>
                    Terminology overrides for "{def.label}"
                    <span style={{ fontWeight: 400, color: theme.textMuted, marginLeft: 6 }}>
                      (leave blank to use the default label)
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                    {TERMINOLOGY_KEYS.map((key) => {
                      const value = def.terminology?.[key] ?? '';
                      return (
                        <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{
                            fontFamily: mono, fontSize: 9, color: theme.textMuted,
                            minWidth: 70,
                          }}>
                            {key}
                          </span>
                          <input
                            value={value}
                            onChange={(e) => handleUpdateTerminology(def.id, key, e.target.value)}
                            placeholder={TERMINOLOGY_DEFAULTS[key]}
                            style={{
                              flex: 1, fontFamily: mono, fontSize: 10,
                              padding: '3px 6px', background: theme.bgCard,
                              border: `1px solid ${theme.border}`, borderRadius: 4,
                              color: theme.text, outline: 'none',
                            }}
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Default slices panel — inline, expands when "slices" button is clicked */}
              {canManage && editingSlicesId === def.id && (
                <div style={{
                  padding: '10px 0 10px 8px',
                  background: theme.bgMuted,
                  borderRadius: 6,
                  marginBottom: 6,
                }}>
                  <div style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, color: theme.textSecondary, marginBottom: 8 }}>
                    Default slices for "{def.label}"
                    <span style={{ fontWeight: 400, color: theme.textMuted, marginLeft: 6 }}>
                      (applied when opening a scope with no active slice)
                    </span>
                  </div>
                  {Object.keys(slicesByScope).length === 0 ? (
                    <div style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted }}>
                      No saved slices yet. Create a slice in a table to map it to this persona.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {Object.entries(slicesByScope).map(([scope, options]) => {
                        const current = def.default_slices?.[scope] ?? '';
                        return (
                          <label key={scope} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{
                              fontFamily: mono, fontSize: 9, color: theme.textMuted,
                              minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const,
                            }}>
                              {scope}
                            </span>
                            <select
                              value={current}
                              onChange={(e) => handleUpdateDefaultSlice(def.id, scope, e.target.value || null)}
                              style={{
                                flex: 1, fontFamily: mono, fontSize: 10,
                                padding: '3px 6px', background: theme.bgCard,
                                border: `1px solid ${theme.border}`, borderRadius: 4,
                                color: theme.text,
                              }}
                            >
                              <option value="">(no default)</option>
                              {options.map((opt) => (
                                <option key={opt.id} value={opt.id}>{opt.name}</option>
                              ))}
                            </select>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Metrics editor */}
          {editingId && (
            <div style={{
              margin: '8px 0',
              padding: 10,
              background: theme.bg,
              border: `1px solid ${theme.border}`,
              borderRadius: 8,
            }}>
              <div style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, color: theme.textSecondary, marginBottom: 6 }}>
                Headline metrics for "{typeDefinitions.find(t => t.id === editingId)?.label}"
              </div>
              {editMetrics.map((m, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                  <input
                    value={m.label}
                    onChange={(e) => updateMetric(i, { label: e.target.value })}
                    placeholder="Label..."
                    style={{
                      flex: 1, fontFamily: mono, fontSize: 10,
                      padding: '4px 6px', background: theme.bgCard,
                      border: `1px solid ${theme.border}`, borderRadius: 4,
                      color: theme.text, outline: 'none',
                    }}
                  />
                  <select
                    value={m.field}
                    onChange={(e) => updateMetric(i, { field: e.target.value })}
                    style={{
                      fontFamily: mono, fontSize: 10,
                      padding: '4px 6px', background: theme.bgCard,
                      border: `1px solid ${theme.border}`, borderRadius: 4,
                      color: theme.text,
                    }}
                  >
                    <option value="">—field—</option>
                    {availableFields.map(f => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                  <select
                    value={m.aggregation}
                    onChange={(e) => updateMetric(i, { aggregation: e.target.value as HeadlineMetric['aggregation'] })}
                    style={{
                      fontFamily: mono, fontSize: 10,
                      padding: '4px 6px', background: theme.bgCard,
                      border: `1px solid ${theme.border}`, borderRadius: 4,
                      color: theme.text,
                    }}
                  >
                    {AGGREGATION_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeMetric(i)}
                    style={{
                      fontFamily: mono, fontSize: 11, color: theme.danger,
                      background: 'none', border: 'none', cursor: 'pointer',
                    }}
                  >&times;</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button
                  onClick={addMetric}
                  style={{
                    fontFamily: mono, fontSize: 10, color: theme.accent,
                    background: theme.accentBg, border: `1px solid ${theme.accentBorder}`,
                    borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
                  }}
                >
                  + Add metric
                </button>
                <button
                  onClick={handleSaveMetrics}
                  style={{
                    fontFamily: mono, fontSize: 10, color: '#fff',
                    background: theme.accent, border: 'none',
                    borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontWeight: 600,
                  }}
                >
                  Save
                </button>
                <button
                  onClick={() => { setEditingId(null); setEditMetrics([]); }}
                  style={{
                    fontFamily: mono, fontSize: 10, color: theme.textMuted,
                    background: 'none', border: 'none', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Add new type — header has its own "+ Add persona" button */}
          {canManage && adding && (
            <div style={{
              margin: '8px 14px',
              padding: 10,
              background: theme.bg,
              border: `1px solid ${theme.border}`,
              borderRadius: 8,
            }}>
              <input
                autoFocus
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAdding(false); }}
                placeholder="Type label (e.g. HR Manager)..."
                style={{
                  width: '100%', fontFamily: mono, fontSize: 11,
                  padding: '6px 8px', background: theme.bgCard,
                  border: `1px solid ${theme.border}`, borderRadius: 4,
                  color: theme.text, outline: 'none', marginBottom: 6,
                  boxSizing: 'border-box' as const,
                }}
              />
              <input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Description (optional)..."
                style={{
                  width: '100%', fontFamily: mono, fontSize: 10,
                  padding: '4px 8px', background: theme.bgCard,
                  border: `1px solid ${theme.border}`, borderRadius: 4,
                  color: theme.text, outline: 'none', marginBottom: 6,
                  boxSizing: 'border-box' as const,
                }}
              />
              {/* Color picker */}
              <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                {DEFAULT_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewColor(c)}
                    style={{
                      width: 20, height: 20, borderRadius: '50%',
                      background: c, border: newColor === c ? '2px solid #fff' : '2px solid transparent',
                      boxShadow: newColor === c ? `0 0 0 2px ${c}` : 'none',
                      cursor: 'pointer', padding: 0,
                    }}
                  />
                ))}
              </div>
              {/* Base capability picker */}
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted, marginBottom: 4 }}>
                  Base capability (optional)
                </div>
                <select
                  value={newBaseRole}
                  onChange={(e) => setNewBaseRole(e.target.value as Exclude<AccessRole, 'owner'> | '')}
                  style={{
                    fontFamily: mono, fontSize: 10,
                    padding: '4px 6px', background: theme.bgCard,
                    border: `1px solid ${theme.border}`, borderRadius: 4,
                    color: theme.text,
                  }}
                >
                  <option value="">Organizational only — no capability change</option>
                  <option value="admin">{ROLE_LABELS.admin} — {ROLE_DESCRIPTIONS.admin}</option>
                  <option value="editor">{ROLE_LABELS.editor} — {ROLE_DESCRIPTIONS.editor}</option>
                  <option value="creator">{ROLE_LABELS.creator} — {ROLE_DESCRIPTIONS.creator}</option>
                  <option value="viewer">{ROLE_LABELS.viewer} — {ROLE_DESCRIPTIONS.viewer}</option>
                </select>
              </div>
              {newLabel.trim() && (
                <div style={{ marginBottom: 8 }}>
                  <span style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted }}>Preview: </span>
                  <UserTypeBadge label={newLabel.trim()} color={newColor} />
                  <span style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted, marginLeft: 6 }}>
                    id: {slugify(newLabel)}
                  </span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={handleAdd}
                  disabled={!newLabel.trim()}
                  style={{
                    fontFamily: mono, fontSize: 10, fontWeight: 600,
                    color: '#fff', background: newLabel.trim() ? theme.accent : theme.textMuted,
                    border: 'none', borderRadius: 4, padding: '4px 12px', cursor: 'pointer',
                  }}
                >
                  Add type
                </button>
                <button
                  onClick={() => setAdding(false)}
                  style={{
                    fontFamily: mono, fontSize: 10, color: theme.textMuted,
                    background: 'none', border: 'none', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
    </div>
  );
}
