/**
 * fold-core — Phase A constitutive site model.
 *
 * This module hosts the deterministic primitives the fold depends on, so that
 * concurrent execution paths (bulk import, worker pool, GPU shard) can rely on
 * a single, race-free surface for helix addressing and sequence allocation.
 *
 * What lives here:
 *
 *   1. Helix constants & wave grouping — HELIX_LEVEL, sortByHelixLevel,
 *      isHelixValid. Previously lived inline in fold.ts; pulled out so every
 *      fold runner can share one authoritative helix model.
 *
 *   2. AddressingHorizon — the constitutive site for seq allocation. The bulk
 *      path pre-reserves a contiguous range of seqs per wave, then hands them
 *      out in a deterministic per-target order. Replaces the previous
 *      Promise.all/per-target nextSeq race documented in
 *      fold-determinism.test.ts (FIXME(phase-A)).
 *
 *   3. Pure helpers — mergeOperand, isFormulaOperand, deepEqual. Order-
 *      independent, side-effect-free; safe for any caller.
 *
 * fold.ts keeps the operator handlers (INS, DEF, ...), cycle detection, and
 * the processEvent / processEventsBulk entry points. fold-core is the
 * foundation they sit on.
 */

import type { EoStore } from './encrypted-store';
import type { EoEventInput, LoggableOperator, HelixPosition } from './types';

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

// ─── AddressingHorizon ──────────────────────────────────────────────────────

/**
 * Deterministic seq allocator used by bulk-import paths.
 *
 * Pre-reserves a contiguous range of sequence numbers from the store via
 * serial store.nextSeq() calls, then hands them out in a fixed, caller-
 * controlled order. This replaces the per-target Promise.all race where
 * concurrent tasks would hit store.nextSeq() in microtask-interleaved order
 * and produce non-reproducible seq assignments across runs of the same input.
 *
 * The horizon is the "addressing" half of the Phase A constitutive site
 * model: once a seq has been reserved for an event, that mapping is
 * authoritative and stable, regardless of how many worker shards or
 * parallel per-target tasks execute afterward. Workers/shards consume seqs
 * via take(), never via nextSeq().
 *
 * USAGE PATTERN
 *
 *   const horizon = new AddressingHorizon(store);
 *   await horizon.reserve(waveEvents.length);   // serial; no races
 *   for (const event of sortedWaveEvents) {
 *     const seq = horizon.take();               // deterministic order
 *     // dispatch to worker / per-target task with (event, seq)
 *   }
 *
 * The reserve/take split is deliberate: reserve() may be awaited (the store
 * may be async), but take() is synchronous so it can be called from inside
 * a tight, deterministic dispatch loop.
 */
export class AddressingHorizon {
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
        `AddressingHorizon exhausted: asked for seq #${this.cursor + 1} ` +
        `but only ${this.reserved.length} were reserved`,
      );
    }
    return this.reserved[this.cursor++];
  }

  /** Seqs reserved but not yet taken. */
  get remaining(): number {
    return this.reserved.length - this.cursor;
  }

  /** Total seqs reserved across the horizon's lifetime. */
  get totalReserved(): number {
    return this.reserved.length;
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
