/**
 * Permission resolution — reads Matrix power levels and room membership
 * to derive capability flags for the current user.
 *
 * Source of truth: Matrix room state (`m.room.power_levels`).
 * The only application-level check is Creator "own records" (in fold.ts).
 */

import type { MatrixClient, Room } from 'matrix-js-sdk';
import {
  type AccessRole,
  type FieldAssignment,
  type ResolvedPermissions,
  type SpaceConfig,
  type UserTypeAssignment,
  type UserTypeDefinition,
  type FieldTypeVisibility,
  powerLevelToRole,
  ROLE_POWER_LEVELS,
} from './types';
import {
  type ManifestState,
  type SpaceRole,
  roleAtLeast,
} from './space-manifest';

/**
 * Read a user's power level from a Matrix Room object.
 * Falls back to 0 (Viewer) if the member is unknown.
 */
export function getUserPowerLevel(room: Room, userId: string): number {
  const member = room.getMember(userId);
  return member?.powerLevel ?? 0;
}

/**
 * Resolve full permissions for a user in a space.
 *
 * Reads the user's power level from the main room's Matrix state,
 * checks membership in restricted/governance rooms, and computes
 * field-level access from the space config's field_assignments.
 */
export function resolvePermissions(
  userId: string,
  mainRoom: Room,
  restrictedRoom?: Room | null,
  governanceRoom?: Room | null,
  spaceConfig?: SpaceConfig | null,
  userTypeAssignments?: UserTypeAssignment[] | null,
  fieldTypeVisibility?: FieldTypeVisibility[] | null,
  activeUserType?: string | null,
): ResolvedPermissions {
  // 1. Read power level from Matrix room state
  const pl = getUserPowerLevel(mainRoom, userId);
  const role = powerLevelToRole(pl);

  // 2. Check room membership
  const inMain = mainRoom.getMember(userId)?.membership === 'join';
  const inRestricted = restrictedRoom?.getMember(userId)?.membership === 'join' || false;
  const inGovernance = governanceRoom?.getMember(userId)?.membership === 'join' || false;

  // 3. Compute field access from field_assignments + room membership
  const fieldAssignments = spaceConfig?.field_assignments ?? [];
  const restrictedFields = fieldAssignments
    .filter(f => f.room === 'restricted')
    .map(f => f.field);

  const redactedFields = restrictedFields.filter(() => !inRestricted);

  // 4. Compute locked fields (within-room write restrictions)
  const lockedFields = fieldAssignments
    .filter(f => f.locked_to && !f.locked_to.includes(role))
    .map(f => f.field);

  // 5. Resolve user types
  const userTypes = userTypeAssignments
    ?.find(a => a.user_id === userId)?.type_ids ?? [];
  const effectiveActiveType = activeUserType ?? null;

  // Admin+ (pl >= 50) bypasses type-based field hiding
  const typeHiddenFields = pl >= 50 ? [] : (fieldTypeVisibility ?? [])
    .filter(ftv =>
      ftv.visible_to_types.length > 0 &&
      (effectiveActiveType === null ||
        !ftv.visible_to_types.includes(effectiveActiveType))
    )
    .map(ftv => ftv.field);

  // 6. Return capabilities derived from power level
  return {
    role,
    powerLevel: pl,
    is_owner: pl >= 100,

    in_main_room: inMain,
    in_restricted_room: inRestricted,
    in_governance_room: inGovernance,

    can_read: inMain,
    can_add_records: pl >= 10,
    can_edit_any_record: pl >= 25,
    can_edit_own_records: pl >= 10,
    can_create_fields: pl >= 50,
    can_build_slices: pl >= 50,
    can_manage_members: pl >= 50,
    can_set_governance: pl >= 50,
    can_manage_keys: pl >= 100,
    can_share: pl >= 50,

    restricted_fields: restrictedFields,
    locked_fields: lockedFields,
    redacted_fields: redactedFields,

    user_types: userTypes,
    active_user_type: effectiveActiveType,
    type_hidden_fields: typeHiddenFields,
  };
}

