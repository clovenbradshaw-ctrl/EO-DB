import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import { processEvent } from '../src/db/fold.js';
import { getState } from '../src/db/state.js';
import type { EoEventInput } from '../src/db/types.js';
import {
  generateSegmentKey,
  encryptOperand,
  decryptOperand,
  createKeyring,
  addToKeyring,
} from '../src/crypto/segment-keys.js';
import {
  type FieldEncryptionDesignation,
  type FieldAccessEntry,
  isFieldEncryptionDesignation,
  addFieldAccess,
  removeFieldAccess,
  changeFieldAccessRole,
  hasFieldAccess,
  getFieldAccessRole,
  canWriteField,
  canManageFieldAccess,
  buildAccessView,
  powerLevelToFieldRole,
  FIELD_ACCESS_POWER_LEVELS,
  registerFieldEncryption,
  getFieldEncryption,
  listFieldEncryptions,
  unregisterFieldEncryption,
  getFieldEncryptionDesignation,
  getEncryptedFieldsForRecord,
} from '../src/crypto/field-access-control.js';
import {
  maybeEncryptForWrite,
  maybeDecryptForRead,
  decryptRecordFields,
  disabledMiddleware,
  isRedactedValue,
  type EncryptionMiddlewareConfig,
} from '../src/crypto/encrypt-middleware.js';
import {
  resolveEncryptionPolicy,
  deriveKeyScope,
  shouldEncryptField,
  isEncryptionPolicy,
  type FieldEncryptionPolicy,
} from '../src/crypto/field-level-policy.js';
import {
  resolveKeyRooms,
  resolvableScopes,
  type KeyRoomTopology,
  type KeyRoomBinding,
} from '../src/crypto/key-room-topology.js';
import { isEncryptedOperand } from '../src/db/crypto-types.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

const OWNER = '@alice:matrix.example.com';
const ADMIN = '@bob:matrix.example.com';
const EDITOR = '@carol:matrix.example.com';
const VIEWER = '@dave:matrix.example.com';
const OUTSIDER = '@eve:matrix.example.com';
const TS = '2025-06-01T00:00:00.000Z';

function ev(overrides: Partial<EoEventInput>): EoEventInput {
  return {
    op: 'INS',
    target: 'app.tblClients.rec001',
    operand: {},
    agent: OWNER,
    ts: TS,
    acquired_ts: TS,
    ...overrides,
  };
}

function makeDesignation(overrides?: Partial<FieldEncryptionDesignation>): FieldEncryptionDesignation {
  return {
    boundary: 'field-encrypt',
    key_id: 'key-001',
    algorithm: 'aes-256-gcm',
    key_version: 1,
    key_room_id: '!keyroom:matrix.example.com',
    access_list: [
      {
        user_id: OWNER,
        role: 'owner',
        power_level: 100,
        granted_at: TS,
        granted_by: OWNER,
      },
    ],
    designated_by: OWNER,
    designated_at: TS,
    ...overrides,
  };
}

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-field-enc-'));
  db = createDb(dbPath);
  await db.open();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

// ─── Field Access Control ───────────────────────────────────────────────────

describe('field access roles and power levels', () => {
  it('maps power levels to roles correctly', () => {
    expect(powerLevelToFieldRole(100)).toBe('owner');
    expect(powerLevelToFieldRole(75)).toBe('admin');
    expect(powerLevelToFieldRole(50)).toBe('admin');
    expect(powerLevelToFieldRole(25)).toBe('editor');
    expect(powerLevelToFieldRole(10)).toBe('viewer');
    expect(powerLevelToFieldRole(0)).toBe('viewer');
  });
});

