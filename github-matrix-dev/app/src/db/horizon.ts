import type { EoStore } from './encrypted-store';
import { getState, getStateByPrefix } from './state';
import { getEdgesFrom, getEdgesTo } from './graph';
import { resolveAlias } from './helpers';
import { readLogForTarget } from './log';
import type {
  EoState, EvaRegistration, HorizonResponse, GroundEntry, SignalEntry,
  NearbyEntry, GovernanceEntry, LoggableOperator, AncestryEntry,
} from './types';

export interface HorizonOpts {
  prefix?: boolean;
  ancestry?: boolean;
  signals?: boolean;
  grounds?: boolean;
  nearby?: boolean;
  governance?: boolean;
  trajectory?: boolean;
}

export async function horizonGet(
  store: EoStore,
  target: string,
  opts?: HorizonOpts,
): Promise<HorizonResponse | HorizonResponse[] | null> {
  if (opts?.prefix) {
    return horizonGetByPrefix(store, target, opts);
  }

  const resolved = await resolveAlias(store, target);

  const figure = await getFigureState(store, resolved);
  if (!figure) return null;

  const ancestry = opts?.ancestry !== false ? await getAncestry(store, resolved) : undefined;
  const grounds = opts?.grounds !== false ? await getGrounds(store, resolved) : [];
  const nearby = opts?.nearby !== false ? await getNearby(store, resolved) : undefined;
  const governance = opts?.governance !== false ? await getGovernance(store, resolved) : undefined;
  const trajectory = opts?.trajectory !== false ? await getTrajectory(store, resolved) : undefined;
  const signals = opts?.signals ? await detectSignals(store, resolved) : undefined;

  return { target: resolved, figure, ancestry, grounds, nearby, governance, trajectory, signals };
}

async function horizonGetByPrefix(
  store: EoStore,
  prefix: string,
  opts?: HorizonOpts,
): Promise<HorizonResponse[]> {
  const states = await getStateByPrefix(store, prefix);
  const results: HorizonResponse[] = [];

  for (const state of states) {
    if (state.value?._alias) continue;

    const figure = await getFigureState(store, state.target);
    const grounds = opts?.grounds !== false ? await getGrounds(store, state.target) : [];
    const nearby = opts?.nearby === true ? await getNearby(store, state.target) : undefined;
    const governance = opts?.governance === true ? await getGovernance(store, state.target) : undefined;
    const trajectory = opts?.trajectory === true ? await getTrajectory(store, state.target) : undefined;
    const signals = opts?.signals ? await detectSignals(store, state.target) : undefined;

    results.push({ target: state.target, figure, grounds, nearby, governance, trajectory, signals });
  }

  return results;
}

// --- Layer 1: Figure ---

