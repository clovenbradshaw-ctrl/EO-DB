/**
 * Field permissions sub-panel — manages per-field restrictions.
 * Assign fields to rooms (main vs restricted), set locked_to overrides.
 * Rendered as a collapsible section inside SpaceMembers.
 */

import { useState } from 'react';
import { useTheme, type Theme } from '../theme';
import type { FieldAssignment, AccessRole, UserTypeDefinition, FieldTypeVisibility } from '../permissions/types';
import { ROLE_LABELS } from '../permissions/types';

interface FieldPermissionsProps {
  fieldAssignments: FieldAssignment[];
  availableFields: string[];
  onUpdate: (assignments: FieldAssignment[]) => void;
  canManage: boolean;
  /** User type definitions for the "Visible to types" feature */
  userTypeDefinitions?: UserTypeDefinition[];
  /** Current field type visibility rules */
  fieldTypeVisibility?: FieldTypeVisibility[];
  /** Callback to update field type visibility */
  onUpdateFieldTypeVisibility?: (updated: FieldTypeVisibility[]) => void;
}

const ALL_ROLES: AccessRole[] = ['owner', 'admin', 'editor', 'creator', 'viewer'];

export function FieldPermissions({
  fieldAssignments,
  availableFields,
  onUpdate,
  canManage,
  userTypeDefinitions,
  fieldTypeVisibility,
  onUpdateFieldTypeVisibility,
}: FieldPermissionsProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [expanded, setExpanded] = useState(false);
  const [addingField, setAddingField] = useState(false);

  function handleRoomChange(field: string, room: 'main' | 'restricted') {
    const updated = fieldAssignments.map(a =>
      a.field === field ? { ...a, room } : a,
    );
    onUpdate(updated);
  }

  function handleToggleLock(field: string, role: AccessRole) {
    const updated = fieldAssignments.map(a => {
      if (a.field !== field) return a;
      const current = a.locked_to ?? [];
      const next = current.includes(role)
        ? current.filter(r => r !== role)
        : [...current, role];
      return { ...a, locked_to: next.length > 0 ? next : undefined };
    });
    onUpdate(updated);
  }

  function handleAddField(field: string) {
    if (fieldAssignments.some(a => a.field === field)) return;
    onUpdate([...fieldAssignments, { field, room: 'main', locked_to: ['owner', 'admin'] }]);
    setAddingField(false);
  }

  function handleRemove(field: string) {
    onUpdate(fieldAssignments.filter(a => a.field !== field));
  }

  function handleToggleTypeVisibility(field: string, typeId: string) {
    if (!onUpdateFieldTypeVisibility || !fieldTypeVisibility) return;
    const existing = fieldTypeVisibility.find(fv => fv.field === field);
    if (existing) {
      const current = existing.visible_to_types;
      const next = current.includes(typeId)
        ? current.filter(id => id !== typeId)
        : [...current, typeId];
      if (next.length === 0) {
        onUpdateFieldTypeVisibility(fieldTypeVisibility.filter(fv => fv.field !== field));
      } else {
        onUpdateFieldTypeVisibility(fieldTypeVisibility.map(fv =>
          fv.field === field ? { ...fv, visible_to_types: next } : fv
        ));
      }
    } else {
      onUpdateFieldTypeVisibility([
        ...fieldTypeVisibility,
        { field, visible_to_types: [typeId] },
      ]);
    }
  }

  function getFieldTypeVisibility(field: string): string[] {
    return fieldTypeVisibility?.find(fv => fv.field === field)?.visible_to_types ?? [];
  }

  const unassignedFields = availableFields.filter(
    f => !fieldAssignments.some(a => a.field === f),
  );

  return (
    <div style={s.container}>
      <button
        style={s.toggleBtn}
        onClick={() => setExpanded(!expanded)}
      >
        <span>{expanded ? '\u25BE' : '\u25B8'} Field permissions</span>
        <span style={s.count}>{fieldAssignments.length}</span>
      </button>

      {expanded && (
        <div style={s.content}>
          {fieldAssignments.map(assignment => (
            <div key={assignment.field} style={s.fieldCard}>
              <div style={s.fieldHeader}>
                <span style={s.fieldName}>{assignment.field}</span>
                {canManage && (
                  <button
                    style={s.removeBtn}
                    onClick={() => handleRemove(assignment.field)}
                  >
                    Remove lock
                  </button>
                )}
              </div>

              <div style={s.fieldRow}>
                <span style={s.label}>Room:</span>
                {canManage ? (
                  <select
                    style={s.select}
                    value={assignment.room}
                    onChange={e => handleRoomChange(assignment.field, e.target.value as 'main' | 'restricted')}
                  >
                    <option value="main">Main</option>
                    <option value="restricted">Restricted</option>
                  </select>
                ) : (
                  <span style={s.value}>{assignment.room}</span>
                )}
              </div>

              <div style={s.fieldRow}>
                <span style={s.label}>Editable by:</span>
                <div style={s.roleTags}>
                  {ALL_ROLES.map(role => {
                    const isLocked = assignment.locked_to?.includes(role);
                    return (
                      <button
                        key={role}
                        style={{
                          ...s.roleTag,
                          ...(isLocked ? s.roleTagActive : {}),
                          cursor: canManage ? 'pointer' : 'default',
                        }}
                        onClick={() => canManage && handleToggleLock(assignment.field, role)}
                        disabled={!canManage}
                      >
                        {ROLE_LABELS[role]}
                        {isLocked && canManage && <span style={s.tagClose}>&times;</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Visible to types — only shown when type definitions exist */}
              {userTypeDefinitions && userTypeDefinitions.length > 0 && (
                <div style={s.fieldRow}>
                  <span style={s.label}>Visible to:</span>
                  <div style={s.roleTags}>
                    {userTypeDefinitions.map(ut => {
                      const visibleTypes = getFieldTypeVisibility(assignment.field);
                      const isVisible = visibleTypes.includes(ut.id);
                      return (
                        <button
                          key={ut.id}
                          style={{
                            ...s.roleTag,
                            ...(isVisible ? {
                              background: `${ut.color || '#6b7280'}18`,
                              color: ut.color || '#6b7280',
                              borderColor: ut.color || '#6b7280',
                            } : {}),
                            cursor: canManage ? 'pointer' : 'default',
                          }}
                          onClick={() => canManage && handleToggleTypeVisibility(assignment.field, ut.id)}
                          disabled={!canManage}
                        >
                          <span style={{
                            width: 5, height: 5, borderRadius: '50%',
                            background: ut.color || '#6b7280', display: 'inline-block',
                          }} />
                          {' '}{ut.label}
                          {isVisible && canManage && <span style={s.tagClose}>&times;</span>}
                        </button>
                      );
                    })}
                  </div>
                  <span style={{
                    fontSize: 9,
                    color: theme.textMuted,
                    marginLeft: 4,
                  }}>
                    {getFieldTypeVisibility(assignment.field).length === 0 ? '(all)' : ''}
                  </span>
                </div>
              )}
            </div>
          ))}

          {canManage && !addingField && unassignedFields.length > 0 && (
            <button
              style={s.addBtn}
              onClick={() => setAddingField(true)}
            >
              + Add field restriction
            </button>
          )}

          {addingField && (
            <div style={s.addPanel}>
              <select
                style={s.select}
                onChange={e => e.target.value && handleAddField(e.target.value)}
                defaultValue=""
              >
                <option value="" disabled>Select a field...</option>
                {unassignedFields.map(f => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
              <button style={s.cancelBtn} onClick={() => setAddingField(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      borderTop: `1px solid ${t.border}`,
      paddingTop: 12,
    },
    toggleBtn: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
      background: 'none',
      border: 'none',
      color: t.textSecondary,
      fontSize: 12,
      fontWeight: 500,
      cursor: 'pointer',
      padding: '4px 0',
      fontFamily: "'JetBrains Mono', monospace",
    },
    count: {
      background: t.bgMuted,
      color: t.textMuted,
      borderRadius: 8,
      padding: '1px 6px',
      fontSize: 10,
    },
    content: {
      marginTop: 8,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    },
    fieldCard: {
      background: t.bgMuted,
      borderRadius: 6,
      padding: 12,
      border: `1px solid ${t.border}`,
    },
    fieldHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 8,
    },
    fieldName: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12,
      fontWeight: 600,
      color: t.text,
    },
    removeBtn: {
      background: 'none',
      border: 'none',
      color: t.danger,
      fontSize: 10,
      cursor: 'pointer',
      fontFamily: "'JetBrains Mono', monospace",
    },
    fieldRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 4,
    },
    label: {
      fontSize: 11,
      color: t.textMuted,
      minWidth: 70,
      fontFamily: "'JetBrains Mono', monospace",
    },
    value: {
      fontSize: 11,
      color: t.textSecondary,
      fontFamily: "'JetBrains Mono', monospace",
    },
    select: {
      background: t.bgCard,
      color: t.text,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      padding: '2px 6px',
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
    },
    roleTags: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 4,
    },
    roleTag: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 3,
      background: t.bgCard,
      color: t.textMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      padding: '1px 6px',
      fontSize: 10,
      cursor: 'pointer',
      fontFamily: "'JetBrains Mono', monospace",
    },
    roleTagActive: {
      background: t.accentBg,
      color: t.accent,
      borderColor: t.accent,
    },
    tagClose: {
      marginLeft: 2,
      fontSize: 11,
    },
    addBtn: {
      background: 'none',
      border: `1px dashed ${t.border}`,
      borderRadius: 6,
      padding: '8px 12px',
      color: t.textMuted,
      fontSize: 11,
      cursor: 'pointer',
      fontFamily: "'JetBrains Mono', monospace",
    },
    addPanel: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
    },
    cancelBtn: {
      background: 'none',
      border: 'none',
      color: t.textMuted,
      fontSize: 11,
      cursor: 'pointer',
      fontFamily: "'JetBrains Mono', monospace",
    },
  };
}
