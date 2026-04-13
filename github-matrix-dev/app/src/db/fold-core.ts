/**
 * fold-core — Phase A constitutive site model.
 *
 * This module hosts the deterministic primitives the fold depends on, so that
 * concurrent execution paths (bulk import, worker pool, GPU shard) can rely on
 * a single, race-free surface for helix addressing, sequence allocation, and
 * helix-state mutation.
 *
 * What lives here:
 *
 *   1. Helix constants & wave grouping — HELIX_LEVEL, sortByHelixLevel,
 *      isHelixValid. Previously lived inline in fold.ts; pulled out so every
 *      fold runner can share one authoritative helix model.
 *
 *   2. SeqReservoir — the seq-allocation primitive used by bulk-import paths.
 *      Pre-reserves a contiguous range of seqs per wave, then hands them out
 *      in a deterministic per-target order. Phase A replaced the previous
 *      Promise.all/per-target nextSeq race; see the file-header rationale in
 *      fold-determinism.test.ts for the property that now holds.
 *
 *      NOTE: this used to be called `AddressingHorizon`, but the Phase A
 *      roadmap reserves that name for the constitutive site model in
 *      addressing-horizon.ts. The class here is just a contiguous-range seq
 *      reservoir; it has nothing to do with site existence.
 *
 *   3. HelixStateTracker — the centralized surface for reading, validating,
 *      and mutating per-target HelixPosition state. StoreHelixStateTracker is
 *      the canonical EoStore-backed implementation. checkAndPromote +
 *      MAX_PROMOTION_DEPTH implement the auto-promotion pass on top of any
 *      tracker, with event-emission provided by caller-supplied callbacks so
 *      fold-core never imports fold.ts.
 *
 *   4. Pure helpers — mergeOperand, isFormulaOperand, deepEqual. Order-
 *      independent, side-effect-free; safe for any caller.
 *
 * fold.ts keeps the operator handlers (INS, DEF, ...), cycle detection, and
 * the processEvent / processEventsBulk entry points. fold-core is the
 * foundation they sit on.
 */

import type { EoStore } from './encrypted-store';
import type { ConEdgeAddItem, EoEventInput, LoggableOperator, HelixPosition } from './types';

// ─── FoldRunner contract ───────────────────────────────────────────────────
//
// Promoted from the Phase 0 determinism harness. Every fold implementation
// (serial, bulk, chunked, shard-pool, worker-pool, GPU) conforms to this
// signature so the property-based tests in fold-determinism.test.ts can be
// re-instantiated against each.
//
// The contract: given a store and a list of events, apply the events to the
// store. The caller owns the store lifecycle; the runner owns only the fold
// dispatch. No return value — observable effects are measured by reading
// the store's keys/values after the run.

/**
 * A fold implementation. Takes a store and a batch of events and folds them
 * into the store. Every runner that satisfies this contract can be plugged
 * into the determinism harness.
 */
export type FoldRunner = (store: EoStore, events: EoEventInput[]) => Promise<void>;

// ─── Helix constants & wave grouping ────────────────────────────────────────

/**
 * Helix level assignment. Determines wave ordering during bulk import.
 * REC is excluded — system-generated and handled separately after all waves.
 */
export const HELIX_LEVEL: Partial<Record<LoggableOperator, number>> = {
  NUL: 0, SIG: 0,
  INS: 1,
  SEG: 2, CON: 2,
  SYN: 3,
  DEF: 4,
  EVA: 5,
};

/**
 * HELIX_ORDINAL — ordinal position of each operator along the lattice's
 * operator axis. Nine distinct positions 0-8, one per operator.
 *
 * DIFFERENT from HELIX_LEVEL (above). HELIX_LEVEL is a wave-group index used
 * for scheduling: operators at the same level can run concurrently in a wave
 * because they do not conflict (NUL+SIG share level 0; SEG+CON share level 2).
 * HELIX_ORDINAL is the canonical lattice coordinate — each operator sits at
 * exactly one ordinal, strictly ordered from NUL at 0 to REC at 8.
 *
 * HELIX_ORDINAL is consulted by:
 *   - Lattice position queries (which slice is this event in?)
 *   - Triad boundary detection (is this event at a triad transition?)
 *   - Checkpoint significance (triad boundaries are the meaningful checkpoints)
 *   - REC ordinal position (8, above EVA at 7)
 *
 * REC is included here even though HELIX_LEVEL omits it — the wave model is
 * about scheduling, but the lattice model is about position, and REC has a
 * position regardless of how it gets executed.
 */
