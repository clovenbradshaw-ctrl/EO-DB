import type { EoStore } from './encrypted-store';
import { getState, getStateByPrefix } from './state';
import { getEdgesFrom, getEdgesTo } from './graph';
import { resolveAlias } from './helpers';
import { readLogForTarget } from './log';
import type {
  EoEvent, EoState, EvaRegistration, HorizonResponse, GroundEntry, SignalEntry,
  NearbyEntry, SimilarityDimensions, GovernanceEntry, LoggableOperator, AncestryEntry, TrajectoryEntry,
  TrajectoryFingerprint, CadenceInfo, CadenceClass, GraphMetrics, GraphRole,
  RecResult, RecCycleInfo,
} from './types';
import { seedHash, chainHash } from './hash';

export interface HorizonOpts {
  prefix?: boolean;
  ancestry?: boolean;     // default true (fast)
  ancestryLight?: boolean; // default true; when true, skip expensive children/sibling counts
  signals?: boolean;      // default false (opt-in; expensive)
  grounds?: boolean;      // default true (fast — from fold cache / ground prefix)
  nearby?: boolean;       // default false (opt-in; O(N) edge lookups)
  governance?: boolean;   // default false (opt-in; EVA registration scan)
  trajectory?: boolean;   // default true (fast; read from fold cache)
  hashCohort?: boolean;   // default false (opt-in; collection prefix scan)
  recCycle?: boolean;     // default false (opt-in; graph walk)
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

  // Read pre-computed fold products directly from the state row — these are
  // maintained incrementally by fold-cache.ts on every event.
  const fold = figure._fold;
  const trajectory = opts?.trajectory !== false ? (fold?.trajectory ?? []) : undefined;
  const trajectoryFingerprint = fold?.trajectoryFingerprint;
  const cadence = fold?.cadence;
  const graphMetrics = figure.graphMetrics;

  // Run independent lookups in parallel. Expensive ones are opt-in so the
  // caller (e.g. RecordView on drawer open) can skip them for instant render.
  const [ancestry, grounds, nearby, governance, signals, hashCohort, recCycle] = await Promise.all([
    opts?.ancestry !== false ? getAncestry(store, resolved, opts?.ancestryLight !== false) : Promise.resolve(undefined),
    opts?.grounds !== false ? getGrounds(store, resolved) : Promise.resolve([] as GroundEntry[]),
    opts?.nearby === true ? getNearby(store, resolved) : Promise.resolve(undefined),
    opts?.governance === true ? getGovernance(store, resolved) : Promise.resolve(undefined),
    opts?.signals === true ? detectSignals(store, resolved) : Promise.resolve(undefined),
    opts?.hashCohort === true && figure?.hash
      ? getHashCohortFromStore(store, figure.hash, resolved)
      : Promise.resolve(undefined),
    opts?.recCycle === true ? getRecCycleInfo(store, figure) : Promise.resolve(undefined),
  ]);

