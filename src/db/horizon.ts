import { EoDb, decode } from './level.js';
import { getState, getStateByPrefix } from './state.js';
import { getEdgesFrom, getEdgesTo } from './graph.js';
import { resolveAlias } from './helpers.js';
import { readLogForTarget } from './log.js';
import type {
  EoState, EvaRegistration, HorizonResponse, GroundEntry, SignalEntry,
  NearbyEntry, GovernanceEntry, LoggableOperator,
} from './types.js';

export interface HorizonOpts {
  prefix?: boolean;
  signals?: boolean;
  grounds?: boolean;    // default true
  nearby?: boolean;     // default true
  governance?: boolean; // default true
  trajectory?: boolean; // default true
}

/**
 * Horizon read — the file cabinet.
 *
 * Five cheap layers (microseconds of additional read time):
 *   1. Figure  — what this target IS (projected state, alias resolution, Horizon-computed EVA)
 *   2. Ground  — what this target is IN (ambient conditions from ancestor prefixes)
 *   3. Nearby  — what's next to it (records sharing structural traits in the same collection)
 *   4. Governance — what rules apply (EVA policies governing this target and its region)
 *   5. Trajectory — where it's been (compact operator history shape)
 *
 * One expensive layer (on-demand only):
 *   6. Signals — statistical patterns across populations
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
  const grounds = opts?.grounds !== false ? await getGrounds(db, resolved) : [];

  // Layer 3: Nearby (default on) — cheap prefix scan + field matching
  const nearby = opts?.nearby !== false ? await getNearby(db, resolved) : undefined;

  // Layer 4: Governance (default on) — scan eva: keyspace for applicable policies
  const governance = opts?.governance !== false ? await getGovernance(db, resolved) : undefined;

  // Layer 5: Trajectory (default on) — compact operator history from log
  const trajectory = opts?.trajectory !== false ? await getTrajectory(db, resolved) : undefined;

  // Layer 6: Signals (expensive, on-demand only)
  const signals = opts?.signals ? await detectSignals(db, resolved) : undefined;

  return { target: resolved, figure, grounds, nearby, governance, trajectory, signals };
}

async function horizonGetByPrefix(db: EoDb, prefix: string, opts?: HorizonOpts): Promise<HorizonResponse[]> {
  const states = await getStateByPrefix(db, prefix);
  const results: HorizonResponse[] = [];

  for (const state of states) {
    if (state.value?._alias) continue;

    const figure = await getFigureState(db, state.target);
    const grounds = opts?.grounds !== false ? await getGrounds(db, state.target) : [];

    // For prefix queries, skip expensive per-record layers unless explicitly requested
    const nearby = opts?.nearby === true ? await getNearby(db, state.target) : undefined;
    const governance = opts?.governance === true ? await getGovernance(db, state.target) : undefined;
    const trajectory = opts?.trajectory === true ? await getTrajectory(db, state.target) : undefined;
    const signals = opts?.signals ? await detectSignals(db, state.target) : undefined;

    results.push({ target: state.target, figure, grounds, nearby, governance, trajectory, signals });
  }

  return results;
}

// ─── Layer 1: Figure ───────────────────────────────────────────────

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

// ─── Layer 2: Grounds ──────────────────────────────────────────────

async function getGrounds(db: EoDb, target: string): Promise<GroundEntry[]> {
  const parts = target.split('.');
  const grounds: GroundEntry[] = [];

  const figureState = await getState(db, target);
  const figureKeys = new Set<string>();
  if (figureState?.value && typeof figureState.value === 'object') {
    Object.keys(figureState.value).forEach(k => figureKeys.add(k));
  }

  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const ancestor = parts.slice(0, depth).join('.');
    const distance = parts.length - depth;

    const ancestorState = await getState(db, ancestor);
    if (ancestorState?.value && typeof ancestorState.value === 'object') {
      if (ancestorState.value._alias) continue;

      for (const [key, value] of Object.entries(ancestorState.value)) {
        if (key.startsWith('_')) continue;
        if (!figureKeys.has(key)) {
          grounds.push({ source: ancestor, key, value, distance });
        }
      }
    }
  }

  return grounds;
}

// ─── Layer 3: Nearby ───────────────────────────────────────────────
// Records in the same collection sharing structural traits.
// Cheap: one prefix scan + in-memory field-value comparison.

async function getNearby(db: EoDb, target: string): Promise<NearbyEntry[]> {
  const parts = target.split('.');
  if (parts.length < 3) return [];

  const collectionPrefix = parts.slice(0, 2).join('.');
  const figureState = await getState(db, target);
  if (!figureState) return [];

  // Get the figure's field values and CON edges for trait comparison
  const figureFields = extractTraits(figureState);
  const figureEdges = await getEdgesFrom(db, target);
  const figureLinked = new Set(figureEdges.map(e => e.dest));

  // Scan sibling records in the same collection
  const siblings = await getStateByPrefix(db, collectionPrefix + '.');
  const candidates: NearbyEntry[] = [];

  for (const sib of siblings) {
    if (sib.target === target) continue;
    if (sib.value?._alias) continue;
    // Only record-level siblings (same depth as target)
    if (sib.target.split('.').length !== parts.length) continue;

    const sibTraits = extractTraits(sib);
    const shared: string[] = [];

    // Compare field values
    for (const trait of figureFields) {
      if (sibTraits.includes(trait)) {
        shared.push(trait);
      }
    }

    // Compare CON linkage (shared connections)
    const sibEdges = await getEdgesFrom(db, sib.target);
    for (const edge of sibEdges) {
      if (figureLinked.has(edge.dest)) {
        shared.push(`linked:${edge.dest}`);
      }
    }

    if (shared.length > 0) {
      candidates.push({
        target: sib.target,
        shared,
        distance: figureFields.length > 0
          ? Math.max(1, figureFields.length - shared.length + 1)
          : 1,
      });
    }
  }

  // Sort by most shared traits (lowest distance)
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.slice(0, 10); // cap at 10 nearby records
}

function extractTraits(state: EoState): string[] {
  const traits: string[] = [];
  if (!state.value || typeof state.value !== 'object') return traits;

  for (const [key, value] of Object.entries(state.value)) {
    if (key.startsWith('_')) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      traits.push(`${key}:${value}`);
    }
  }
  return traits;
}

// ─── Layer 4: Governance ───────────────────────────────────────────
// EVA policies and formula registrations that govern this target and its region.
// Cheap: scan eva: keyspace for registrations matching this target or its ancestors.

async function getGovernance(db: EoDb, target: string): Promise<GovernanceEntry[]> {
  const governance: GovernanceEntry[] = [];
  const parts = target.split('.');

  // Scan eva: keyspace for registrations
  for await (const [key, buf] of db.iterator({
    gte: 'eva:',
    lte: 'eva:\xff',
  })) {
    const reg = decode(buf) as EvaRegistration;
    const regTarget = reg.target;

    // Direct: EVA registration on this exact target
    if (regTarget === target) {
      governance.push({
        target: regTarget,
        formula: reg.formula,
        mode: reg.mode,
        scope: 'direct',
      });
      continue;
    }

    // Collection: EVA registration shares the same collection prefix
    const regParts = regTarget.split('.');
    if (parts.length >= 2 && regParts.length >= 2 &&
        parts[0] === regParts[0] && parts[1] === regParts[1]) {
      governance.push({
        target: regTarget,
        formula: reg.formula,
        mode: reg.mode,
        scope: 'collection',
      });
      continue;
    }

    // Ancestor: EVA registration is on a parent prefix of this target
    if (target.startsWith(regTarget + '.') || target.startsWith(regTarget)) {
      governance.push({
        target: regTarget,
        formula: reg.formula,
        mode: reg.mode,
        scope: 'ancestor',
      });
    }
  }

  return governance;
}

// ─── Layer 5: Trajectory ───────────────────────────────────────────
// Compact operator history: the shape of this record's journey.
// Cheap: filter log for this target, extract op sequence, collapse consecutive same-ops.

async function getTrajectory(db: EoDb, target: string): Promise<LoggableOperator[]> {
  const events = await readLogForTarget(db, target);
  if (events.length === 0) return [];

  // Extract operator sequence, collapse consecutive duplicates
  const trajectory: LoggableOperator[] = [];
  let lastOp: LoggableOperator | null = null;

  for (const event of events) {
    if (event.op !== lastOp) {
      trajectory.push(event.op);
      lastOp = event.op;
    }
  }

  return trajectory;
}

// ─── Layer 6: Signals (expensive, on-demand) ───────────────────────

async function detectSignals(db: EoDb, target: string): Promise<SignalEntry[]> {
  const signals: SignalEntry[] = [];
  const parts = target.split('.');

  if (parts.length < 3) return signals;
  const collectionPrefix = parts.slice(0, 2).join('.');

  const population = await getStateByPrefix(db, collectionPrefix + '.');
  const records = population.filter(s => {
    const p = s.target.split('.');
    return p.length === 3 && !s.value?._alias;
  });

  if (records.length < 3) return signals;

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
