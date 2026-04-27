/**
 * onEvent contract across shard transports.
 *
 * Phase G moved shard dispatch behind an opaque ShardDispatcher so any
 * transport (in-process, Worker pool, hypothetical network) could plug in.
 * Workers can't round-trip a function, so the coordinator collects each
 * shard's `emittedEvents` and fans them out through the caller's `onEvent`
 * callback post-merge.
 *
 * These tests pin that contract so the wiring in eo-store.ts (which
 * depends on onEvent firing for every imported event so the Zustand
 * recentEvents buffer and the PeerSync broadcast queue all catch up)
 * stays correct.
 */

import { describe, it, expect } from 'vitest';
import {
  processEventsBulk,
  processEventsBulkIsolated,
  processEventsBulkWorker,
  processEventsBulkWithDispatcher,
} from '../fold';
import {
  dispatchShardInProcess,
  type WorkerDispatchMessage,
  type WorkerResultMessage,
} from '../fold-worker-transport';
import type { EoStore, IteratorOpts } from '../encrypted-store';
import type { EoEvent, EoEventInput } from '../types';

function createTestStore(): EoStore {
  const data = new Map<string, unknown>();
  let seq = 0;
  return {
    async get(key) {
      return data.has(key) ? data.get(key) : null;
    },
    async put(key, value) {
      data.set(key, value);
    },
    async del(key) {
      data.delete(key);
    },
    async iterator(prefix: string, opts?: IteratorOpts) {
      const results: [string, unknown][] = [];
      for (const [k, v] of data.entries()) {
        if (k >= prefix && k <= prefix + '\uffff') {
          if (opts?.afterKey && k <= opts.afterKey) continue;
          results.push([k, v]);
        }
      }
      results.sort((a, b) => a[0].localeCompare(b[0]));
      if (opts?.limit !== undefined && results.length > opts.limit) {
        results.length = opts.limit;
      }
      return results;
    },
    async nextSeq() {
      seq += 1;
      data.set('meta:seq', seq);
      return seq;
    },
    async getCurrentSeq() {
      return seq;
    },
    close() {},
  };
}

/**
 * In-process Worker mock: postMessage routes through structuredClone (so the
 * test catches any non-serializable payload) and dispatches via the real
 * in-process shard body. Same mock the determinism harness uses, just kept
 * local so this file is self-contained.
 */
class MockShardWorker implements Partial<Worker> {
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private terminated = false;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown): void {
    if (this.terminated) return;
    const msg = structuredClone(message) as WorkerDispatchMessage;
    if (!msg || msg.type !== 'dispatch') return;
    void (async () => {
      try {
        const response = await dispatchShardInProcess(msg.request);
        if (this.terminated) return;
        const reply = structuredClone({
          type: 'result', id: msg.id, response,
        } as WorkerResultMessage);
        this.deliver('message', new MessageEvent('message', { data: reply }));
      } catch (err) {
        if (this.terminated) return;
        const error = err instanceof Error ? err.message : String(err);
        const reply = structuredClone({ type: 'error', id: msg.id, error } as WorkerResultMessage);
        this.deliver('message', new MessageEvent('message', { data: reply }));
      }
    })();
  }

  terminate(): void {
    this.terminated = true;
    this.listeners.clear();
  }

  private deliver(type: string, event: Event): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const l of set) {
      if (typeof l === 'function') l(event);
      else l.handleEvent(event);
    }
  }
}

/** Build a batch of N INS events across spread targets so the shard
 *  partition has something to partition. */
function makeBatch(n: number): EoEventInput[] {
  const events: EoEventInput[] = [];
  for (let i = 0; i < n; i++) {
    events.push({
      op: 'INS',
      target: `record:${i % 5}:${i}`,
      operand: { i },
      agent: '@test:test',
      ts: `2025-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      acquired_ts: `2025-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      client_event_id: `cid-${i}`,
    });
  }
  return events;
}

describe('onEvent contract across shard transports', () => {
  it('serial bulk fires onEvent once per input and covers the full seq range', async () => {
    // onEvent order is NOT input order — processEventsBulk groups events by
    // target and dispatches in sorted-key order, so the stream shuffles
    // relative to the input array. The contract is "once per input, seqs
    // form a contiguous range" — not "strictly increasing in emit order".
    const store = createTestStore();
    const events = makeBatch(20);
    const collected: EoEvent[] = [];
    await processEventsBulk(store, events, undefined, (ev) => collected.push(ev));
    expect(collected).toHaveLength(events.length);
    const seqs = collected.map((e) => e.seq).sort((a, b) => a - b);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }
  });

  it('isolated-pool (in-process shard dispatcher) fires onEvent once per input', async () => {
    const store = createTestStore();
    const events = makeBatch(20);
    const collected: EoEvent[] = [];
    await processEventsBulkIsolated(
      store, events, 3, undefined, (ev) => collected.push(ev),
    );
    expect(collected).toHaveLength(events.length);
    const cids = new Set(collected.map((e) => e.client_event_id));
    for (const e of events) expect(cids.has(e.client_event_id!)).toBe(true);
  });

  it('worker transport fires onEvent once per input despite postMessage boundary', async () => {
    const store = createTestStore();
    const events = makeBatch(20);
    const collected: EoEvent[] = [];
    const workerFactory = (): Worker => new MockShardWorker() as unknown as Worker;
    await processEventsBulkWorker(
      store, events, 3, workerFactory, undefined, (ev) => collected.push(ev),
    );
    expect(collected).toHaveLength(events.length);
    // Every input's client_event_id must be present in the emitted stream.
    const cids = new Set(collected.map((e) => e.client_event_id));
    for (const e of events) expect(cids.has(e.client_event_id!)).toBe(true);
  });

  it('processEventsBulkWithDispatcher delivers the same stream with a caller-owned dispatcher', async () => {
    // Caller owns the dispatcher — mirrors what eo-store.ts does with a
    // cached WorkerShardPool.
    const store = createTestStore();
    const events = makeBatch(20);
    const collected: EoEvent[] = [];
    await processEventsBulkWithDispatcher(
      store, events, 3, dispatchShardInProcess, undefined, (ev) => collected.push(ev),
    );
    expect(collected).toHaveLength(events.length);
  });

  it('onEvent is optional — worker path is tolerant of undefined callback', async () => {
    const store = createTestStore();
    const events = makeBatch(10);
    const workerFactory = (): Worker => new MockShardWorker() as unknown as Worker;
    await expect(
      processEventsBulkWorker(store, events, 2, workerFactory),
    ).resolves.toBeGreaterThan(0);
  });
});