  return {
    target: resolved, figure, ancestry, grounds, nearby, governance, trajectory, signals,
    hashCohort: hashCohort && hashCohort.length > 0 ? hashCohort : undefined,
    trajectoryFingerprint,
    cadence,
    graphMetrics,
    recCycle,
    classification: figure.classification,
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
    const trajectory = opts?.trajectory === true ? (figure?._fold?.trajectory ?? []) : undefined;
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

async function getAncestry(store: EoStore, target: string, light = false): Promise<AncestryEntry[]> {
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

    // In light mode, skip expensive prefix scans for children/sibling counts.
    // These are informational metadata and not critical for initial render.
    let childrenCount = 0;
    let nearbyCount = 0;

    if (!light) {
      const childPrefix = ancestorTarget + '.';
      const allChildren = await getStateByPrefix(store, childPrefix);
      childrenCount = allChildren.filter(s => {
        const childParts = s.target.split('.');
        return childParts.length === depth + 1 && !s.value?._alias;
      }).length;

      if (depth >= 2) {
        const parentTarget = parts.slice(0, depth - 1).join('.');
        const sibPrefix = parentTarget + '.';
        const siblings = await getStateByPrefix(store, sibPrefix);
        nearbyCount = siblings.filter(s => {
          const sp = s.target.split('.');
          return sp.length === depth && s.target !== ancestorTarget && !s.value?._alias;
        }).length;
      }
    }

    ancestry.push({
      target: ancestorTarget,
      figure: figure && !figure.value?._alias ? figure : null,
      grounds: ancestorGrounds,
      nearby_count: nearbyCount,
      children_count: childrenCount,
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

  const figureKeys = extractFieldKeys(figureState);
  const figureEdges = await getEdgesFrom(store, target);
  const figureLinked = new Set(figureEdges.map(e => e.dest));
  const figureFp = figureState._fold?.trajectoryFingerprint;
  const figureOpCounts = figureFp?.opCounts;

  const siblings = await getStateByPrefix(store, collectionPrefix + '.');
  const candidates: NearbyEntry[] = [];

  for (const sib of siblings) {
    if (sib.target === target) continue;
    if (sib.value?._alias) continue;
    if (sib.target.split('.').length !== parts.length) continue;

    const dims: SimilarityDimensions = {};

    // ─── Dimension 1: Hash — exact trajectory fingerprint match ───
    const sibFp = sib._fold?.trajectoryFingerprint;
    if (figureFp && sibFp && figureFp.fingerprint === sibFp.fingerprint) {
      dims.hash = true;
    }

    // ─── Dimension 2: Trajectory — op-count cosine similarity ───
    const sibOpCounts = sibFp?.opCounts;
    if (figureOpCounts && sibOpCounts) {
      dims.trajectory = cosineSimilarity(figureOpCounts, sibOpCounts);
    }

    // ─── Dimension 3: State — field-key Jaccard overlap ───
    const sibKeys = extractFieldKeys(sib);
    if (figureKeys.size > 0 || sibKeys.size > 0) {
      let intersection = 0;
      for (const k of figureKeys) if (sibKeys.has(k)) intersection++;
      const union = figureKeys.size + sibKeys.size - intersection;
      dims.state = union > 0 ? intersection / union : 0;
    }

    // ─── Dimension 4: Connections — shared link ratio ───
    if (figureLinked.size > 0) {
      const sibEdges = await getEdgesFrom(store, sib.target);
      const sibLinked = new Set(sibEdges.map(e => e.dest));
      let sharedLinks = 0;
      for (const l of figureLinked) if (sibLinked.has(l)) sharedLinks++;
      const linkUnion = figureLinked.size + sibLinked.size - sharedLinks;
      dims.connections = linkUnion > 0 ? sharedLinks / linkUnion : 0;
    }

    // ─── Composite score (weighted) ───
    const score = compositeScore(dims);
    if (score > 0.05) {
      candidates.push({
        target: sib.target,
        score,
        dimensions: dims,
        shared: [],   // deprecated
        distance: score > 0 ? Math.round(1 / score) : 999,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 10);
}

/** Extract non-internal field keys from a state value. */
function extractFieldKeys(state: EoState): Set<string> {
  const keys = new Set<string>();
  if (!state.value || typeof state.value !== 'object') return keys;
  for (const key of Object.keys(state.value)) {
    if (!key.startsWith('_')) keys.add(key);
  }
  return keys;
}

/** Cosine similarity between two op-count vectors. */
function cosineSimilarity(
  a: Record<string, number>,
  b: Record<string, number>,
): number {
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, magA = 0, magB = 0;
  for (const k of allKeys) {
    const va = a[k] ?? 0;
    const vb = b[k] ?? 0;
    dot += va * vb;
    magA += va * va;
    magB += vb * vb;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

/** Weighted composite of similarity dimensions. */
function compositeScore(dims: SimilarityDimensions): number {
  let score = 0;
  let weight = 0;
  if (dims.hash) { score += 0.3; weight += 0.3; }
  if (dims.trajectory !== undefined) { score += dims.trajectory * 0.3; weight += 0.3; }
  if (dims.state !== undefined) { score += dims.state * 0.2; weight += 0.2; }
  if (dims.connections !== undefined) { score += dims.connections * 0.2; weight += 0.2; }
  return weight > 0 ? score / weight : 0;
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

/** Legacy fallback — rescans the full event log. Retained for tests/backfill.
 *  Production reads use the cached figure._fold.trajectory. */
export async function getTrajectory(store: EoStore, target: string): Promise<TrajectoryEntry[]> {
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

export async function computeTrajectoryFingerprint(trajectory: TrajectoryEntry[]): Promise<TrajectoryFingerprint> {
  const sequence = trajectory.map(t => t.op).join('.');
  const fingerprint = (await sha256Hex(sequence)).slice(0, 16);

  const opCounts = {} as Record<LoggableOperator, number>;
  for (const op of ALL_LOGGABLE_OPS) opCounts[op] = 0;
  for (const t of trajectory) opCounts[t.op] = (opCounts[t.op] || 0) + 1;

  return { sequence, fingerprint, opCounts };
}

// ─── Pattern Surfacing: Temporal Cadence ─────────────────────────

/** Legacy fallback — rescans the full event log. Retained for tests/backfill. */
export async function computeCadence(store: EoStore, target: string): Promise<CadenceInfo> {
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
    const periodic = median > 0 ? intervals.filter(i => Math.abs(i - median) / median < 0.2).length : 0;
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

/** Legacy fallback — retained for tests/backfill. Production reads figure.graphMetrics. */
export async function computeGraphMetrics(store: EoStore, target: string): Promise<GraphMetrics | undefined> {
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

async function getRecCycleInfo(store: EoStore, figure: EoState): Promise<RecCycleInfo | undefined> {
  // Check if this target has formula registrations (EVA)
  const registration = await store.get(`eva:${figure.target}`) as EvaRegistration | null;
  if (!registration) return undefined;

  // Use the cached last-REC pointer rather than rescanning the log
  const recSeq = figure._lastRecSeq;
  if (recSeq === undefined) return undefined;
  const padded = String(recSeq).padStart(12, '0');
  const recEvent = await store.get(`log:${padded}`) as EoEvent | null;
  if (!recEvent) return undefined;

  const participants = recEvent.operand?.contains
    ? (recEvent.operand.contains as Array<{ target: string }>).map(c => c.target)
    : [figure.target];
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