export const HELIX_ORDINAL: Record<LoggableOperator, number> = {
  NUL: 0,
  SIG: 1,
  INS: 2,
  SEG: 3,
  CON: 4,
  SYN: 5,
  DEF: 6,
  EVA: 7,
  REC: 8,
};

/**
 * TRIAD_BOUNDARY — operators that sit at the boundary between triads.
 * These are the semantically significant checkpoint moments in the operator
 * axis. A fold walker consulting HELIX_ORDINAL can detect triad transitions
 * by checking membership in this set.
 *
 * Identity triad       ends after INS (ordinal 2).
 * Structure triad      ends after SYN (ordinal 5).
 * Interpretation triad ends after REC (ordinal 8).
 */
export const TRIAD_BOUNDARY = new Set<LoggableOperator>(['INS', 'SYN', 'REC']);

/**
 * triadOf — which triad does this operator belong to? Derived from HELIX_ORDINAL.
 *
 *   identity        — NUL, SIG, INS                 (ordinal 0-2)
 *   structure       — SEG, CON, SYN                 (ordinal 3-5)
 *   interpretation  — DEF, EVA, REC                 (ordinal 6-8)
 */
export function triadOf(op: LoggableOperator): 'identity' | 'structure' | 'interpretation' {
  const ord = HELIX_ORDINAL[op];
  if (ord <= 2) return 'identity';
  if (ord <= 5) return 'structure';
  return 'interpretation';
}

// ─── OPERATOR_PROCESSING_CLASS ──────────────────────────────────────────────

/**
 * Describes how an operator should be routed through the execution pipeline:
 * which execution layer handles it (CPU / GPU / boundary / adaptive), which
 * memory model its state lives in, and whether it acts as a synchronization
 * barrier between layers.
 *
 *   layer:
 *     'cpu'       — pure CPU operation, never touches GPU
 *     'gpu'       — GPU compute dispatch (EVA formulas, REC fixed-points)
 *     'boundary'  — CPU-writes / GPU-reads shared memory (CON adjacency)
 *     'adaptive'  — routed to CPU or GPU at runtime based on fan-in size
 *
 *   memory: free-form label identifying the state's storage shape. Informal
 *     for now; formalized when Phases C-K wire the actual backing stores.
 *
 *   sync:
 *     'none'       — no cross-layer synchronization required
 *     'flush-gpu'  — CPU must wait for any in-flight GPU work to drain
 *                    BEFORE applying this operator. DEF changes the schema
 *                    (i.e. the dimensionality of the state space), so every
 *                    dense-vector buffer the GPU is reading becomes stale at
 *                    the instant the DEF lands. Treat this as an ontological
 *                    barrier, not a scheduling hint.
 *     'push-state' — CPU must publish updated state to GPU-visible memory
 *                    before subsequent GPU ops execute. Reserved; no
 *                    operator uses this today.
 */
export interface OperatorProcessingClass {
  layer: 'cpu' | 'gpu' | 'boundary' | 'adaptive';
  memory:
    | 'constituted-set'
    | 'ephemeral'
    | 'point-write'
    | 'boundary'
    | 'csr-shared'
    | 'reduction'
    | 'schema-table'
    | 'dense-vector'
    | 'double-buffered';
  sync: 'none' | 'flush-gpu' | 'push-state';
}