async function getFigureState(store: EoStore, target: string): Promise<EoState | null> {
  const state = await getState(store, target);
  if (!state) return null;

  if (state.value?._alias) {
    return getFigureState(store, state.value._alias);
  }

  const registration = await store.get(`eva:${target}`) as EvaRegistration | null;

  if (registration && registration.mode === 'horizon') {
    const inputs: Record<string, any> = {
      _now: new Date().toISOString(),
      _today: new Date().toISOString().split('T')[0],
    };
    for (const dep of registration.dependencies) {
      const resolved = await resolveAlias(store, dep);
      const depState = await getState(store, resolved);
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

// --- Layer 2: Grounds ---

async function getGrounds(store: EoStore, target: string): Promise<GroundEntry[]> {
  const parts = target.split('.');
  const grounds: GroundEntry[] = [];

  const figureState = await getState(store, target);
  const figureKeys = new Set<string>();
  if (figureState?.value && typeof figureState.value === 'object') {
    Object.keys(figureState.value).forEach(k => figureKeys.add(k));
  }

  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const ancestor = parts.slice(0, depth).join('.');
    const distance = parts.length - depth;

    const ancestorState = await getState(store, ancestor);
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

// --- Ancestry ---

async function getAncestry(store: EoStore, target: string): Promise<AncestryEntry[]> {
  const parts = target.split('.');
  if (parts.length <= 1) return [];

  const ancestry: AncestryEntry[] = [];

  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const ancestorTarget = parts.slice(0, depth).join('.');
    const distance = parts.length - depth;

    const figure = await getState(store, ancestorTarget);

    const ancestorParts = ancestorTarget.split('.');
    const ancestorGrounds: GroundEntry[] = [];
    const ancestorKeys = new Set<string>();
    if (figure?.value && typeof figure.value === 'object') {
      Object.keys(figure.value).forEach(k => ancestorKeys.add(k));
    }
    for (let gd = ancestorParts.length - 1; gd >= 1; gd--) {
      const gAncestor = ancestorParts.slice(0, gd).join('.');
      const gDist = ancestorParts.length - gd;
      const gState = await getState(store, gAncestor);
      if (gState?.value && typeof gState.value === 'object' && !gState.value._alias) {
        for (const [key, value] of Object.entries(gState.value)) {
          if (!key.startsWith('_') && !ancestorKeys.has(key)) {
            ancestorGrounds.push({ source: gAncestor, key, value, distance: gDist });
          }
        }
      }
    }

    const childPrefix = ancestorTarget + '.';
    const allChildren = await getStateByPrefix(store, childPrefix);
    const directChildren = allChildren.filter(s => {
      const childParts = s.target.split('.');
      return childParts.length === depth + 1 && !s.value?._alias;
    });

    let nearbyCount = 0;
    if (depth >= 2) {
      const parentTarget = parts.slice(0, depth - 1).join('.');
      const sibPrefix = parentTarget + '.';
      const siblings = await getStateByPrefix(store, sibPrefix);
      nearbyCount = siblings.filter(s => {
        const sp = s.target.split('.');
        return sp.length === depth && s.target !== ancestorTarget && !s.value?._alias;
      }).length;
    }

    ancestry.push({
      target: ancestorTarget,
      figure: figure && !figure.value?._alias ? figure : null,
      grounds: ancestorGrounds,
      nearby_count: nearbyCount,
      children_count: directChildren.length,
      depth: distance,
    });
  }

  return ancestry;
}

// --- Layer 3: Nearby ---

async function getNearby(store: EoStore, target: string): Promise<NearbyEntry[]> {
  const parts = target.split('.');
  if (parts.length < 3) return [];

  const collectionPrefix = parts.slice(0, 2).join('.');
  const figureState = await getState(store, target);
  if (!figureState) return [];

  const figureFields = extractTraits(figureState);
  const figureEdges = await getEdgesFrom(store, target);
  const figureLinked = new Set(figureEdges.map(e => e.dest));

  const siblings = await getStateByPrefix(store, collectionPrefix + '.');
  const candidates: NearbyEntry[] = [];

  for (const sib of siblings) {
    if (sib.target === target) continue;
    if (sib.value?._alias) continue;
    if (sib.target.split('.').length !== parts.length) continue;

    const sibTraits = extractTraits(sib);
    const shared: string[] = [];

    for (const trait of figureFields) {
      if (sibTraits.includes(trait)) {
        shared.push(trait);
      }
    }

    const sibEdges = await getEdgesFrom(store, sib.target);
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

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.slice(0, 10);
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

// --- Layer 4: Governance ---

async function getGovernance(store: EoStore, target: string): Promise<GovernanceEntry[]> {
  const governance: GovernanceEntry[] = [];
  const parts = target.split('.');

  const evaEntries = await store.iterator('eva:');

  for (const [, value] of evaEntries) {
    const reg = value as EvaRegistration;
    const regTarget = reg.target;

    if (regTarget === target) {
      governance.push({
        target: regTarget,
        formula: reg.formula,
        mode: reg.mode,
        scope: 'direct',
      });
      continue;
    }

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

    if (target.startsWith(regTarget + '.')) {
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

// --- Layer 5: Trajectory ---

async function getTrajectory(store: EoStore, target: string): Promise<LoggableOperator[]> {
  const events = await readLogForTarget(store, target);
  if (events.length === 0) return [];

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

// --- Layer 6: Signals ---

async function detectSignals(store: EoStore, target: string): Promise<SignalEntry[]> {
  const signals: SignalEntry[] = [];
  const parts = target.split('.');

  if (parts.length < 3) return signals;
  const collectionPrefix = parts.slice(0, 2).join('.');

  const population = await getStateByPrefix(store, collectionPrefix + '.');
  const records = population.filter(s => {
    const p = s.target.split('.');
    return p.length === 3 && !s.value?._alias;
  });

  if (records.length < 3) return signals;

  const fieldValues: Record<string, number[]> = {};
  const allEntries = await getStateByPrefix(store, collectionPrefix + '.');
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

    const targetFieldState = await getState(store, `${target}.${field}`);
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
