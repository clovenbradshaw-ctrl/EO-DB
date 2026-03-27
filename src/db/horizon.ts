import { EoDb, decode } from './level.js';
import { getState, getStateByPrefix } from './state.js';
import { getEdgesFrom } from './graph.js';
import { resolveAlias } from './helpers.js';
import type { EoState, EvaRegistration, HorizonResponse, GroundEntry, SignalEntry } from './types.js';

export interface HorizonOpts {
  prefix?: boolean;
  signals?: boolean;
  grounds?: boolean; // default true
}

/**
 * Three-layer Horizon read.
 *
 * Layer 1 — Figure: projected state at the target. Alias resolution. Horizon-computed EVA.
 * Layer 2 — Ground: walk up prefix hierarchy collecting ancestor-level state.
 * Layer 3 — Signal: on-demand population analytics (only when opts.signals === true).
 */
export async function horizonGet(
  db: EoDb,
  target: string,
  opts?: HorizonOpts
): Promise<HorizonResponse | HorizonResponse[] | null> {
  if (opts?.prefix) {
    return horizonGetByPrefix(db, target, opts);
  }

  const resolved = await resolveAlias(db, target);

  // Layer 1: Figure
  const figure = await getFigureState(db, resolved);
  if (!figure) return null;

  // Layer 2: Grounds (default on)
  const includeGrounds = opts?.grounds !== false;
  const grounds = includeGrounds ? await getGrounds(db, resolved) : [];

  // Layer 3: Signals (only when requested)
  let signals: SignalEntry[] | undefined;
  if (opts?.signals) {
    signals = await detectSignals(db, resolved);
  }

  return { target: resolved, figure, grounds, signals };
}

async function horizonGetByPrefix(db: EoDb, prefix: string, opts?: HorizonOpts): Promise<HorizonResponse[]> {
  const states = await getStateByPrefix(db, prefix);
  const results: HorizonResponse[] = [];

  for (const state of states) {
    if (state.value?._alias) continue;

    const figure = await getFigureState(db, state.target);
    const includeGrounds = opts?.grounds !== false;
    const grounds = includeGrounds ? await getGrounds(db, state.target) : [];

    let signals: SignalEntry[] | undefined;
    if (opts?.signals) {
      signals = await detectSignals(db, state.target);
    }

    results.push({ target: state.target, figure, grounds, signals });
  }

  return results;
}

/**
 * Layer 1: Get figure state with alias resolution and Horizon-computed EVA.
 */
async function getFigureState(db: EoDb, target: string): Promise<EoState | null> {
  const state = await getState(db, target);
  if (!state) return null;

  if (state.value?._alias) {
    return getFigureState(db, state.value._alias);
  }

  let registration: EvaRegistration | null = null;
  try {
    const buf = await db.get(`eva:${target}`);
    registration = decode(buf) as EvaRegistration;
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }

  if (registration && registration.mode === 'horizon') {
    const inputs: Record<string, any> = {
      _now: new Date().toISOString(),
      _today: new Date().toISOString().split('T')[0],
    };
    for (const dep of registration.dependencies) {
      const resolved = await resolveAlias(db, dep);
      const depState = await getState(db, resolved);
      inputs[dep] = depState?.value;
    }
    return {
      ...state,
      value: {
        ...state.value,
        _computed: {
          formula: registration.formula.formula || registration.formula,
          inputs,
          evaluated_at: new Date().toISOString(),
        },
      },
    };
  }

  return state;
}

/**
 * Layer 2: Walk up the prefix hierarchy collecting ambient conditions.
 *
 * Override rule: if the figure has an explicit value for a field that also
 * exists as a ground, the figure's value wins (CSS cascade).
 */
async function getGrounds(db: EoDb, target: string): Promise<GroundEntry[]> {
  const parts = target.split('.');
  const grounds: GroundEntry[] = [];

  // Collect the figure's own keys to detect overrides
  const figureState = await getState(db, target);
  const figureKeys = new Set<string>();
  if (figureState?.value && typeof figureState.value === 'object') {
    Object.keys(figureState.value).forEach(k => figureKeys.add(k));
  }

  // Walk up the hierarchy, skipping the target itself
  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const ancestor = parts.slice(0, depth).join('.');
    const distance = parts.length - depth;

    const ancestorState = await getState(db, ancestor);
    if (ancestorState?.value && typeof ancestorState.value === 'object') {
      // Skip alias entries and SEG boundary entries
      if (ancestorState.value._alias) continue;

      for (const [key, value] of Object.entries(ancestorState.value)) {
        if (key.startsWith('_')) continue; // skip internal fields
        if (!figureKeys.has(key)) {
          grounds.push({ source: ancestor, key, value, distance });
        }
      }
    }
  }

  return grounds;
}

/**
 * Layer 3: Detect emergent patterns in the population around a target.
 *
 * Only runs when opts.signals === true. Ephemeral — never stored.
 * Returns basic population statistics and outlier detection.
 */
async function detectSignals(db: EoDb, target: string): Promise<SignalEntry[]> {
  const signals: SignalEntry[] = [];
  const parts = target.split('.');

  if (parts.length < 3) return signals;
  const collectionPrefix = parts.slice(0, 2).join('.');

  // Get all state entries in this collection
  const population = await getStateByPrefix(db, collectionPrefix + '.');
  const records = population.filter(s => {
    const p = s.target.split('.');
    return p.length === 3 && !s.value?._alias;
  });

  if (records.length < 3) return signals;

  // Collect numeric field values across population
  const fieldValues: Record<string, number[]> = {};
  const allEntries = await getStateByPrefix(db, collectionPrefix + '.');
  for (const entry of allEntries) {
    const entryParts = entry.target.split('.');
    if (entryParts.length === 4 && typeof entry.value === 'number') {
      const field = entryParts[3];
      if (!fieldValues[field]) fieldValues[field] = [];
      fieldValues[field].push(entry.value);
    }
  }

  // Check for outliers
  for (const [field, values] of Object.entries(fieldValues)) {
    if (values.length < 3) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    if (std === 0) continue;

    const targetFieldState = await getState(db, `${target}.${field}`);
    if (targetFieldState && typeof targetFieldState.value === 'number') {
      const z = (targetFieldState.value - mean) / std;
      if (Math.abs(z) > 1.5) {
        signals.push({
          description: `${field} is ${z > 0 ? 'above' : 'below'} population average (z=${z.toFixed(2)})`,
          measure: field,
          value: { target_value: targetFieldState.value, population_mean: mean, z_score: z },
          population: collectionPrefix,
          n: values.length,
          computed_at: new Date().toISOString(),
        });
      }
    }
  }

  // Population count signal
  signals.push({
    description: `Population: ${records.length} records in ${collectionPrefix}`,
    measure: 'count',
    value: records.length,
    population: collectionPrefix,
    n: records.length,
    computed_at: new Date().toISOString(),
  });

  return signals;
}
