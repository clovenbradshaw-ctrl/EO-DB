/**
 * GpuInFlightTracker — Phase C in-flight counter for GPU dispatches.
 *
 * Background. Phase B (barrier extraction) split each HelixWave into a
 * sequence of WaveSteps, flagging every flush-gpu op (currently only DEF)
 * as a `barrier: true` step and adding a `drainGpuInFlight()` call site in
 * fold.ts ahead of every barrier. The drain was stubbed out as a no-op
 * because no GPU dispatch had been wired into the fold yet.
 *
 * Phase C lands the in-flight counter that `drainGpuInFlight` binds to.
 * The two things that change here:
 *
 *   1. `register(promise)` — the single public entry point that any future
 *      EVA/REC GPU dispatch calls to enrol its compute-shader promise with
 *      the tracker. The tracker auto-cleans the promise from its in-flight
 *      set once the promise settles (resolved or rejected).
 *
 *   2. `drain()` — the awaitable drain used by the fold barrier. When the
 *      in-flight count is zero, drain is O(1) and synchronous-fast-path:
 *      no microtask hop, no allocation, no await. When the count is
 *      non-zero, drain snapshots the current in-flight set and awaits
 *      Promise.allSettled on that snapshot. Work registered AFTER drain
 *      starts is NOT awaited by that drain call — the barrier semantic is
 *      "flush everything dispatched strictly before the barrier."
 *
 * Scope boundary. Phase C wired up the tracker and the drain plumbing.
 * Phase D (gpu-dispatch.ts) closed the loop by wiring dispatchEvalGpu to
 * call `gpuInFlight.register()` for GPU-eligible EVA formulas, and
 * syncDefToGpu to keep GPU field buffers current on every DEF. The barrier
 * is now operationally live: drain actually awaits GPU work when WebGPU is
 * available and a GPU-eligible formula has been dispatched.
 *
 * Concurrency model. The fold path is already serialized by foldMutex, so
 * `drainGpuInFlight()` is never called concurrently with another
 * processEvent run. External callers (query-path GPU filters, for example)
 * do not cross the fold barrier. The tracker itself is therefore single-
 * threaded by construction; it uses a plain Set without any lock.
 *
 * Errors do not propagate. A rejected GPU dispatch cleans up from the
 * tracker just like a resolved one, and drain uses Promise.allSettled so
 * one failed dispatch does not poison the barrier. The caller owns error
 * handling of the original promise — this tracker only observes lifetimes.
 */

/**
 * Tracks in-flight GPU work so the fold barrier can drain before a
 * schema-mutating operation. See the module header for the full contract.
 */
export class GpuInFlightTracker {
  private readonly inFlight: Set<Promise<void>> = new Set();

  /**
   * Enrol a GPU dispatch promise with the tracker. The returned handle
   * settles when the original work settles; callers do not need to await
   * it (the tracker owns cleanup).
   *
   * The tracker never observes the resolved value — GPU dispatches are
   * fire-and-forget from the tracker's perspective. Callers that need the
   * value should keep their own reference to the original promise.
   */
  register(work: Promise<unknown>): void {
    // Wrap so we can attach a cleanup handler without mutating the
    // caller's promise chain. The wrapped promise resolves to void once
    // cleanup has removed it from the set, which keeps drain's
    // post-condition (inFlight.size === 0 when the snapshot settles) tight.
    let wrapped: Promise<void>;
    wrapped = work.then(
      () => {
        this.inFlight.delete(wrapped);
      },
      () => {
        this.inFlight.delete(wrapped);
      },
    );
    this.inFlight.add(wrapped);
  }

  /**
   * Drain all currently in-flight GPU work. Fast path: if nothing is
   * registered, return synchronously (no microtask hop). This is the
   * Phase B skip-redundant-drain optimization: in steady state the fold
   * barrier costs one property read per barrier step.
   *
   * Slow path: snapshot the in-flight set and await Promise.allSettled on
   * the snapshot. Work registered AFTER drain starts is not awaited by
   * this call — the snapshot is taken exactly once.
   */
  async drain(): Promise<void> {
    if (this.inFlight.size === 0) return;
    const snapshot = [...this.inFlight];
    await Promise.allSettled(snapshot);
  }

  /**
   * Current in-flight count. Exposed for tests and for any future
   * instrumentation that wants to report "how much GPU work is pending"
   * without reaching into the tracker's private state.
   */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Clear the in-flight set without awaiting. For test teardown only —
   * production callers should always `drain()` instead. Provided so a
   * test whose predecessor leaked a registered promise can hard-reset
   * the module singleton in `afterEach` and avoid cross-test bleed.
   *
   * The cleared promises' `.then` handlers still fire when they settle,
   * but will be operating on an already-gone Set entry (delete is a
   * no-op on a missing key), so this is safe.
   */
  clear(): void {
    this.inFlight.clear();
  }
}

/**
 * Module-level tracker used by the fold barrier (`drainGpuInFlight` in
 * fold.ts) and by GPU dispatch sites (`gpu-dispatch.ts`). Callers register
 * their work with the *current* tracker; tests can swap in their own via
 * `setGpuInFlightTracker` (or hard-reset with `resetGpuInFlightTracker`)
 * for isolation between cases.
 *
 * Why `let` rather than `const`. ES-module imports are live bindings, so
 * every `import { gpuInFlight } from './gpu-in-flight'` automatically sees
 * replacements made here. Swapping the tracker from a test's `beforeEach`
 * is therefore safe — no callers cache the previous reference — as long
 * as callers always read `gpuInFlight.x` at the call site (they do) and
 * never stash the reference in a closure variable (they don't).
 */
export let gpuInFlight = new GpuInFlightTracker();

/**
 * Replace the module-level tracker. Intended for tests that need their
 * own isolation or that want to observe register/drain activity without
 * leaking into the next test. Production code should not call this.
 */
export function setGpuInFlightTracker(tracker: GpuInFlightTracker): void {
  gpuInFlight = tracker;
}

/**
 * Replace the module-level tracker with a fresh instance. Equivalent to
 * `setGpuInFlightTracker(new GpuInFlightTracker())` but clearer at call
 * sites. Use in `afterEach` to guarantee no cross-test bleed.
 */
export function resetGpuInFlightTracker(): void {
  gpuInFlight = new GpuInFlightTracker();
}