/**
 * Single source of truth for per-operator routing. Every phase of the scaling
 * roadmap (worker pool, shard workers, GPU SpMV) consults this table rather
 * than reimplementing operator-class decisions as scattered switch statements.
 *
 * Changing a row here propagates the effect of that change to every runner.
 * Adding a new operator requires adding an entry — TypeScript's exhaustiveness
 * check on `Record<LoggableOperator, ...>` enforces this at compile time.
 *
 * ─── Resolution-awareness: Phase C.5 scope ─────────────────────────────────
 *
 * This table is currently indexed by operator alone. That is correct today —
 * with resolution-writing only just landing in Phase A slice 6, every event
 * in every existing log reads back with resolution 'unspecified'. There is
 * nothing to route on.
 *
 * Resolution-aware routing (e.g. CON × Binding → high-weight CSR edge vs
 * CON × Tracing → provisional edge) is reserved for Phase C.5. Do not add
 * resolution-awareness here until compound glyphs have been populated in
 * real workloads and profiling reveals which ones actually matter.
 *
 * NOTE: `sync: 'flush-gpu'` is load-bearing for `splitWaveIntoSteps` below —
 * every row marked `flush-gpu` becomes a wave-step boundary. Adding another
 * `flush-gpu` operator will silently reshape every wave into more (smaller)
 * steps; verify the determinism harness and any Phase C GPU dispatch first.
 */
export const OPERATOR_PROCESSING_CLASS: Record<LoggableOperator, OperatorProcessingClass> = {
  NUL: { layer: 'cpu',      memory: 'constituted-set', sync: 'none'      },
  SIG: { layer: 'cpu',      memory: 'ephemeral',       sync: 'none'      },
  INS: { layer: 'cpu',      memory: 'point-write',     sync: 'none'      },
  SEG: { layer: 'cpu',      memory: 'boundary',        sync: 'none'      },
  CON: { layer: 'boundary', memory: 'csr-shared',      sync: 'none'      },
  SYN: { layer: 'adaptive', memory: 'reduction',       sync: 'none'      },
  DEF: { layer: 'cpu',      memory: 'schema-table',    sync: 'flush-gpu' },
  EVA: { layer: 'gpu',      memory: 'dense-vector',    sync: 'none'      },
  REC: { layer: 'gpu',      memory: 'double-buffered', sync: 'none'      },
};

/**
 * True if applying `op` requires draining any in-flight GPU work before the
 * CPU can proceed. Currently `DEF` is the only such operator (it mutates the
 * schema dimensionality every GPU buffer is indexed against).
 */
export function requiresGpuFlush(op: LoggableOperator): boolean {
  return OPERATOR_PROCESSING_CLASS[op].sync === 'flush-gpu';
}

/** A group of events at the same helix level, ready for wave processing. */
export interface HelixWave {
  level: number;
  events: EoEventInput[];
}

/**
 * Groups events by helix level in ascending order, preserving arrival order
 * within each level. REC events are excluded (system-generated).
 */
export function sortByHelixLevel(events: EoEventInput[]): HelixWave[] {
  const byLevel = new Map<number, EoEventInput[]>();
  for (const event of events) {
    const level = HELIX_LEVEL[event.op as LoggableOperator];
    if (level === undefined) continue; // skip REC and unknown ops
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level)!.push(event);
  }
  return Array.from(byLevel.entries())
    .sort(([a], [b]) => a - b)
    .map(([level, evts]) => ({ level, events: evts }));
}

/**
 * A wave-step is a contiguous slice of a HelixWave that can execute without
 * a GPU-drain boundary in the middle. Waves are split into steps at every
 * flush-gpu operator (currently DEF): a flush-gpu op gets its own
 * single-event step with `barrier: true`, and non-flush events accumulate
 * into a single step with `barrier: false`.
 *
 * The `barrier` flag says "drain any in-flight GPU work BEFORE applying
 * this step's events." Today the drain is a no-op (no GPU dispatch is
 * wired into the fold), but the structure gives Phase C a single dispatch
 * boundary to bind to without re-threading the wave loop.
 *
 * Rule: each flush-gpu op is its own single-event step. We deliberately do
 * NOT coalesce consecutive flush-gpus into one step, because the barrier
 * abstraction stays locally testable ("a barrier step has exactly one
 * event"), and the "skip a drain if nothing has been dispatched"
 * optimization belongs inside the drain function itself (tracked by a
 * Phase C in-flight counter), not in the splitter.
 *
 * `level` is NOT duplicated on WaveStep — the parent HelixWave owns it as
 * the single source of truth.
 */
export interface WaveStep {
  events: EoEventInput[];
  barrier: boolean;
}

