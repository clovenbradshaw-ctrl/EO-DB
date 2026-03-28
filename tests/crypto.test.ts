import { describe, it, expect } from 'vitest';
import {
  generateSegmentKey,
  encryptOperand,
  decryptOperand,
  createKeyring,
  addToKeyring,
  resolveKeyForTarget,
  getKeyById,
  exportKey,
  importKey,
} from '../src/crypto/segment-keys.js';
import { isEncryptedOperand, isEncryptBoundary } from '../src/db/crypto-types.js';
import type { EncryptedOperand } from '../src/db/crypto-types.js';

const AGENT = '@test:homeserver.example';

describe('generateSegmentKey', () => {
  it('generates a key with correct metadata', async () => {
    const { metadata, key } = await generateSegmentKey('app.tblClients', AGENT, 'Client data key');
    expect(metadata.scope).toBe('app.tblClients');
    expect(metadata.version).toBe(1);
    expect(metadata.created_by).toBe(AGENT);
    expect(metadata.label).toBe('Client data key');
    expect(metadata.key_id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    expect(key).toBeDefined();
    expect(key.type).toBe('secret');
  });
});

describe('encryptOperand / decryptOperand', () => {
  it('round-trips a string operand', async () => {
    const { metadata, key } = await generateSegmentKey('app.tblClients', AGENT);
    const encrypted = await encryptOperand(key, metadata.key_id, metadata.version, 'hello world');

    expect(encrypted._encrypted).toBe(true);
    expect(encrypted.key_id).toBe(metadata.key_id);
    expect(encrypted.key_version).toBe(1);
    expect(typeof encrypted.ciphertext).toBe('string');

    const decrypted = await decryptOperand(key, encrypted);
    expect(decrypted).toBe('hello world');
  });

  it('round-trips an object operand', async () => {
    const { metadata, key } = await generateSegmentKey('app.tblClients', AGENT);
    const original = { name: 'Maria Garcia', ssn: '123-45-6789', active: true };
    const encrypted = await encryptOperand(key, metadata.key_id, metadata.version, original);
    const decrypted = await decryptOperand(key, encrypted);
    expect(decrypted).toEqual(original);
  });

  it('round-trips a numeric operand', async () => {
    const { metadata, key } = await generateSegmentKey('app.tblClients', AGENT);
    const encrypted = await encryptOperand(key, metadata.key_id, metadata.version, 42);
    const decrypted = await decryptOperand(key, encrypted);
    expect(decrypted).toBe(42);
  });

  it('round-trips a null operand', async () => {
    const { metadata, key } = await generateSegmentKey('app.tblClients', AGENT);
    const encrypted = await encryptOperand(key, metadata.key_id, metadata.version, null);
    const decrypted = await decryptOperand(key, encrypted);
    expect(decrypted).toBeNull();
  });

  it('produces different ciphertext for the same plaintext (random IV)', async () => {
    const { metadata, key } = await generateSegmentKey('app.tblClients', AGENT);
    const enc1 = await encryptOperand(key, metadata.key_id, metadata.version, 'same');
    const enc2 = await encryptOperand(key, metadata.key_id, metadata.version, 'same');
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });

  it('fails to decrypt with wrong key', async () => {
    const { metadata, key: key1 } = await generateSegmentKey('app.tblClients', AGENT);
    const { key: key2 } = await generateSegmentKey('app.tblCases', AGENT);
    const encrypted = await encryptOperand(key1, metadata.key_id, metadata.version, 'secret');

    await expect(decryptOperand(key2, encrypted)).rejects.toThrow();
  });
});

describe('isEncryptedOperand', () => {
  it('returns true for encrypted operands', () => {
    const encrypted: EncryptedOperand = {
      _encrypted: true,
      key_id: 'abc',
      ciphertext: 'base64data',
      key_version: 1,
    };
    expect(isEncryptedOperand(encrypted)).toBe(true);
  });

  it('returns false for plain operands', () => {
    expect(isEncryptedOperand({ name: 'Maria' })).toBe(false);
    expect(isEncryptedOperand('hello')).toBe(false);
    expect(isEncryptedOperand(42)).toBe(false);
    expect(isEncryptedOperand(null)).toBe(false);
    expect(isEncryptedOperand(undefined)).toBe(false);
  });
});

describe('isEncryptBoundary', () => {
  it('returns true for encrypt boundary operands', () => {
    expect(isEncryptBoundary({
      boundary: 'encrypt',
      key_id: 'abc-123',
      algorithm: 'aes-256-gcm',
    })).toBe(true);
  });

  it('returns false for non-encrypt boundaries', () => {
    expect(isEncryptBoundary({ boundary: 'exclude', reason: 'archived' })).toBe(false);
    expect(isEncryptBoundary(null)).toBe(false);
    expect(isEncryptBoundary('encrypt')).toBe(false);
  });
});

describe('keyring and waterfall resolution', () => {
  it('resolves the most specific key for a target', async () => {
    const keyring = createKeyring();

    const { metadata: m1, key: k1 } = await generateSegmentKey('app.tblClients', AGENT);
    const { metadata: m2, key: k2 } = await generateSegmentKey('app.tblClients.rec123', AGENT);

    addToKeyring(keyring, m1.key_id, { key: k1, scope: m1.scope, version: m1.version });
    addToKeyring(keyring, m2.key_id, { key: k2, scope: m2.scope, version: m2.version });

    // Deep target resolves to the most specific key (rec123)
    const resolved = resolveKeyForTarget(keyring, 'app.tblClients.rec123.fldSSN');
    expect(resolved?.scope).toBe('app.tblClients.rec123');

    // A different record resolves to the table-level key
    const resolved2 = resolveKeyForTarget(keyring, 'app.tblClients.rec456.fldEmail');
    expect(resolved2?.scope).toBe('app.tblClients');
  });

  it('returns null when no key covers the target', async () => {
    const keyring = createKeyring();

    const { metadata, key } = await generateSegmentKey('app.tblClients', AGENT);
    addToKeyring(keyring, metadata.key_id, { key, scope: metadata.scope, version: metadata.version });

    // Different branch — no key
    const resolved = resolveKeyForTarget(keyring, 'app.tblCases.rec001');
    expect(resolved).toBeNull();
  });

  it('resolves exact scope match', async () => {
    const keyring = createKeyring();
    const { metadata, key } = await generateSegmentKey('app.tblClients', AGENT);
    addToKeyring(keyring, metadata.key_id, { key, scope: metadata.scope, version: metadata.version });

    const resolved = resolveKeyForTarget(keyring, 'app.tblClients');
    expect(resolved?.scope).toBe('app.tblClients');
  });

  it('getKeyById finds key by ID', async () => {
    const keyring = createKeyring();
    const { metadata, key } = await generateSegmentKey('app.tblClients', AGENT);
    addToKeyring(keyring, metadata.key_id, { key, scope: metadata.scope, version: metadata.version });

    const found = getKeyById(keyring, metadata.key_id);
    expect(found?.scope).toBe('app.tblClients');

    const missing = getKeyById(keyring, 'nonexistent');
    expect(missing).toBeNull();
  });
});

describe('exportKey / importKey', () => {
  it('round-trips a key through export and import', async () => {
    const { metadata, key: original } = await generateSegmentKey('app.tblClients', AGENT);
    const rawBytes = await exportKey(original);
    expect(rawBytes.byteLength).toBe(32); // 256-bit key

    const reimported = await importKey(rawBytes);

    // Verify the reimported key can decrypt data encrypted with the original
    const encrypted = await encryptOperand(original, metadata.key_id, metadata.version, 'test data');
    const decrypted = await decryptOperand(reimported, encrypted);
    expect(decrypted).toBe('test data');
  });
});