/**
 * Resolve permissions without Matrix Room objects — for local-only / offline mode.
 * Uses the legacy `_sharing` array from space state as a fallback.
 */
export function resolvePermissionsFromSharing(
  userId: string,
  owner: string,
  sharing: Array<{ user_id: string; access: string }>,
  fieldAssignments?: FieldAssignment[],
  userTypeAssignments?: UserTypeAssignment[] | null,
  fieldTypeVisibility?: FieldTypeVisibility[] | null,
  activeUserType?: string | null,
  typeDefinitions?: UserTypeDefinition[] | null,
): ResolvedPermissions {
  let pl: number;

  if (userId === owner) {
    pl = 100;
  } else {
    const entry = sharing.find(s => s.user_id === userId);
    if (!entry) {
      // Default: editor-level access for anyone with space access.
      // Permissions are restrictive (restrict-by-exception), not grant-only.
      // Admins can explicitly lower access via the sharing list.
      pl = 25;
    } else {
      switch (entry.access) {
        case 'admin':   pl = 50; break;
        case 'editor':
        case 'write':   pl = 25; break;  // 'write' = legacy backward compat
        case 'creator': pl = 10; break;
        case 'viewer':
        case 'read':
        default:        pl = 0;  break;  // 'read' = legacy backward compat
      }
    }
  }

  // Apply base_role cap from the user's active space-specific role.
  // A named role (user type with base_role set) can restrict capabilities
  // below the user's sharing access level, but never elevate them.
  const effectiveActiveType = activeUserType ?? null;
  const activeTypeDef = (typeDefinitions ?? []).find(t => t.id === effectiveActiveType);
  if (activeTypeDef?.base_role) {
    pl = Math.min(pl, ROLE_POWER_LEVELS[activeTypeDef.base_role]);
  }

  const role = powerLevelToRole(pl);
  const assignments = fieldAssignments ?? [];

  const restrictedFields = assignments
    .filter(f => f.room === 'restricted')
    .map(f => f.field);

  const lockedFields = assignments
    .filter(f => f.locked_to && !f.locked_to.includes(role))
    .map(f => f.field);

  // Resolve user types
  const userTypes = userTypeAssignments
    ?.find(a => a.user_id === userId)?.type_ids ?? [];

  // Admin+ (pl >= 50) bypasses type-based field hiding
  const typeHiddenFields = pl >= 50 ? [] : (fieldTypeVisibility ?? [])
    .filter(ftv =>
      ftv.visible_to_types.length > 0 &&
      (effectiveActiveType === null ||
        !ftv.visible_to_types.includes(effectiveActiveType))
    )
    .map(ftv => ftv.field);

  return {
    role,
    powerLevel: pl,
    is_owner: pl >= 100,

    in_main_room: true,
    in_restricted_room: pl >= 50,
    in_governance_room: pl >= 50,

    can_read: true,
    can_add_records: pl >= 10,
    can_edit_any_record: pl >= 25,
    can_edit_own_records: pl >= 10,
    can_create_fields: pl >= 50,
    can_build_slices: pl >= 50,
    can_manage_members: pl >= 50,
    can_set_governance: pl >= 50,
    can_manage_keys: pl >= 100,
    can_share: pl >= 50,

    restricted_fields: restrictedFields,
    locked_fields: lockedFields,
    redacted_fields: restrictedFields.filter(() => pl < 50),

    user_types: userTypes,
    active_user_type: effectiveActiveType,
    type_hidden_fields: typeHiddenFields,
  };
}

// ─── Manifest-based resolver (new model) ─────────────────────────────────────

/**
 * Map a SpaceRole to a numeric power level for capability flag derivation.
 * Keeps the same thresholds as the Matrix power level model for consistency.
 */
