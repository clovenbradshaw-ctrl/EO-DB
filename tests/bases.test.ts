import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import {
  createBase,
  getBase,
  updateBase,
  deleteBase,
  listBasesForUser,
  addBaseShare,
  updateBaseShare,
  removeBaseShare,
  getBaseSharing,
  checkBaseAccess,
} from '../src/db/bases.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

const OWNER = '@alice:homeserver.com';
const USER_B = '@bob:homeserver.com';
const USER_C = '@carol:homeserver.com';

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-bases-test-'));
  db = createDb(dbPath);
  await db.open();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

describe('Base CRUD', () => {
  it('creates a base with correct defaults', async () => {
    const base = await createBase(db, 'My Base', OWNER, 'A test base');
    expect(base.name).toBe('My Base');
    expect(base.description).toBe('A test base');
    expect(base.created_by).toBe(OWNER);
    expect(base.target_prefix).toBe(`base.${base.id}`);
    expect(base.sharing).toEqual([]);
  });

  it('retrieves a base by ID', async () => {
    const created = await createBase(db, 'Test', OWNER);
    const fetched = await getBase(db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('Test');
  });

  it('returns null for non-existent base', async () => {
    const fetched = await getBase(db, 'nonexistent');
    expect(fetched).toBeNull();
  });

  it('updates name and description', async () => {
    const base = await createBase(db, 'Old Name', OWNER);
    const updated = await updateBase(db, base.id, OWNER, { name: 'New Name', description: 'Updated' });
    expect(updated.name).toBe('New Name');
    expect(updated.description).toBe('Updated');
  });

  it('rejects update from non-owner', async () => {
    const base = await createBase(db, 'Test', OWNER);
    await expect(updateBase(db, base.id, USER_B, { name: 'Hacked' })).rejects.toThrow('owner');
  });

  it('deletes a base', async () => {
    const base = await createBase(db, 'To Delete', OWNER);
    await deleteBase(db, base.id, OWNER);
    expect(await getBase(db, base.id)).toBeNull();
  });

  it('rejects delete from non-owner', async () => {
    const base = await createBase(db, 'Test', OWNER);
    await expect(deleteBase(db, base.id, USER_B)).rejects.toThrow('owner');
  });
});

describe('listBasesForUser', () => {
  it('lists bases owned by user', async () => {
    await createBase(db, 'Base 1', OWNER);
    await createBase(db, 'Base 2', OWNER);
    await createBase(db, 'Not Mine', USER_B);

    const list = await listBasesForUser(db, OWNER);
    expect(list).toHaveLength(2);
    expect(list.every(b => b.your_access === 'read_write')).toBe(true);
  });

  it('includes shared bases', async () => {
    const base = await createBase(db, 'Shared', OWNER);
    await addBaseShare(db, base.id, USER_B, 'read', OWNER);

    const list = await listBasesForUser(db, USER_B);
    expect(list).toHaveLength(1);
    expect(list[0].your_access).toBe('read');
  });
});

describe('Sharing', () => {
  it('shares a base with a user', async () => {
    const base = await createBase(db, 'Test', OWNER);
    const updated = await addBaseShare(db, base.id, USER_B, 'read', OWNER);
    expect(updated.sharing).toHaveLength(1);
    expect(updated.sharing[0].user_id).toBe(USER_B);
    expect(updated.sharing[0].access).toBe('read');
  });

  it('updates existing share access level', async () => {
    const base = await createBase(db, 'Test', OWNER);
    await addBaseShare(db, base.id, USER_B, 'read', OWNER);
    const updated = await addBaseShare(db, base.id, USER_B, 'read_write', OWNER);
    expect(updated.sharing).toHaveLength(1);
    expect(updated.sharing[0].access).toBe('read_write');
  });

  it('rejects sharing by non-owner', async () => {
    const base = await createBase(db, 'Test', OWNER);
    await expect(addBaseShare(db, base.id, USER_C, 'read', USER_B)).rejects.toThrow('owner');
  });

  it('rejects sharing with self', async () => {
    const base = await createBase(db, 'Test', OWNER);
    await expect(addBaseShare(db, base.id, OWNER, 'read', OWNER)).rejects.toThrow('yourself');
  });

  it('updates share access via updateBaseShare', async () => {
    const base = await createBase(db, 'Test', OWNER);
    await addBaseShare(db, base.id, USER_B, 'read', OWNER);
    const updated = await updateBaseShare(db, base.id, USER_B, 'write', OWNER);
    expect(updated.sharing[0].access).toBe('write');
  });

  it('removes a share', async () => {
    const base = await createBase(db, 'Test', OWNER);
    await addBaseShare(db, base.id, USER_B, 'read', OWNER);
    const updated = await removeBaseShare(db, base.id, USER_B, OWNER);
    expect(updated.sharing).toHaveLength(0);

    // User should no longer see the base
    const list = await listBasesForUser(db, USER_B);
    expect(list).toHaveLength(0);
  });

  it('gets sharing info', async () => {
    const base = await createBase(db, 'Test', OWNER);
    await addBaseShare(db, base.id, USER_B, 'read', OWNER);
    await addBaseShare(db, base.id, USER_C, 'write', OWNER);

    const info = await getBaseSharing(db, base.id, OWNER);
    expect(info.owner).toBe(OWNER);
    expect(info.sharing).toHaveLength(2);
  });

  it('allows shared users to view sharing info', async () => {
    const base = await createBase(db, 'Test', OWNER);
    await addBaseShare(db, base.id, USER_B, 'read', OWNER);
    const info = await getBaseSharing(db, base.id, USER_B);
    expect(info.owner).toBe(OWNER);
  });

  it('rejects sharing info from non-members', async () => {
    const base = await createBase(db, 'Test', OWNER);
    await expect(getBaseSharing(db, base.id, USER_C)).rejects.toThrow('access');
  });
});

describe('checkBaseAccess', () => {
  it('owner has read_write', async () => {
    const base = await createBase(db, 'Test', OWNER);
    const result = await checkBaseAccess(db, base.id, OWNER);
    expect(result).toEqual({ allowed: true, access: 'read_write' });
  });

  it('shared user has their granted access', async () => {
    const base = await createBase(db, 'Test', OWNER);
    await addBaseShare(db, base.id, USER_B, 'read', OWNER);
    const result = await checkBaseAccess(db, base.id, USER_B);
    expect(result).toEqual({ allowed: true, access: 'read' });
  });

  it('unshared user is denied', async () => {
    const base = await createBase(db, 'Test', OWNER);
    const result = await checkBaseAccess(db, base.id, USER_C);
    expect(result).toEqual({ allowed: false, access: 'read' });
  });

  it('non-existent base is denied', async () => {
    const result = await checkBaseAccess(db, 'nonexistent', OWNER);
    expect(result).toEqual({ allowed: false, access: 'read' });
  });
});

describe('Delete base cleans up sharing indexes', () => {
  it('shared users no longer see deleted base', async () => {
    const base = await createBase(db, 'Test', OWNER);
    await addBaseShare(db, base.id, USER_B, 'read', OWNER);
    await deleteBase(db, base.id, OWNER);

    const ownerList = await listBasesForUser(db, OWNER);
    const userList = await listBasesForUser(db, USER_B);
    expect(ownerList).toHaveLength(0);
    expect(userList).toHaveLength(0);
  });
});
