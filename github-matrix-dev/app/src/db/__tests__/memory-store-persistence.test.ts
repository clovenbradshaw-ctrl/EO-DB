import { describe, it, expect } from 'vitest';
import { createMemoryStore } from '../memory-store';
import type { EoEvent } from '../types';

const ev = (seq: number): EoEvent => ({
  seq,
  op: 'DEF',
  target: `t.${seq}`,
  operand: { v: seq },
  agent: '@test:test',
  ts: '2024-01-01T00:00:00Z',
  acquired_ts: '2024-01-01T00:00:00Z',
  client_event_id: `cid-${seq}`,
});

describe('MemoryStore persistence queue', () => {
  it('awaitPersistence resolves when no writes are pending', async () => {
    const store = createMemoryStore();
    await expect(store.awaitPersistence()).resolves.toBeUndefined();
  });

  it('awaitPersistence drains slow async appendRaw promises', async () => {
    const store = createMemoryStore();
    let resolved = 0;
    const inflight: Array<() => void> = [];
    store.enablePersistence((_event: EoEvent) => {
      return new Promise<void>((resolve) => {
        inflight.push(() => {
          resolved++;
          resolve();
        });
      });
    });

    await store.put('log:1', ev(1));
    await store.put('log:2', ev(2));
    await store.put('log:3', ev(3));

    // Nothing resolved yet — three promises queued.
    expect(resolved).toBe(0);

    const settled = store.awaitPersistence();
    // Drain the queue out-of-order.
    inflight[1]();
    inflight[0]();
    inflight[2]();
    await settled;
    expect(resolved).toBe(3);
  });

  it('awaitPersistence ignores rejections (so put never throws)', async () => {
    const store = createMemoryStore();
    store.enablePersistence(() => Promise.reject(new Error('boom')));
    await expect(store.put('log:1', ev(1))).resolves.toBeUndefined();
    await expect(store.awaitPersistence()).resolves.toBeUndefined();
  });

  it('synchronous persistFn (no Promise) is not tracked', async () => {
    const store = createMemoryStore();
    let calls = 0;
    store.enablePersistence(() => {
      calls++;
      // returns void, not a Promise
    });
    await store.put('log:1', ev(1));
    await store.put('log:2', ev(2));
    expect(calls).toBe(2);
    await expect(store.awaitPersistence()).resolves.toBeUndefined();
  });

  it('non-log keys do not invoke persistFn', async () => {
    const store = createMemoryStore();
    let calls = 0;
    store.enablePersistence(() => { calls++; });
    await store.put('meta:seq', 1);
    await store.put('idem:abc', 1);
    expect(calls).toBe(0);
  });
});
