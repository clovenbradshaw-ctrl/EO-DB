import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClassicLevel } from 'classic-level';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  setMatrixAuthEnabled,
  setServerRule,
  isHomeserverAllowed,
  addAllowedHomeserver,
} from '../src/auth/matrix-auth-config.js';
import type { EoDb } from '../src/db/level.js';

let db: EoDb;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'eo-auth-regression-'));
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

describe('isHomeserverAllowed — server_rules code path', () => {
  it('allows homeserver with accept_all rule', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await setServerRule(db, 'matrix.example.com', 'accept_all', 'read_write', '@admin:example.com');
    expect(await isHomeserverAllowed(db, 'matrix.example.com')).toBe(true);
  });

  it('allows homeserver with whitelist rule (server allowed, users gated)', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await setServerRule(db, 'matrix.example.com', 'whitelist', 'read', '@admin:example.com');
    expect(await isHomeserverAllowed(db, 'matrix.example.com')).toBe(true);
  });

  it('allows homeserver with blacklist rule (server allowed, specific users blocked)', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await setServerRule(db, 'matrix.example.com', 'blacklist', 'read_write', '@admin:example.com');
    expect(await isHomeserverAllowed(db, 'matrix.example.com')).toBe(true);
  });

  it('falls through to legacy list when no server rule matches', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await setServerRule(db, 'other.server', 'accept_all', 'read', '@admin:example.com');
    await addAllowedHomeserver(db, 'legacy.server', '@admin:example.com');
    // Has server rule for other.server but not for query target
    expect(await isHomeserverAllowed(db, 'legacy.server')).toBe(true);
    expect(await isHomeserverAllowed(db, 'unknown.server')).toBe(false);
  });

  it('returns true when auth is disabled regardless of rules', async () => {
    // Auth disabled by default
    expect(await isHomeserverAllowed(db, 'any.server')).toBe(true);
  });

  it('allows all when enabled with no rules and empty legacy list', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    expect(await isHomeserverAllowed(db, 'any.server')).toBe(true);
  });

  it('rejects unlisted homeserver when legacy list is populated', async () => {
    await setMatrixAuthEnabled(db, true, '@admin:example.com');
    await addAllowedHomeserver(db, 'allowed.server', '@admin:example.com');
    expect(await isHomeserverAllowed(db, 'blocked.server')).toBe(false);
  });
});