/**
 * Split a HelixWave into a sequence of WaveSteps at flush-gpu boundaries.
 * Pure function: no state, no side effects, total event order preserved.
 *
 * Invariant: the flattened `steps.flatMap(s => s.events)` equals the input
 * `wave.events` exactly, and every step where `barrier === true` contains
 * exactly one event whose operator returns `requiresGpuFlush(op) === true`.
 */
export function splitWaveIntoSteps(wave: HelixWave): WaveStep[] {
  const steps: WaveStep[] = [];
  let current: WaveStep = { events: [], barrier: false };
  for (const event of wave.events) {
    if (requiresGpuFlush(event.op as LoggableOperator)) {
      if (current.events.length > 0) {
        steps.push(current);
        current = { events: [], barrier: false };
      }
      steps.push({ events: [event], barrier: true });
    } else {
      current.events.push(event);
    }
  }
  if (current.events.length > 0) steps.push(current);
  return steps;
}

/**
 * Returns true if the current helix position satisfies the operator's preconditions.
 *
 *   NUL, SIG, REC — always valid (no preconditions)
 *   INS           — valid only if target has NOT yet been instantiated
 *   SEG, CON, SYN, DEF, EVA — require INS to have fired on the target
 *
 * CON's requirement that destination targets be instantiated is checked
 * separately by the caller (operand-level, not target-level).
 * EVA's CON-edge requirement is handled inside handleEVA (checked post-INS).
 */
export function isHelixValid(op: LoggableOperator, pos: HelixPosition | null): boolean {
  const declared = new Set(pos?.declared ?? []);
  switch (op) {
    case 'NUL': return true;
    case 'SIG': return true;
    case 'INS': return !declared.has('INS');
    case 'SEG': return declared.has('INS');
    case 'CON': return declared.has('INS');
    case 'SYN': return declared.has('INS');
    case 'DEF': return declared.has('INS');
    case 'EVA': return declared.has('INS');
    case 'REC': return true;
  }
}

// ─── SeqReservoir ───────────────────────────────────────────────────────────

/**
 * Deterministic seq allocator used by bulk-import paths. Not the
 * AddressingHorizon — that name is reserved for the constitutive site model
 * in addressing-horizon.ts. This class is purely a contiguous-range seq
 * reservoir.
 *
 * Pre-reserves a contiguous range of sequence numbers from the store via
 * serial store.nextSeq() calls, then hands them out in a fixed, caller-
 * controlled order. This replaces the per-target Promise.all race where
 * concurrent tasks would hit store.nextSeq() in microtask-interleaved order
 * and produce non-reproducible seq assignments across runs of the same input.
 *
 * Once a seq has been reserved, that mapping is authoritative and stable,
 * regardless of how many worker shards or parallel per-target tasks execute
 * afterward. Workers/shards consume seqs via take(), never via nextSeq().
 *
 * USAGE PATTERN
 *
 *   const reservoir = new SeqReservoir(store);
 *   await reservoir.reserve(waveEvents.length);   // serial; no races
 *   for (const event of sortedWaveEvents) {
 *     const seq = reservoir.take();               // deterministic order
 *     // dispatch to worker / per-target task with (event, seq)
 *   }
 *
 * The reserve/take split is deliberate: reserve() may be awaited (the store
 * may be async), but take() is synchronous so it can be called from inside
 * a tight, deterministic dispatch loop.
 */
export class SeqReservoir {
  private readonly reserved: number[] = [];
  private cursor = 0;

  constructor(private readonly store: EoStore) {}

  /**
   * Reserve `count` contiguous seqs from the store. Called serially from a
   * single control-flow site (e.g. the bulk dispatcher's pre-pass). Because
   * this is the only call site that advances store.nextSeq() during a bulk
   * import, there is no race: the reserved range is contiguous and ordered.
   */
  async reserve(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const s = await this.store.nextSeq();
      this.reserved.push(s);
    }
  }

  /**
   * Take the next reserved seq. Must be called in deterministic order from a
   * single control-flow site — typically the dispatcher that hands events out
   * to per-target tasks.
   */
  take(): number {
    if (this.cursor >= this.reserved.length) {
      throw new Error(
        `SeqReservoir exhausted: asked for seq #${this.cursor + 1} ` +
        `but only ${this.reserved.length} were reserved`,
      );
    }
    return this.reserved[this.cursor++];
  }

  /** Seqs reserved but not yet taken. */
  get remaining(): number {
    return this.reserved.length - this.cursor;
  }

  /** Total seqs reserved across the reservoir's lifetime. */
  get totalReserved(): number {
    return this.reserved.length;
  }
}