function spaceRoleToPowerLevel(role: SpaceRole): number {
  switch (role) {
    case 'owner': return 100;
    case 'admin': return 50;
    case 'restricted': return 30;  // between editor and admin
    case 'editor': return 25;
    case 'viewer': return 0;
  }
}

/**
 * Resolve permissions from a folded manifest state.
 *
 * This replaces the Matrix-power-level-based resolver for spaces using the
 * new Drive-based permission model.  The manifest fold state is downloaded
 * from manifest.eodb on space open and cached in Zustand.
 *
 * Field-level access is determined by the manifest's fieldRestrictions:
 *   - Fields with sensitivity "restricted" are redacted for viewer/editor roles.
 *   - Fields with sensitivity "admin" are redacted for everyone below admin.
 *   - Shadow values from the manifest are used in place of redacted values.
 */
export function resolvePermissionsFromManifest(
  userId: string,
  manifestState: ManifestState,
  userTypeAssignments?: UserTypeAssignment[] | null,
  fieldTypeVisibility?: FieldTypeVisibility[] | null,
  activeUserType?: string | null,
): ResolvedPermissions {
  const member = manifestState.members[userId];
  const role: SpaceRole = member?.role ?? 'viewer';
  const pl = spaceRoleToPowerLevel(role);
  const accessRole = powerLevelToRole(pl);

  // Field-level access from manifest field restrictions.
  const restrictedFields: string[] = [];
  const redactedFields: string[] = [];

  for (const [field, config] of Object.entries(manifestState.fields)) {
    if (config.sensitivity === 'restricted' && !roleAtLeast(role, 'restricted')) {
      restrictedFields.push(field);
      redactedFields.push(field);
    } else if (config.sensitivity === 'admin' && !roleAtLeast(role, 'admin')) {
      restrictedFields.push(field);
      redactedFields.push(field);
    }
  }

  // User types
  const userTypes = userTypeAssignments?.find(a => a.user_id === userId)?.type_ids ?? [];
  const effectiveActiveType = activeUserType ?? null;
  const typeHiddenFields = pl >= 50 ? [] : (fieldTypeVisibility ?? [])
    .filter(ftv =>
      ftv.visible_to_types.length > 0 &&
      (effectiveActiveType === null || !ftv.visible_to_types.includes(effectiveActiveType))
    )
    .map(ftv => ftv.field);

  return {
    role: accessRole,
    powerLevel: pl,
    is_owner: role === 'owner',

    // Simplified: single room per space.
    in_main_room: !!member,
    in_restricted_room: roleAtLeast(role, 'restricted'),
    in_governance_room: roleAtLeast(role, 'admin'),

    can_read: !!member,
    can_add_records: pl >= 25,
    can_edit_any_record: pl >= 25,
    can_edit_own_records: pl >= 25,
    can_create_fields: pl >= 50,
    can_build_slices: pl >= 50,
    can_manage_members: pl >= 50,
    can_set_governance: pl >= 50,
    can_manage_keys: pl >= 100,
    can_share: pl >= 50,

    restricted_fields: restrictedFields,
    locked_fields: [],
    redacted_fields: redactedFields,

    user_types: userTypes,
    active_user_type: effectiveActiveType,
    type_hidden_fields: typeHiddenFields,
  };
}

/**
 * Check if a user can edit a specific field, given their resolved permissions.
 */
export function canEditField(
  permissions: ResolvedPermissions,
  fieldKey: string,
): boolean {
  if (permissions.redacted_fields.includes(fieldKey)) return false;
  if (permissions.locked_fields.includes(fieldKey)) return false;
  return permissions.can_edit_any_record || permissions.can_edit_own_records;
}

/**
 * Check if a Creator-level user owns a record (for fold enforcement).
 */
export function isRecordOwner(
  recordValue: any,
  userId: string,
): boolean {
  return recordValue?._created_by === userId;
}
