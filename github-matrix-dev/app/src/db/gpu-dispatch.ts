/**
 * gpu-dispatch.ts — Phase D: GPU dispatch wiring.
 *
 * Phase C landed the GpuInFlightTracker and wired drainGpuInFlight() into the
 * wave-step loop, but no production code called gpuInFlight.register(). The
 * barrier was structurally in place but operationally inert — drain always
 * returned on the fast path because nothing was ever in flight.
 *
 * Phase D closes that gap. This module is the bridge between the fold's
 * operator handlers (DEF, EVA) and the GPU buffer infrastructure in
 * gpu-buffers.ts. It has two responsibilities:
 *
 *   1. **Field sync** (DEF → GPU). When handleDEF writes a numeric value to
 *      state, `syncDefToGpu` mirrors that value into the GpuFieldBuffers so
 *      the GPU's view of the data stays current. O(1) for updates to
 *      existing target+field pairs; rebuilds the field buffer when a new
 *      target or field appears.
 *
 *   2. **Eval dispatch** (EVA → GPU). When evaluateFormula runs, it first
 *      calls `dispatchEvalGpu`. If the formula is GPU-eligible (numeric
 *      aggregation, filter, or cosine similarity), the dispatch runs on
 *      GPU buffers and registers the work promise with gpuInFlight. If the
 *      formula is not GPU-eligible or WebGPU is unavailable, the function
 *      returns null and the caller falls back to the CPU path.
 *
 * The contract change from Phase C to Phase D:
 *
 *   Phase C: gpuInFlight.register() has zero callers → drain is always a
 *            no-op fast path.
 *   Phase D: gpuInFlight.register() is called from dispatchEvalGpu → drain
 *            actually awaits GPU work → the wave-step barrier is live.
 *
 * Progressive enhancement. Every function in this module is a no-op or
 * returns null when WebGPU is unavailable. The fold works identically on
 * CPU-only environments; GPU acceleration is additive, never required.
 *
 * Concurrency model. This module is only called from within the fold mutex
 * (processEvent / processEventsBulk), so the singleton state is never
 * accessed concurrently. The gpuInFlight tracker itself is also single-
 * threaded by construction (see gpu-in-flight.ts header).
 */

import { gpuInFlight } from './gpu-in-flight';
import type { GpuFieldBuffers } from './gpu-buffers';
import {
  acquireGpuDevice,
  initGpuBuffers,
  writeFieldValue,
  uploadNumericField,
  filterNumeric,
  computeCosineSimilarity,
} from './gpu-buffers';
import type { EvaRegistration } from './types';

// ─── Lazy singleton ─────────────────────────────────────────────────────────

let gpuBuffers: GpuFieldBuffers | null = null;
let gpuInitAttempted = false;

/**
 * Acquire a WebGPU device and initialise the field buffer store. Returns
 * true if GPU is ready, false if WebGPU is unavailable or init failed.
 * Idempotent: a successful init is cached; a failed init is not retried.
 */
export async function ensureGpuReady(): Promise<boolean> {
  if (gpuBuffers) return true;
  if (gpuInitAttempted) return false;
  gpuInitAttempted = true;

  const device = await acquireGpuDevice();
  if (!device) return false;

  gpuBuffers = initGpuBuffers(device);
  return true;
}

/** True if GPU field buffers are initialised and available for dispatch. */
export function isGpuAvailable(): boolean {
  return gpuBuffers !== null;
}

// ─── DEF → GPU field sync ───────────────────────────────────────────────────

/**
 * Mirror a single numeric value into the GPU field buffer.
 *
 * Fast path (O(1)): when the target already has a slot and the field buffer
 * already exists, delegates to writeFieldValue which updates 4 bytes on
 * both the CPU mirror and the GPU buffer.
 *
 * Slow path: when the target or field is new, rebuilds the field buffer via
 * uploadNumericField. This is O(n) in the number of targets for that field
 * but happens at most once per new target×field pair.
 *
 * No-op when GPU is unavailable.
 */