describe('addFieldAccess', () => {
  it('adds a user with the specified role', () => {
    const d = makeDesignation();
    const updated = addFieldAccess(d, EDITOR, 'editor', OWNER);

    expect(updated.access_list).toHaveLength(2);
    const carol = updated.access_list.find(e => e.user_id === EDITOR);
    expect(carol?.role).toBe('editor');
    expect(carol?.power_level).toBe(25);
    expect(carol?.granted_by).toBe(OWNER);
  });

  it('updates role if user already exists', () => {
    const d = makeDesignation();
    const withEditor = addFieldAccess(d, EDITOR, 'editor', OWNER);
    const promoted = addFieldAccess(withEditor, EDITOR, 'admin', OWNER);

    expect(promoted.access_list).toHaveLength(2);
    const carol = promoted.access_list.find(e => e.user_id === EDITOR);
    expect(carol?.role).toBe('admin');
    expect(carol?.power_level).toBe(50);
  });

  it('allows granting a role higher than your own', () => {
    // Editor grants owner access to someone else
    const d = makeDesignation();
    const withEditor = addFieldAccess(d, EDITOR, 'editor', OWNER);
    const elevated = addFieldAccess(withEditor, VIEWER, 'owner', EDITOR);

    const dave = elevated.access_list.find(e => e.user_id === VIEWER);
    expect(dave?.role).toBe('owner');
    expect(dave?.power_level).toBe(100);
    expect(dave?.granted_by).toBe(EDITOR);
  });
});

describe('removeFieldAccess', () => {
  it('removes a user and rotates the key', () => {
    const d = makeDesignation();
    const withEditor = addFieldAccess(d, EDITOR, 'editor', OWNER);
    const removed = removeFieldAccess(withEditor, EDITOR, 'new-key-002');

    expect(removed.access_list).toHaveLength(1);
    expect(removed.access_list.some(e => e.user_id === EDITOR)).toBe(false);
    expect(removed.key_id).toBe('new-key-002');
    expect(removed.key_version).toBe(2);
  });
});

describe('changeFieldAccessRole', () => {
  it('changes a user role', () => {
    const d = makeDesignation();
    const withEditor = addFieldAccess(d, EDITOR, 'editor', OWNER);
    const changed = changeFieldAccessRole(withEditor, EDITOR, 'admin');

    expect(changed).not.toBeNull();
    const carol = changed!.access_list.find(e => e.user_id === EDITOR);
    expect(carol?.role).toBe('admin');
  });

  it('returns null for nonexistent user', () => {
    const d = makeDesignation();
    expect(changeFieldAccessRole(d, OUTSIDER, 'viewer')).toBeNull();
  });
});

describe('access checks', () => {
  it('hasFieldAccess returns true/false correctly', () => {
    const d = makeDesignation();
    expect(hasFieldAccess(d, OWNER)).toBe(true);
    expect(hasFieldAccess(d, OUTSIDER)).toBe(false);
  });

  it('getFieldAccessRole returns the role or null', () => {
    const d = addFieldAccess(makeDesignation(), EDITOR, 'editor', OWNER);
    expect(getFieldAccessRole(d, OWNER)).toBe('owner');
    expect(getFieldAccessRole(d, EDITOR)).toBe('editor');
    expect(getFieldAccessRole(d, OUTSIDER)).toBeNull();
  });

  it('canWriteField requires editor+', () => {
    let d = makeDesignation();
    d = addFieldAccess(d, ADMIN, 'admin', OWNER);
    d = addFieldAccess(d, EDITOR, 'editor', OWNER);
    d = addFieldAccess(d, VIEWER, 'viewer', OWNER);

    expect(canWriteField(d, OWNER)).toBe(true);
    expect(canWriteField(d, ADMIN)).toBe(true);
    expect(canWriteField(d, EDITOR)).toBe(true);
    expect(canWriteField(d, VIEWER)).toBe(false);
    expect(canWriteField(d, OUTSIDER)).toBe(false);
  });

  it('canManageFieldAccess requires admin+', () => {
    let d = makeDesignation();
    d = addFieldAccess(d, ADMIN, 'admin', OWNER);
    d = addFieldAccess(d, EDITOR, 'editor', OWNER);

    expect(canManageFieldAccess(d, OWNER)).toBe(true);
    expect(canManageFieldAccess(d, ADMIN)).toBe(true);
    expect(canManageFieldAccess(d, EDITOR)).toBe(false);
  });
});

// ─── "Who Has Access" View ──────────────────────────────────────────────────

