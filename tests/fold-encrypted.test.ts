import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import { processEvent } from '../src/db/fold.js';
import { getState } from '../src/db/state.js';
import type { EoEventInput } from '../src/db/types.js';
import type { EncryptedOperand } from '../src/db/crypto-types.js';
import { isEncryptedOperand } from '../src/db/crypto-types.js';
import {
  generateSegmentKey,
  encryptOperand,
  decryptOperand,
} from '../src/crypto/segment-keys.js';
import { getEncryptionScope } from '../src/db/encryption-scope.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

const AGENT = '@intake:matrix.example.com';
const TS = '2025-06-01T00:00:00.000Z';

function ev(overrides: Partial<EoEventInput>): EoEventInput {
  return {
    op: 'INS',
    target: 'app.tblClients.rec001',
    operand: {},
    agent: AGENT,
    ts: TS,
    acquired_ts: TS,
    ...overrides,
  };
}

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-fold-enc-'));
  db = createDb(dbPath);
  await db.open();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

describe('fold with encrypted operands', () => {
  it('stores an encrypted DEF operand as-is in state', async () => {
    // Setup: create target first
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001' }));
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001.fldSSN' }));

    // Encrypt the operand
    const { metadata, key } = await generateSegmentKey('app.tblClients', AGENT);
    const encrypted = await encryptOperand(key, metadata.key_id, metadata.version, '123-45-6789');

    // DEF with encrypted operand
    await processEvent(db, ev({
      op: 'DEF',
      target: 'app.tblClients.rec001.fldSSN',
      operand: encrypted,
    }));

    // State should contain the encrypted blob
    const state = await getState(db, 'app.tblClients.rec001.fldSSN');
    expect(isEncryptedOperand(state?.value)).toBe(true);
    expect((state?.value as EncryptedOperand).key_id).toBe(metadata.key_id);

    // Decrypt the value from state
    const decrypted = await decryptOperand(key, state?.value as EncryptedOperand);
    expect(decrypted).toBe('123-45-6789');
  });

  it('atomic replaces encrypted operand on subsequent DEF (no merge)', async () => {
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001' }));

    const { metadata, key } = await generateSegmentKey('app.tblClients', AGENT);

    // First DEF with encrypted operand
    const enc1 = await encryptOperand(key, metadata.key_id, metadata.version, { name: 'Maria' });
    await processEvent(db, ev({
      op: 'DEF',
      target: 'app.tblClients.rec001',
      operand: enc1,
    }));

    // Second DEF with another encrypted operand — should REPLACE, not merge
    const enc2 = await encryptOperand(key, metadata.key_id, metadata.version, { email: 'maria@test.com' });
    await processEvent(db, ev({
      op: 'DEF',
      target: 'app.tblClients.rec001',
      operand: enc2,
    }));

    const state = await getState(db, 'app.tblClients.rec001');
    expect(isEncryptedOperand(state?.value)).toBe(true);

    // Should be the second value (replaced, not merged)
    const decrypted = await decryptOperand(key, state?.value as EncryptedOperand);
    expect(decrypted).toEqual({ email: 'maria@test.com' });
  });

  it('replaces encrypted state with plaintext on DEF without encryption', async () => {
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001' }));

    const { metadata, key } = await generateSegmentKey('app.tblClients', AGENT);
    const encrypted = await encryptOperand(key, metadata.key_id, metadata.version, { name: 'Maria' });

    // First: encrypted DEF
    await processEvent(db, ev({
      op: 'DEF',
      target: 'app.tblClients.rec001',
      operand: encrypted,
    }));

    // Second: plaintext DEF (re-encryption boundary changed)
    await processEvent(db, ev({
      op: 'DEF',
      target: 'app.tblClients.rec001',
      operand: { name: 'Maria Garcia' },
    }));

    const state = await getState(db, 'app.tblClients.rec001');
    expect(isEncryptedOperand(state?.value)).toBe(false);
    expect(state?.value).toEqual({ name: 'Maria Garcia' });
  });

  it('INS with encrypted operand stores the blob', async () => {
    const { metadata, key } = await generateSegmentKey('app.tblClients', AGENT);
    const encrypted = await encryptOperand(key, metadata.key_id, metadata.version, { name: 'Secret Client' });

    await processEvent(db, ev({
      op: 'INS',
      target: 'app.tblClients.rec002',
      operand: encrypted,
    }));

    const state = await getState(db, 'app.tblClients.rec002');
    expect(isEncryptedOperand(state?.value)).toBe(true);

    const decrypted = await decryptOperand(key, state?.value as EncryptedOperand);
    expect(decrypted).toEqual({ name: 'Secret Client' });
  });
});

