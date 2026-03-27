import { EoDb, decode } from './level.js';
import { getState, getStateByPrefix } from './state.js';
import { getEdgesFrom } from './graph.js';
import { resolveAlias } from './helpers.js';
import type { EoState, EvaRegistration } from './types.js';

export interface HorizonResult {
  state: EoState;
  boundary?: { boundary: string; reason?: string };
}

/**
 * Horizon GET: read-time evaluation with alias resolution and
 * Horizon-computed formula evaluation.
 */
export async function horizonGet(
  db: EoDb,
  target: string,
  options?: { prefix?: boolean }
): Promise<HorizonResult | HorizonResult[] | null> {
  if (options?.prefix) {
    return horizonGetByPrefix(db, target);
  }

  // SYN capacity: resolve alias
  const resolved = await resolveAlias(db, target);
  const state = await getState(db, resolved);
  if (!state) return null;

  // Check if this is an EVA-active horizon-computed target
  let registration: EvaRegistration | null = null;
  try {
    const buf = await db.get(`eva:${resolved}`);
    registration = decode(buf) as EvaRegistration;
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }

  // If horizon-computed, evaluate at read time
  if (registration && registration.mode === 'horizon') {
    const computed = await evaluateHorizon(db, registration);
    return {
      state: {
        ...state,
        value: { ...state.value, _computed: computed },
      },
      boundary: extractBoundary(state),
    };
  }

  return {
    state,
    boundary: extractBoundary(state),
  };
}

async function horizonGetByPrefix(db: EoDb, prefix: string): Promise<HorizonResult[]> {
  const states = await getStateByPrefix(db, prefix);
  const results: HorizonResult[] = [];

  for (const state of states) {
    // Skip alias entries
    if (state.value?._alias) continue;

    let registration: EvaRegistration | null = null;
    try {
      const buf = await db.get(`eva:${state.target}`);
      registration = decode(buf) as EvaRegistration;
    } catch (e: any) {
      if (e.code !== 'LEVEL_NOT_FOUND') throw e;
    }

    if (registration && registration.mode === 'horizon') {
      const computed = await evaluateHorizon(db, registration);
      results.push({
        state: { ...state, value: { ...state.value, _computed: computed } },
        boundary: extractBoundary(state),
      });
    } else {
      results.push({
        state,
        boundary: extractBoundary(state),
      });
    }
  }

  return results;
}

/**
 * Evaluate a Horizon-computed formula at read time.
 * Injects _now and _today as external inputs.
 */
async function evaluateHorizon(
  db: EoDb,
  registration: EvaRegistration
): Promise<any> {
  const inputs: Record<string, any> = {
    _now: new Date().toISOString(),
    _today: new Date().toISOString().split('T')[0],
  };

  // Gather dependency values
  for (const dep of registration.dependencies) {
    const resolved = await resolveAlias(db, dep);
    const state = await getState(db, resolved);
    inputs[dep] = state?.value;
  }

  // Placeholder formula executor
  return {
    formula: registration.formula.formula || registration.formula,
    inputs,
    evaluated_at: new Date().toISOString(),
  };
}

function extractBoundary(state: EoState): { boundary: string; reason?: string } | undefined {
  if (state.last_op === 'SEG' && state.value?.boundary) {
    return { boundary: state.value.boundary, reason: state.value.reason };
  }
  return undefined;
}
