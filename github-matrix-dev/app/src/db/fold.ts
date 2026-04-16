import type { EoStore } from './encrypted-store';
import type { ConEdgeAddItem } from './types';
import { appendToLog } from './log';
import { getState, setState } from './state';
import { addEdge, removeEdge, getEdgesFrom, getEdgesTo } from './graph';
import { resolveAlias, checkExists } from './helpers';
import { AsyncMutex } from './mutex';
import { eventHash } from './hash';
import { validateEvent, formatValidationErrors } from './validate';
import { updateFoldCache, refreshGraphMetrics } from './fold-cache';
import {
  SeqReservoir,
  StoreHelixStateTracker,
  checkAndPromote as checkAndPromoteHelix,
  sortByHelixLevel,
  splitWaveIntoSteps,
  mergeOperand,
  isFormulaOperand,
  deepEqual,
} from './fold-core';
import type { HelixStateTracker, PromotionCallbacks } from './fold-core';
import { StoreAddressingHorizon, StoreDeclaredHorizon, StoreNulHorizon } from './addressing-horizon';
import type { AddressingHorizon, DeclaredHorizon, NulHorizon } from './addressing-horizon';
import { gpuInFlight } from './gpu-in-flight';
import { syncDefToGpu, dispatchEvalGpu } from './gpu-dispatch';
import { partitionTargets } from './fold-pool';
import type { EoEvent, EoEventInput, EoState, EvaRegistration, RecResult, ExternalOperator, DerivedEntity, LoggableOperator, Resolution } from './types';
import { nulStateToResolution } from './types';
import { isSyncTarget } from '../sync/sites';

export { sortByHelixLevel } from './fold-core';
export type { HelixWave } from './fold-core';

/** Fold mutex — ensures only one processEvent executes at a time. */
const foldMutex = new AsyncMutex();

/**
 * Drain any in-flight GPU work before applying a schema-mutating op.
 *
 * Called before every wave-step whose `barrier` flag is set — today that
 * means every step containing a `DEF`, which is the only `sync: 'flush-gpu'`
 * operator in OPERATOR_PROCESSING_CLASS. The drain is semantically required
 * because DEF changes the schema dimensionality, and every dense-vector GPU
 * buffer the fold may have been reading becomes stale at the instant the
 * DEF lands.
 *
 * Phase D wiring. This delegates to `gpuInFlight.drain()` — a module-level
 * singleton that tracks registered GPU dispatch promises. When the
 * tracker's in-flight count is zero, drain is O(1) and returns without a
 * microtask hop (the Phase B skip-redundant-drain optimization).
 *
 * As of Phase D, dispatchEvalGpu (in gpu-dispatch.ts) registers GPU work
 * promises with the tracker when evaluating GPU-eligible formulas (numeric
 * aggregation, filter, cosine similarity). The barrier is operationally
 * live: drain awaits any in-flight GPU evaluation before DEF mutates the
 * schema. See `GpuInFlightTracker` in gpu-in-flight.ts,
 * `WaveStep.barrier` in fold-core.ts, and `dispatchEvalGpu` in
 * gpu-dispatch.ts.
 */
async function drainGpuInFlight(): Promise<void> {
  await gpuInFlight.drain();
}

// ─── Helix Infrastructure ────────────────────────────────────────────────────
//
// HELIX_LEVEL, sortByHelixLevel, isHelixValid, SeqReservoir, and the
// HelixStateTracker interface + StoreHelixStateTracker + checkAndPromote all
// live in fold-core.ts (Phase A — slice 1/2/4 deliverables). The Phase A
// constitutive site model — AddressingHorizon and DeclaredHorizon — lives in
// addressing-horizon.ts (slice 3). This file owns only the operator handlers
// and the wiring that connects all of them to processEventCore.
//
// Constitutive site touches happen at one place per processEvent path:
// after appendToLog and before helix.recordOperator, every event touches
// the AddressingHorizon for its target (and, for CON, every destination).
// Explicit SEG events additionally update the DeclaredHorizon with the
// SEG's boundary content.

/**
 * Touch the AddressingHorizon for an event's target plus, for CON events,
 * every destination site in the operand. Returns nothing — touch is
 * idempotent and the new lifecycle state is observable via getRecord.
 */
async function touchAddressingForEvent(
  addressing: AddressingHorizon,
  event: EoEvent,
): Promise<void> {
  await addressing.touch(event.target, event.op as LoggableOperator, event.seq);

  if (event.op === 'CON' && event.operand?.added) {
    for (const item of event.operand.added as ConEdgeAddItem[]) {
      const dest = typeof item === 'string' ? item : item.dest;
      await addressing.touch(dest, 'CON', event.seq);
    }
  }
}

/**
 * Update the DeclaredHorizon for explicit SEG events. The SEG's operand is
 * the boundary content (type, name, partition, …) — stored verbatim so the
 * snapshot writer can serialize it without re-walking the log.
 */
async function declareForEvent(
  declared: DeclaredHorizon,
  event: EoEvent,
): Promise<void> {
  if (event.op !== 'SEG') return;
  await declared.declare(event.target, event.seq, event.operand);
}

/**
 * Resolve the effective Resolution for a NUL event. Prefers the canonical
 * `resolution` field; falls back to the deprecated `nul_state` field via
 * nulStateToResolution for events that pre-date Phase A slice 6 or come
 * from callers that have not yet been migrated. If neither is set, returns
 * 'unspecified'.
 */
function effectiveResolutionForNul(event: EoEvent): Resolution {
  if (event.resolution && event.resolution !== 'unspecified') {
    return event.resolution;
  }
  if (event.nul_state) {
    return nulStateToResolution(event.nul_state);
  }
  return event.resolution ?? 'unspecified';
}

/**
 * Record a NUL event on the NulHorizon. NUL is a typed observation, not a
 * deletion — this function does not mutate any state map. The resolution is
 * resolved via effectiveResolutionForNul so callers that still set the
 * legacy `nul_state` field continue to be honored.
 */
async function recordNulForEvent(
  nulHorizon: NulHorizon,
  event: EoEvent,
): Promise<void> {
  if (event.op !== 'NUL') return;
  const resolution = effectiveResolutionForNul(event);
  await nulHorizon.record(event.target, resolution, event.seq);
}

/**
 * Build the PromotionCallbacks fold-core's checkAndPromote expects, binding
 * them to the live store + tracker + onEvent hook. Exposed as a single helper
 * so processEventCore and processEventInner share one wiring and the blocked-
 * promotion stub lives in exactly one place.
 */
function buildPromotionCallbacks(
  store: EoStore,
  tracker: HelixStateTracker,
  onEvent: ((event: EoEvent) => void) | undefined,
): PromotionCallbacks {
  return {
    emitSynthetic: async (input, d) => {
      await processEventCore(store, input, onEvent, d);
    },
    emitBlocked: async (target) => {
      const now = new Date().toISOString();
      const blockedSeq = await store.nextSeq();
      // Resolution 'Unraveling' is the lattice-model encoding of cascade-limit
      // observations. `nul_state: 'promotion_blocked'` is retained for
      // backward-compatible display until consumers migrate; both mean the
      // same thing — the depth cap was hit trying to auto-promote this site.
      const blockedEvent: EoEvent = {
        seq: blockedSeq,
        op: 'NUL',
        target,
        operand: {},
        agent: 'system:helix',
        ts: now,
        acquired_ts: now,
        resolution: 'Unraveling',
        nul_state: 'promotion_blocked',
        meta: { auto_promoted: false, promotion_blocked: true, reason: 'max promotion depth exceeded' },
      };
      await appendToLog(store, blockedEvent);
      await tracker.recordOperator(target, 'NUL', blockedSeq);
      // Record the blocked observation in the NulHorizon so replayed state
      // carries the absence fact forward.
      await new StoreNulHorizon(store).record(target, 'Unraveling', blockedSeq);
      await updateFoldCache(store, blockedEvent);
      if (onEvent) onEvent(blockedEvent);
    },
  };
}

/**
 * Process a single EO event through the fold.
 * This is the heart of the database — every event flows through here.
 *
 * Protected by foldMutex: concurrent calls queue and execute serially.
 * Uses content-addressable hashing for idempotency when client_event_id
 * is not provided.
 */
export async function processEvent(
  store: EoStore,
  event: EoEventInput,
  onEvent?: (event: EoEvent) => void,
): Promise<number> {
  return foldMutex.run(() => processEventInner(store, event, onEvent));
}

// ─── Shared step-dispatch helper ──────────────────────────────────────────
//
// Phase E: extracted from the inline dispatch in processEventsBulk so that
// processEventsBulkPooled (shard-pool path) can reuse the same seq-
// assignment, target grouping, and barrier logic with a different target
// grouping strategy.

/**
 * Context object for the step-dispatch helper. Carries the shared state
 * that the wave-step loop mutates.
 */
interface StepDispatchContext {
  store: EoStore;
  reservoir: SeqReservoir;
  addressing: AddressingHorizon;
  declared: DeclaredHorizon;
  nulHorizon: NulHorizon;
  onEvent?: (event: EoEvent) => void;
  onProgress?: (current: number, total: number) => void;
  totalEvents: number;
  /** Mutable counter — incremented by the dispatch. */
  processed: number;
  /** Mutable high-water mark — updated by the dispatch. */
  lastSeq: number;
}

/**
 * Process a sequence of WaveSteps, dispatching events to targets grouped
 * by `groupTargets`. Before each barrier step, drains in-flight GPU work.
 *
 * `groupTargets` controls parallelism:
 *   - Default (one group per target): maximum concurrency — one Promise per
 *     target. This is the existing bulk-path behavior.
 *   - Shard pool (N groups): bounded concurrency — one Promise per shard,
 *     targets within a shard are processed sequentially.
 *
 * Mutates `ctx.processed` and `ctx.lastSeq` as side effects.
 */
