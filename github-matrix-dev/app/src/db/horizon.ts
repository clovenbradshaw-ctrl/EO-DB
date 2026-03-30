import type { EoStore } from './encrypted-store';
import { getState, getStateByPrefix } from './state';
import { getEdgesFrom, getEdgesTo } from './graph';
import { resolveAlias } from './helpers';
import { readLogForTarget } from './log';
import type {
  EoState, EvaRegistration, HorizonResponse, GroundEntry, SignalEntry,
  NearbyEntry, GovernanceEntry, LoggableOperator, AncestryEntry, TrajectoryEntry,
  TrajectoryFingerprint, CadenceInfo, CadenceClass, GraphMetrics, GraphRole,
  RecResult, RecCycleInfo,
} from './types';
import { seedHash, chainHash } from './hash';

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

  // ─── Pattern Surfacing (cheap, auto-computed alongside existing layers) ───
  const hashCohort = figure?.hash
    ? await getHashCohortFromStore(store, figure.hash, resolved)
    : undefined;
  const trajectoryFingerprint = trajectory && trajectory.length > 0
    ? await computeTrajectoryFingerprint(trajectory)
    : undefined;
  const cadence = trajectory && trajectory.length > 0
    ? await computeCadence(store, resolved)
    : undefined;
  const graphMetrics = await computeGraphMetrics(store, resolved);
  const recCycle = await getRecCycleInfo(store, resolved);

  return {
    target: resolved, figure, ancestry, grounds, nearby, governance, trajectory, signals,
    hashCohort: hashCohort && hashCohort.length > 0 ? hashCohort : undefined,
    trajectoryFingerprint,
    cadence,
    graphMetrics,
    recCycle,
  };
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

async function getTrajectory(store: EoStore, target: string): Promise<TrajectoryEntry[]> {
  const events = await readLogForTarget(store, target);
  if (events.length === 0) return [];

  const trajectory: TrajectoryEntry[] = [];
  let lastOp: LoggableOperator | null = null;
  let runningHash = '';

  for (const event of events) {
    // Compute running hash — seed on first event, chain thereafter
    runningHash = runningHash === ''
      ? await seedHash(event)
      : await chainHash(runningHash, event);

    if (event.op !== lastOp) {
      trajectory.push({ op: event.op, hash: runningHash });
      lastOp = event.op;
    } else {
      // Update the hash on the compressed entry to reflect the latest event
      trajectory[trajectory.length - 1].hash = runningHash;
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

// ─── Pattern Surfacing: Hash Cohort ──────────────────────────────

async function getHashCohortFromStore(store: EoStore, hash: string, self: string): Promise<string[]> {
  // Scan state entries with matching hash — browser-side has no reverse index,
  // so we do a lightweight scan of the same collection prefix
  const parts = self.split('.');
  if (parts.length < 2) return [];
  const collectionPrefix = parts.slice(0, 2).join('.');
  const siblings = await getStateByPrefix(store, collectionPrefix + '.');
  return siblings
    .filter(s => s.hash === hash && s.target !== self && !s.value?._alias)
    .map(s => s.target);
}

// ─── Pattern Surfacing: Trajectory Fingerprint ───────────────────

const ALL_LOGGABLE_OPS: LoggableOperator[] = ['NUL', 'INS', 'SEG', 'CON', 'SYN', 'DEF', 'EVA', 'REC'];

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function computeTrajectoryFingerprint(trajectory: TrajectoryEntry[]): Promise<TrajectoryFingerprint> {
  const sequence = trajectory.map(t => t.op).join('.');
  const fingerprint = (await sha256Hex(sequence)).slice(0, 16);

  const opCounts = {} as Record<LoggableOperator, number>;
  for (const op of ALL_LOGGABLE_OPS) opCounts[op] = 0;
  for (const t of trajectory) opCounts[t.op] = (opCounts[t.op] || 0) + 1;

  return { sequence, fingerprint, opCounts };
}

// ─── Pattern Surfacing: Temporal Cadence ─────────────────────────

async function computeCadence(store: EoStore, target: string): Promise<CadenceInfo> {
  const events = await readLogForTarget(store, target);
  if (events.length === 0) {
    return { classification: 'sparse', lastEventTs: '', eventCount: 0, description: 'No events' };
  }

  const timestamps = events.map(e => new Date(e.ts).getTime()).sort((a, b) => a - b);
  const lastTs = events[events.length - 1].ts;
  const now = Date.now();
  const daysSinceLast = (now - timestamps[timestamps.length - 1]) / (1000 * 60 * 60 * 24);

  if (events.length < 2) {
    return { classification: 'sparse', lastEventTs: lastTs, eventCount: 1, description: 'Single event' };
  }

  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i - 1]);
  }

  let maxInHour = 0;
  for (let i = 0; i < timestamps.length; i++) {
    let count = 1;
    for (let j = i + 1; j < timestamps.length && timestamps[j] - timestamps[i] <= 3600000; j++) {
      count++;
    }
    maxInHour = Math.max(maxInHour, count);
  }

  let classification: CadenceClass;
  let description: string;

  if (daysSinceLast > 30) {
    classification = 'dormant';
    description = `Dormant — no activity for ${Math.round(daysSinceLast)} days`;
  } else if (maxInHour > 3) {
    classification = 'burst';
    description = `Burst activity — ${maxInHour} events within one hour`;
  } else if (intervals.length >= 3) {
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const periodic = intervals.filter(i => Math.abs(i - median) / median < 0.2).length;
    if (periodic / intervals.length > 0.6) {
      classification = 'periodic';
      const periodHours = Math.round(median / 3600000);
      description = `Periodic — roughly every ${periodHours > 24 ? Math.round(periodHours / 24) + ' days' : periodHours + ' hours'}`;
    } else {
      classification = 'steady';
      description = `Steady — ${events.length} events over ${Math.round((timestamps[timestamps.length - 1] - timestamps[0]) / 86400000)} days`;
    }
  } else {
    classification = 'sparse';
    description = `Sparse — ${events.length} events total`;
  }

  return { classification, lastEventTs: lastTs, eventCount: events.length, description };
}

