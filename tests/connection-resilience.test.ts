import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchWithRetry,
  MatrixConnectionMonitor,
  type ConnectionState,
} from '../src/matrix/connection-resilience.js';

describe('fetchWithRetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns immediately on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('ok', { status: 200 }),
    );

    const res = await fetchWithRetry('https://example.com', undefined, {
      maxRetries: 3,
      baseDelay: 10,
    });
    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns immediately on 4xx client error (no retry)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('not found', { status: 404 }),
    );

    const res = await fetchWithRetry('https://example.com', undefined, {
      maxRetries: 3,
      baseDelay: 10,
    });
    expect(res.status).toBe(404);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 500 then succeeds', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('error', { status: 500 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await fetchWithRetry('https://example.com', undefined, {
      maxRetries: 3,
      baseDelay: 10,
    });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries on network error then succeeds', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await fetchWithRetry('https://example.com', undefined, {
      maxRetries: 3,
      baseDelay: 10,
    });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws after all retries exhausted on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      fetchWithRetry('https://example.com', undefined, {
        maxRetries: 2,
        baseDelay: 10,
      }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(globalThis.fetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchWithRetry('https://example.com', undefined, {
        maxRetries: 3,
        baseDelay: 10,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it('retries on 429 with server-provided retry_after_ms', async () => {
    const body429 = JSON.stringify({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 50 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(body429, { status: 429, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await fetchWithRetry('https://example.com', undefined, {
      maxRetries: 2,
      baseDelay: 10,
    });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('MatrixConnectionMonitor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports online when health check passes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"versions":["v1.1"]}', { status: 200 }),
    );

    const monitor = new MatrixConnectionMonitor('https://matrix.example.com', 60000);
    const status = await monitor.check();
    expect(status).toBe('online');
    expect(monitor.getState().status).toBe('online');
    monitor.stop();
  });

  it('transitions to degraded after consecutive failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));

    const monitor = new MatrixConnectionMonitor('https://matrix.example.com', 60000);

    await monitor.check();
    expect(monitor.getState().status).toBe('online'); // 1 failure

    await monitor.check();
    expect(monitor.getState().status).toBe('degraded'); // 2 failures

    monitor.stop();
  });

  it('transitions to offline after more failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));

    const monitor = new MatrixConnectionMonitor('https://matrix.example.com', 60000);

    // Need 4 failures for offline
    for (let i = 0; i < 4; i++) {
      await monitor.check();
    }
    expect(monitor.getState().status).toBe('offline');
    monitor.stop();
  });

  it('recovers to online after success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    // Fail 3 times
    for (let i = 0; i < 3; i++) {
      fetchMock.mockRejectedValueOnce(new Error('timeout'));
    }
    // Then succeed
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const monitor = new MatrixConnectionMonitor('https://matrix.example.com', 60000);

    for (let i = 0; i < 3; i++) {
      await monitor.check();
    }
    expect(monitor.getState().status).toBe('degraded');

    await monitor.check();
    expect(monitor.getState().status).toBe('online');

    monitor.stop();
  });

  it('notifies listeners on state change', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockRejectedValueOnce(new Error('fail1'));
    fetchMock.mockRejectedValueOnce(new Error('fail2'));

    const states: ConnectionState[] = [];
    const monitor = new MatrixConnectionMonitor('https://matrix.example.com', 60000);
    monitor.onStateChange((s) => states.push({ ...s }));

    await monitor.check(); // failure 1
    await monitor.check(); // failure 2 → degraded

    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states[states.length - 1].status).toBe('degraded');

    monitor.stop();
  });

  it('unsubscribe stops notifications', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fail'));

    const states: ConnectionState[] = [];
    const monitor = new MatrixConnectionMonitor('https://matrix.example.com', 60000);
    const unsub = monitor.onStateChange((s) => states.push(s));

    await monitor.check();
    unsub();
    await monitor.check();

    // Should only have one notification (before unsubscribe)
    expect(states.length).toBe(1);

    monitor.stop();
  });

  it('recordSuccess resets failure count', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fail'));

    const monitor = new MatrixConnectionMonitor('https://matrix.example.com', 60000);
    await monitor.check();
    await monitor.check();
    expect(monitor.getState().consecutiveFailures).toBe(2);

    monitor.recordSuccess();
    expect(monitor.getState().consecutiveFailures).toBe(0);
    expect(monitor.getState().status).toBe('online');

    monitor.stop();
  });
});