async function dispatchWaveSteps(
  steps: import('./fold-core').WaveStep[],
  ctx: StepDispatchContext,
  groupTargets: (sortedTargets: string[]) => string[][],
): Promise<void> {
  for (const step of steps) {
    if (step.barrier) {
      await drainGpuInFlight();
    }

    // Assign seqs in step-event order — the same order in which the
    // pre-pass saw events. Synthetic INS events receive a seq BEFORE
    // any event that depends on them.
    const planned: { event: EoEventInput; seq: number }[] = step.events.map((event) => ({
      event,
      seq: ctx.reservoir.take(),
    }));

    // Group by target while preserving the pre-assigned seqs.
    const byTarget = new Map<string, { event: EoEventInput; seq: number }[]>();
    for (const p of planned) {
      const bucket = byTarget.get(p.event.target);
      if (bucket) bucket.push(p);
      else byTarget.set(p.event.target, [p]);
    }
    const sortedTargetKeys = [...byTarget.keys()].sort();

    // Apply the grouping strategy and dispatch.
    const groups = groupTargets(sortedTargetKeys);
    const stepSeqs = await Promise.all(
      groups.map(async (groupTargetList) => {
        let groupLastSeq = 0;
        for (const target of groupTargetList) {
          const targetEvents = byTarget.get(target)!;
          for (const { event, seq } of targetEvents) {
            await processEventCoreWithSeq(
              ctx.store, event, seq,
              ctx.addressing, ctx.declared, ctx.nulHorizon,
              ctx.onEvent,
            );
            if (seq > groupLastSeq) groupLastSeq = seq;
            ctx.processed++;
            ctx.onProgress?.(ctx.processed, ctx.totalEvents);
          }
        }
        return groupLastSeq;
      })
    );

    for (const seq of stepSeqs) {
      if (seq > ctx.lastSeq) ctx.lastSeq = seq;
    }
  }
}

/** Default grouping: one target per group (maximum parallelism). */
function oneTargetPerGroup(targets: string[]): string[][] {
  return targets.map(t => [t]);
}

/**
 * Bulk-import mode: process events quickly by:
 *
 *   1. Sorting events into helix waves (NUL/SIG → INS → SEG/CON → SYN → DEF → EVA).
 *
 *   2. Walking each wave in arrival order to expand auto-promotion into
 *      explicit synthetic INS events (Phase A constitutive site pre-pass).
 *      The expansion is fully sequential, so there is no microtask race on
 *      helix checks — and no need for the recursive checkAndPromote path.
 *
 *   3. Reserving a contiguous seq range for the expanded wave via an
 *      AddressingHorizon, assigning seqs in deterministic expansion order
 *      BEFORE any parallel dispatch runs. This is the fix for the V8-
 *      microtask race documented in fold-determinism.test.ts (FIXME(phase-A)):
 *      seqs are frozen before Promise.all sees them, so the bulk path is now
 *      byte-identical across runs of the same input.
 *
 *   4. Grouping by target and executing targets in parallel via
 *      processEventCoreWithSeq, which skips nextSeq() and checkAndPromote
 *      (both handled by the pre-pass). Per-target tasks remain sequential
 *      within a target to preserve arrival order on that target's trajectory
 *      hash chain.
 *
 *   5. Deferring recomputeDependents, detectAndEmitREC, and cascadeUpward
 *      until all waves complete, then running each once per touched target.
 */
export async function processEventsBulk(
  store: EoStore,
  events: EoEventInput[],
  onProgress?: (current: number, total: number) => void,
  onEvent?: (event: EoEvent) => void,
): Promise<number> {
  return foldMutex.run(async () => {
    const touchedTargets = new Set<string>();
    const reservoir = new SeqReservoir(store);
    const helix = new StoreHelixStateTracker(store);
    const addressing = new StoreAddressingHorizon(store);
    const declared = new StoreDeclaredHorizon(store);
    const nulHorizon = new StoreNulHorizon(store);
    let lastSeq = 0;
    let processed = 0;

    // Persistent across waves: which targets have been INSed so far (either
    // already in the store, or inserted by an earlier wave's real/synthetic
    // INS). Seeded lazily per target via tracker reads.
    const insedLocal = new Set<string>();
    const insedChecked = new Set<string>();

    async function markInsed(target: string): Promise<void> {
      if (insedChecked.has(target)) {
        insedLocal.add(target);
        return;
      }
      insedChecked.add(target);
      insedLocal.add(target);
    }

    async function needsSyntheticINS(target: string): Promise<boolean> {
      if (insedLocal.has(target)) return false;
      if (!insedChecked.has(target)) {
        insedChecked.add(target);
        const pos = await helix.getPosition(target);
        if (pos && new Set(pos.declared ?? []).has('INS')) {
          insedLocal.add(target);
          return false;
        }
      }
      return true;
    }

    function makeSyntheticINS(target: string): EoEventInput {
      const now = new Date().toISOString();
      return {
        op: 'INS',
        target,
        operand: {},
        agent: 'system:helix',
        ts: now,
        acquired_ts: now,
        meta: { auto_promoted: true, reason: 'required by helix — missing INS' },
      };
    }

    // Phase 1: wave-based ingestion
    const waves = sortByHelixLevel(events);

    for (const wave of waves) {
      // Step 1: Pre-pass. Walk wave events in deterministic arrival order and
      // emit synthetic INS events for any target (or CON destination) that
      // has not yet been INSed. The expanded stream is the full sequence of
      // work for this wave, in replay order.
      const expanded: EoEventInput[] = [];
      for (const event of wave.events) {
        touchedTargets.add(event.target);

        // Synthetic INS for the event's own target, if it needs one.
        if (
          event.op !== 'NUL' && event.op !== 'SIG' &&
          event.op !== 'REC' && event.op !== 'INS'
        ) {
          if (await needsSyntheticINS(event.target)) {
            expanded.push(makeSyntheticINS(event.target));
            await markInsed(event.target);
          }
        } else if (event.op === 'INS') {
          // The event itself is the INS — mark and enqueue.
          await markInsed(event.target);
        }

        // CON: synthetic INS for any destination target that needs one.
        if (event.op === 'CON' && event.operand?.added) {
          for (const item of event.operand.added as ConEdgeAddItem[]) {
            const dest = typeof item === 'string' ? item : item.dest;
            touchedTargets.add(dest);
            if (await needsSyntheticINS(dest)) {
              expanded.push(makeSyntheticINS(dest));
              await markInsed(dest);
            }
          }
        }

        expanded.push(event);
      }

      if (expanded.length === 0) continue;

      // Step 2: Split the expanded wave into wave-steps at flush-gpu
      // boundaries (Phase B — Barrier extraction). Each flush-gpu op
      // (currently only DEF) becomes its own single-event step with
      // `barrier: true`; non-flush events accumulate into `barrier: false`
      // steps. The splitter is pure — no side effects, no seq allocation.
      //
      // CRITICAL: this runs BEFORE reservoir.reserve() so the single
      // reservation call below remains the sole control-flow site that
      // advances store.nextSeq() during bulk ingestion. Moving reserve()
      // inside the step loop would reintroduce the V8 microtask race that
      // Phase A closed by serializing seq allocation.
      const steps = splitWaveIntoSteps({ level: wave.level, events: expanded });

      // Step 3: Reserve a contiguous seq range for the WHOLE expanded wave
      // (not per-step). reservoir.take() carries across step boundaries
      // within a wave — same reservoir, same arrival order — so the seqs
      // assigned are identical to the pre-barrier-extraction behavior.
      await reservoir.reserve(expanded.length);

      // Step 4: Process each wave-step sequentially via the shared helper.
      // Default grouping: one target per group (maximum parallelism).
      const ctx: StepDispatchContext = {
        store, reservoir, addressing, declared, nulHorizon, onEvent, onProgress,
        totalEvents: events.length, processed, lastSeq,
      };
      await dispatchWaveSteps(steps, ctx, oneTargetPerGroup);
      processed = ctx.processed;
      lastSeq = ctx.lastSeq;
    }

    // Phase 2: run deferred recomputation once per unique target
    for (const target of touchedTargets) {
      await recomputeDependents(store, target, new Set());
    }

    // Phase 3: detect cycles once per unique target
    const now = new Date().toISOString();
    const syntheticTrigger: EoEvent = {
      seq: lastSeq,
      op: 'INS',
      target: '__bulk_import__',
      operand: {},
      agent: 'system:bulk',
      ts: now,
      acquired_ts: now,
    };
    for (const target of touchedTargets) {
      await detectAndEmitREC(store, target, syntheticTrigger, onEvent);
      await cascadeUpward(store, target, syntheticTrigger, onEvent);
    }

    return lastSeq;
  });
}

/**
 * Shard-pool bulk import — Phase E.
 *
 * Identical to processEventsBulk in every way except the dispatch strategy:
 * instead of one Promise per target (maximum concurrency), targets are
 * partitioned into `shardCount` fixed shards via a deterministic hash
 * (see partitionTargets in fold-pool.ts). Each shard processes its targets
 * sequentially; shards run concurrently via Promise.all.
 *
 * The wave-level synchronization model resolves the cross-shard CON
 * dependency that blocked the naive shard runner in Phase D:
 *
 *   1. Helix waves enforce operator precedence: all INS events (level 1)
 *      complete across ALL shards before any CON event (level 2) starts.
 *
 *   2. The pre-pass generates synthetic INS events for CON destinations,
 *      so every target referenced by a CON is guaranteed to exist by the
 *      time the CON's wave runs.
 *
 *   3. The shared-store model makes cross-shard writes (e.g. CON reverse
 *      edges in the destination's key space) immediately visible. For real
 *      Web Workers with isolated stores, a merge phase would be needed —
 *      deferred to the worker-transport phase.
 *
 * The pooled path exists to prove that the partitioning strategy is
 * deterministic: the fold-determinism harness runs all 4 properties against
 * the shard-pool runner alongside serial, bulk, and chunked-bulk.
 */
