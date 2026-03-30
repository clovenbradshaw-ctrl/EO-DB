/**
 * Governance & Access Control — public API.
 *
 * Re-exports types, resolution logic, and room topology helpers.
 */

export {
  type AccessRole,
  type FieldAssignment,
  type FieldPermission,
  type SpaceConfig,
  type SpaceSettings,
  type ResolvedPermissions,
  type SchemaManifest,
  type SchemaManifestField,
  ROLE_POWER_LEVELS,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  EO_POWER_LEVEL_CONTENT,
  powerLevelToRole,
  legacyAccessToRole,
  roleToLegacyAccess,
} from './types';

export {
  resolvePermissions,
  resolvePermissionsFromSharing,
  getUserPowerLevel,
  canEditField,
  isRecordOwner,
} from './resolve';

export {
  createRestrictedRoom,
  createGovernanceRoom,
  setSpaceConfig,
  getSpaceConfig,
  setSchemaManifest,
  getSchemaManifest,
  setUserRole,
  applyEoPowerLevels,
  inviteToRoom,
  removeFromRoom,
  ensureSpaceRooms,
  assignFieldToRoom,
  removeFieldAssignment,
  migrateShareToMatrix,
  type SpaceRooms,
} from './room-topology';
