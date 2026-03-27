import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClassicLevel } from 'classic-level';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getMatrixAuthConfig,
  setMatrixAuthConfig,
  setMatrixAuthEnabled,
  addAllowedAccount,
  removeAllowedAccount,
  addAllowedHomeserver,
  removeAllowedHomeserver,
  isAccountAllowed,
  isHomeserverAllowed,
  addBlacklistedAccount,
  removeBlacklistedAccount,
  setServerRule,
  removeServerRule,
  createUserRulesBucket,
  deleteUserRulesBucket,
  updateUserRulesBucket,
  addBucketMember,
  removeBucketMember,
  addBucketServerMember,
  removeBucketServerMember,
  checkAccess,
  extractHomeserver,
  accessSatisfies,
} from '../src/auth/matrix-auth-config.js';
import type { EoDb } from '../src/db/level.js';

let db: EoDb;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'eo-matrix-auth-test-'));
  db = new ClassicLevel<string, Buffer>(tmpDir, {
    keyEncoding: 'utf8',
    valueEncoding: 'buffer',
  });
  await db.open();
});

afterEach(async () => {
  await db.close();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('getMatrixAuthConfig', () => {
  it('returns default config when none exists', async () => {
    const config = await getMatrixAuthConfig(db);
    expect(config.enabled).toBe(false);
    expect(config.allowed_accounts).toEqual([]);
    expect(config.allowed_homeservers).toEqual([]);
    expect(config.server_rules).toEqual([]);
    expect(config.blacklisted_accounts).toEqual([]);
    expect(config.user_rules_buckets).toEqual([]);
    expect(config.encryption.enabled).toBe(false);
    expect(config.updated_by).toBe('system');
  });

  it('round-trips config through DB', async () => {
    const config = await getMatrixAuthConfig(db);
    config.enabled = true;
    config.allowed_accounts.push({
      user_id: '@test:app.aminoimmigration.com',
      access: 'read_write',
      added_at: new Date().toISOString(),
      added_by: '@admin:app.aminoimmigration.com',
    });
    await setMatrixAuthConfig(db, config);

    const loaded = await getMatrixAuthConfig(db);
    expect(loaded.enabled).toBe(true);
    expect(loaded.allowed_accounts).toHaveLength(1);
    expect(loaded.allowed_accounts[0].user_id).toBe('@test:app.aminoimmigration.com');
    expect(loaded.allowed_accounts[0].access).toBe('read_write');
  });

  it('normalizes old configs without new fields', async () => {
    // Simulate an old config stored without the new fields
    const { encode } = await import('../src/db/level.js');
    const oldConfig = {
      enabled: true,
      allowed_homeservers: ['example.com'],
      allowed_accounts: [
        { user_id: '@old:example.com', added_at: '2024-01-01', added_by: '@admin:example.com' },
      ],
      encryption: { enabled: false },
      updated_at: '2024-01-01',
      updated_by: '@admin:example.com',
    };
    await db.put('meta:matrix_auth_config', encode(oldConfig));

    const loaded = await getMatrixAuthConfig(db);
    expect(loaded.server_rules).toEqual([]);
    expect(loaded.blacklisted_accounts).toEqual([]);
    expect(loaded.user_rules_buckets).toEqual([]);
    // Old account should get default access level
    expect(loaded.allowed_accounts[0].access).toBe('read_write');
  });
});

describe('setMatrixAuthEnabled', () => {
  it('toggles enabled flag', async () => {
    const c1 = await setMatrixAuthEnabled(db, true, '@admin:example.com');
    expect(c1.enabled).toBe(true);
    expect(c1.updated_by).toBe('@admin:example.com');

    const c2 = await setMatrixAuthEnabled(db, false, '@admin:example.com');
    expect(c2.enabled).toBe(false);
  });
});

describe('addAllowedAccount / removeAllowedAccount', () => {
  it('adds accounts with default read_write access', async () => {
    const config = await addAllowedAccount(
      db,
      '@caseworker:app.aminoimmigration.com',
      '@admin:app.aminoimmigration.com',
      'Maria',
    );
    expect(config.allowed_accounts).toHaveLength(1);
    expect(config.allowed_accounts[0].user_id).toBe('@caseworker:app.aminoimmigration.com');
    expect(config.allowed_accounts[0].label).toBe('Maria');
    expect(config.allowed_accounts[0].access).toBe('read_write');
  });

  it('adds accounts with explicit read-only access', async () => {
    const config = await addAllowedAccount(
      db,
      '@reader:example.com',
      '@admin:example.com',
      'Reader',
      'read',
    );
    expect(config.allowed_accounts[0].access).toBe('read');
  });

  it('updates access level on duplicate add', async () => {
    await addAllowedAccount(db, '@user:example.com', '@admin:example.com', undefined, 'read');
    const config = await addAllowedAccount(db, '@user:example.com', '@admin:example.com', undefined, 'write');
    expect(config.allowed_accounts).toHaveLength(1);
    expect(config.allowed_accounts[0].access).toBe('write');
  });

  it('removes accounts from the allowlist', async () => {
    await addAllowedAccount(db, '@user1:example.com', '@admin:example.com');
    await addAllowedAccount(db, '@user2:example.com', '@admin:example.com');

    const config = await removeAllowedAccount(db, '@user1:example.com', '@admin:example.com');
    expect(config.allowed_accounts).toHaveLength(1);
    expect(config.allowed_accounts[0].user_id).toBe('@user2:example.com');
  });
});

describe('blacklist', () => {
  it('adds and removes blacklisted accounts', async () => {
    const c1 = await addBlacklistedAccount(db, '@bad:example.com', '@admin:example.com', 'spam');
    expect(c1.blacklisted_accounts).toHaveLength(1);
    expect(c1.blacklisted_accounts[0].user_id).toBe('@bad:example.com');
    expect(c1.blacklisted_accounts[0].reason).toBe('spam');

    const c2 = await removeBlacklistedAccount(db, '@bad:example.com', '@admin:example.com');
    expect(c2.blacklisted_accounts).toHaveLength(0);
  });

  it('prevents duplicate blacklist entries', async () => {
    await addBlacklistedAccount(db, '@bad:example.com', '@admin:example.com');
    const config = await addBlacklistedAccount(db, '@bad:example.com', '@admin:example.com');
    expect(config.blacklisted_accounts).toHaveLength(1);
  });
});

describe('server rules', () => {
  it('adds a server rule with accept_all mode', async () => {
    const config = await setServerRule(db, 'example.com', 'accept_all', 'read', '@admin:example.com');
    expect(config.server_rules).toHaveLength(1);
    expect(config.server_rules[0].homeserver).toBe('example.com');
    expect(config.server_rules[0].mode).toBe('accept_all');
    expect(config.server_rules[0].default_access).toBe('read');
  });

  it('updates an existing server rule', async () => {
    await setServerRule(db, 'example.com', 'accept_all', 'read', '@admin:example.com');
    const config = await setServerRule(db, 'example.com', 'blacklist', 'read_write', '@admin:example.com');
    expect(config.server_rules).toHaveLength(1);
    expect(config.server_rules[0].mode).toBe('blacklist');
    expect(config.server_rules[0].default_access).toBe('read_write');
  });

  it('removes a server rule', async () => {
    await setServerRule(db, 'example.com', 'accept_all', 'read', '@admin:example.com');
    const config = await removeServerRule(db, 'example.com', '@admin:example.com');
    expect(config.server_rules).toHaveLength(0);
  });
});

describe('user rules buckets', () => {
  it('creates a bucket', async () => {
    const config = await createUserRulesBucket(db, 'auditors', 'read', '@admin:example.com', 'Read-only auditors');
    expect(config.user_rules_buckets).toHaveLength(1);
    const bucket = config.user_rules_buckets[0];
    expect(bucket.name).toBe('auditors');
    expect(bucket.access).toBe('read');
    expect(bucket.description).toBe('Read-only auditors');
    expect(bucket.members).toEqual([]);
    expect(bucket.server_members).toEqual([]);
  });

  it('rejects duplicate bucket names', async () => {
    await createUserRulesBucket(db, 'auditors', 'read', '@admin:example.com');
    await expect(
      createUserRulesBucket(db, 'auditors', 'write', '@admin:example.com'),
    ).rejects.toThrow('already exists');
  });

  it('updates a bucket', async () => {
    await createUserRulesBucket(db, 'team', 'read', '@admin:example.com');
    const config = await updateUserRulesBucket(db, 'team', '@admin:example.com', {
      access: 'read_write',
      description: 'Full access team',
    });
    const bucket = config.user_rules_buckets.find(b => b.name === 'team')!;
    expect(bucket.access).toBe('read_write');
    expect(bucket.description).toBe('Full access team');
  });

  it('deletes a bucket', async () => {
    await createUserRulesBucket(db, 'temp', 'read', '@admin:example.com');
    const config = await deleteUserRulesBucket(db, 'temp', '@admin:example.com');
    expect(config.user_rules_buckets).toHaveLength(0);
  });

  it('adds and removes members', async () => {
    await createUserRulesBucket(db, 'writers', 'write', '@admin:example.com');
    const c1 = await addBucketMember(db, 'writers', '@user1:example.com', '@admin:example.com');
    expect(c1.user_rules_buckets[0].members).toEqual(['@user1:example.com']);

    // Duplicate is a no-op
    const c2 = await addBucketMember(db, 'writers', '@user1:example.com', '@admin:example.com');
    expect(c2.user_rules_buckets[0].members).toHaveLength(1);

    const c3 = await removeBucketMember(db, 'writers', '@user1:example.com', '@admin:example.com');
    expect(c3.user_rules_buckets[0].members).toHaveLength(0);
  });

  it('adds and removes server members', async () => {
    await createUserRulesBucket(db, 'org', 'read_write', '@admin:example.com');
    const c1 = await addBucketServerMember(db, 'org', 'corp.example.com', '@admin:example.com');
    expect(c1.user_rules_buckets[0].server_members).toEqual(['corp.example.com']);

    const c2 = await removeBucketServerMember(db, 'org', 'corp.example.com', '@admin:example.com');
    expect(c2.user_rules_buckets[0].server_members).toHaveLength(0);
  });

  it('throws on operations against nonexistent buckets', async () => {
    await expect(addBucketMember(db, 'nope', '@u:e.com', '@a:e.com')).rejects.toThrow('not found');
    await expect(removeBucketMember(db, 'nope', '@u:e.com', '@a:e.com')).rejects.toThrow('not found');
    await expect(updateUserRulesBucket(db, 'nope', '@a:e.com', {})).rejects.toThrow('not found');
  });
});

describe('extractHomeserver', () => {
  it('extracts the homeserver from a Matrix user ID', () => {
    expect(extractHomeserver('@user:example.com')).toBe('example.com');
    expect(extractHomeserver('@user:app.amino.com')).toBe('app.amino.com');
  });

  it('returns empty string for malformed IDs', () => {
    expect(extractHomeserver('nocolon')).toBe('');
  });
});

describe('accessSatisfies', () => {
  it('read_write satisfies both read and write', () => {
    expect(accessSatisfies('read_write', 'read')).toBe(true);
    expect(accessSatisfies('read_write', 'write')).toBe(true);
  });

  it('read satisfies only read', () => {
    expect(accessSatisfies('read', 'read')).toBe(true);
    expect(accessSatisfies('read', 'write')).toBe(false);
  });

  it('write satisfies only write', () => {
    expect(accessSatisfies('write', 'write')).toBe(true);
    expect(accessSatisfies('write', 'read')).toBe(false);
  });
});

describe('checkAccess', () => {
  it('allows everything when auth is disabled', async () => {
    const result = await checkAccess(db, '@anyone:anywhere.com');
    expect(result.allowed).toBe(true);
    expect(result.access).toBe('read_write');
    expect(result.source).toBe('disabled');
  });

  it('denies blacklisted accounts even with other grants', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await addAllowedAccount(db, '@bad:example.com', '@admin:example.com', undefined, 'read_write');
    await addBlacklistedAccount(db, '@bad:example.com', '@admin:example.com');

    const result = await checkAccess(db, '@bad:example.com');
    expect(result.allowed).toBe(false);
    expect(result.source).toBe('blacklist');
  });

  it('grants access from explicit account entry', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await addAllowedAccount(db, '@reader:example.com', '@admin:example.com', undefined, 'read');

    const result = await checkAccess(db, '@reader:example.com');
    expect(result.allowed).toBe(true);
    expect(result.access).toBe('read');
    expect(result.source).toBe('account');
  });

  it('grants access from bucket membership', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await createUserRulesBucket(db, 'writers', 'write', '@admin:example.com');
    await addBucketMember(db, 'writers', '@user:example.com', '@admin:example.com');

    const result = await checkAccess(db, '@user:example.com');
    expect(result.allowed).toBe(true);
    expect(result.access).toBe('write');
    expect(result.source).toBe('bucket');
  });

  it('merges access across multiple buckets', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await createUserRulesBucket(db, 'readers', 'read', '@admin:example.com');
    await createUserRulesBucket(db, 'writers', 'write', '@admin:example.com');
    await addBucketMember(db, 'readers', '@user:example.com', '@admin:example.com');
    await addBucketMember(db, 'writers', '@user:example.com', '@admin:example.com');

    const result = await checkAccess(db, '@user:example.com');
    expect(result.allowed).toBe(true);
    expect(result.access).toBe('read_write');
    expect(result.source).toBe('bucket');
  });

  it('grants access from bucket server membership', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await createUserRulesBucket(db, 'org', 'read', '@admin:example.com');
    await addBucketServerMember(db, 'org', 'corp.example.com', '@admin:example.com');

    const result = await checkAccess(db, '@employee:corp.example.com');
    expect(result.allowed).toBe(true);
    expect(result.access).toBe('read');
    expect(result.source).toBe('bucket');
  });

  it('grants access from accept_all server rule', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await setServerRule(db, 'open.example.com', 'accept_all', 'read', '@admin:example.com');

    const result = await checkAccess(db, '@someone:open.example.com');
    expect(result.allowed).toBe(true);
    expect(result.access).toBe('read');
    expect(result.source).toBe('server_rule');
  });

  it('grants access from blacklist-mode server rule when not blacklisted', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await setServerRule(db, 'example.com', 'blacklist', 'read_write', '@admin:example.com');

    const result = await checkAccess(db, '@normal:example.com');
    expect(result.allowed).toBe(true);
    expect(result.access).toBe('read_write');
    expect(result.source).toBe('server_rule');
  });

  it('denies non-whitelisted users under whitelist server rule', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await setServerRule(db, 'example.com', 'whitelist', 'read_write', '@admin:example.com');

    const result = await checkAccess(db, '@stranger:example.com');
    expect(result.allowed).toBe(false);
    expect(result.source).toBe('denied');
  });

  it('allows whitelisted users under whitelist server rule via account entry', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await setServerRule(db, 'example.com', 'whitelist', 'read_write', '@admin:example.com');
    await addAllowedAccount(db, '@special:example.com', '@admin:example.com', undefined, 'read');

    const result = await checkAccess(db, '@special:example.com');
    expect(result.allowed).toBe(true);
    expect(result.access).toBe('read');
    expect(result.source).toBe('account');
  });

  it('falls back to legacy allowed_homeservers', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await addAllowedHomeserver(db, 'legacy.example.com', '@admin:example.com');

    const result = await checkAccess(db, '@user:legacy.example.com');
    expect(result.allowed).toBe(true);
    expect(result.access).toBe('read_write');
  });

  it('denies when no rules match', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');

    const result = await checkAccess(db, '@nobody:nowhere.com');
    expect(result.allowed).toBe(false);
    expect(result.source).toBe('denied');
  });
});

