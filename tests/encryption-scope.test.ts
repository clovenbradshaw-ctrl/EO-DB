import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import { getEncryptionScope } from '../src/db/encryption-scope.js';
import { setState } from '../src/db/state.js';
import type { EoState } from '../src/db/types.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

function makeState(target: string, value: any = {}): EoState {
  return {
    target,
    value,
    last_seq: 1,
    last_op: 'SEG',
    last_agent: '@test:example.com',
    last_ts: '2025-06-01T00:00:00.000Z',
    last_acquired_ts: '2025-06-01T00:00:00.000Z',
  };
}

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-test-'));
  db = createDb(dbPath);
  await db.open();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

describe('getEncryptionScope', () => {
  it('returns null when no encryption boundary exists', async () => {
    await setState(db, makeState('app.tblClients', { boundary: 'standard' }));
    const scope = await getEncryptionScope(db, 'app.tblClients.rec001');
    expect(scope).toBeNull();
  });

  it('finds direct boundary on target', async () => {
    await setState(db, makeState('app.tblClients', {
      boundary: 'encrypt',
      key_id: 'key-uuid-1',
      key_version: 2,
      _encrypted: false,
    }));
    const scope = await getEncryptionScope(db, 'app.tblClients');
    expect(scope).not.toBeNull();
    expect(scope!.key_id).toBe('key-uuid-1');
    expect(scope!.scope).toBe('app.tblClients');
    expect(scope!.key_version).toBe(2);
  });

  it('inherits boundary from parent (waterfall)', async () => {
    await setState(db, makeState('app.tblClients', {
      boundary: 'encrypt',
      key_id: 'key-uuid-1',
      key_version: 1,
      _encrypted: false,
    }));
    const scope = await getEncryptionScope(db, 'app.tblClients.rec001.fldSSN');
    expect(scope).not.toBeNull();
    expect(scope!.key_id).toBe('key-uuid-1');
    expect(scope!.scope).toBe('app.tblClients');
  });

  it('returns most specific (deepest) boundary', async () => {
    // Parent boundary
    await setState(db, makeState('app', {
      boundary: 'encrypt',
      key_id: 'parent-key',
      _encrypted: false,
    }));
    // More specific boundary
    await setState(db, makeState('app.tblClients', {
      boundary: 'encrypt',
      key_id: 'child-key',
      key_version: 3,
      _encrypted: false,
    }));
    const scope = await getEncryptionScope(db, 'app.tblClients.rec001');
    expect(scope!.key_id).toBe('child-key');
    expect(scope!.scope).toBe('app.tblClients');
  });

  it('defaults key_version to 1 when missing', async () => {
    await setState(db, makeState('app.tblClients', {
      boundary: 'encrypt',
      key_id: 'key-uuid-1',
      _encrypted: false,
    }));
    const scope = await getEncryptionScope(db, 'app.tblClients.rec001');
    expect(scope!.key_version).toBe(1);
  });

  it('returns null for root-level target with no boundary', async () => {
    const scope = await getEncryptionScope(db, 'app');
    expect(scope).toBeNull();
  });
});
