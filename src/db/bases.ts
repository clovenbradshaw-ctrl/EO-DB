import type { EoDb } from './level.js';
import { encode, decode } from './level.js';
import { v4 as uuidv4 } from 'uuid';
import type { AccessLevel } from '../auth/matrix-auth-config.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A sharing entry granting a Matrix user access to a base. */
export interface BaseShare {
  /** Full Matrix user ID, e.g. "@user:homeserver.com" */
  user_id: string;
  /** What this user can do within this base */
  access: AccessLevel;
  /** When this share was created */
  added_at: string;
  /** Who granted this share (Matrix user ID) */
  added_by: string;
}

/** A named workspace/container that scopes data and sharing. */
export interface Base {
  /** Unique identifier (UUID) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** The target namespace prefix this base owns (e.g. "base.{id}") */
  target_prefix: string;
  /** Matrix user ID of the creator (implicit owner with full access) */
  created_by: string;
  /** When this base was created */
  created_at: string;
  /** Who last modified this base */
  updated_by: string;
  /** When this base was last modified */
  updated_at: string;
  /** Per-user sharing entries */
  sharing: BaseShare[];
}

/** Summary returned when listing bases. */
export interface BaseSummary {
  id: string;
  name: string;
  description?: string;
  target_prefix: string;
  created_by: string;
  created_at: string;
  your_access: AccessLevel;
}

// ─── Key helpers ─────────────────────────────────────────────────────────────

function baseKey(id: string): string {
  return `base:${id}`;
}

function baseUserIndexKey(user_id: string, base_id: string): string {
  return `base_idx:user:${user_id}:${base_id}`;
}

// ─── Internal read/write ─────────────────────────────────────────────────────

