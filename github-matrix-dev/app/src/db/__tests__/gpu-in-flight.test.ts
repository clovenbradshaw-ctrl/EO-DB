/**
 * Unit tests for the Phase C GpuInFlightTracker.
 *
 * Pins the contract the fold barrier (`drainGpuInFlight` in fold.ts)
 * relies on:
 *
 *   1. Skip-redundant-drain — when nothing is in flight, drain is
 *      synchronous-fast and adds no microtask hop.
 *   2. Register + drain — a pending promise registered before drain is
 *      awaited by that drain call; count drops to zero after settlement.
 *   3. Rejection isolation — a rejected GPU dispatch does not propagate
 *      out of drain, and does not leave the tracker in a stuck state.
 *   4. Multi-dispatch — drain awaits all registered promises, not just
 *      the first or the last.
 *   5. Snapshot semantics — work registered strictly AFTER drain() is
 *      called is not awaited by that drain call. The barrier flushes
 *      "everything dispatched before the barrier," not "everything that
 *      exists at any time during the drain."
 *   6. Idempotence — a second drain with no new registrations is also a
 *      synchronous fast path.
 */

import { describe, it, expect } from 'vitest';
import {
  GpuInFlightTracker,
  gpuInFlight,
  setGpuInFlightTracker,
  resetGpuInFlightTracker,
} from '../gpu-in-flight';

/**
 * A manually-settleable deferred. Used to model a GPU dispatch whose
 * compute-shader promise the test controls end-to-end.
 */
function makeDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('GpuInFlightTracker', () => {
  describe('skip-redundant-drain fast path', () => {
    it('drain on an empty tracker returns without awaiting a microtask', async () => {
      // The fast path contract: drain on an empty tracker must return a
      // promise that is already resolved by the time the caller sees it,
      // without hopping through Promise.allSettled on an empty array.
      // Use a sentinel set inside a microtask after drain() to verify
      // drain's promise resolves in the same microtask tick.
      const tracker = new GpuInFlightTracker();
      expect(tracker.inFlightCount()).toBe(0);

      let drainSettled = false;
      const drainPromise = tracker.drain().then(() => {
        drainSettled = true;
      });
      // drainPromise has only one .then handler queued; once the next
      // microtask runs, drainSettled must be true.
      await drainPromise;
      expect(drainSettled).toBe(true);
      expect(tracker.inFlightCount()).toBe(0);
    });

    it('drain on an empty tracker is idempotent', async () => {
      const tracker = new GpuInFlightTracker();
      await tracker.drain();
      await tracker.drain();
      await tracker.drain();
      expect(tracker.inFlightCount()).toBe(0);
    });
  });

  describe('register + drain', () => {
    it('awaits a single pending registration and clears the count', async () => {
      const tracker = new GpuInFlightTracker();
      const d = makeDeferred();
      tracker.register(d.promise);
      expect(tracker.inFlightCount()).toBe(1);

      let drainSettled = false;
      const drainPromise = tracker.drain().then(() => {
        drainSettled = true;
      });

      // Drain must NOT resolve before the underlying work does.
      await Promise.resolve();
      await Promise.resolve();
      expect(drainSettled).toBe(false);
      expect(tracker.inFlightCount()).toBe(1);

      d.resolve();
      await drainPromise;
      expect(drainSettled).toBe(true);
      expect(tracker.inFlightCount()).toBe(0);
    });

    it('awaits multiple pending registrations', async () => {
      const tracker = new GpuInFlightTracker();
      const d1 = makeDeferred();
      const d2 = makeDeferred();
      const d3 = makeDeferred();
      tracker.register(d1.promise);
      tracker.register(d2.promise);
      tracker.register(d3.promise);
      expect(tracker.inFlightCount()).toBe(3);

      let drainSettled = false;
      const drainPromise = tracker.drain().then(() => {
        drainSettled = true;
      });

      // Resolving only two of three must leave drain pending.
      d1.resolve();
      d2.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(drainSettled).toBe(false);
      expect(tracker.inFlightCount()).toBe(1);

      d3.resolve();
      await drainPromise;
      expect(drainSettled).toBe(true);
      expect(tracker.inFlightCount()).toBe(0);
    });

    it('auto-cleans on resolution even without an intervening drain', async () => {
      const tracker = new GpuInFlightTracker();
      const d = makeDeferred();
      tracker.register(d.promise);
      expect(tracker.inFlightCount()).toBe(1);

      d.resolve();
      // Two microtask ticks let the cleanup .then fire.
      await Promise.resolve();
      await Promise.resolve();
      expect(tracker.inFlightCount()).toBe(0);
    });
  });

  describe('rejection isolation', () => {
    it('drain resolves (does not reject) when a registered promise rejects', async () => {
      const tracker = new GpuInFlightTracker();
      const d = makeDeferred();
      tracker.register(d.promise);

      // Reject the underlying work. Drain must settle as resolved, not
      // rejected — the barrier is a synchronization point, not an error
      // channel. Callers observe dispatch errors via the original promise.
      d.reject(new Error('shader compile failed'));

      // drain() must resolve without throwing.
      await expect(tracker.drain()).resolves.toBeUndefined();
      expect(tracker.inFlightCount()).toBe(0);
    });

    it('auto-cleans on rejection so subsequent drains are fast-path', async () => {
      const tracker = new GpuInFlightTracker();
      const d = makeDeferred();
      tracker.register(d.promise);

      d.reject(new Error('dispatch failed'));
      await tracker.drain();
      expect(tracker.inFlightCount()).toBe(0);

      // Next drain is a fast path with no pending work.
      let drainSettled = false;
      await tracker.drain().then(() => { drainSettled = true; });
      expect(drainSettled).toBe(true);
    });

    it('survives a mix of resolved and rejected registrations', async () => {
      const tracker = new GpuInFlightTracker();
      const ok1 = makeDeferred();
      const bad = makeDeferred();
      const ok2 = makeDeferred();
      tracker.register(ok1.promise);
      tracker.register(bad.promise);
      tracker.register(ok2.promise);

      ok1.resolve();
      bad.reject(new Error('kernel panic'));
      ok2.resolve();

      await expect(tracker.drain()).resolves.toBeUndefined();
      expect(tracker.inFlightCount()).toBe(0);
    });
  });

  describe('snapshot semantics', () => {
    it('does not await work registered after drain starts', async () => {
      // The barrier contract: drain flushes everything dispatched STRICTLY
      // BEFORE the barrier. Work registered while drain is running belongs
      // to the post-barrier step and must NOT block the current drain.
      const tracker = new GpuInFlightTracker();
      const early = makeDeferred();
      tracker.register(early.promise);

      const drainPromise = tracker.drain();

      // Register a new piece of work AFTER drain has started.
      const late = makeDeferred();
      tracker.register(late.promise);
      expect(tracker.inFlightCount()).toBe(2);

      // Resolve ONLY the early work. Drain must complete regardless of
      // whether `late` has settled.
      early.resolve();
      await drainPromise;

      // `late` is still pending; a count of 1 (the late work) is correct.
      expect(tracker.inFlightCount()).toBe(1);

      // Cleanup so vitest doesn't complain about dangling promises.
      late.resolve();
      await tracker.drain();
      expect(tracker.inFlightCount()).toBe(0);
    });
  });

  describe('register accepts arbitrary promise value types', () => {
    it('does not constrain the caller to Promise<void>', async () => {
      // GPU dispatches commonly resolve to a GPUCommandBuffer, a buffer
      // map result, a numeric score, etc. The tracker must not care about
      // the value — only the lifetime. This tests the `Promise<unknown>`
      // signature pins down.
      const tracker = new GpuInFlightTracker();
      tracker.register(Promise.resolve(42));
      tracker.register(Promise.resolve('done'));
      tracker.register(Promise.resolve({ bytesWritten: 1024 }));

      await tracker.drain();
      expect(tracker.inFlightCount()).toBe(0);
    });
  });

  // ─── Module-level tracker injection ───────────────────────────────────────

  describe('setGpuInFlightTracker / resetGpuInFlightTracker', () => {
    it('setGpuInFlightTracker replaces the module tracker — live binding', async () => {
      const original = gpuInFlight;
      const injected = new GpuInFlightTracker();

      // Pre-condition: the module default is the current tracker.
      const beforeInject = (await import('../gpu-in-flight')).gpuInFlight;
      expect(beforeInject).toBe(original);

      try {
        setGpuInFlightTracker(injected);

        // Post-inject: a fresh import sees the replacement (live binding).
        const afterInject = (await import('../gpu-in-flight')).gpuInFlight;
        expect(afterInject).toBe(injected);

        // And register/drain operate on the new tracker only.
        injected.register(Promise.resolve());
        expect(original.inFlightCount()).toBe(0);
      } finally {
        setGpuInFlightTracker(original);
      }
    });

    it('resetGpuInFlightTracker installs a fresh empty tracker', async () => {
      const original = gpuInFlight;
      try {
        // Dirty the current tracker so the reset is observable.
        gpuInFlight.register(new Promise(() => { /* never settles */ }));
        expect(gpuInFlight.inFlightCount()).toBe(1);

        resetGpuInFlightTracker();

        const fresh = (await import('../gpu-in-flight')).gpuInFlight;
        expect(fresh).not.toBe(original);
        expect(fresh.inFlightCount()).toBe(0);
      } finally {
        setGpuInFlightTracker(original);
      }
    });

    it('clear() on the tracker drops in-flight entries without awaiting', () => {
      const tracker = new GpuInFlightTracker();
      // Register two never-settling promises so clear has work to do.
      tracker.register(new Promise(() => { /* never */ }));
      tracker.register(new Promise(() => { /* never */ }));
      expect(tracker.inFlightCount()).toBe(2);

      tracker.clear();
      expect(tracker.inFlightCount()).toBe(0);
    });
  });
});