describe('isAccountAllowed (backwards compatibility)', () => {
  it('allows all accounts when gating is disabled', async () => {
    const allowed = await isAccountAllowed(db, '@anyone:example.com');
    expect(allowed).toBe(true);
  });

  it('rejects accounts not in allowlist when enabled', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await addAllowedAccount(db, '@allowed:example.com', '@admin:example.com');

    expect(await isAccountAllowed(db, '@allowed:example.com')).toBe(true);
    expect(await isAccountAllowed(db, '@stranger:example.com')).toBe(false);
  });

  it('rejects all accounts when enabled with empty allowlist', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    expect(await isAccountAllowed(db, '@anyone:example.com')).toBe(false);
  });
});

describe('homeserver allowlist', () => {
  it('allows all homeservers when gating is disabled', async () => {
    expect(await isHomeserverAllowed(db, 'https://random.server')).toBe(true);
  });

  it('allows all homeservers when list is empty (even if enabled)', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    expect(await isHomeserverAllowed(db, 'https://random.server')).toBe(true);
  });

  it('restricts to listed homeservers when populated', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await addAllowedHomeserver(db, 'https://app.aminoimmigration.com', '@admin:example.com');

    expect(await isHomeserverAllowed(db, 'https://app.aminoimmigration.com')).toBe(true);
    expect(await isHomeserverAllowed(db, 'https://evil.server')).toBe(false);
  });

  it('removes homeservers', async () => {
    await addAllowedHomeserver(db, 'https://a.com', '@admin:example.com');
    await addAllowedHomeserver(db, 'https://b.com', '@admin:example.com');
    const config = await removeAllowedHomeserver(db, 'https://a.com', '@admin:example.com');
    expect(config.allowed_homeservers).toEqual(['https://b.com']);
  });
});

describe('encryption config structure', () => {
  it('preserves encryption fields through round-trip', async () => {
    const config = await getMatrixAuthConfig(db);
    config.encryption = {
      enabled: false,
      algorithm: 'm.megolm.v1.aes-sha2',
      key_version: 1,
    };
    await setMatrixAuthConfig(db, config);

    const loaded = await getMatrixAuthConfig(db);
    expect(loaded.encryption.algorithm).toBe('m.megolm.v1.aes-sha2');
    expect(loaded.encryption.key_version).toBe(1);
    expect(loaded.encryption.enabled).toBe(false);
  });
});