describe('buildAccessView', () => {
  it('shows all users with correct mutation flags for owner', () => {
    let d = makeDesignation();
    d = addFieldAccess(d, ADMIN, 'admin', OWNER);
    d = addFieldAccess(d, EDITOR, 'editor', OWNER);
    d = addFieldAccess(d, VIEWER, 'viewer', OWNER);

    const view = buildAccessView(d, OWNER);
    expect(view).toHaveLength(4);

    const ownerView = view.find(v => v.user_id === OWNER)!;
    expect(ownerView.can_remove).toBe(false); // Can't remove yourself (PL not < own PL)
    expect(ownerView.can_change_role).toBe(false);

    const adminView = view.find(v => v.user_id === ADMIN)!;
    expect(adminView.can_remove).toBe(true);
    expect(adminView.can_change_role).toBe(true);

    const editorView = view.find(v => v.user_id === EDITOR)!;
    expect(editorView.can_remove).toBe(true);

    const viewerView = view.find(v => v.user_id === VIEWER)!;
    expect(viewerView.can_remove).toBe(true);
  });

  it('admin can manage editor/viewer but not owner', () => {
    let d = makeDesignation();
    d = addFieldAccess(d, ADMIN, 'admin', OWNER);
    d = addFieldAccess(d, EDITOR, 'editor', OWNER);

    const view = buildAccessView(d, ADMIN);

    const ownerView = view.find(v => v.user_id === OWNER)!;
    expect(ownerView.can_remove).toBe(false);

    const editorView = view.find(v => v.user_id === EDITOR)!;
    expect(editorView.can_remove).toBe(true);
  });

  it('editor sees list but cannot remove or change anyone', () => {
    let d = makeDesignation();
    d = addFieldAccess(d, EDITOR, 'editor', OWNER);

    const view = buildAccessView(d, EDITOR);
    expect(view).toHaveLength(2);

    // Editor PL is 25, below the 50 threshold for management
    for (const entry of view) {
      expect(entry.can_remove).toBe(false);
      expect(entry.can_change_role).toBe(false);
    }
  });
});

// ─── Registry Operations ────────────────────────────────────────────────────

describe('field encryption registry', () => {
  it('registers and retrieves a field encryption entry', async () => {
    const entry = {
      target: 'app.tblClients.rec001.fldSSN',
      key_id: 'key-001',
      key_room_id: '!room:example.com',
      access_list: [],
      key_version: 1,
      updated_at: TS,
    };

    await registerFieldEncryption(db, entry);
    const retrieved = await getFieldEncryption(db, 'app.tblClients.rec001.fldSSN');
    expect(retrieved).toEqual(entry);
  });

  it('returns null for unregistered target', async () => {
    const result = await getFieldEncryption(db, 'app.tblClients.rec001.fldNope');
    expect(result).toBeNull();
  });

  it('lists all registered field encryptions', async () => {
    await registerFieldEncryption(db, {
      target: 'app.tblClients.rec001.fldSSN',
      key_id: 'key-001',
      key_room_id: '!room1:example.com',
      access_list: [],
      key_version: 1,
      updated_at: TS,
    });
    await registerFieldEncryption(db, {
      target: 'app.tblClients.rec001.fldDOB',
      key_id: 'key-002',
      key_room_id: '!room1:example.com',
      access_list: [],
      key_version: 1,
      updated_at: TS,
    });

    const all = await listFieldEncryptions(db);
    expect(all).toHaveLength(2);
  });

  it('unregisters a field encryption', async () => {
    await registerFieldEncryption(db, {
      target: 'app.tblClients.rec001.fldSSN',
      key_id: 'key-001',
      key_room_id: '!room:example.com',
      access_list: [],
      key_version: 1,
      updated_at: TS,
    });

    await unregisterFieldEncryption(db, 'app.tblClients.rec001.fldSSN');
    const result = await getFieldEncryption(db, 'app.tblClients.rec001.fldSSN');
    expect(result).toBeNull();
  });
});

// ─── Field Encryption Designation in State ──────────────────────────────────

