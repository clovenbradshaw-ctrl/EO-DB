import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  encryptWithPassword,
  decryptWithPassword,
  deriveKey,
  EncryptedLocalStore,
} from '../src/crypto/encrypted-local-store.js';

describe('encryptWithPassword / decryptWithPassword', () => {
  const password = 'hunter2';

  it('round-trips arbitrary data', () => {
    const data = Buffer.from(JSON.stringify({ hello: 'world', n: 42 }));
    const encrypted = encryptWithPassword(data, password);
    const decrypted = decryptWithPassword(encrypted, password);
    expect(decrypted.toString('utf8')).toBe(data.toString('utf8'));
  });

  it('produces different ciphertext each time (random IV+salt)', () => {
    const data = Buffer.from('same data');
    const a = encryptWithPassword(data, password);
    const b = encryptWithPassword(data, password);
    expect(a.equals(b)).toBe(false);
  });

  it('fails with wrong password', () => {
    const data = Buffer.from('secret');
    const encrypted = encryptWithPassword(data, password);
    expect(() => decryptWithPassword(encrypted, 'wrong-password')).toThrow();
  });

  it('fails on truncated data', () => {
    const data = Buffer.from('secret');
    const encrypted = encryptWithPassword(data, password);
    const truncated = encrypted.subarray(0, 20);
    expect(() => decryptWithPassword(truncated, password)).toThrow();
  });

  it('fails on corrupted magic header', () => {
    const data = Buffer.from('secret');
    const encrypted = encryptWithPassword(data, password);
    encrypted[0] = 0xFF;
    expect(() => decryptWithPassword(encrypted, password)).toThrow('bad magic header');
  });
});

describe('deriveKey', () => {
  it('produces consistent output for same password+salt', () => {
    const salt = Buffer.alloc(16, 0xAB);
    const a = deriveKey('password', salt);
    const b = deriveKey('password', salt);
    expect(a.equals(b)).toBe(true);
  });

  it('produces different output for different passwords', () => {
    const salt = Buffer.alloc(16, 0xAB);
    const a = deriveKey('password1', salt);
    const b = deriveKey('password2', salt);
    expect(a.equals(b)).toBe(false);
  });

  it('produces 32-byte key', () => {
    const salt = Buffer.alloc(16, 0xAB);
    const key = deriveKey('password', salt);
    expect(key.length).toBe(32);
  });
});

describe('EncryptedLocalStore', () => {
  let dir: string;
  let store: EncryptedLocalStore;
  const password = 'test-password-123';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eo-enc-test-'));
    store = new EncryptedLocalStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('put and get round-trip', async () => {
    await store.put('test', { name: 'Alice', age: 30 }, password);
    const value = await store.get<{ name: string; age: number }>('test', password);
    expect(value).toEqual({ name: 'Alice', age: 30 });
  });

  it('returns null for non-existent key', async () => {
    const value = await store.get('nonexistent', password);
    expect(value).toBeNull();
  });

  it('throws on wrong password', async () => {
    await store.put('secret', { data: 'classified' }, password);
    await expect(store.get('secret', 'wrong-password')).rejects.toThrow();
  });

  it('has() returns true for existing, false for missing', async () => {
    expect(await store.has('item')).toBe(false);
    await store.put('item', 'value', password);
    expect(await store.has('item')).toBe(true);
  });

  it('delete removes the file', async () => {
    await store.put('item', 'value', password);
    expect(await store.has('item')).toBe(true);
    await store.delete('item');
    expect(await store.has('item')).toBe(false);
  });

  it('delete on nonexistent is a no-op', async () => {
    await expect(store.delete('nonexistent')).resolves.not.toThrow();
  });

  it('changePassword re-encrypts data', async () => {
    const newPassword = 'new-password-456';
    await store.put('data', { secret: 42 }, password);

    await store.changePassword(password, newPassword, ['data']);

    // Old password no longer works
    await expect(store.get('data', password)).rejects.toThrow();
    // New password works
    const value = await store.get<{ secret: number }>('data', newPassword);
    expect(value).toEqual({ secret: 42 });
  });

  it('stores complex nested structures', async () => {
    const complex = {
      users: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
      meta: { created: '2024-01-01', nested: { deep: true } },
    };
    await store.put('complex', complex, password);
    const result = await store.get('complex', password);
    expect(result).toEqual(complex);
  });
});