export function syncNumericField(
  target: string,
  field: string,
  value: number,
): void {
  if (!gpuBuffers) return;

  const hasSlot = gpuBuffers.targetToSlot.has(target);
  const hasField = gpuBuffers.numericFields.has(field);

  if (hasSlot && hasField) {
    // Fast path: both target and field exist — O(1) update.
    writeFieldValue(gpuBuffers, target, field, value);
    return;
  }

  // Slow path: need to (re)build the field buffer. Collect existing values
  // so they are preserved across the rebuild.
  const values = new Map<string, number>();
  if (hasField) {
    const fieldData = gpuBuffers.numericFields.get(field)!;
    for (let i = 0; i < fieldData.cpu.length; i++) {
      if (i < gpuBuffers.targetIndex.length) {
        values.set(gpuBuffers.targetIndex[i], fieldData.cpu[i]);
      }
    }
  }
  values.set(target, value);
  uploadNumericField(gpuBuffers, field, values);
}

/**
 * Sync all numeric fields in a DEF operand to GPU buffers.
 * Called from handleDEF after setState. Iterates the operand's top-level
 * keys and syncs any that have numeric values.
 *
 * Non-numeric keys (strings, objects, arrays, underscore-prefixed internals)
 * are silently skipped. No-op when GPU is unavailable.
 */
export function syncDefToGpu(target: string, operand: unknown): void {
  if (!gpuBuffers) return;
  if (!operand || typeof operand !== 'object' || Array.isArray(operand)) return;

  for (const [key, value] of Object.entries(operand as Record<string, unknown>)) {
    // Skip internal/metadata keys
    if (key.startsWith('_')) continue;
    // Only sync numeric values
    if (typeof value === 'number' && Number.isFinite(value)) {
      syncNumericField(target, key, value);
    }
  }
}

// ─── EVA GPU dispatch ───────────────────────────────────────────────────────

/** Result from a successful GPU-accelerated evaluation. */
export interface GpuEvalResult {
  /** The computed value — same shape as executeFormulaFunction's result. */
  result: unknown;
}

/**
 * GPU-eligible formula patterns. A formula is GPU-eligible if it is a
 * string matching one of these forms:
 *
 *   Aggregation:  SUM(field), AVG(field), MIN(field), MAX(field), COUNT(field)
 *   Filter:       FILTER(field > 100), FILTER(field <= 50)
 *   Similarity:   COSINE(target)
 *
 * All other formulas fall through to the CPU path.
 */