export async function processEventsBulkPooled(
  store: EoStore,
  events: EoEventInput[],
  shardCount: number,
  onProgress?: (current: number, total: number) => void,
  onEvent?: (event: EoEvent) => void,
): Promise<number> {
  return foldMutex.run(async () => {
    const touchedTargets = new Set<string>();
    const reservoir = new SeqReservoir(store);
    const helix = new StoreHelixStateTracker(store);
    const addressing = new StoreAddressingHorizon(store);
    const declared = new StoreDeclaredHorizon(store);
    const nulHorizon = new StoreNulHorizon(store);
    let lastSeq = 0;
    let processed = 0;

    const insedLocal = new Set<string>();
    const insedChecked = new Set<string>();

    async function markInsed(target: string): Promise<void> {
      if (insedChecked.has(target)) {
        insedLocal.add(target);
        return;
      }
      insedChecked.add(target);
      insedLocal.add(target);
    }

    async function needsSyntheticINS(target: string): Promise<boolean> {
      if (insedLocal.has(target)) return false;
      if (!insedChecked.has(target)) {
        insedChecked.add(target);
        const pos = await helix.getPosition(target);
        if (pos && new Set(pos.declared ?? []).has('INS')) {
          insedLocal.add(target);
          return false;
        }
      }
      return true;
    }

    function makeSyntheticINS(target: string): EoEventInput {
      const now = new Date().toISOString();
      return {
        op: 'INS',
        target,
        operand: {},
        agent: 'system:helix',
        ts: now,
        acquired_ts: now,
        meta: { auto_promoted: true, reason: 'required by helix — missing INS' },
      };
    }

    // Phase 1: wave-based ingestion — identical to processEventsBulk
    const waves = sortByHelixLevel(events);

    for (const wave of waves) {
      const expanded: EoEventInput[] = [];
      for (const event of wave.events) {
        touchedTargets.add(event.target);

        if (
          event.op !== 'NUL' && event.op !== 'SIG' &&
          event.op !== 'REC' && event.op !== 'INS'
        ) {
          if (await needsSyntheticINS(event.target)) {
            expanded.push(makeSyntheticINS(event.target));
            await markInsed(event.target);
          }
        } else if (event.op === 'INS') {
          await markInsed(event.target);
        }

        if (event.op === 'CON' && event.operand?.added) {
          for (const item of event.operand.added as ConEdgeAddItem[]) {
            const dest = typeof item === 'string' ? item : item.dest;
            touchedTargets.add(dest);
            if (await needsSyntheticINS(dest)) {
              expanded.push(makeSyntheticINS(dest));
              await markInsed(dest);
            }
          }
        }

        expanded.push(event);
      }

      if (expanded.length === 0) continue;

      const steps = splitWaveIntoSteps({ level: wave.level, events: expanded });
      await reservoir.reserve(expanded.length);

      // Phase E dispatch: shard-pool grouping instead of one-per-target.
      const shardGrouper = (targets: string[]) => partitionTargets(targets, shardCount);
      const ctx: StepDispatchContext = {
        store, reservoir, addressing, declared, nulHorizon, onEvent, onProgress,
        totalEvents: events.length, processed, lastSeq,
      };
      await dispatchWaveSteps(steps, ctx, shardGrouper);
      processed = ctx.processed;
      lastSeq = ctx.lastSeq;
    }

    // Phase 2: deferred recomputation — identical to processEventsBulk
    for (const target of touchedTargets) {
      await recomputeDependents(store, target, new Set());
    }

    // Phase 3: detect cycles
    const now = new Date().toISOString();
    const syntheticTrigger: EoEvent = {
      seq: lastSeq,
      op: 'INS',
      target: '__bulk_import__',
      operand: {},
      agent: 'system:bulk',
      ts: now,
      acquired_ts: now,
    };
    for (const target of touchedTargets) {
      await detectAndEmitREC(store, target, syntheticTrigger, onEvent);
      await cascadeUpward(store, target, syntheticTrigger, onEvent);
    }

    return lastSeq;
  });
}

/**
 * Dispatcher-backed shard fold — Phases F + G.
 *
 * Same wave/step/reservoir/pre-pass logic as processEventsBulkPooled, but
 * the actual shard body is delegated to a pluggable `ShardDispatcher`
 * (see fold-worker-transport.ts). Phase F proved the isolation+merge
 * protocol correct when the dispatcher ran in-process; Phase G lifts the
 * same body onto a real Web Worker pool by swapping the dispatcher.
 *
 * The dispatcher-based design is what turns Phase E + F's shard work
 * into actual multi-core parallelism. Nothing else about the coordinator
 * changes — the wave model, the pre-pass, the seq reservation, the
 * per-step barrier, and the post-merge graph-metric reconciliation all
 * behave identically regardless of which dispatcher is plugged in.
 *
 * The isolation protocol:
 *
 *   1. Snapshot the main store before each wave step.
 *   2. Ship (snapshot, shardTargets, planned events) to each shard via
 *      the dispatcher. In-process: run the work on the current thread.
 *      Worker: postMessage to a worker and await the reply.
 *   3. Each shard returns a mutation log recorded on its isolated clone.
 *   4. Apply all shards' mutations to the main store in shard order.
 *   5. Re-run refreshGraphMetrics on every CON destination to reconcile
 *      reverse-edge degree counts that each shard saw only partially.
 *
 * Cross-shard writes (CON reverse edges) are safe because they are
 * additive inserts — no read-modify-write conflicts. The wave-level
 * synchronization guarantees all INS events complete before any CON
 * event, so checkExists calls on CON destinations always succeed (the
 * destination was INS'd in a prior wave and is present in the snapshot).
 */
export async function processEventsBulkViaDispatcher(
  store: EoStore,
  events: EoEventInput[],
  shardCount: number,
  dispatcher: import('./fold-worker-transport').ShardDispatcher,
  onProgress?: (current: number, total: number) => void,
  onEvent?: (event: EoEvent) => void,
  options?: { useFullSnapshot?: boolean },
): Promise<number> {
  const { applyMutations } = await import('./fold-isolate');
  const { snapshotStoreWithEdgeIndex, filterSnapshotForShard } = await import('./fold-worker-transport');
  // Escape hatch for the determinism harness: when `useFullSnapshot` is set,
  // every shard receives the unfiltered snapshot. Proves that selective-seed
  // filtering is lossless — any filter regression that drops a key the shard
  // body reads would show up as a projection divergence against the full
  // path. Production paths always leave this undefined so shards get the
  // narrowed payload.
  const useFullSnapshot = options?.useFullSnapshot === true;

  return foldMutex.run(async () => {
    const touchedTargets = new Set<string>();
    const reservoir = new SeqReservoir(store);
    const helix = new StoreHelixStateTracker(store);
    let lastSeq = 0;
    let processed = 0;

    const insedLocal = new Set<string>();
    const insedChecked = new Set<string>();

    async function markInsed(target: string): Promise<void> {
      if (insedChecked.has(target)) {
        insedLocal.add(target);
        return;
      }
      insedChecked.add(target);
      insedLocal.add(target);
    }

    async function needsSyntheticINS(target: string): Promise<boolean> {
      if (insedLocal.has(target)) return false;
      if (!insedChecked.has(target)) {
        insedChecked.add(target);
        const pos = await helix.getPosition(target);
        if (pos && new Set(pos.declared ?? []).has('INS')) {
          insedLocal.add(target);
          return false;
        }
      }
      return true;
    }

    function makeSyntheticINS(target: string): EoEventInput {
      const now = new Date().toISOString();
      return {
        op: 'INS',
        target,
        operand: {},
        agent: 'system:helix',
        ts: now,
        acquired_ts: now,
        meta: { auto_promoted: true, reason: 'required by helix — missing INS' },
      };
    }

    // Phase 1: wave-based ingestion — pre-pass identical to processEventsBulk
    const waves = sortByHelixLevel(events);

    for (const wave of waves) {
      const expanded: EoEventInput[] = [];
      for (const event of wave.events) {
        touchedTargets.add(event.target);

        if (
          event.op !== 'NUL' && event.op !== 'SIG' &&
          event.op !== 'REC' && event.op !== 'INS'
        ) {
          if (await needsSyntheticINS(event.target)) {
            expanded.push(makeSyntheticINS(event.target));
            await markInsed(event.target);
          }
        } else if (event.op === 'INS') {
          await markInsed(event.target);
        }

        if (event.op === 'CON' && event.operand?.added) {
          for (const item of event.operand.added as ConEdgeAddItem[]) {
            const dest = typeof item === 'string' ? item : item.dest;
            touchedTargets.add(dest);
            if (await needsSyntheticINS(dest)) {
              expanded.push(makeSyntheticINS(dest));
              await markInsed(dest);
            }
          }
        }

        expanded.push(event);
      }

      if (expanded.length === 0) continue;

      const steps = splitWaveIntoSteps({ level: wave.level, events: expanded });
      await reservoir.reserve(expanded.length);

      // Dispatcher-backed shard dispatch with post-merge reconciliation.
      for (const step of steps) {
        if (step.barrier) {
          await drainGpuInFlight();
        }

        // Assign seqs in step-event order (same as shared-store paths).
        const planned: { event: EoEventInput; seq: number }[] = step.events.map((event) => ({
          event,
          seq: reservoir.take(),
        }));

        // Group by target.
        const byTarget = new Map<string, { event: EoEventInput; seq: number }[]>();
        for (const p of planned) {
          const bucket = byTarget.get(p.event.target);
          if (bucket) bucket.push(p);
          else byTarget.set(p.event.target, [p]);
        }
        const sortedTargetKeys = [...byTarget.keys()].sort();

        // Partition into shards.
        const shards = partitionTargets(sortedTargetKeys, shardCount);

        // Collect CON destinations for post-merge reconciliation.
        // In the isolated model, handleCON calls refreshGraphMetrics on
        // destinations, but each shard only sees its own reverse edges.
        // After merge, the main store has ALL edges, so we re-run the
        // metrics to get the correct degree/role counts.
        const conDestinations = new Set<string>();
        for (const p of planned) {
          if (p.event.op === 'CON' && p.event.operand?.added) {
            for (const item of p.event.operand.added as ConEdgeAddItem[]) {
              conDestinations.add(typeof item === 'string' ? item : item.dest);
            }
          }
        }

        // Snapshot the main store BEFORE shard dispatch, with the outgoing
        // edge index pre-built so per-shard filtering is linear in the
        // snapshot size. Selective seeding (Phase H) then narrows each
        // shard's wire payload to the keys it can actually observe —
        // see `filterSnapshotForShard` in fold-worker-transport.ts.
        const snapshotBundle = await snapshotStoreWithEdgeIndex(store);
        const currentSeq = await store.getCurrentSeq();

        // Pre-compute per-shard CON destinations so the filter can include
        // their rows. `conDestinations` above is the UNION across shards
        // (needed for post-merge graph-metric reconciliation); here we
        // need the partition so each shard only sees its own dests.
        const perShardConDests: Set<string>[] = shards.map(() => new Set<string>());
        for (let shardIdx = 0; shardIdx < shards.length; shardIdx++) {
          const targetSet = new Set(shards[shardIdx]);
          for (const p of planned) {
            if (!targetSet.has(p.event.target)) continue;
            if (p.event.op === 'CON' && p.event.operand?.added) {
              for (const item of p.event.operand.added as ConEdgeAddItem[]) {
                perShardConDests[shardIdx].add(typeof item === 'string' ? item : item.dest);
              }
            }
          }
        }

        // Dispatch: each shard gets its own isolated clone via the
        // transport-agnostic dispatcher. In-process path runs locally;
        // worker path postMessages to a Worker thread.
        const shardResults = await Promise.all(
          shards.map(async (shardTargets, shardIdx) => {
            if (shardTargets.length === 0) {
              return { mutations: [], shardLastSeq: 0, processedCount: 0, emittedEvents: [] };
            }
            // Restrict the target→planned payload to just this shard's
            // targets — the snapshot is filtered to this shard's relevant
            // targets, and planned events are shard-specific. Shrinks
            // wire size on the worker path.
            const targetsToPlanned: [string, { event: EoEventInput; seq: number }[]][] =
              shardTargets.map((t) => [t, byTarget.get(t)!]);
            const shardSnapshot = useFullSnapshot
              ? snapshotBundle.entries.slice()
              : filterSnapshotForShard(
                  snapshotBundle,
                  shardTargets,
                  perShardConDests[shardIdx],
                );
            return dispatcher({
              shardingHashVersion: snapshotBundle.shardingHashVersion,
              snapshot: shardSnapshot,
              currentSeq,
              shardTargets,
              targetsToPlanned,
            });
          })
        );

        // Merge: apply every shard's mutation log to the main store in
        // shard order. Each shard's writes to its own target key space
        // are conflict-free; CON reverse-edge writes are additive.
        //
        // Fan out the shard's `emittedEvents` through `onEvent` AFTER the
        // mutations are merged — this is how the worker transport delivers
        // the same event stream the in-process bulk paths deliver
        // (UI bookkeeping, Drive saveOp batching, PeerSync broadcast queue).
        // The function-valued `onEvent` can't cross postMessage, so the
        // shard collected events on its side and the coordinator replays
        // them here in shard order.
        for (const { mutations, shardLastSeq, processedCount, emittedEvents } of shardResults) {
          await applyMutations(store, mutations);
          if (onEvent) {
            for (const ev of emittedEvents) onEvent(ev);
          }
          if (shardLastSeq > lastSeq) lastSeq = shardLastSeq;
          processed += processedCount;
          onProgress?.(processed, events.length);
        }

        // Post-merge reconciliation: re-compute graph metrics for CON
        // destinations on the merged store. Each shard's handleCON only
        // saw its own reverse edges, so destination metrics were partial.
        // This pass sees ALL edges and produces correct degree/role values.
        for (const dest of conDestinations) {
          await refreshGraphMetrics(store, dest);
        }
      }
    }

    // Phase 2: deferred recomputation on the main (merged) store.
    for (const target of touchedTargets) {
      await recomputeDependents(store, target, new Set());
    }

    // Phase 3: detect cycles.
    const now = new Date().toISOString();
    const syntheticTrigger: EoEvent = {
      seq: lastSeq,
      op: 'INS',
      target: '__bulk_import__',
      operand: {},
      agent: 'system:bulk',
      ts: now,
      acquired_ts: now,
    };
    for (const target of touchedTargets) {
      await detectAndEmitREC(store, target, syntheticTrigger, onEvent);
      await cascadeUpward(store, target, syntheticTrigger, onEvent);
    }

    return lastSeq;
  });
}