// ─── Pattern Surfacing: Graph Metrics ────────────────────────────

async function computeGraphMetrics(store: EoStore, target: string): Promise<GraphMetrics | undefined> {
  const outEdges = await getEdgesFrom(store, target);
  const inEdges = await getEdgesTo(store, target);

  const outDegree = outEdges.length;
  const inDegree = inEdges.length;
  const degree = outDegree + inDegree;

  if (degree === 0) return undefined;

  const outTargets = new Set(outEdges.map(e => e.dest));
  const inSources = new Set(inEdges.map(e => e.source));
  let mutualCount = 0;
  for (const t of outTargets) {
    if (inSources.has(t)) mutualCount++;
  }

  let role: GraphRole;
  if (degree === 0) {
    role = 'isolated';
  } else if (degree === 1) {
    role = 'leaf';
  } else if (degree >= 6) {
    role = 'hub';
  } else {
    const connectedCollections = new Set<string>();
    for (const e of outEdges) {
      const parts = e.dest.split('.');
      if (parts.length >= 2) connectedCollections.add(parts.slice(0, 2).join('.'));
    }
    for (const e of inEdges) {
      const parts = e.source.split('.');
      if (parts.length >= 2) connectedCollections.add(parts.slice(0, 2).join('.'));
    }
    role = connectedCollections.size >= 2 ? 'bridge' : 'leaf';
  }

  return { role, degree, inDegree, outDegree, mutualCount };
}

// ─── Pattern Surfacing: REC Cycle Info ───────────────────────────

async function getRecCycleInfo(store: EoStore, target: string): Promise<RecCycleInfo | undefined> {
  // Check if this target has formula registrations (EVA)
  const registration = await store.get(`eva:${target}`) as EvaRegistration | null;
  if (!registration) return undefined;

  // Check for REC events on this target
  const events = await readLogForTarget(store, target);
  const recEvent = [...events].reverse().find(e => e.op === 'REC');
  if (!recEvent) return undefined;

  const participants = recEvent.operand?.contains
    ? (recEvent.operand.contains as Array<{ target: string }>).map(c => c.target)
    : [target];
  const edges = recEvent.operand?.contains
    ? (recEvent.operand.contains as Array<{ target: string }>).flatMap((c, i, arr) => {
      const next = arr[(i + 1) % arr.length];
      return [{ source: c.target, dest: next.target }];
    })
    : [];

  const result: RecResult = {
    converged: recEvent.operand?.converged ?? true,
    iterations: recEvent.operand?.iterations ?? 0,
    cycle_length: recEvent.operand?.cycle_length,
    states: recEvent.operand?.states,
    stable_state: recEvent.operand?.stable_state,
  };

  return {
    participants,
    triggeringSeq: recEvent.triggered_by,
    result,
    edges,
  };
}