// ─── HelixStateTracker ──────────────────────────────────────────────────────

/**
 * Centralized helix-state surface. Every path that reads or mutates a
 * target's HelixPosition (serial fold, replay, REC cascade, future worker
 * shards) goes through a HelixStateTracker so the state model lives in one
 * place and a single implementation can be swapped in for tests or alternate
 * backends.
 *
 * The interface is deliberately narrow — three operations — and is kept free
 * of any log-write or event-emission dependencies. Promotion logic (which
 * must append system-generated events) lives above the tracker as a
 * callback-driven helper, so fold-core never needs to import fold.ts.
 */
export interface HelixStateTracker {
  /** Read a target's HelixPosition, or null if no operators have fired yet. */
  getPosition(target: string): Promise<HelixPosition | null>;
  /**
   * Record that `op` fired on `target` at `seq`. O(1), never walks the log.
   * Adds `op` to `declared` on first fire, sets `firstSeq[op]` only if it was
   * unset, always updates `lastSeq[op]`, always increments `count[op]`.
   */
  recordOperator(target: string, op: LoggableOperator, seq: number): Promise<void>;
  /**
   * Returns true if `pos` satisfies `op`'s helix preconditions. Thin wrapper
   * over the module-level `isHelixValid` — exposed on the tracker so callers
   * can mock validation alongside state reads in tests.
   */
  isValid(op: LoggableOperator, pos: HelixPosition | null): boolean;
}

/**
 * The canonical HelixStateTracker. Stateless wrapper over an EoStore — all
 * helix state lives on `helix:${target}` keys, and every method is a direct
 * store read or write with no in-memory caching. Safe to instantiate per-call
 * or per-function-scope; construction cost is a single field assignment.
 */
export class StoreHelixStateTracker implements HelixStateTracker {
  constructor(private readonly store: EoStore) {}

  async getPosition(target: string): Promise<HelixPosition | null> {
    return (await this.store.get(`helix:${target}`)) as HelixPosition | null;
  }

  async recordOperator(target: string, op: LoggableOperator, seq: number): Promise<void> {
    const existing = (await this.store.get(`helix:${target}`)) as HelixPosition | null;
    const pos: HelixPosition = existing ?? { declared: [], firstSeq: {}, lastSeq: {}, count: {} };
    if (!pos.declared.includes(op)) {
      pos.declared = [...pos.declared, op];
    }
    pos.firstSeq = pos.firstSeq[op] === undefined
      ? { ...pos.firstSeq, [op]: seq }
      : pos.firstSeq;
    pos.lastSeq = { ...pos.lastSeq, [op]: seq };
    pos.count = { ...pos.count, [op]: (pos.count[op] ?? 0) + 1 };
    await this.store.put(`helix:${target}`, pos);
  }

  isValid(op: LoggableOperator, pos: HelixPosition | null): boolean {
    return isHelixValid(op, pos);
  }
}

// ─── Helix auto-promotion ───────────────────────────────────────────────────

/** Maximum auto-promotion depth — prevents infinite cascade. */
export const MAX_PROMOTION_DEPTH = 5;

/**
 * Callbacks the caller must provide when running a promotion pass. Kept
 * callback-driven so fold-core does not import fold.ts (which would create
 * a cycle: fold-core ← fold ← fold-core).
 */
export interface PromotionCallbacks {
  /**
   * Process a synthetic auto-promoted event through the full event pipeline
   * (validation → idempotency → seq assignment → log append → operator
   * dispatch → helix record → fold-cache update). Must recurse back into
   * the caller's serial processEvent core with the incremented depth so
   * the MAX_PROMOTION_DEPTH cap is honored on nested promotions.
   */
  emitSynthetic: (input: EoEventInput, depth: number) => Promise<void>;
  /**
   * Emit a promotion-blocked stub — called once per target when the depth
   * cap has been reached. The stub is a NUL event with nul_state set to
   * `promotion_blocked`; the callback is responsible for allocating a seq,
   * writing the event to the log, recording the NUL on the helix, updating
   * the fold cache, and calling any onEvent hook.
   */
  emitBlocked: (target: string) => Promise<void>;
}

