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
}

/**
 * Module-level singleton used by the fold barrier (`drainGpuInFlight` in
 * fold.ts). External callers that dispatch GPU work inside the fold path
 * should call `gpuInFlight.register(promise)` exactly once per dispatch.
 *
 * Tests should instantiate their own `GpuInFlightTracker` rather than
 * reaching for this singleton — the singleton is intentionally mutable
 * state and does not reset between test cases.
 */
export const gpuInFlight = new GpuInFlightTracker();
