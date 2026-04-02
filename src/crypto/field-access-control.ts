/**
 * Field-specific encryption access control.
 *
 * This is the "right-click → encrypt this field" backend. When a user designates
 * a field for field-specific encryption:
 *
 *   1. A unique AES-256-GCM key is generated for that field
 *   2. The key is announced to a key room (existing or newly created)
 *   3. A SEG boundary is placed on the field target with the key + access metadata
 *   4. An access list is stored with Matrix power levels per user
 *   5. Adding/removing access = managing the key room membership + rotating keys
 *
 * Access model mirrors the existing Matrix permission system:
 *   - owner  (PL 100): Full control, manage encryption settings, grant/revoke any role
 *   - admin  (PL  50): Manage access list, rotate keys, grant up to admin
 *   - editor (PL  25): Read + write encrypted values
 *   - viewer (PL   0): Read-only access to decrypted values
 *
 * Key design choice: users CAN grant access levels higher than their own.
 * An editor (PL 25) can grant someone admin (PL 50) on a field they have access to.
 * This enables delegation without requiring the owner to be online.
 *
 * Revoking access: when a user is removed, the key is rotated. The removed user's
 * cached key becomes useless for future writes. Historical data they already
 * decrypted cannot be un-seen (forward secrecy only).
 */

import type { EoDb } from '../db/level.js';
import { encode, decode } from '../db/level.js';
import { getState } from '../db/state.js';
import { getStateByPrefix } from '../db/state.js';

// ─── Roles & Power Levels (mirrors permissions/types.ts) ────────────────────

/** Access roles for field-level encryption — same as the room-level roles. */
export type FieldAccessRole = 'owner' | 'admin' | 'editor' | 'viewer';

/** Matrix power levels for each role. */
export const FIELD_ACCESS_POWER_LEVELS: Record<FieldAccessRole, number> = {
  owner: 100,
  admin: 50,
  editor: 25,
  viewer: 0,
};

/** Human-readable labels for the access role picker. */
export const FIELD_ACCESS_LABELS: Record<FieldAccessRole, string> = {
  owner: 'Owner',
  admin: 'Full access',
  editor: 'Can edit',
  viewer: 'Can view',
};

/** Descriptions for the role picker dropdown. */
export const FIELD_ACCESS_DESCRIPTIONS: Record<FieldAccessRole, string> = {
  owner: 'Full control — manage encryption, grant/revoke any role',
  admin: 'Manage people, rotate keys, grant up to admin',
  editor: 'Read and write encrypted values',
  viewer: 'Read-only access to decrypted values',
};

