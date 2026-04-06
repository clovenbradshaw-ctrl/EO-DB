import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OfflineAuthManager } from '../src/auth/offline-auth.js';

describe('OfflineAuthManager', () => {
  let dir: string;
  let manager: OfflineAuthManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eo-offline-auth-test-'));
    manager = new OfflineAuthManager(dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('hasCachedSession returns false initially', async () => {
    expect(await manager.hasCachedSession()).toBe(false);
  });

  it('online login caches session for offline use', async () => {
    // Mock successful Matrix login
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: 'tok_123',
        user_id: '@alice:matrix.example.com',
        device_id: 'DEV1',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await manager.login('alice', 'password123', 'https://matrix.example.com');

    expect(result.mode).toBe('online');
    expect(result.user_id).toBe('@alice:matrix.example.com');
    expect(result.access_token).toBe('tok_123');
    expect(await manager.hasCachedSession()).toBe(true);
  });

  it('falls back to offline cache when homeserver is down', async () => {
    // First: successful online login to populate cache
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: 'tok_123',
        user_id: '@alice:matrix.example.com',
        device_id: 'DEV1',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await manager.login('alice', 'password123', 'https://matrix.example.com');

    // Now: homeserver is unreachable
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await manager.login('alice', 'password123', 'https://matrix.example.com');

    expect(result.mode).toBe('offline');
    expect(result.user_id).toBe('@alice:matrix.example.com');
    expect(result.access_token).toBe('tok_123');
  });

  it('rejects offline login with wrong password', async () => {
    // Populate cache with correct password
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: 'tok_123',
        user_id: '@alice:matrix.example.com',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await manager.login('alice', 'correct-pass', 'https://matrix.example.com');

    // Homeserver down + wrong password
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      manager.login('alice', 'wrong-pass', 'https://matrix.example.com'),
    ).rejects.toThrow();
  });

  it('rejects offline login with no cached session', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      manager.login('alice', 'password', 'https://matrix.example.com'),
    ).rejects.toThrow('no cached session');
  });

  it('clearSession removes the cache', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: 'tok_123',
        user_id: '@alice:matrix.example.com',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await manager.login('alice', 'password', 'https://matrix.example.com');
    expect(await manager.hasCachedSession()).toBe(true);

    await manager.clearSession();
    expect(await manager.hasCachedSession()).toBe(false);
  });

  it('changePassword re-encrypts the session', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: 'tok_123',
        user_id: '@alice:matrix.example.com',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await manager.login('alice', 'old-pass', 'https://matrix.example.com');
    await manager.changePassword('old-pass', 'new-pass');

    // Offline login with old password should fail
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      manager.login('alice', 'old-pass', 'https://matrix.example.com'),
    ).rejects.toThrow();

    // Offline login with new password should work
    const result = await manager.login('alice', 'new-pass', 'https://matrix.example.com');
    expect(result.mode).toBe('offline');
    expect(result.user_id).toBe('@alice:matrix.example.com');
  });
});