async function getBaseById(db: EoDb, id: string): Promise<Base | null> {
  try {
    const buf = await db.get(baseKey(id));
    return decode(buf) as Base;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

async function putBase(db: EoDb, base: Base): Promise<void> {
  await db.put(baseKey(base.id), encode(base));
}

async function putUserIndex(db: EoDb, user_id: string, base_id: string): Promise<void> {
  await db.put(baseUserIndexKey(user_id, base_id), encode(true));
}

async function deleteUserIndex(db: EoDb, user_id: string, base_id: string): Promise<void> {
  try {
    await db.del(baseUserIndexKey(user_id, base_id));
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/** Create a new base. The creator is the implicit owner. */
export async function createBase(
  db: EoDb,
  name: string,
  actor: string,
  description?: string,
): Promise<Base> {
  const id = uuidv4();
  const now = new Date().toISOString();
  const base: Base = {
    id,
    name,
    description,
    target_prefix: `base.${id}`,
    created_by: actor,
    created_at: now,
    updated_by: actor,
    updated_at: now,
    sharing: [],
  };
  await putBase(db, base);
  // Index the owner
  await putUserIndex(db, actor, id);
  return base;
}

/** Get a base by ID. Returns null if not found. */
export async function getBase(db: EoDb, id: string): Promise<Base | null> {
  return getBaseById(db, id);
}

/** Update a base's name and/or description. Only the owner can do this. */
export async function updateBase(
  db: EoDb,
  id: string,
  actor: string,
  updates: { name?: string; description?: string },
): Promise<Base> {
  const base = await getBaseById(db, id);
  if (!base) throw new Error(`Base "${id}" not found`);
  if (base.created_by !== actor) throw new Error('Only the base owner can update it');

  if (updates.name !== undefined) base.name = updates.name;
  if (updates.description !== undefined) base.description = updates.description;
  base.updated_by = actor;
  base.updated_at = new Date().toISOString();
  await putBase(db, base);
  return base;
}

/** Delete a base. Only the owner can do this. */
export async function deleteBase(db: EoDb, id: string, actor: string): Promise<void> {
  const base = await getBaseById(db, id);
  if (!base) throw new Error(`Base "${id}" not found`);
  if (base.created_by !== actor) throw new Error('Only the base owner can delete it');

  // Remove all user index entries
  await deleteUserIndex(db, base.created_by, id);
  for (const share of base.sharing) {
    await deleteUserIndex(db, share.user_id, id);
  }
  await db.del(baseKey(id));
}

/** List all bases accessible to a user (owned + shared). */
export async function listBasesForUser(db: EoDb, user_id: string): Promise<BaseSummary[]> {
  const prefix = `base_idx:user:${user_id}:`;
  const summaries: BaseSummary[] = [];

  for await (const key of db.keys({ gte: prefix, lt: prefix + '\xff' })) {
    const base_id = key.slice(prefix.length);
    const base = await getBaseById(db, base_id);
    if (!base) continue;

    let your_access: AccessLevel = 'read_write';
    if (base.created_by !== user_id) {
      const share = base.sharing.find(s => s.user_id === user_id);
      your_access = share?.access ?? 'read';
    }

    summaries.push({
      id: base.id,
      name: base.name,
      description: base.description,
      target_prefix: base.target_prefix,
      created_by: base.created_by,
      created_at: base.created_at,
      your_access,
    });
  }

  return summaries;
}

// ─── Sharing ─────────────────────────────────────────────────────────────────

/** Share a base with a Matrix user. Only the owner can share. */
export async function addBaseShare(
  db: EoDb,
  base_id: string,
  target_user_id: string,
  access: AccessLevel,
  actor: string,
): Promise<Base> {
  const base = await getBaseById(db, base_id);
  if (!base) throw new Error(`Base "${base_id}" not found`);
  if (base.created_by !== actor) throw new Error('Only the base owner can manage sharing');
  if (target_user_id === actor) throw new Error('Cannot share a base with yourself (you are the owner)');

  const now = new Date().toISOString();
  const existing = base.sharing.find(s => s.user_id === target_user_id);
  if (existing) {
    existing.access = access;
    existing.added_by = actor;
    existing.added_at = now;
  } else {
    base.sharing.push({
      user_id: target_user_id,
      access,
      added_at: now,
      added_by: actor,
    });
  }

  base.updated_by = actor;
  base.updated_at = now;
  await putBase(db, base);
  await putUserIndex(db, target_user_id, base_id);
  return base;
}

/** Update an existing share's access level. */
export async function updateBaseShare(
  db: EoDb,
  base_id: string,
  target_user_id: string,
  access: AccessLevel,
  actor: string,
): Promise<Base> {
  const base = await getBaseById(db, base_id);
  if (!base) throw new Error(`Base "${base_id}" not found`);
  if (base.created_by !== actor) throw new Error('Only the base owner can manage sharing');

  const share = base.sharing.find(s => s.user_id === target_user_id);
  if (!share) throw new Error(`User "${target_user_id}" does not have access to this base`);

  share.access = access;
  base.updated_by = actor;
  base.updated_at = new Date().toISOString();
  await putBase(db, base);
  return base;
}

/** Remove a user's access to a base. */
export async function removeBaseShare(
  db: EoDb,
  base_id: string,
  target_user_id: string,
  actor: string,
): Promise<Base> {
  const base = await getBaseById(db, base_id);
  if (!base) throw new Error(`Base "${base_id}" not found`);
  if (base.created_by !== actor) throw new Error('Only the base owner can manage sharing');

  base.sharing = base.sharing.filter(s => s.user_id !== target_user_id);
  base.updated_by = actor;
  base.updated_at = new Date().toISOString();
  await putBase(db, base);
  await deleteUserIndex(db, target_user_id, base_id);
  return base;
}

/** Get sharing info for a base. User must be owner or have access. */
export async function getBaseSharing(
  db: EoDb,
  base_id: string,
  actor: string,
): Promise<{ owner: string; sharing: BaseShare[] }> {
  const base = await getBaseById(db, base_id);
  if (!base) throw new Error(`Base "${base_id}" not found`);

  const hasAccess = base.created_by === actor || base.sharing.some(s => s.user_id === actor);
  if (!hasAccess) throw new Error('You do not have access to this base');

  return { owner: base.created_by, sharing: base.sharing };
}

/** Check if a user can access a specific base and at what level. */
export async function checkBaseAccess(
  db: EoDb,
  base_id: string,
  user_id: string,
): Promise<{ allowed: boolean; access: AccessLevel }> {
  const base = await getBaseById(db, base_id);
  if (!base) return { allowed: false, access: 'read' };

  if (base.created_by === user_id) {
    return { allowed: true, access: 'read_write' };
  }

  const share = base.sharing.find(s => s.user_id === user_id);
  if (share) {
    return { allowed: true, access: share.access };
  }

  return { allowed: false, access: 'read' };
}