/** Derive role from a raw power level. */
export function powerLevelToFieldRole(pl: number): FieldAccessRole {
  if (pl >= 100) return 'owner';
  if (pl >= 50) return 'admin';
  if (pl >= 25) return 'editor';
  return 'viewer';
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single user in a field's access list with their role. */
export interface FieldAccessEntry {
  /** Matrix user ID */
  user_id: string;
  /** Their role on this field */
  role: FieldAccessRole;
  /** Matrix power level (derived from role) */
  power_level: number;
  /** When access was granted */
  granted_at: string;
  /** Who granted access */
  granted_by: string;
}

/**
 * Stored as the SEG operand value on a field target when the user
 * designates it for field-specific encryption.
 */
export interface FieldEncryptionDesignation {
  /** Marker — distinguishes from waterfall 'encrypt' and policy 'encrypt-policy' */
  boundary: 'field-encrypt';
  /** The AES-256-GCM key ID for this specific field */
  key_id: string;
  /** Algorithm */
  algorithm: 'aes-256-gcm';
  /** Key version (incremented on rotation / access revocation) */
  key_version: number;
  /** Key room where this field's key is distributed */
  key_room_id: string;
  /** Explicit access list — who can decrypt this field and at what level */
  access_list: FieldAccessEntry[];
  /** Who designated this field for encryption */
  designated_by: string;
  /** When */
  designated_at: string;
}

/** Type guard for field-specific encryption designations. */
export function isFieldEncryptionDesignation(operand: any): operand is FieldEncryptionDesignation {
  return (
    operand != null &&
    typeof operand === 'object' &&
    operand.boundary === 'field-encrypt' &&
    typeof operand.key_id === 'string' &&
    Array.isArray(operand.access_list)
  );
}

// ─── DB Key for field encryption registry ───────────────────────────────────

const REGISTRY_PREFIX = 'meta:field-encrypt:';

/** Persisted registry entry for a field-encrypted target. */
export interface FieldEncryptionRegistryEntry {
  /** The field target path */
  target: string;
  /** Key ID */
  key_id: string;
  /** Key room ID */
  key_room_id: string;
  /** Current access list (mirrored from state for fast lookup) */
  access_list: FieldAccessEntry[];
  /** Current key version */
  key_version: number;
  /** When this entry was last updated */
  updated_at: string;
}

// ─── Registry Operations ────────────────────────────────────────────────────

/** Register a field as encrypted in the fast-lookup registry. */
export async function registerFieldEncryption(
  db: EoDb,
  entry: FieldEncryptionRegistryEntry,
): Promise<void> {
  await db.put(REGISTRY_PREFIX + entry.target, encode(entry));
}

/** Get a field's encryption registry entry. */
export async function getFieldEncryption(
  db: EoDb,
  target: string,
): Promise<FieldEncryptionRegistryEntry | null> {
  try {
    const buf = await db.get(REGISTRY_PREFIX + target);
    return decode(buf) as FieldEncryptionRegistryEntry;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

/** Remove a field's encryption designation. */
export async function unregisterFieldEncryption(
  db: EoDb,
  target: string,
): Promise<void> {
  try {
    await db.del(REGISTRY_PREFIX + target);
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
}

/** List all field-encrypted targets (for admin/UI). */
export async function listFieldEncryptions(
  db: EoDb,
): Promise<FieldEncryptionRegistryEntry[]> {
  const entries: FieldEncryptionRegistryEntry[] = [];

  for await (const [, value] of db.iterator({
    gte: REGISTRY_PREFIX,
    lte: REGISTRY_PREFIX + '\xff',
  })) {
    entries.push(decode(value) as FieldEncryptionRegistryEntry);
  }

  return entries;
}

// ─── "Who Has Access" View (for UI panel) ───────────────────────────────────

/** Summary of one user's access for the "who has access" screen. */
export interface FieldAccessSummary {
  user_id: string;
  role: FieldAccessRole;
  power_level: number;
  granted_at: string;
  granted_by: string;
  /** Whether this user can be removed by the current viewer */
  can_remove: boolean;
  /** Whether this user's role can be changed by the current viewer */
  can_change_role: boolean;
}

/**
 * Build the "who has access" view for a field's encryption.
 *
 * Given the designation and the current viewer's user_id, returns a summary
 * for each user in the access list, with flags indicating what the viewer
 * can do to each entry.
 *
 * Anyone with access can see the full list. Mutation capabilities depend on role:
 *   - owner:  can remove anyone, change any role
 *   - admin:  can remove editor/viewer, change editor/viewer roles
 *   - editor: can grant access to others (any role), but not remove or change existing
 *   - viewer: read-only view of the access list
 */
export function buildAccessView(
  designation: FieldEncryptionDesignation,
  viewerUserId: string,
): FieldAccessSummary[] {
  const viewer = designation.access_list.find(e => e.user_id === viewerUserId);
  const viewerPL = viewer?.power_level ?? -1; // -1 if not in the list

  return designation.access_list.map(entry => ({
    user_id: entry.user_id,
    role: entry.role,
    power_level: entry.power_level,
    granted_at: entry.granted_at,
    granted_by: entry.granted_by,
    // Owner can remove/change anyone. Admin can manage those below them.
    can_remove: viewerPL >= 50 && entry.power_level < viewerPL,
    can_change_role: viewerPL >= 50 && entry.power_level < viewerPL,
  }));
}

// ─── Access List Mutations ──────────────────────────────────────────────────

/**
 * Add a user to a field's access list with a specific role.
 *
 * KEY DESIGN: Users CAN grant roles higher than their own.
 * An editor can make someone an owner. This enables delegation patterns
 * where the person setting up encryption isn't necessarily the most privileged.
 *
 * The only requirement to grant access: you must be in the access list yourself
 * (at any level, including viewer). If you can see the field, you can share it.
 *
 * Returns the updated designation. Caller must also invite the user to the key room
 * and set their Matrix power level there.
 */
export function addFieldAccess(
  designation: FieldEncryptionDesignation,
  userId: string,
  role: FieldAccessRole,
  grantedBy: string,
): FieldEncryptionDesignation {
  // Prevent duplicates — update role if already present
  const existing = designation.access_list.find(e => e.user_id === userId);
  if (existing) {
    return {
      ...designation,
      access_list: designation.access_list.map(e =>
        e.user_id === userId
          ? { ...e, role, power_level: FIELD_ACCESS_POWER_LEVELS[role] }
          : e
      ),
    };
  }

  return {
    ...designation,
    access_list: [
      ...designation.access_list,
      {
        user_id: userId,
        role,
        power_level: FIELD_ACCESS_POWER_LEVELS[role],
        granted_at: new Date().toISOString(),
        granted_by: grantedBy,
      },
    ],
  };
}

/**
 * Change a user's role on a field.
 *
 * Caller must have admin+ power level, OR be the owner.
 * Returns null if the user is not in the access list.
 */
export function changeFieldAccessRole(
  designation: FieldEncryptionDesignation,
  userId: string,
  newRole: FieldAccessRole,
): FieldEncryptionDesignation | null {
  const entry = designation.access_list.find(e => e.user_id === userId);
  if (!entry) return null;

  return {
    ...designation,
    access_list: designation.access_list.map(e =>
      e.user_id === userId
        ? { ...e, role: newRole, power_level: FIELD_ACCESS_POWER_LEVELS[newRole] }
        : e
    ),
  };
}

/**
 * Remove a user from a field's access list.
 *
 * IMPORTANT: After removing, the caller MUST rotate the key so the removed user
 * can't decrypt future writes with their cached key.
 *
 * Returns the updated designation with incremented key_version.
 * The new_key_id should come from a freshly generated segment key.
 */
export function removeFieldAccess(
  designation: FieldEncryptionDesignation,
  userId: string,
  newKeyId: string,
): FieldEncryptionDesignation {
  return {
    ...designation,
    access_list: designation.access_list.filter(e => e.user_id !== userId),
    key_id: newKeyId,
    key_version: designation.key_version + 1,
  };
}

/**
 * Check whether a user has access to a field-encrypted target.
 */
export function hasFieldAccess(
  designation: FieldEncryptionDesignation,
  userId: string,
): boolean {
  return designation.access_list.some(e => e.user_id === userId);
}

/**
 * Get a user's effective role on a field.
 */
export function getFieldAccessRole(
  designation: FieldEncryptionDesignation,
  userId: string,
): FieldAccessRole | null {
  const entry = designation.access_list.find(e => e.user_id === userId);
  return entry?.role ?? null;
}

/**
 * Check if a user can write to a field (editor+ power level).
 */
export function canWriteField(
  designation: FieldEncryptionDesignation,
  userId: string,
): boolean {
  const entry = designation.access_list.find(e => e.user_id === userId);
  return entry != null && entry.power_level >= FIELD_ACCESS_POWER_LEVELS.editor;
}

/**
 * Check if a user can manage a field's access list (admin+ power level).
 */
export function canManageFieldAccess(
  designation: FieldEncryptionDesignation,
  userId: string,
): boolean {
  const entry = designation.access_list.find(e => e.user_id === userId);
  return entry != null && entry.power_level >= FIELD_ACCESS_POWER_LEVELS.admin;
}

// ─── Resolution (for encrypt/decrypt middleware) ────────────────────────────

/**
 * Check if a target has a field-specific encryption designation.
 * Unlike waterfall encryption, field-encrypt only matches exact targets — not children.
 *
 * Returns the designation if the target itself is field-encrypted, null otherwise.
 */
export async function getFieldEncryptionDesignation(
  db: EoDb,
  target: string,
): Promise<FieldEncryptionDesignation | null> {
  const state = await getState(db, target);
  if (state?.value && isFieldEncryptionDesignation(state.value)) {
    return state.value;
  }
  return null;
}

/**
 * For a record target, find all its child fields that have field-specific encryption.
 * Used by the Horizon reader to know which columns need per-field decryption.
 */
export async function getEncryptedFieldsForRecord(
  db: EoDb,
  recordTarget: string,
): Promise<Map<string, FieldEncryptionDesignation>> {
  const children = await getStateByPrefix(db, recordTarget + '.');
  const targetDepth = recordTarget.split('.').length;
  const result = new Map<string, FieldEncryptionDesignation>();

  for (const child of children) {
    const parts = child.target.split('.');
    // Only direct children (fields)
    if (parts.length !== targetDepth + 1) continue;

    if (isFieldEncryptionDesignation(child.value)) {
      result.set(child.target, child.value);
    }
  }

  return result;
}
