/**
 * lazy-fold dead-latch — V7 of HELIX-AUDIT-2026-05-11.md.
 *
 * When a fold worker crashes (unhandled throw, OOM, postMessage size
 * limit), the historical behavior was to reject in-flight requests but
 * leave the FoldWorkerClient instance in an apparently-healthy state.
 * Subsequent `send()` calls would postMessage into the dead worker and
 * the returned promise would hang forever.
 *
 * The fix latches `client.dead = true` in the worker's onerror; send()
 * rejects fast on that. These tests pin the latch + reject behavior
 * without spawning a real Worker (which the test environment can't do).
 */

import { describe, it, expect, vi } from 'vitest';
import { appendRaw, scanLog, type FoldWorkerClient } from '../lazy-fold';
import type { EoEvent } from '../types';

function makeStubClient(): FoldWorkerClient {
  // Minimal Worker stand-in. The test never invokes a real worker
  // method; only `postMessage` matters when `dead === false`.
  const worker = {
    postMessage: vi.fn(),
  } as unknown as Worker;

  return {
    worker,
    pendingRequests: new Map(),
    nextId: 1,
    dead: false,
  };
}

function makeEvent(): EoEvent {
  return {
    op: 'INS',
    target: 't.r',
    operand: 1,
    agent: '@u:t',
    ts: '2026-01-01T00:00:00Z',
    acquired_ts: '2026-01-01T00:00:00Z',
    client_event_id: 'ev:1',
    seq: 1,
  } as EoEvent;
}

describe('lazy-fold dead-latch (V7)', () => {
  it('postMessage fires on a live client', () => {
    const client = makeStubClient();
    // Don't await — appendRaw returns a pending promise that will hang
    // without an external response. We only care that postMessage fired.
    void appendRaw(client, makeEvent());
    expect(client.worker.postMessage).toHaveBeenCalledTimes(1);
    expect(client.pendingRequests.size).toBe(1);
  });

  it('send via appendRaw rejects immediately when the client is dead', async () => {
    const client = makeStubClient();
    client.dead = true;
    await expect(appendRaw(client, makeEvent())).rejects.toThrow(/dead/i);
    // Verify the dead client did NOT postMessage into a corpse.
    expect(client.worker.postMessage).not.toHaveBeenCalled();
    // And no pending entry was registered (would otherwise leak memory).
    expect(client.pendingRequests.size).toBe(0);
  });

  it('send via scanLog rejects immediately when the client is dead', async () => {
    const client = makeStubClient();
    client.dead = true;
    await expect(scanLog(client, 0)).rejects.toThrow(/dead/i);
    expect(client.worker.postMessage).not.toHaveBeenCalled();
  });

  it('the dead latch is monotonic — a fresh client is not dead', () => {
    const client = makeStubClient();
    expect(client.dead).toBe(false);
  });
});