describe('field encryption designation via SEG', () => {
  it('stores field-encrypt designation as SEG operand', async () => {
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients' }));
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001' }));
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001.fldSSN' }));

    const designation = makeDesignation();
    await processEvent(db, ev({
      op: 'SEG',
      target: 'app.tblClients.rec001.fldSSN',
      operand: designation,
    }));

    const state = await getState(db, 'app.tblClients.rec001.fldSSN');
    expect(isFieldEncryptionDesignation(state?.value)).toBe(true);
    expect(state?.value.access_list).toHaveLength(1);
    expect(state?.value.access_list[0].user_id).toBe(OWNER);
    expect(state?.value.access_list[0].role).toBe('owner');
  });

  it('getFieldEncryptionDesignation resolves from state', async () => {
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients' }));
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001' }));
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001.fldSSN' }));

    await processEvent(db, ev({
      op: 'SEG',
      target: 'app.tblClients.rec001.fldSSN',
      operand: makeDesignation(),
    }));

    const found = await getFieldEncryptionDesignation(db, 'app.tblClients.rec001.fldSSN');
    expect(found).not.toBeNull();
    expect(found!.key_id).toBe('key-001');

    // Non-designated field returns null
    const notFound = await getFieldEncryptionDesignation(db, 'app.tblClients.rec001');
    expect(notFound).toBeNull();
  });

  it('getEncryptedFieldsForRecord finds designated fields', async () => {
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients' }));
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001' }));
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001.fldSSN' }));
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001.fldName' }));

    // Only fldSSN is encrypted
    await processEvent(db, ev({
      op: 'SEG',
      target: 'app.tblClients.rec001.fldSSN',
      operand: makeDesignation(),
    }));

    const fields = await getEncryptedFieldsForRecord(db, 'app.tblClients.rec001');
    expect(fields.size).toBe(1);
    expect(fields.has('app.tblClients.rec001.fldSSN')).toBe(true);
    expect(fields.has('app.tblClients.rec001.fldName')).toBe(false);
  });
});

// ─── Encrypt/Decrypt Middleware ─────────────────────────────────────────────

describe('encrypt middleware', () => {
  it('passes through when disabled', async () => {
    const config = disabledMiddleware();
    const result = await maybeEncryptForWrite(db, config, 'app.tblClients.rec001', { name: 'Maria' });
    expect(result).toEqual({ name: 'Maria' });
  });

  it('passes through already-encrypted operands', async () => {
    const { metadata, key } = await generateSegmentKey('app.tblClients', OWNER);
    const encrypted = await encryptOperand(key, metadata.key_id, metadata.version, 'secret');
    const keyring = createKeyring();
    addToKeyring(keyring, metadata.key_id, { key, scope: metadata.scope, version: metadata.version });

    const config: EncryptionMiddlewareConfig = { enabled: true, keyring };
    const result = await maybeEncryptForWrite(db, config, 'app.tblClients.rec001', encrypted);
    expect(isEncryptedOperand(result)).toBe(true);
    expect(result.key_id).toBe(metadata.key_id);
  });

  it('skips structural operands (boundaries, aliases, links)', async () => {
    const keyring = createKeyring();
    const config: EncryptionMiddlewareConfig = { enabled: true, keyring };

    // Encryption boundary
    const boundary = { boundary: 'encrypt', key_id: 'k', algorithm: 'aes-256-gcm' };
    expect(await maybeEncryptForWrite(db, config, 'app.tblClients', boundary)).toEqual(boundary);

    // Alias
    const alias = { _alias: 'app.tblClients.rec002' };
    expect(await maybeEncryptForWrite(db, config, 'app.tblClients.rec001', alias)).toEqual(alias);

    // CON links
    const links = { linked: ['app.tblCases.rec001'], edge_type: 'related' };
    expect(await maybeEncryptForWrite(db, config, 'app.tblClients.rec001', links)).toEqual(links);
  });

  it('encrypts when waterfall scope exists and key is available', async () => {
    // Set up encryption boundary
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients', operand: {} }));
    await processEvent(db, ev({
      op: 'SEG',
      target: 'app.tblClients',
      operand: { boundary: 'encrypt', key_id: 'table-key', algorithm: 'aes-256-gcm' },
    }));

    const { key } = await generateSegmentKey('app.tblClients', OWNER);
    const keyring = createKeyring();
    addToKeyring(keyring, 'table-key', { key, scope: 'app.tblClients', version: 1 });

    const config: EncryptionMiddlewareConfig = { enabled: true, keyring };
    const result = await maybeEncryptForWrite(
      db, config, 'app.tblClients.rec001.fldEmail', 'maria@test.com',
    );

    expect(isEncryptedOperand(result)).toBe(true);
    const decrypted = await decryptOperand(key, result);
    expect(decrypted).toBe('maria@test.com');
  });
});

