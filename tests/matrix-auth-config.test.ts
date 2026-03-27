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
    expect(config.encryption.enabled).toBe(false);
    expect(config.updated_by).toBe('system');
  });

  it('round-trips config through DB', async () => {
    const config = await getMatrixAuthConfig(db);
    config.enabled = true;
    config.allowed_accounts.push({
      user_id: '@test:app.aminoimmigration.com',
      added_at: new Date().toISOString(),
      added_by: '@admin:app.aminoimmigration.com',
    });
    await setMatrixAuthConfig(db, config);

    const loaded = await getMatrixAuthConfig(db);
    expect(loaded.enabled).toBe(true);
    expect(loaded.allowed_accounts).toHaveLength(1);
    expect(loaded.allowed_accounts[0].user_id).toBe('@test:app.aminoimmigration.com');
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
  it('adds accounts to the allowlist', async () => {
    const config = await addAllowedAccount(
      db,
      '@caseworker:app.aminoimmigration.com',
      '@admin:app.aminoimmigration.com',
      'Maria',
    );
    expect(config.allowed_accounts).toHaveLength(1);
    expect(config.allowed_accounts[0].user_id).toBe('@caseworker:app.aminoimmigration.com');
    expect(config.allowed_accounts[0].label).toBe('Maria');
  });

  it('prevents duplicate accounts', async () => {
    await addAllowedAccount(db, '@user:example.com', '@admin:example.com');
    const config = await addAllowedAccount(db, '@user:example.com', '@admin:example.com');
    expect(config.allowed_accounts).toHaveLength(1);
  });

  it('removes accounts from the allowlist', async () => {
    await addAllowedAccount(db, '@user1:example.com', '@admin:example.com');
    await addAllowedAccount(db, '@user2:example.com', '@admin:example.com');

    const config = await removeAllowedAccount(db, '@user1:example.com', '@admin:example.com');
    expect(config.allowed_accounts).toHaveLength(1);
    expect(config.allowed_accounts[0].user_id).toBe('@user2:example.com');
  });
});

describe('isAccountAllowed', () => {
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