describe('SEG encryption boundary', () => {
  it('SEG with boundary:encrypt is stored and detectable', async () => {
    // Create the target hierarchy
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients', operand: {} }));

    // Set encryption boundary
    await processEvent(db, ev({
      op: 'SEG',
      target: 'app.tblClients',
      operand: {
        boundary: 'encrypt',
        key_id: 'test-key-123',
        algorithm: 'aes-256-gcm',
      },
    }));

    const state = await getState(db, 'app.tblClients');
    expect(state?.value.boundary).toBe('encrypt');
    expect(state?.value.key_id).toBe('test-key-123');
  });

  it('getEncryptionScope resolves waterfall from child to ancestor', async () => {
    // Create hierarchy
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients', operand: {} }));
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001', operand: {} }));
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001.fldSSN', operand: {} }));

    // Set encryption boundary at table level
    await processEvent(db, ev({
      op: 'SEG',
      target: 'app.tblClients',
      operand: {
        boundary: 'encrypt',
        key_id: 'client-key',
        algorithm: 'aes-256-gcm',
      },
    }));

    // Child targets should resolve to the table-level boundary
    const scope1 = await getEncryptionScope(db, 'app.tblClients.rec001.fldSSN');
    expect(scope1).not.toBeNull();
    expect(scope1?.key_id).toBe('client-key');
    expect(scope1?.scope).toBe('app.tblClients');

    const scope2 = await getEncryptionScope(db, 'app.tblClients.rec001');
    expect(scope2?.key_id).toBe('client-key');

    // The boundary target itself resolves
    const scope3 = await getEncryptionScope(db, 'app.tblClients');
    expect(scope3?.key_id).toBe('client-key');
  });

  it('returns null for targets outside any encryption boundary', async () => {
    // Create separate table
    await processEvent(db, ev({ op: 'INS', target: 'app.tblCases', operand: {} }));
    await processEvent(db, ev({ op: 'INS', target: 'app.tblCases.rec001', operand: {} }));

    // Only encrypt tblClients
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients', operand: {} }));
    await processEvent(db, ev({
      op: 'SEG',
      target: 'app.tblClients',
      operand: {
        boundary: 'encrypt',
        key_id: 'client-key',
        algorithm: 'aes-256-gcm',
      },
    }));

    // tblCases should not have encryption
    const scope = await getEncryptionScope(db, 'app.tblCases.rec001');
    expect(scope).toBeNull();
  });

  it('most specific encryption boundary wins', async () => {
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients', operand: {} }));
    await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001', operand: {} }));

    // Table-level boundary
    await processEvent(db, ev({
      op: 'SEG',
      target: 'app.tblClients',
      operand: { boundary: 'encrypt', key_id: 'table-key', algorithm: 'aes-256-gcm' },
    }));

    // Record-level boundary (more specific)
    await processEvent(db, ev({
      op: 'SEG',
      target: 'app.tblClients.rec001',
      operand: { boundary: 'encrypt', key_id: 'record-key', algorithm: 'aes-256-gcm' },
    }));

    // Field under rec001 should use the record-level key
    const scope = await getEncryptionScope(db, 'app.tblClients.rec001.fldSSN');
    expect(scope?.key_id).toBe('record-key');

    // Field under a different record should use the table-level key
    const scope2 = await getEncryptionScope(db, 'app.tblClients.rec999.fldEmail');
    expect(scope2?.key_id).toBe('table-key');
  });
});
