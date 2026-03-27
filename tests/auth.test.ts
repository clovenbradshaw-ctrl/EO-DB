import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  verifyMatrixToken,
  verifyWebhookSecret,
  setAuthConfig,
  clearTokenCache,
} from '../src/auth/matrix.js';

beforeEach(() => {
  clearTokenCache();
});

describe('verifyMatrixToken', () => {
  it('returns user_id for valid token', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ user_id: '@caseworker:app.aminoimmigration.com', device_id: 'DEV1' }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse as any);

    const user = await verifyMatrixToken('valid-token');
    expect(user.user_id).toBe('@caseworker:app.aminoimmigration.com');
    expect(user.device_id).toBe('DEV1');

    vi.restoreAllMocks();
  });

  it('throws for invalid token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false } as any);

    await expect(verifyMatrixToken('bad-token')).rejects.toThrow('Invalid Matrix token');

    vi.restoreAllMocks();
  });

  it('caches successful verification', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ user_id: '@test:app.aminoimmigration.com' }),
    } as any);

    await verifyMatrixToken('cached-token');
    await verifyMatrixToken('cached-token');

    // fetch should only be called once (second call uses cache)
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });

  it('cache expires after 5 minutes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ user_id: '@test:app.aminoimmigration.com' }),
    } as any);

    await verifyMatrixToken('expiring-token');

    // Advance time past cache TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(300_001); // 5 minutes + 1ms

    await verifyMatrixToken('expiring-token');

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});

describe('verifyWebhookSecret', () => {
  beforeEach(() => {
    setAuthConfig({ webhookSecret: 'test-secret-123' });
  });

  it('succeeds with correct secret', () => {
    const user = verifyWebhookSecret('test-secret-123');
    expect(user.user_id).toBe('@n8n:app.aminoimmigration.com');
  });

  it('fails with wrong secret', () => {
    expect(() => verifyWebhookSecret('wrong-secret')).toThrow('Invalid webhook secret');
  });

  it('sets agent to n8n system user', () => {
    const user = verifyWebhookSecret('test-secret-123');
    expect(user.user_id).toBe('@n8n:app.aminoimmigration.com');
  });
});