/**
 * Isolated-store shard pool — Phase F (now dispatcher-backed).
 *
 * Equivalent to `processEventsBulkViaDispatcher` with the in-process
 * dispatcher. Retained as a named entry point so the determinism harness
 * and any existing caller continue to work unchanged — the refactor
 * moved the shard body onto the ShardDispatcher contract without
 * altering the observable behavior.
 */
export async function processEventsBulkIsolated(
  store: EoStore,
  events: EoEventInput[],
  shardCount: number,
  onProgress?: (current: number, total: number) => void,
  onEvent?: (event: EoEvent) => void,
): Promise<number> {
  const { dispatchShardInProcess } = await import('./fold-worker-transport');
  return processEventsBulkViaDispatcher(
    store, events, shardCount, dispatchShardInProcess, onProgress, onEvent,
  );
}

/**
 * Real Web Worker transport — Phase G.
 *
 * Runs the same dispatcher-backed shard fold as `processEventsBulkIsolated`,
 * but each shard is dispatched to a dedicated Worker thread via postMessage.
 * The caller supplies a `workerFactory` (because the way a Worker is
 * constructed is bundler-specific):
 *
 *   new Worker(
 *     new URL('../workers/fold-shard.worker.ts', import.meta.url),
 *     { type: 'module' },
 *   )
 *
 * The pool is sized to `shardCount` by default — one worker per shard.
 * Callers importing at a fan-in threshold should size shardCount to
 * `navigator.hardwareConcurrency` (capped) so the pool matches the
 * available cores.
 *
 * The pool is terminated when the fold completes (or throws), so callers
 * don't need a long-lived pool unless they're doing many back-to-back
 * bulk imports. A future optimization can cache the pool at the EoDB
 * level to amortize worker-spawn cost across multiple imports.
 */
export async function processEventsBulkWorker(
  store: EoStore,
  events: EoEventInput[],
  shardCount: number,
  workerFactory: () => Worker,
  onProgress?: (current: number, total: number) => void,
  onEvent?: (event: EoEvent) => void,
): Promise<number> {
  const { createWorkerShardPool } = await import('./fold-worker-transport');
  const pool = createWorkerShardPool({ workerCount: shardCount, workerFactory });
  try {
    return await processEventsBulkViaDispatcher(
      store, events, shardCount, pool.dispatcher, onProgress, onEvent,
    );
  } finally {
    pool.terminate();
  }
}

/**
 * Dispatcher-backed bulk fold with a caller-owned dispatcher. Same wave
 * pipeline as `processEventsBulkWorker`, but the coordinator does NOT
 * spawn or terminate the pool — ownership is the caller's.
 *
 * This is the entry point to use when the caller wants to amortize
 * worker-spawn cost across back-to-back imports (e.g. the EoDB store
 * caches a single pool for the lifetime of a space and reuses it).
 *
 * `dispatcher` can be any ShardDispatcher — `dispatchShardInProcess`,
 * a long-lived `WorkerShardPool.dispatcher`, or a test double.
 */
export async function processEventsBulkWithDispatcher(
  store: EoStore,
  events: EoEventInput[],
  shardCount: number,
  dispatcher: import('./fold-worker-transport').ShardDispatcher,
  onProgress?: (current: number, total: number) => void,
  onEvent?: (event: EoEvent) => void,
): Promise<number> {
  return processEventsBulkViaDispatcher(
    store, events, shardCount, dispatcher, onProgress, onEvent,
  );
}

/**
 * Process an event with a pre-assigned seq. Used by the bulk path after
 * SeqReservoir has reserved and ordered seqs. Skips nextSeq() and
 * checkAndPromote — both are handled by the bulk dispatcher's pre-pass.
 *
 * All other steps (validate → client_event_id → idempotency → INS pre-check
 * → appendToLog → executeOperator → addressing.touch → declared.declare
 * → helix.recordOperator → updateFoldCache → onEvent) run exactly as they
 * do in the serial processEventCore.
 */
