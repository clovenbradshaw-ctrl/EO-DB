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
  powerLevelToRole,
} from './types';

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
): ResolvedPermissions {
  // 1. Read power level from Matrix room state
  const pl = getUserPowerLevel(mainRoom, userId);
  const role = powerLevelToRole(pl);

  // 2. Check room membership
  const inMain = mainRoom.getMember(userId)?.membership === 'join';
  const inRestricted = (restrictedRoom?.getMember(userId)?.membership ?? null) === 'join';
  const inGovernance = (governanceRoom?.getMember(userId)?.membership ?? null) === 'join';

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

  // 5. Return capabilities derived from power level
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
    can_build_views: pl >= 50,
    can_manage_members: pl >= 50,
    can_set_governance: pl >= 50,
    can_manage_keys: pl >= 100,
    can_share: pl >= 50,

    restricted_fields: restrictedFields,
    locked_fields: lockedFields,
    redacted_fields: redactedFields,
  };
}

/**
 * Resolve permissions without Matrix Room objects — for local-only / offline mode.
 * Uses the legacy `_sharing` array from space state as a fallback.
 */
export function resolvePermissionsFromSharing(
  userId: string,
  owner: string,
  sharing: Array<{ user_id: string; access: 'read' | 'write' | 'admin' }>,
  fieldAssignments?: FieldAssignment[],
): ResolvedPermissions {
  let pl: number;

  if (userId === owner) {
    pl = 100;
  } else {
    const entry = sharing.find(s => s.user_id === userId);
    if (!entry) {
      pl = 0;
    } else {
      switch (entry.access) {
        case 'admin': pl = 50; break;
        case 'write': pl = 25; break;
        default: pl = 0; break;
      }
    }
  }

  const role = powerLevelToRole(pl);
  const assignments = fieldAssignments ?? [];

  const restrictedFields = assignments
    .filter(f => f.room === 'restricted')
    .map(f => f.field);

  const lockedFields = assignments
    .filter(f => f.locked_to && !f.locked_to.includes(role))
    .map(f => f.field);

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
    can_build_views: pl >= 50,
    can_manage_members: pl >= 50,
    can_set_governance: pl >= 50,
    can_manage_keys: pl >= 100,
    can_share: pl >= 50,

    restricted_fields: restrictedFields,
    locked_fields: lockedFields,
    redacted_fields: restrictedFields.filter(() => pl < 50),
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