describe('decrypt middleware', () => {
  it('passes through when disabled', async () => {
    const config = disabledMiddleware();
    const result = await maybeDecryptForRead(config, { name: 'Maria' });
    expect(result).toEqual({ name: 'Maria' });
  });

  it('decrypts when key is available', async () => {
    const { metadata, key } = await generateSegmentKey('app.tblClients', OWNER);
    const encrypted = await encryptOperand(key, metadata.key_id, metadata.version, 'secret value');

    const keyring = createKeyring();
    addToKeyring(keyring, metadata.key_id, { key, scope: metadata.scope, version: metadata.version });

    const config: EncryptionMiddlewareConfig = { enabled: true, keyring };
    const result = await maybeDecryptForRead(config, encrypted);
    expect(result).toBe('secret value');
  });

  it('returns redacted marker when key is missing', async () => {
    const { metadata, key } = await generateSegmentKey('app.tblClients', OWNER);
    const encrypted = await encryptOperand(key, metadata.key_id, metadata.version, 'secret');

    // Empty keyring — no keys
    const config: EncryptionMiddlewareConfig = { enabled: true, keyring: createKeyring() };
    const result = await maybeDecryptForRead(config, encrypted);

    expect(isRedactedValue(result)).toBe(true);
    expect(result.required_key_id).toBe(metadata.key_id);
  });

  it('passes through non-encrypted values', async () => {
    const keyring = createKeyring();
    const config: EncryptionMiddlewareConfig = { enabled: true, keyring };

    expect(await maybeDecryptForRead(config, 'hello')).toBe('hello');
    expect(await maybeDecryptForRead(config, 42)).toBe(42);
    expect(await maybeDecryptForRead(config, null)).toBeNull();
    expect(await maybeDecryptForRead(config, { name: 'Maria' })).toEqual({ name: 'Maria' });
  });
});

describe('decryptRecordFields', () => {
  it('decrypts individual encrypted fields in a record value', async () => {
    const { metadata, key } = await generateSegmentKey('app.tblClients', OWNER);
    const encSSN = await encryptOperand(key, metadata.key_id, metadata.version, '123-45-6789');

    const keyring = createKeyring();
    addToKeyring(keyring, metadata.key_id, { key, scope: metadata.scope, version: metadata.version });
    const config: EncryptionMiddlewareConfig = { enabled: true, keyring };

    const recordValue = {
      name: 'Maria Garcia',  // plaintext
      fldSSN: encSSN,         // encrypted
      active: true,           // plaintext
    };

    const result = await decryptRecordFields(config, recordValue);
    expect(result.name).toBe('Maria Garcia');
    expect(result.fldSSN).toBe('123-45-6789');
    expect(result.active).toBe(true);
  });

  it('redacts fields when key is missing', async () => {
    const { metadata, key } = await generateSegmentKey('app.tblClients', OWNER);
    const encSSN = await encryptOperand(key, metadata.key_id, metadata.version, '123-45-6789');

    // No keys in keyring
    const config: EncryptionMiddlewareConfig = { enabled: true, keyring: createKeyring() };

    const recordValue = {
      name: 'Maria Garcia',
      fldSSN: encSSN,
    };

    const result = await decryptRecordFields(config, recordValue);
    expect(result.name).toBe('Maria Garcia');
    expect(isRedactedValue(result.fldSSN)).toBe(true);
  });
});

// ─── Field-Level Policy ─────────────────────────────────────────────────────

describe('field-level policy', () => {
  it('isEncryptionPolicy detects policy operands', () => {
    expect(isEncryptionPolicy({
      boundary: 'encrypt-policy',
      granularity: 'field',
      key_room_id: '!room:example.com',
      algorithm: 'aes-256-gcm',
      auto_generate: true,
      created_by: OWNER,
      created_at: TS,
    })).toBe(true);

    expect(isEncryptionPolicy({ boundary: 'encrypt', key_id: 'k' })).toBe(false);
  });

  it('deriveKeyScope produces correct scope for each granularity', () => {
    const target = 'app.tblClients.rec123.fldSSN';
    const policyScope = 'app.tblClients';

    expect(deriveKeyScope(target, policyScope, 'table')).toBe('app.tblClients');
    expect(deriveKeyScope(target, policyScope, 'record')).toBe('app.tblClients.rec123');
    expect(deriveKeyScope(target, policyScope, 'field')).toBe('app.tblClients.rec123.fldSSN');
  });

  it('shouldEncryptField checks field filter', () => {
    const policy: FieldEncryptionPolicy = {
      boundary: 'encrypt-policy',
      granularity: 'field',
      key_room_id: '!room:example.com',
      algorithm: 'aes-256-gcm',
      auto_generate: true,
      field_filter: ['fldSSN', 'fldDOB'],
      created_by: OWNER,
      created_at: TS,
    };

    expect(shouldEncryptField('fldSSN', policy)).toBe(true);
    expect(shouldEncryptField('fldDOB', policy)).toBe(true);
    expect(shouldEncryptField('fldName', policy)).toBe(false);
  });

  it('shouldEncryptField encrypts all when no filter', () => {
    const policy: FieldEncryptionPolicy = {
      boundary: 'encrypt-policy',
      granularity: 'field',
      key_room_id: '!room:example.com',
      algorithm: 'aes-256-gcm',
      auto_generate: true,
      created_by: OWNER,
      created_at: TS,
    };

    expect(shouldEncryptField('fldAnything', policy)).toBe(true);
  });
});