export async function processEventCoreWithSeq(
  store: EoStore,
  event: EoEventInput,
  seq: number,
  addressing: AddressingHorizon,
  declared: DeclaredHorizon,
  nulHorizon: NulHorizon,
  onEvent?: (event: EoEvent) => void,
): Promise<number> {
  if (event.op === 'REC' && !isSyncTarget(event.target)) {
    // App-layer RECs are emitted internally by detectAndEmitREC. Sync-layer
    // RECs (peer/piece site restructuring, §3) are emitted by the sync
    // worker — a system actor — and must be accepted here so they enter
    // the log on the same path as application events (sync.md §Phase 5).
    throw new Error('REC is system-generated and cannot be submitted externally');
  }
  const validationErrors = validateEvent(event);
  if (validationErrors) {
    throw new Error(`Invalid event: ${formatValidationErrors(validationErrors)}`);
  }

  if (!event.client_event_id) {
    event = { ...event, client_event_id: await eventHash(event) };
  }

  // Idempotency check
  const idemExisting = await store.get(`idem:${event.client_event_id}`);
  if (idemExisting != null) {
    return idemExisting as number;
  }

  // Pre-check for INS: reject before any state mutation if target already exists.
  if (event.op === 'INS') {
    const existingState = await checkExists(store, event.target);
    if (existingState) {
      throw new Error(`Target already instantiated: ${event.target}`);
    }
  }

  const fullEvent: EoEvent = { ...event, seq };

  await appendToLog(store, fullEvent);
  await store.put(`idem:${event.client_event_id!}`, seq);

  try {
    await executeOperator(store, fullEvent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.put(`error:${seq}`, {
      seq,
      client_event_id: event.client_event_id,
      op: event.op,
      target: event.target,
      error: message,
      ts: new Date().toISOString(),
    });
    if (onEvent) onEvent({ ...fullEvent, meta: { ...fullEvent.meta, _error: message } });
    return seq;
  }

  // Phase A constitutive site touches — every event addresses the AddressingHorizon
  // for its target (and CON destinations); explicit SEG events update the
  // DeclaredHorizon with their boundary content; NUL events record a typed
  // absence observation on the NulHorizon.
  await touchAddressingForEvent(addressing, fullEvent);
  await declareForEvent(declared, fullEvent);
  await recordNulForEvent(nulHorizon, fullEvent);

  await new StoreHelixStateTracker(store).recordOperator(fullEvent.target, fullEvent.op as LoggableOperator, seq);
  await updateFoldCache(store, fullEvent);

  if (onEvent) {
    onEvent(fullEvent);
  }

  return seq;
}

/**
 * Core event processing — steps 1-7 only (no deferred recomputation).
 * Used by bulk import to defer steps 7b-9 until after all events are ingested.
 *
 * _promotionDepth is an internal parameter that tracks recursion through
 * fold-core's checkAndPromote to prevent infinite cascade (cap:
 * MAX_PROMOTION_DEPTH, defined in fold-core).
 */
async function processEventCore(
  store: EoStore,
  event: EoEventInput,
  onEvent?: (event: EoEvent) => void,
  _promotionDepth = 0,
): Promise<number> {
  if (event.op === 'REC' && !isSyncTarget(event.target)) {
    // App-layer RECs are emitted internally by detectAndEmitREC. Sync-layer
    // RECs (peer/piece site restructuring, §3) are emitted by the sync
    // worker — a system actor — and must be accepted here so they enter
    // the log on the same path as application events (sync.md §Phase 5).
    throw new Error('REC is system-generated and cannot be submitted externally');
  }
  const validationErrors = validateEvent(event);
  if (validationErrors) {
    throw new Error(`Invalid event: ${formatValidationErrors(validationErrors)}`);
  }

  if (!event.client_event_id) {
    event = { ...event, client_event_id: await eventHash(event) };
  }

  // Idempotency check
  const idemExisting = await store.get(`idem:${event.client_event_id}`);
  if (idemExisting != null) {
    return idemExisting as number;
  }

  // Pre-check for INS: reject before any state mutation if target already exists.
  if (event.op === 'INS') {
    const existingState = await checkExists(store, event.target);
    if (existingState) {
      throw new Error(`Target already instantiated: ${event.target}`);
    }
  }

  // Helix promotion — runs BEFORE seq assignment so promoted events get lower
  // seq numbers and appear before the original event in replay order.
  const helix = new StoreHelixStateTracker(store);
  const addressing = new StoreAddressingHorizon(store);
  const declared = new StoreDeclaredHorizon(store);
  const nulHorizon = new StoreNulHorizon(store);
  await checkAndPromoteHelix(helix, event, buildPromotionCallbacks(store, helix, onEvent), _promotionDepth);

  const seq = await store.nextSeq();
  const fullEvent: EoEvent = { ...event, seq };

  await appendToLog(store, fullEvent);
  await store.put(`idem:${event.client_event_id!}`, seq);

  try {
    await executeOperator(store, fullEvent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.put(`error:${seq}`, {
      seq,
      client_event_id: event.client_event_id,
      op: event.op,
      target: event.target,
      error: message,
      ts: new Date().toISOString(),
    });
    if (onEvent) onEvent({ ...fullEvent, meta: { ...fullEvent.meta, _error: message } });
    return seq;
  }

  // Phase A constitutive site touches.
  await touchAddressingForEvent(addressing, fullEvent);
  await declareForEvent(declared, fullEvent);
  await recordNulForEvent(nulHorizon, fullEvent);

  await helix.recordOperator(fullEvent.target, fullEvent.op as LoggableOperator, seq);
  await updateFoldCache(store, fullEvent);

  if (onEvent) {
    onEvent(fullEvent);
  }

  return seq;
}

async function processEventInner(
  store: EoStore,
  event: EoEventInput,
  onEvent?: (event: EoEvent) => void,
): Promise<number> {
  // 0. Validate event structure before any state mutation.
  //    This catches malformed events from Matrix/peer sync before we
  //    assign a seq or touch the log.
  if (event.op === 'REC' && !isSyncTarget(event.target)) {
    // App-layer RECs are emitted internally by detectAndEmitREC. Sync-layer
    // RECs (peer/piece site restructuring, §3) are emitted by the sync
    // worker — a system actor — and must be accepted here so they enter
    // the log on the same path as application events (sync.md §Phase 5).
    throw new Error('REC is system-generated and cannot be submitted externally');
  }
  const validationErrors = validateEvent(event);
  if (validationErrors) {
    throw new Error(`Invalid event: ${formatValidationErrors(validationErrors)}`);
  }

  // 1. Ensure event has a content-addressable ID for dedup.
  //    If the caller provided client_event_id, use it.
  //    Otherwise, derive one from the event content (hash chain).
  if (!event.client_event_id) {
    event = { ...event, client_event_id: await eventHash(event) };
  }

  // 2. Idempotency check — works for both caller-provided and derived IDs
  const idemExisting = await store.get(`idem:${event.client_event_id}`);
  if (idemExisting != null) {
    return idemExisting as number;
  }

  // 2b. Pre-check for INS: reject before logging if target already exists
  if (event.op === 'INS') {
    const existingState = await checkExists(store, event.target);
    if (existingState) {
      throw new Error(`Target already instantiated: ${event.target}`);
    }
  }

  // 2c. Helix promotion — runs BEFORE seq assignment so promoted events get
  //     lower seq numbers and appear before the original event in replay order.
  const helix = new StoreHelixStateTracker(store);
  const addressing = new StoreAddressingHorizon(store);
  const declared = new StoreDeclaredHorizon(store);
  const nulHorizon = new StoreNulHorizon(store);
  await checkAndPromoteHelix(helix, event, buildPromotionCallbacks(store, helix, onEvent), 0);

  // 3. Assign sequence number
  const seq = await store.nextSeq();
  const fullEvent: EoEvent = { ...event, seq };

  // 4. Append to log
  await appendToLog(store, fullEvent);

  // 5. Store idempotency key
  await store.put(`idem:${event.client_event_id!}`, seq);

  // 6. Execute operator-specific logic (helix dispatch)
  //    If the operator throws, the event is already logged — we record
  //    the error on the event's state so it can be diagnosed and replayed.
  try {
    await executeOperator(store, fullEvent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.put(`error:${seq}`, {
      seq,
      client_event_id: event.client_event_id,
      op: event.op,
      target: event.target,
      error: message,
      ts: new Date().toISOString(),
    });
    // Still notify so the UI can surface the error
    if (onEvent) onEvent({ ...fullEvent, meta: { ...fullEvent.meta, _error: message } });
    return seq;
  }

  // 6a. Phase A constitutive site touches — every event addresses the
  //     AddressingHorizon for its target (and CON destinations); explicit
  //     SEG events update the DeclaredHorizon with their boundary content;
  //     NUL events record a typed absence observation on the NulHorizon.
  await touchAddressingForEvent(addressing, fullEvent);
  await declareForEvent(declared, fullEvent);
  await recordNulForEvent(nulHorizon, fullEvent);

  // 6b. Record this operator in the target's helix position.
  await helix.recordOperator(fullEvent.target, fullEvent.op as LoggableOperator, seq);

  // 7. Update the incrementally-maintained fold cache on the target's state
  //    (trajectory, trajectoryFingerprint, cadence, _lastRecSeq). This is the
  //    "current state fold" that horizonGet reads from — so views don't rescan
  //    the event log on every click.
  await updateFoldCache(store, fullEvent);

  // 7b. Recompute fold-computed EVA-active dependents (with cycle guard)
  await recomputeDependents(store, fullEvent.target, new Set());

  // 8. Detect dependency cycles and emit system-generated REC if found
  await detectAndEmitREC(store, fullEvent.target, fullEvent, onEvent);

  // 9. Cascade upward: if this target is a constituent of any derived entity, re-evaluate it
  await cascadeUpward(store, fullEvent.target, fullEvent, onEvent);

  // 10. Notify listeners (Zustand store callback replaces Feed)
  if (onEvent) {
    onEvent(fullEvent);
  }

  return seq;
}

/**
 * Operator dispatch — routes to helix-aware handler.
 */
export async function executeOperator(store: EoStore, event: EoEvent): Promise<void> {
  switch (event.op) {
    case 'INS': return handleINS(store, event);
    case 'SEG': return handleSEG(store, event);
    case 'CON': return handleCON(store, event);
    case 'SYN': return handleSYN(store, event);
    case 'DEF': return handleDEF(store, event);
    case 'EVA': return handleEVA(store, event);
    case 'SIG': return handleSIG(store, event);
    case 'NUL': return; // pure observation — logged by processEvent, no state mutation
    // REC is not dispatched from outside — it is produced by the fold
    // when it detects a circular dependency after applying a human-initiated event.
  }
}

// Builds the common state metadata fields from an event
function stateFromEvent(event: EoEvent, op: EoEvent['op']) {
  return {
    last_seq: event.seq,
    last_op: op,
    last_agent: event.agent,
    last_ts: event.ts,
    last_acquired_ts: event.acquired_ts,
  };
}

// --- INS: Instantiate ---
// External INS is always level 1. System-generated INS carries level 2+.
async function handleINS(store: EoStore, event: EoEvent): Promise<void> {
  const existing = await checkExists(store, event.target);
  if (existing) {
    throw new Error(`Target already instantiated: ${event.target}`);
  }

  const operand = event.operand ?? {};
  const value = typeof operand === 'object' && !Array.isArray(operand)
    ? { ...operand }
    : operand;

  await setState(store, {
    target: event.target,
    value,
    level: event.level ?? 1,
    ...stateFromEvent(event, 'INS'),
  });
}

// --- SEG: Segment (Boundary) ---
// checkAndPromote guarantees INS has fired before handleSEG runs.
async function handleSEG(store: EoStore, event: EoEvent): Promise<void> {
  const existing = await checkExists(store, event.target);

  await setState(store, {
    target: event.target,
    value: event.operand,
    level: existing?.level ?? 1,
    ...stateFromEvent(event, 'SEG'),
  });
}

// --- CON: Connect ---
// checkAndPromote guarantees INS has fired on both source and all destination targets.
async function handleCON(store: EoStore, event: EoEvent): Promise<void> {
  const operand = event.operand;

  if (operand.added) {
    for (const item of operand.added as ConEdgeAddItem[]) {
      const dest = typeof item === 'string' ? item : item.dest;
      const attrs = typeof item === 'string' ? undefined : item.attrs;
      await addEdge(store, {
        source: event.target,
        dest,
        edge_type: operand.edge_type,
        seq: event.seq,
        attrs,
      });
    }
  }

  if (operand.removed) {
    for (const dest of operand.removed) {
      await removeEdge(store, event.target, dest);
    }
  }

  // If source had a deferred EVA registration (registered with no CON edges),
  // it can now be activated since this CON event has added edges.
  const evaReg = await store.get(`eva:${event.target}`) as EvaRegistration | null;
  if (evaReg && evaReg.mode === 'deferred') {
    const freshEdges = await getEdgesFrom(store, event.target);
    if (freshEdges.length > 0) {
      const activeMode = formulaReferencesExternal(evaReg.formula?.formula) ? 'horizon' : 'fold';
      const activatedReg: EvaRegistration = {
        target: evaReg.target,
        formula: evaReg.formula,
        mode: activeMode,
        dependencies: freshEdges.map(e => e.dest),
      };
      await store.put(`eva:${event.target}`, activatedReg);
      if (activeMode === 'fold') {
        await evaluateFormula(store, activatedReg);
      }
    }
  }

  const currentEdges = await getEdgesFrom(store, event.target);
  const sourceState = await getState(store, event.target);
  await setState(store, {
    target: event.target,
    value: {
      ...(sourceState?.value ?? {}),
      _edges: currentEdges.map(e => ({ dest: e.dest, edge_type: e.edge_type, attrs: e.attrs })),
    },
    level: sourceState?.level ?? 1,
    ...stateFromEvent(event, 'CON'),
  });

  // Refresh cached graphMetrics on every endpoint whose edges changed.
  const touched = new Set<string>([event.target]);
  if (operand.added) for (const item of operand.added as ConEdgeAddItem[]) touched.add(typeof item === 'string' ? item : item.dest);
  if (operand.removed) for (const d of operand.removed) touched.add(d);
  for (const t of touched) await refreshGraphMetrics(store, t);
}

// --- SYN: Synthesis (Merge) ---
async function handleSYN(store: EoStore, event: EoEvent): Promise<void> {
  const operand = event.operand;

  if (operand.merge) {
    const [a, b] = operand.merge;

    const stateA = await checkExists(store, a);
    const stateB = await checkExists(store, b);
    if (!stateA || !stateB) {
      throw new Error(`SYN merge targets must both exist: ${a}, ${b}`);
    }

    const mergedTarget = operand.into || event.target;
    const mergedValue = mergeOperand(stateA.value, stateB.value);

    await setState(store, {
      target: mergedTarget,
      value: mergedValue,
      level: 1,
      ...stateFromEvent(event, 'SYN'),
    });

    const edgesFromA = await getEdgesFrom(store, a);
    const edgesFromB = await getEdgesFrom(store, b);
    const edgesToA = await getEdgesTo(store, a);
    const edgesToB = await getEdgesTo(store, b);

    for (const edge of [...edgesFromA, ...edgesFromB]) {
      if (edge.dest !== a && edge.dest !== b) {
        await addEdge(store, { ...edge, source: mergedTarget, seq: event.seq });
      }
    }
    for (const edge of [...edgesToA, ...edgesToB]) {
      if (edge.source !== a && edge.source !== b) {
        await addEdge(store, { ...edge, dest: mergedTarget, seq: event.seq });
      }
    }

    await setState(store, {
      target: a,
      value: { _alias: mergedTarget },
      level: stateA.level,
      ...stateFromEvent(event, 'SYN'),
    });
    if (b !== mergedTarget) {
      await setState(store, {
        target: b,
        value: { _alias: mergedTarget },
        level: stateB.level,
        ...stateFromEvent(event, 'SYN'),
      });
    }

    // Refresh graphMetrics for the merged target and every endpoint of a rewired edge.
    const touched = new Set<string>([mergedTarget]);
    for (const e of [...edgesFromA, ...edgesFromB]) touched.add(e.dest);
    for (const e of [...edgesToA, ...edgesToB]) touched.add(e.source);
    for (const t of touched) await refreshGraphMetrics(store, t);
  }
}

// --- SIG: Signal (ephemeral editing intent) ---
// Writes a _sigs entry on the target's value to broadcast that an agent is
// editing a specific field. Cleared automatically when a DEF arrives for the
// same field, or explicitly when editing: false is sent.
// Stale entries (older than SIG_TTL_MS relative to the current event) are pruned
// on every SIG and DEF write so dead-tab signals don't accumulate.

/** SIGs older than this are treated as abandoned (tab closed mid-edit). */
const SIG_TTL_MS = 5 * 60 * 1000; // 5 minutes

type SigEntry = { agent: string; draft: string; since: string };

/** Remove entries whose `since` timestamp is older than SIG_TTL_MS relative to referenceTs. */
function pruneStaleSignals(
  sigs: Record<string, SigEntry>,
  referenceTs: string,
): Record<string, SigEntry> {
  const refTime = Date.parse(referenceTs);
  const result: Record<string, SigEntry> = {};
  for (const [key, entry] of Object.entries(sigs)) {
    if (refTime - Date.parse(entry.since) < SIG_TTL_MS) {
      result[key] = entry;
    }
  }
  return result;
}

async function handleSIG(store: EoStore, event: EoEvent): Promise<void> {
  const target = await resolveAlias(store, event.target);
  const existing = await getState(store, target);
  const operand = event.operand as { fieldKey: string; draft?: string; editing?: boolean };

  // Phase A: SIG on a never-INSed site is a pure draft signal — there is no
  // state record to attach the _sigs marker to and there is no UI rendering
  // a non-existent cell. The SIG fact is recorded in the AddressingHorizon
  // as an ephemeral entry; promotion happens when (and only when) a real
  // operator subsequently fires on the same site.
  //
  // Without this guard, an INS arriving after a SIG would trip
  // checkExists() because handleSIG had quietly materialized a phantom
  // state record. The existing test "SIG does not create a new state:
  // target (only updates existing)" already documented this as the
  // intended behavior — this guard makes it actually true.
  if (!existing) return;

  const currentSigs: Record<string, SigEntry> = existing?.value?._sigs ?? {};

  let updatedSigs: Record<string, SigEntry>;
  if (operand.editing === false) {
    // Cancel — remove the entry for this field
    const { [operand.fieldKey]: _removed, ...rest } = currentSigs;
    updatedSigs = rest;
  } else {
    // Start or update draft — upsert
    updatedSigs = {
      ...currentSigs,
      [operand.fieldKey]: {
        agent: event.agent,
        draft: operand.draft ?? '',
        since: event.ts,
      },
    };
  }

  // Prune stale entries left over from abandoned edits (e.g. tab close).
  updatedSigs = pruneStaleSignals(updatedSigs, event.ts);

  await setState(store, {
    target,
    value: {
      ...(existing?.value ?? {}),
      _sigs: Object.keys(updatedSigs).length > 0 ? updatedSigs : undefined,
    },
    level: existing?.level ?? 1,
    ...stateFromEvent(event, 'SIG'),
  });
}

// --- DEF: Define Value or Register Computation ---
// checkAndPromote guarantees INS has fired before handleDEF runs.
// Includes Creator ownership check: agents with PL 10-24 can only DEF
// records they created (identified by _created_by field).
async function handleDEF(store: EoStore, event: EoEvent): Promise<void> {
  const target = await resolveAlias(store, event.target);

  const existing = await getState(store, target);

  // Level guard: reject DEFs on core content of derived entities (INS2+).
  if ((existing?.level ?? 1) > 1 && event.agent !== 'system') {
    throw new Error(
      `Cannot DEF core content of derived entity at level ${existing!.level}: ${target}`
    );
  }

  // Creator ownership check: if meta._power_level is 10-24 (Creator),
  // only allow DEF on records they created. This is the only fold-level
  // permission check — everything else is Matrix-native.
  const agentPL = event.meta?._power_level;
  if (typeof agentPL === 'number' && agentPL >= 10 && agentPL < 25) {
    const createdBy = existing?.value?._created_by;
    if (createdBy && createdBy !== event.agent) {
      throw new Error(
        `Creator-level agent cannot edit records created by others: ${target} (created by ${createdBy})`
      );
    }
  }

  const merged = mergeOperand(existing?.value, event.operand);

  // Clear _sigs for saved fields, then prune any stale entries from dead tabs.
  let finalValue = merged;
  if (merged._sigs) {
    let updatedSigs: Record<string, SigEntry> = { ...merged._sigs };
    // Remove entries for the fields explicitly committed by this DEF.
    if (typeof event.operand === 'object' && event.operand !== null) {
      const savedKeys = Object.keys(event.operand).filter((k) => !k.startsWith('_'));
      for (const k of savedKeys) delete updatedSigs[k];
    }
    // Prune entries abandoned by tab-close (older than SIG_TTL_MS).
    updatedSigs = pruneStaleSignals(updatedSigs, event.ts);
    finalValue = {
      ...merged,
      _sigs: Object.keys(updatedSigs).length > 0 ? updatedSigs : undefined,
    };
  }

  await setState(store, {
    target,
    value: finalValue,
    level: existing?.level ?? 1,
    ...stateFromEvent(event, 'DEF'),
  });

  if (isFormulaOperand(event.operand)) {
    await registerEvaActive(store, target, event.operand);
  }

  // Phase D: mirror numeric operand values into GPU field buffers so the
  // GPU's view of the data stays current. No-op when WebGPU is unavailable.
  syncDefToGpu(target, event.operand);
}

// --- EVA: Evaluate ---
// checkAndPromote guarantees INS has fired before handleEVA runs.
// If the operand is a formula and the target has no CON edges yet, the
// registration is marked 'deferred' rather than failing or fabricating edges.
// The registration is activated automatically when a CON edge is later added
// (see handleCON above).
async function handleEVA(store: EoStore, event: EoEvent): Promise<void> {
  const target = await resolveAlias(store, event.target);
  const existing = await getState(store, target);

  if (isFormulaOperand(event.operand)) {
    const edges = await getEdgesFrom(store, target);
    if (edges.length === 0) {
      // No CON edges — register as deferred rather than evaluating against nothing.
      const deferredReg: EvaRegistration = {
        target,
        formula: event.operand,
        mode: 'deferred',
        dependencies: [],
        deferred_reason: 'no_con_edges',
      };
      await store.put(`eva:${target}`, deferredReg);
    } else {
      await registerEvaActive(store, target, event.operand);
    }
  }

  await setState(store, {
    target,
    value: event.operand,
    level: existing?.level ?? 1,
    ...stateFromEvent(event, 'EVA'),
  });
}

// --- REC: Recursion (Fixed-Point Iteration) ---
// Applies operator sequences to their own outputs until structure stabilizes.
// Three outcomes: convergence, oscillation, or max-iteration bailout.

const DEFAULT_MAX_ITERATIONS = 100;

async function handleREC(store: EoStore, event: EoEvent): Promise<void> {
  const subOps = event.operand?.contains || [];
  const pivot = event.operand?.pivot || null;
  const maxIterations = event.operand?.max_iterations || DEFAULT_MAX_ITERATIONS;

  // Collect all targets the loop body touches
  const watchedTargets = new Set<string>();
  for (const subOp of subOps) {
    if (subOp.target) watchedTargets.add(subOp.target);
  }
  if (pivot) watchedTargets.add(pivot);

  async function snapshot(): Promise<Record<string, any>> {
    const snap: Record<string, any> = {};
    for (const t of watchedTargets) {
      const state = await getState(store, t);
      snap[t] = state?.value ?? null;
    }
    return snap;
  }

  function subEvent(subOp: any): EoEvent {
    return {
      ...subOp,
      seq: event.seq,
      agent: event.agent,
      ts: event.ts,
      acquired_ts: event.acquired_ts,
    };
  }

  const initialSnap = await snapshot();
  const history: Array<Record<string, any>> = [initialSnap];

  let iterations = 0;
  let converged = false;
  let cycleLength = 0;

  while (iterations < maxIterations) {
    for (const subOp of subOps) {
      await executeOperator(store, subEvent(subOp));
      await recomputeDependents(store, subOp.target, new Set());
    }

    iterations++;
    const currentSnap = await snapshot();

    let matched = -1;
    for (let i = 0; i < history.length; i++) {
      if (deepEqual(currentSnap, history[i])) {
        matched = i;
        break;
      }
    }

    if (matched >= 0) {
      if (matched === history.length - 1) {
        converged = true;
      } else {
        cycleLength = history.length - matched;
      }
      break;
    }

    history.push(currentSnap);
  }

  const result: RecResult = {
    converged,
    iterations,
  };

  if (!converged && cycleLength > 0) {
    result.cycle_length = cycleLength;
    result.states = history.slice(history.length - cycleLength);
  } else if (converged) {
    const finalSnap = await snapshot();
    result.stable_state = finalSnap;
  }

  const existingRec = await getState(store, event.target);
  await setState(store, {
    target: event.target,
    value: {
      recursion: true,
      pivot,
      sub_ops: subOps.length,
      reason: event.operand?.reason,
      result,
    },
    level: existingRec?.level ?? 1,
    ...stateFromEvent(event, 'REC'),
  });
}

// --- System-Generated REC: Cycle Detection and Emission ---

function stripEphemeral(val: any): any {
  if (val == null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(stripEphemeral);
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(val)) {
    if (k === 'evaluated_at') continue;
    result[k] = stripEphemeral(v);
  }
  return result;
}

async function detectAndEmitREC(
  store: EoStore,
  changedTarget: string,
  triggeringEvent: EoEvent,
  onEvent?: (event: EoEvent) => void,
): Promise<void> {
  const helix = new StoreHelixStateTracker(store);
  const cycleTargets = await findRecomputationCycle(store, changedTarget);
  if (!cycleTargets || cycleTargets.length === 0) return;

  const registrations: EvaRegistration[] = [];
  for (const target of cycleTargets) {
    const reg = await store.get(`eva:${target}`) as EvaRegistration | null;
    if (reg && reg.mode === 'fold') {
      registrations.push(reg);
    }
  }

  if (registrations.length === 0) return;

  // Determine the level of the constituents
  let maxConstituentLevel = 1;
  const constituentTargets: string[] = [];
  for (const target of cycleTargets) {
    constituentTargets.push(target);
    const state = await getState(store, target);
    if (state && state.level > maxConstituentLevel) {
      maxConstituentLevel = state.level;
    }
  }
  constituentTargets.push(changedTarget);
  const derivedLevel = maxConstituentLevel + 1;

  const watchedTargets = new Set<string>(cycleTargets);
  watchedTargets.add(changedTarget);

  async function snapshot(): Promise<Record<string, any>> {
    const snap: Record<string, any> = {};
    for (const t of watchedTargets) {
      const state = await getState(store, t);
      snap[t] = stripEphemeral(state?.value ?? null);
    }
    return snap;
  }

  const initialSnap = await snapshot();
  const history: Array<Record<string, any>> = [initialSnap];

  let iterations = 0;
  let converged = false;
  let cycleLength = 0;

  while (iterations < DEFAULT_MAX_ITERATIONS) {
    for (const reg of registrations) {
      await evaluateFormula(store, reg);
    }

    iterations++;
    const currentSnap = await snapshot();

    let matched = -1;
    for (let i = 0; i < history.length; i++) {
      if (deepEqual(currentSnap, history[i])) {
        matched = i;
        break;
      }
    }

    if (matched >= 0) {
      if (matched === history.length - 1) converged = true;
      else cycleLength = history.length - matched;
      break;
    }

    history.push(currentSnap);
  }

  const result: RecResult = { converged, iterations };
  if (!converged && cycleLength > 0) {
    result.cycle_length = cycleLength;
    result.states = history.slice(history.length - cycleLength);
  } else if (converged) {
    result.stable_state = await snapshot();
  }

  const containsOps = registrations.map(reg => ({
    op: 'DEF' as const,
    target: reg.target,
    operand: reg.formula,
  }));

  const recSeq = await store.nextSeq();
  const now = new Date().toISOString();
  const recEvent: EoEvent = {
    seq: recSeq,
    op: 'REC',
    target: changedTarget,
    operand: {
      contains: containsOps,
      pivot: changedTarget,
    },
    agent: 'system',
    ts: now,
    acquired_ts: now,
    triggered_by: triggeringEvent.seq,
  };

  await appendToLog(store, recEvent);
  await helix.recordOperator(changedTarget, 'REC', recSeq);

  const existingPivot = await getState(store, changedTarget);
  await setState(store, {
    target: changedTarget,
    value: {
      ...existingPivot?.value,
      _rec: {
        recursion: true,
        pivot: changedTarget,
        sub_ops: registrations.length,
        triggered_by: triggeringEvent.seq,
        result,
      },
    },
    level: existingPivot?.level ?? 1,
    ...stateFromEvent(recEvent, 'REC'),
  });
  await updateFoldCache(store, recEvent);

  if (onEvent) onEvent(recEvent);

  // --- INS2+: Produce a derived entity ---
  const sortedConstituents = [...new Set(constituentTargets)].sort();
  const derivedTargetId = derivedEntityTarget(sortedConstituents);
  const existingDerived = await getState(store, derivedTargetId);

  const derivedOperand = {
    constituents: sortedConstituents,
    topology: 'cycle',
    result,
  };

  if (existingDerived) {
    const updateSeq = await store.nextSeq();
    const updateEvent: EoEvent = {
      seq: updateSeq,
      op: 'DEF',
      target: derivedTargetId,
      operand: derivedOperand,
      agent: 'system',
      ts: now,
      acquired_ts: now,
      triggered_by: triggeringEvent.seq,
    };
    await appendToLog(store, updateEvent);
    await helix.recordOperator(derivedTargetId, 'DEF', updateSeq);
    await setState(store, {
      target: derivedTargetId,
      value: derivedOperand,
      level: existingDerived.level,
      ...stateFromEvent(updateEvent, 'DEF'),
    });
    await updateFoldCache(store, updateEvent);
    if (onEvent) onEvent(updateEvent);
  } else {
    const insSeq = await store.nextSeq();
    const insEvent: EoEvent = {
      seq: insSeq,
      op: 'INS',
      target: derivedTargetId,
      operand: derivedOperand,
      agent: 'system',
      level: derivedLevel,
      ts: now,
      acquired_ts: now,
      triggered_by: triggeringEvent.seq,
    };
    await appendToLog(store, insEvent);
    await helix.recordOperator(derivedTargetId, 'INS', insSeq);
    await setState(store, {
      target: derivedTargetId,
      value: derivedOperand,
      level: derivedLevel,
      ...stateFromEvent(insEvent, 'INS'),
    });
    await updateFoldCache(store, insEvent);

    const derived: DerivedEntity = {
      target: derivedTargetId,
      level: derivedLevel,
      constituents: sortedConstituents,
      topology: 'cycle',
      inert: false,
    };
    await store.put(`derived:${derivedTargetId}`, derived);

    for (const constituent of sortedConstituents) {
      await store.put(`rdep:${constituent}:${derivedTargetId}`, derivedTargetId);
      // Write crystallizedIn on each constituent's fold cache so the similarity
      // engine can detect co-constituents in O(1) without scanning rdep:* keys.
      const constituentState = await getState(store, constituent);
      if (constituentState?._fold) {
        await setState(store, {
          ...constituentState,
          _fold: { ...constituentState._fold, crystallizedIn: derivedTargetId },
        });
      }
    }

    if (onEvent) onEvent(insEvent);
  }

  await cascadeUpward(store, derivedTargetId, triggeringEvent, onEvent);
}

async function findRecomputationCycle(store: EoStore, startTarget: string): Promise<string[] | null> {
  const visited = new Set<string>();
  const path: string[] = [];

  async function dfs(current: string): Promise<string[] | null> {
    const reverseEdges = await getEdgesTo(store, current);
    for (const edge of reverseEdges) {
      const source = edge.source;

      const reg = await store.get(`eva:${source}`) as EvaRegistration | null;
      if (!reg || reg.mode !== 'fold') continue;

      if (source === startTarget) {
        return [...path, current];
      }

      if (!visited.has(source)) {
        visited.add(source);
        path.push(current);
        const result = await dfs(source);
        if (result) return result;
        path.pop();
      }
    }
    return null;
  }

  return dfs(startTarget);
}

function derivedEntityTarget(sortedConstituents: string[]): string {
  const key = sortedConstituents.join('|');
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  const hexId = (hash >>> 0).toString(16).padStart(8, '0');
  return `system.rec.${hexId}`;
}

async function getReverseDeps(store: EoStore, constituent: string): Promise<string[]> {
  const deps: string[] = [];
  const results = await store.iterator(`rdep:${constituent}:`);
  for (const [, value] of results) {
    deps.push(value as string);
  }
  return deps;
}

const MAX_CASCADE_DEPTH = 20;

async function cascadeUpward(
  store: EoStore,
  changedTarget: string,
  triggeringEvent: EoEvent,
  onEvent?: (event: EoEvent) => void,
  depth: number = 0,
): Promise<void> {
  if (depth >= MAX_CASCADE_DEPTH) {
    // Record cascade limit hit as a NUL event so it appears in the log.
    // Resolution 'Unraveling' encodes the cascade-limit flavor of absence
    // in the lattice model; the legacy nul_state:'cascade_limit' literal
    // lives on in the operand for backward-compatible introspection.
    const now = new Date().toISOString();
    const limitEvent: EoEvent = {
      seq: await store.nextSeq(),
      op: 'NUL',
      target: changedTarget,
      operand: { nul_state: 'cascade_limit', triggered_by: triggeringEvent.seq },
      agent: 'system:cascade-guard',
      ts: now,
      acquired_ts: now,
      resolution: 'Unraveling',
    };
    await appendToLog(store, limitEvent);
    await new StoreNulHorizon(store).record(changedTarget, 'Unraveling', limitEvent.seq);
    if (onEvent) onEvent(limitEvent);
    return;
  }
  const helix = new StoreHelixStateTracker(store);
  const dependentTargets = await getReverseDeps(store, changedTarget);
  for (const derivedTarget of dependentTargets) {
    const derived = await store.get(`derived:${derivedTarget}`) as DerivedEntity | null;
    if (!derived || derived.inert) continue;

    const constituentValues: Record<string, any> = {};
    for (const c of derived.constituents) {
      const state = await getState(store, c);
      constituentValues[c] = state?.value ?? null;
    }

    const reEvalSeq = await store.nextSeq();
    const now = new Date().toISOString();
    const reEvalEvent: EoEvent = {
      seq: reEvalSeq,
      op: 'REC',
      target: derivedTarget,
      operand: {
        re_evaluation: true,
        changed_constituent: changedTarget,
        constituent_values: constituentValues,
      },
      agent: 'system',
      ts: now,
      acquired_ts: now,
      triggered_by: triggeringEvent.seq,
    };
    await appendToLog(store, reEvalEvent);
    await helix.recordOperator(derivedTarget, 'REC', reEvalSeq);

    const existingDerived = await getState(store, derivedTarget);
    if (existingDerived) {
      await setState(store, {
        target: derivedTarget,
        value: {
          ...existingDerived.value,
          result: {
            ...existingDerived.value?.result,
            stable_state: constituentValues,
          },
        },
        level: existingDerived.level,
        ...stateFromEvent(reEvalEvent, 'REC'),
      });
      await updateFoldCache(store, reEvalEvent);
    }

    if (onEvent) onEvent(reEvalEvent);
    await cascadeUpward(store, derivedTarget, triggeringEvent, onEvent, depth + 1);
  }
}

// --- Dependent Recomputation ---

async function recomputeDependents(store: EoStore, changedTarget: string, visited: Set<string> = new Set()): Promise<void> {
  if (visited.has(changedTarget)) return; // cycle guard
  visited.add(changedTarget);

  const reverseEdges = await getEdgesTo(store, changedTarget);

  for (const edge of reverseEdges) {
    const registration = await store.get(`eva:${edge.source}`) as EvaRegistration | null;
    if (!registration) continue;

    if (registration.mode === 'fold') {
      await evaluateFormula(store, registration);
      await recomputeDependents(store, registration.target, visited);
    }
  }
}

async function evaluateFormula(store: EoStore, registration: EvaRegistration): Promise<void> {
  // Phase D: try GPU-accelerated evaluation first. If the formula is
  // GPU-eligible and buffers are available, dispatchEvalGpu registers the
  // work promise with gpuInFlight (making the wave-step barrier live) and
  // returns the computed result. Otherwise it returns null and we fall
  // through to the CPU path.
  const gpuResult = await dispatchEvalGpu(registration);
  if (gpuResult) {
    const existing = await getState(store, registration.target);
    const now = new Date().toISOString();
    await setState(store, {
      target: registration.target,
      value: { ...existing?.value, _computed: gpuResult.result },
      level: existing?.level ?? 1,
      last_seq: existing?.last_seq || 0,
      last_op: existing?.last_op || 'DEF',
      last_agent: 'system:eva:gpu',
      last_ts: now,
      last_acquired_ts: now,
    });
    return;
  }

  // CPU fallback — gather inputs from dependencies and evaluate on CPU.
  const inputs: Record<string, any> = {};
  for (const dep of registration.dependencies) {
    const resolved = await resolveAlias(store, dep);
    const state = await getState(store, resolved);
    inputs[dep] = state?.value;
  }

  const result = executeFormulaFunction(registration.formula, inputs);

  const existing = await getState(store, registration.target);
  const now = new Date().toISOString();
  await setState(store, {
    target: registration.target,
    value: { ...existing?.value, _computed: result },
    level: existing?.level ?? 1,
    last_seq: existing?.last_seq || 0,
    last_op: existing?.last_op || 'DEF',
    last_agent: 'system:eva',
    last_ts: now,
    last_acquired_ts: now,
  });
}

function executeFormulaFunction(formula: any, inputs: Record<string, any>): any {
  return { formula: formula.formula || formula, inputs, evaluated_at: new Date().toISOString() };
}

// --- Helpers ---
//
// mergeOperand, isFormulaOperand, and deepEqual are pure and live in
// fold-core.ts (Phase A). They are re-exported here for backward compat
// with existing importers (tests, etc.).

export { mergeOperand, isFormulaOperand, deepEqual } from './fold-core';

async function registerEvaActive(store: EoStore, target: string, operand: any): Promise<void> {
  const edges = await getEdgesFrom(store, target);
  const dependencies = edges.map(e => e.dest);

  const mode = formulaReferencesExternal(operand.formula) ? 'horizon' : 'fold';

  const registration: EvaRegistration = {
    target,
    formula: operand,
    mode,
    dependencies,
  };

  await store.put(`eva:${target}`, registration);

  if (mode === 'fold') {
    await evaluateFormula(store, registration);
  }
}

function formulaReferencesExternal(formula: any): boolean {
  const externalPatterns = [
    'NOW()', 'TODAY()', 'DAYS_UNTIL(', 'DAYS_SINCE(',
    'CURRENT_TIME', 'CURRENT_DATE',
  ];
  const str = typeof formula === 'string' ? formula.toUpperCase() : '';
  return externalPatterns.some(p => str.includes(p));
}

/**
 * Replay already-processed events from the OPFS log into a fresh in-memory
 * store (used on page load after scanning the fold worker's OPFS log).
 *
 * Unlike processEventsBulk, this:
 *   - Accepts ALL event types (including system-generated REC/NUL).
 *   - Does NOT run EVA recomputation or REC detection phases — those
 *     system events are already present in `events` and will be replayed.
 *   - Silently ignores operator errors (the original fold was valid).
 *   - Does NOT trigger the MemoryStore's persistence hook, so no duplicate
 *     writes go back to the OPFS fold worker.
 *
 * Events must be in ascending seq order (as returned by the fold worker's
 * scanLog). The store's nextSeq() counter advances in step with the
 * replayed seq numbers because events are sequential with no gaps.
 */
export async function replayFromLog(
  store: EoStore,
  events: EoEvent[],
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  return foldMutex.run(async () => {
    const helix = new StoreHelixStateTracker(store);
    const addressing = new StoreAddressingHorizon(store);
    const declared = new StoreDeclaredHorizon(store);
    const nulHorizon = new StoreNulHorizon(store);
    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      // Skip already-replayed events (idempotency guard for double-init).
      if (event.client_event_id) {
        const idem = await store.get(`idem:${event.client_event_id}`);
        if (idem != null) {
          onProgress?.(i + 1, events.length);
          continue;
        }
      }

      // Assign seq via nextSeq() — sequential replay means counter matches.
      const seq = await store.nextSeq();
      const fullEvent: EoEvent = { ...event, seq };

      await appendToLog(store, fullEvent);
      if (fullEvent.client_event_id) {
        await store.put(`idem:${fullEvent.client_event_id}`, seq);
      }

      // Apply operator (REC falls through as a no-op in executeOperator).
      try {
        await executeOperator(store, fullEvent);
        await touchAddressingForEvent(addressing, fullEvent);
        await declareForEvent(declared, fullEvent);
        await recordNulForEvent(nulHorizon, fullEvent);
        await helix.recordOperator(fullEvent.target, fullEvent.op as LoggableOperator, seq);
      } catch {
        // Ignore errors during replay — the original fold succeeded.
      }

      await updateFoldCache(store, fullEvent);
      onProgress?.(i + 1, events.length);
    }

    // Post-replay: re-evaluate all fold-mode EVA formulas so that _computed
    // reflects the final dependency values rather than values at EVA-registration
    // time. During replay, recomputeDependents is not called after each event,
    // so any DEF on a dependency that fires after the EVA was registered leaves
    // _computed stale. One pass here corrects all fold-mode formulas atomically.
    const evaEntries = await store.iterator('eva:');
    for (const [, reg] of evaEntries) {
      const r = reg as EvaRegistration;
      if (r && r.mode === 'fold' && r.dependencies && r.dependencies.length > 0) {
        try {
          await evaluateFormula(store, r);
        } catch {
          // Ignore — formula may reference targets not yet fully hydrated.
        }
      }
    }
  });
}
