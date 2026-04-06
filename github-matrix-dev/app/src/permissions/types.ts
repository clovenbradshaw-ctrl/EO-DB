/**
 * Governance & Access Control — Type definitions.
 *
 * Roles map directly to Matrix power levels. The homeserver enforces
 * event submission; the app enforces Creator-vs-Editor and UI guards.
 */

// --- Roles ---

export type AccessRole = 'owner' | 'admin' | 'editor' | 'creator' | 'viewer';

/** Matrix power level for each role. */
export const ROLE_POWER_LEVELS: Record<AccessRole, number> = {
  owner: 100,
  admin: 50,
  editor: 25,
  creator: 10,
  viewer: 0,
};

/** Human-readable labels for the role picker UI. */
export const ROLE_LABELS: Record<AccessRole, string> = {
  owner: 'Owner',
  admin: 'Full access',
  editor: 'Can edit',
  creator: 'Can add',
  viewer: 'Can view',
};

/** Short descriptions for the role picker dropdown. */
export const ROLE_DESCRIPTIONS: Record<AccessRole, string> = {
  owner: 'Full control, manage rooms & keys',
  admin: 'Manage people, fields, policies',
  editor: 'Edit any record, add/remove records',
  creator: 'Add records, edit own only',
  viewer: 'Read-only access',
};

/** Derive role from a raw Matrix power level. */
export function powerLevelToRole(pl: number): AccessRole {
  if (pl >= 100) return 'owner';
  if (pl >= 50) return 'admin';
  if (pl >= 25) return 'editor';
  if (pl >= 10) return 'creator';
  return 'viewer';
}

// --- Field Assignments ---

export interface FieldAssignment {
  /** Field key (e.g. "fldSSN") */
  field: string;
  /** Which room holds this field's DEF events */
  room: 'main' | 'restricted';
  /** Within that room, further restrict who can edit */
  locked_to?: AccessRole[];
}

// --- Space Configuration ---

export interface SpaceSettings {
  creators_can_delete_own?: boolean;
  lock_shared_views?: boolean;
}

export interface SpaceConfig {
  name: string;
  rooms: {
    main: string;
    restricted?: string;
    governance?: string;
  };
  field_assignments: FieldAssignment[];
  space_settings: SpaceSettings;
  /** Whether this space is listed in the homeserver's public room directory.
   *  'public' (default) — anyone on the homeserver can discover the space and knock to request access.
   *  'private' — only invited members know the space exists. */
  discoverability?: 'public' | 'private';
  /** Soft-lifecycle status. Absent or 'active' means normal. */
  status?: 'active' | 'archived' | 'deleted';
  /** Epoch ms when the status was last changed. */
  status_changed_at?: number;
  /** Matrix user ID who changed the status. */
  status_changed_by?: string;
}

// --- Field Permissions ---

export interface FieldPermission {
  field: string;
  room: 'main' | 'restricted';
  locked_to?: AccessRole[];
  set_by: string;
  set_at: string;
}

// --- Resolved Permissions ---

export interface ResolvedPermissions {
  role: AccessRole;
  powerLevel: number;
  is_owner: boolean;

  // Room membership
  in_main_room: boolean;
  in_restricted_room: boolean;
  in_governance_room: boolean;

  // Capability flags (derived from power level)
  can_read: boolean;
  can_add_records: boolean;
  can_edit_any_record: boolean;
  can_edit_own_records: boolean;
  can_create_fields: boolean;
  can_build_views: boolean;
  can_manage_members: boolean;
  can_set_governance: boolean;
  can_manage_keys: boolean;
  can_share: boolean;

  // Field-level
  restricted_fields: string[];
  locked_fields: string[];
  redacted_fields: string[];
}

// --- Matrix Power Level Config ---

/** Default power level configuration for EO-DB rooms. */
export const EO_POWER_LEVEL_CONTENT = {
  users_default: 0,
  events: {
    'com.eo-db.event': 10,
    'com.eo-db.schema': 50,
    'com.eo-db.governance': 50,
    'com.eo-db.key.announce': 100,
    'com.eo-db.snapshot': 50,
    'm.room.name': 100,
    'm.room.power_levels': 100,
  },
  invite: 50,
  kick: 50,
  ban: 100,
  state_default: 50,
  events_default: 10,
} as const;

// --- Schema Manifest ---

export interface SchemaManifestField {
  name: string;
  room: 'main' | 'restricted';
}

export interface SchemaManifest {
  fields: SchemaManifestField[];
}

// --- Backward Compatibility ---

/** Map old 3-tier access levels to new roles. */
export function legacyAccessToRole(access: 'read' | 'write' | 'admin'): AccessRole {
  switch (access) {
    case 'read': return 'viewer';
    case 'write': return 'editor';
    case 'admin': return 'admin';
  }
}

/** Map new roles to old access levels (for backward compat). */
export function roleToLegacyAccess(role: AccessRole): 'read' | 'write' | 'admin' {
  switch (role) {
    case 'owner': return 'admin';
    case 'admin': return 'admin';
    case 'editor': return 'write';
    case 'creator': return 'write';
    case 'viewer': return 'read';
  }
}
