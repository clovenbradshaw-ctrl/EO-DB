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

// --- Field Assignments (legacy — replaced by manifest.eodb fieldRestrictions) ---

/** @deprecated Use FieldShadowConfig from space-permissions.ts instead. */
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
  lock_shared_slices?: boolean;
}

export interface SpaceConfig {
  name: string;
  rooms: {
    main: string;
    restricted?: string;
    governance?: string;
  };
  /** @deprecated Use manifest.eodb fieldRestrictions instead. */
  field_assignments?: FieldAssignment[];
  space_settings: SpaceSettings;
  /** Canonical Matrix room alias for deterministic room lookup.
   *  e.g. "#eo-db_drive_test_2:app.aminoimmigration.com" */
  canonical_alias?: string;
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
  can_build_slices: boolean;
  can_manage_members: boolean;
  can_set_governance: boolean;
  can_manage_keys: boolean;
  can_share: boolean;

  // Field-level
  restricted_fields: string[];
  locked_fields: string[];
  redacted_fields: string[];

  // User types
  /** All user type IDs assigned to the current user in this space */
  user_types: string[];
  /** Currently selected user type (from header switcher) */
  active_user_type: string | null;
  /** Fields hidden from this user due to type-based visibility rules */
  type_hidden_fields: string[];
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

// --- User Types (organizational/functional roles) ---

/**
 * A persona's landing destination — where the user is routed when they open
 * the space or switch into this persona. If absent, the app falls back to
 * the default 'records' view.
 */
export interface PersonaHome {
  /** Which top-level view to land on. */
  view: 'records' | 'builder' | 'graph' | 'log' | 'messages' | 'people' | 'members' | 'api' | 'import' | 'compose' | 'settings';
  /** Optional default scope (table full path) when landing. */
  scope?: string;
  /** If view === 'builder', the specific builder page to open. */
  builderViewId?: string;
  /** If view === 'builder' and using a slug-addressable custom page. */
  customPageId?: string;
}

/** A user type definition, created by admins per-space. */
export interface UserTypeDefinition {
  /** Unique slug identifier, e.g. "hr_manager", "finance" */
  id: string;
  /** Human-readable label, e.g. "HR Manager" */
  label: string;
  /** Optional badge color hex */
  color?: string;
  /** Optional description */
  description?: string;
  /** Headline metrics shown when this type is active */
  headline_metrics?: HeadlineMetric[];
  /**
   * If set, only these nav views are shown when this type is active.
   * Absence (undefined) means no restriction — all views are visible.
   * 'records' is always accessible regardless of this list.
   * This is a UI-layer restriction only; cryptographic access control
   * is enforced via Matrix room membership (restricted room).
   */
  visible_views?: string[];
  /**
   * Optional base capability tier for this user type.
   * When set, users assigned to this type have their effective power level
   * capped to this role (min of their sharing access and this value).
   * Absent = organizational label only, does not affect capabilities.
   */
  base_role?: Exclude<AccessRole, 'owner'>;
  /**
   * Optional landing destination when the user opens the space or switches
   * into this persona. Falls back to the default 'records' view if absent.
   * See PersonaHome for the shape.
   */
  home?: PersonaHome;
  /**
   * Optional per-scope default slice map. When this persona is active and
   * a table is opened, if an entry exists for that scope AND the slice
   * exists and is visible, it is activated automatically.
   *
   * Keys are full-path scopes (e.g., "tblCases"); values are slice IDs.
   * A persona default never overrides an already-active non-default slice
   * within the same session — it only applies when the SIG is fresh.
   */
  default_slices?: Record<string, string>;
  /**
   * Optional quick-action buttons shown on the records view when this
   * persona is active and the user is viewing one of the action's scopes.
   * Each action creates a prefilled record in its scope.
   */
  quick_actions?: QuickAction[];
  /**
   * Optional terminology overrides for canonical UI strings. Keys must
   * come from TERMINOLOGY_KEYS; values are the label this persona sees
   * instead of the default. Falls back to the canonical label when absent.
   */
  terminology?: Partial<Record<TerminologyKey, string>>;
}

/**
 * Canonical terminology keys a persona can override. Kept small and
 * descriptive — a persona only needs to override the few nouns that
 * define its domain (e.g., "record" -> "case" for attorneys).
 */
export const TERMINOLOGY_KEYS = [
  'record',        // singular
  'records',       // plural + nav label
  'compose',       // nav label
  'import',        // nav label
  'log',           // nav label
  'people',        // nav label
  'messages',      // nav label
  'members',       // nav label
  'graph',         // nav label
  'new_record',    // button label
] as const;

export type TerminologyKey = typeof TERMINOLOGY_KEYS[number];

/** Default (fallback) labels used when a persona has no override. */
export const TERMINOLOGY_DEFAULTS: Record<TerminologyKey, string> = {
  record: 'Record',
  records: 'Records',
  compose: 'Compose',
  import: 'Import',
  log: 'Log',
  people: 'People',
  messages: 'Messages',
  members: 'Members',
  graph: 'Graph',
  new_record: 'New record',
};

/**
 * Resolve a terminology label for the current persona. Pure function; use
 * this from components that can't use React hooks, or via the hook below.
 */
export function resolveTerminology(
  key: TerminologyKey,
  activeType: UserTypeDefinition | null | undefined,
): string {
  const override = activeType?.terminology?.[key];
  return override && override.trim().length > 0 ? override : TERMINOLOGY_DEFAULTS[key];
}

/** A single headline metric card displayed above the table. */
export interface HeadlineMetric {
  /** Display label, e.g. "Total Clients" */
  label: string;
  /** Field key to aggregate */
  field: string;
  /** Aggregation function */
  aggregation: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct';
  /** Optional filter — only count records where this field matches */
  filter_field?: string;
  filter_value?: string;
}

/**
 * A persona quick-action button. Rendered on the records view when the
 * active persona has actions whose `scope` matches the currently open scope.
 * Clicking emits a prefilled INS event via the existing fold pipeline.
 */
export interface QuickAction {
  /** Display label, e.g. "Start Intake", "File I-130" */
  label: string;
  /** Optional short icon/emoji, e.g. "\u2605" */
  icon?: string;
  /** Scope (table full path) where this action applies, e.g. "tblCases" */
  scope: string;
  /**
   * Optional template of field values to seed the new record with.
   * Keys are field names, values are literals. Empty template creates a
   * blank record at the scope.
   */
  template?: Record<string, unknown>;
}

/** Assignment of user types to a specific member. */
export interface UserTypeAssignment {
  /** Matrix user ID */
  user_id: string;
  /** Array of user type IDs assigned to this user */
  type_ids: string[];
}

/** Field visibility rule scoped to user types. */
export interface FieldTypeVisibility {
  /** Field key (e.g. "fldSalary") */
  field: string;
  /** Which user types can see this field. Empty array = visible to all. */
  visible_to_types: string[];
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