/**
 * Check whether an event's target (and, for CON, any destination targets)
 * satisfies the operator's helix preconditions. If not, auto-promote by
 * invoking `emitSynthetic` for each missing operator.
 *
 * Runs BEFORE seq assignment on the original event so promoted events get
 * lower seq numbers and appear earlier in replay order.
 *
 * NUL / SIG / REC / INS have no preconditions and short-circuit immediately.
 */
export async function checkAndPromote(
  tracker: HelixStateTracker,
  event: EoEventInput,
  callbacks: PromotionCallbacks,
  depth: number,
): Promise<void> {
  if (event.op === 'NUL' || event.op === 'SIG' || event.op === 'REC' || event.op === 'INS') {
    return;
  }

  const pos = await tracker.getPosition(event.target);
  if (!tracker.isValid(event.op as LoggableOperator, pos)) {
    await promoteToHelix(tracker, event.target, ['INS'], callbacks, depth);
  }

  // CON: also check every destination target.
  if (event.op === 'CON' && event.operand?.added) {
    for (const item of event.operand.added as ConEdgeAddItem[]) {
      const dest = typeof item === 'string' ? item : item.dest;
      const destPos = await tracker.getPosition(dest);
      if (!new Set(destPos?.declared ?? []).has('INS')) {
        await promoteToHelix(tracker, dest, ['INS'], callbacks, depth);
      }
    }
  }
}

/**
 * Emits system-generated operator events to satisfy a target's missing helix
 * preconditions, via the caller's emitSynthetic callback. If `depth` has
 * reached MAX_PROMOTION_DEPTH, invokes emitBlocked instead and returns
 * without emitting further events.
 *
 * After each emitSynthetic, the declared set is refreshed from the tracker
 * so a single recursive promotion that fires multiple operators (e.g. a NUL
 * handler that promotes to INS on the same target) is observed before the
 * next required op is considered.
 */
async function promoteToHelix(
  tracker: HelixStateTracker,
  target: string,
  requiredOps: LoggableOperator[],
  callbacks: PromotionCallbacks,
  depth: number,
): Promise<void> {
  if (depth >= MAX_PROMOTION_DEPTH) {
    await callbacks.emitBlocked(target);
    return;
  }

  const pos = await tracker.getPosition(target);
  const declared = new Set(pos?.declared ?? []);

  for (const op of requiredOps) {
    if (declared.has(op)) continue;
    const now = new Date().toISOString();
    const systemInput: EoEventInput = {
      op,
      target,
      operand: {},
      agent: 'system:helix',
      ts: now,
      acquired_ts: now,
      meta: { auto_promoted: true, reason: `required by helix — missing ${op}` },
    };
    await callbacks.emitSynthetic(systemInput, depth + 1);
    // Refresh declared after each promotion so subsequent required ops see
    // anything the synthetic event (or its own cascaded promotions) declared.
    const updated = await tracker.getPosition(target);
    if (updated) for (const d of updated.declared) declared.add(d);
  }
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Shallow-merge two operands if both are plain objects; otherwise return
 * the incoming value. Used by DEF/SYN to combine values.
 */
export function mergeOperand(existing: any, incoming: any): any {
  if (
    existing && typeof existing === 'object' && !Array.isArray(existing) &&
    incoming && typeof incoming === 'object' && !Array.isArray(incoming)
  ) {
    return { ...existing, ...incoming };
  }
  return incoming;
}

/** Formula-shaped operand (has a `formula` key). */
export function isFormulaOperand(operand: any): boolean {
  return operand && typeof operand === 'object' && 'formula' in operand;
}

/** Structural equality over JSON-shaped values. */
export function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((val: any, i: number) => deepEqual(val, b[i]));
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(key => deepEqual(a[key], b[key]));
}