// ─── Key Room Topology ──────────────────────────────────────────────────────

describe('key room topology', () => {
  it('resolves key rooms by scope prefix match', () => {
    const topology: KeyRoomTopology = {
      bindings: [
        {
          binding_id: 'b1',
          scope: 'app.tblClients',
          key_room_id: '!clients:example.com',
          created_by: OWNER,
          created_at: TS,
        },
        {
          binding_id: 'b2',
          scope: 'app.tblFinance',
          key_room_id: '!finance:example.com',
          created_by: OWNER,
          created_at: TS,
        },
      ],
      updated_at: TS,
      updated_by: OWNER,
    };

    const rooms = resolveKeyRooms(topology, 'app.tblClients.rec123.fldSSN');
    expect(rooms).toHaveLength(1);
    expect(rooms[0].binding.key_room_id).toBe('!clients:example.com');

    const financeRooms = resolveKeyRooms(topology, 'app.tblFinance.rec001');
    expect(financeRooms).toHaveLength(1);
    expect(financeRooms[0].binding.key_room_id).toBe('!finance:example.com');

    // No match
    const noRooms = resolveKeyRooms(topology, 'app.tblCases.rec001');
    expect(noRooms).toHaveLength(0);
  });

  it('resolvableScopes returns bindings the user can access', () => {
    const topology: KeyRoomTopology = {
      bindings: [
        {
          binding_id: 'b1',
          scope: 'app.tblClients',
          key_room_id: '!clients:example.com',
          created_by: OWNER,
          created_at: TS,
        },
        {
          binding_id: 'b2',
          scope: 'app.tblFinance',
          key_room_id: '!finance:example.com',
          created_by: OWNER,
          created_at: TS,
        },
      ],
      updated_at: TS,
      updated_by: OWNER,
    };

    // User is only in the clients key room
    const memberRooms = new Set(['!clients:example.com']);
    const scopes = resolvableScopes(topology, memberRooms);
    expect(scopes).toHaveLength(1);
    expect(scopes[0].scope).toBe('app.tblClients');
  });

  it('field_pattern restricts which targets match', () => {
    const topology: KeyRoomTopology = {
      bindings: [
        {
          binding_id: 'b1',
          scope: 'app.tblClients',
          key_room_id: '!pii:example.com',
          field_pattern: '*.fldSSN',
          created_by: OWNER,
          created_at: TS,
        },
      ],
      updated_at: TS,
      updated_by: OWNER,
    };

    // Matches: SSN field under any record
    const ssnRooms = resolveKeyRooms(topology, 'app.tblClients.rec123.fldSSN');
    expect(ssnRooms).toHaveLength(1);

    // Doesn't match: different field
    const nameRooms = resolveKeyRooms(topology, 'app.tblClients.rec123.fldName');
    expect(nameRooms).toHaveLength(0);
  });
});

// ─── Type Guards ────────────────────────────────────────────────────────────

describe('type guards', () => {
  it('isFieldEncryptionDesignation', () => {
    expect(isFieldEncryptionDesignation(makeDesignation())).toBe(true);
    expect(isFieldEncryptionDesignation({ boundary: 'encrypt', key_id: 'k' })).toBe(false);
    expect(isFieldEncryptionDesignation(null)).toBe(false);
    expect(isFieldEncryptionDesignation('string')).toBe(false);
  });

  it('isRedactedValue', () => {
    expect(isRedactedValue({ _redacted: true, required_key_id: 'k' })).toBe(true);
    expect(isRedactedValue({ name: 'Maria' })).toBe(false);
    expect(isRedactedValue(null)).toBe(false);
  });
});