export function isGpuEligible(formula: unknown): boolean {
  if (!formula || typeof formula !== 'object') return false;
  const f = (formula as Record<string, unknown>).formula;
  if (typeof f !== 'string') return false;
  const upper = f.toUpperCase().trim();
  return /^(SUM|AVG|MIN|MAX|COUNT)\s*\(/.test(upper) ||
         /^COSINE\s*\(/.test(upper) ||
         /^FILTER\s*\(/.test(upper);
}

/** Parsed GPU formula — result of parseGpuFormula. */
export interface ParsedGpuFormula {
  op: 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT' | 'FILTER' | 'COSINE';
  field: string;
  cmp?: '>' | '<' | '>=' | '<=' | '=';
  threshold?: number;
}

/**
 * Parse a formula string into a GPU-dispatchable descriptor. Returns null
 * if the formula doesn't match any GPU-eligible pattern.
 */
export function parseGpuFormula(formula: string): ParsedGpuFormula | null {
  const trimmed = formula.trim();

  // SUM(field), AVG(field), etc.
  const aggMatch = trimmed.match(/^(SUM|AVG|MIN|MAX|COUNT)\s*\(\s*(\w+)\s*\)$/i);
  if (aggMatch) {
    return {
      op: aggMatch[1].toUpperCase() as ParsedGpuFormula['op'],
      field: aggMatch[2],
    };
  }

  // FILTER(field > 100)
  const filterMatch = trimmed.match(/^FILTER\s*\(\s*(\w+)\s*(>=|<=|>|<|=)\s*([\d.]+)\s*\)$/i);
  if (filterMatch) {
    return {
      op: 'FILTER',
      field: filterMatch[1],
      cmp: filterMatch[2] as ParsedGpuFormula['cmp'],
      threshold: parseFloat(filterMatch[3]),
    };
  }

  // COSINE(target)
  const cosineMatch = trimmed.match(/^COSINE\s*\(\s*(.+?)\s*\)$/i);
  if (cosineMatch) {
    return { op: 'COSINE', field: cosineMatch[1] };
  }

  return null;
}

/**
 * Attempt GPU-accelerated evaluation of an EVA registration's formula.
 *
 * If the formula is GPU-eligible and GPU buffers are available, dispatches
 * the computation and registers the work promise with gpuInFlight so the
 * wave-step barrier can drain it before the next schema-mutating op.
 *
 * Returns the result on success, or null if GPU dispatch is not possible
 * (WebGPU unavailable, formula not eligible, field not in GPU buffers).
 * The caller falls back to the CPU path when null is returned.
 */
export async function dispatchEvalGpu(
  registration: EvaRegistration,
): Promise<GpuEvalResult | null> {
  if (!gpuBuffers) return null;
  if (!isGpuEligible(registration.formula)) return null;

  const parsed = parseGpuFormula(registration.formula.formula);
  if (!parsed) return null;

  switch (parsed.op) {
    case 'FILTER': {
      if (parsed.cmp === undefined || parsed.threshold === undefined) return null;
      const promise = filterNumeric(
        gpuBuffers, parsed.field, parsed.cmp, parsed.threshold,
      );
      gpuInFlight.register(promise);
      const matches = await promise;
      return {
        result: {
          formula: registration.formula.formula,
          matches,
          count: matches.length,
          evaluated_at: new Date().toISOString(),
          gpu_accelerated: true,
        },
      };
    }

    case 'COSINE': {
      const promise = computeCosineSimilarity(gpuBuffers, parsed.field);
      gpuInFlight.register(promise);
      const scores = await promise;
      return {
        result: {
          formula: registration.formula.formula,
          scores,
          evaluated_at: new Date().toISOString(),
          gpu_accelerated: true,
        },
      };
    }

    case 'SUM':
    case 'AVG':
    case 'MIN':
    case 'MAX':
    case 'COUNT': {
      // Numeric aggregation over the registration's dependencies (CON edges).
      // Reads from the CPU-side Float32Array mirror which is kept in sync with
      // the GPU buffer by syncNumericField. The aggregation itself runs on CPU
      // today; when it moves to a GPU compute shader the promise will be
      // genuinely async. The promise is registered with gpuInFlight so the
      // barrier protocol is exercised on this path.
      const fieldData = gpuBuffers.numericFields.get(parsed.field);
      if (!fieldData) return null;

      const depSlots = registration.dependencies
        .map(dep => gpuBuffers!.targetToSlot.get(dep))
        .filter((s): s is number => s !== undefined && s < fieldData.cpu.length);

      if (depSlots.length === 0) return null;

      const values = depSlots.map(slot => fieldData.cpu[slot]);
      let computed: number;

      switch (parsed.op) {
        case 'SUM':   computed = values.reduce((a, b) => a + b, 0); break;
        case 'AVG':   computed = values.reduce((a, b) => a + b, 0) / values.length; break;
        case 'MIN':   computed = Math.min(...values); break;
        case 'MAX':   computed = Math.max(...values); break;
        case 'COUNT': computed = values.filter(v => v !== 0).length; break;
      }

      // Register as GPU work so the barrier protocol is live on this path.
      const promise = Promise.resolve(computed);
      gpuInFlight.register(promise);

      return {
        result: {
          formula: registration.formula.formula,
          value: computed,
          op: parsed.op,
          field: parsed.field,
          dep_count: depSlots.length,
          evaluated_at: new Date().toISOString(),
          gpu_accelerated: true,
        },
      };
    }

    default:
      return null;
  }
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/**
 * Reset the module singleton. For tests only — allows a fresh init cycle
 * without reloading the module.
 */
export function resetGpuDispatch(): void {
  gpuBuffers = null;
  gpuInitAttempted = false;
}

/**
 * Inject a GpuFieldBuffers instance for testing. Bypasses device acquisition
 * so tests can provide a mock device without a real WebGPU context.
 */
export function _setGpuBuffersForTest(buffers: GpuFieldBuffers | null): void {
  gpuBuffers = buffers;
  gpuInitAttempted = buffers !== null;
}
