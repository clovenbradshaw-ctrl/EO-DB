import type { EoStore } from './encrypted-store';
import { getState, getStateByPrefix } from './state';
import { getEdgesFrom, getEdgesTo } from './graph';
import { resolveAlias } from './helpers';
import { readLogForTarget } from './log';
import { StoreNulHorizon } from './addressing-horizon';
import type {
  EoEvent, EoState, EvaRegistration, HorizonResponse, GroundEntry, SignalEntry,
  SimilarRecord, SimilarityReason, Observation,
  GovernanceEntry, LoggableOperator, AncestryEntry, TrajectoryEntry,
  TrajectoryFingerprint, CadenceInfo, CadenceClass, GraphMetrics, GraphRole,
  RecResult, RecCycleInfo, DerivedEntity, Resolution,
} from './types';
import { seedHash, chainHash } from './hash';
import { classifyOnDemand } from './space-statistics';

export interface HorizonOpts {
  prefix?: boolean;
  ancestry?: boolean;     // default true (fast)
  ancestryLight?: boolean; // default true; when true, skip expensive children/sibling counts
  signals?: boolean;      // default false (opt-in; expensive)
  grounds?: boolean;      // default true (fast — from fold cache / ground prefix)
  nearby?: boolean;       // default false (opt-in; O(N) fold cache reads)
  observations?: boolean; // default false (opt-in; O(N) collection scan for structural anomalies)
  governance?: boolean;   // default false (opt-in; EVA registration scan)
  trajectory?: boolean;   // default true (fast; read from fold cache)
  hashCohort?: boolean;   // default false (opt-in; collection prefix scan)
  recCycle?: boolean;     // default false (opt-in; graph walk)
  classification?: boolean; // default false (opt-in; population scan + z-score classification)
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
  const [ancestry, grounds, nearby, observations, governance, signals, hashCohort, recCycle, classification] = await Promise.all([
    opts?.ancestry !== false ? getAncestry(store, resolved, opts?.ancestryLight !== false) : Promise.resolve(undefined),
    opts?.grounds !== false ? getGrounds(store, resolved) : Promise.resolve([] as GroundEntry[]),
    opts?.nearby === true ? getNearby(store, resolved) : Promise.resolve(undefined),
    opts?.observations === true ? getObservations(store, resolved) : Promise.resolve(undefined),
    opts?.governance === true ? getGovernance(store, resolved) : Promise.resolve(undefined),
    opts?.signals === true ? detectSignals(store, resolved) : Promise.resolve(undefined),
    opts?.hashCohort === true && figure?.hash
      ? getHashCohortFromStore(store, figure.hash, resolved)
      : Promise.resolve(undefined),
    opts?.recCycle === true ? getRecCycleInfo(store, figure) : Promise.resolve(undefined),
    opts?.classification === true && fold
      ? classifyOnDemand(store, resolved, fold)
      : Promise.resolve(undefined),
  ]);

  return {
    target: resolved, figure, ancestry, grounds, nearby, observations, governance, trajectory, signals,
    hashCohort: hashCohort && hashCohort.length > 0 ? hashCohort : undefined,
    trajectoryFingerprint,
    cadence,
    graphMetrics,
    recCycle,
    classification,
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

async function getNearby(store: EoStore, target: string): Promise<SimilarRecord[]> {
  const parts = target.split('.');
  if (parts.length < 3) return [];

  const collectionPrefix = parts.slice(0, 2).join('.');
  const figureState = await getState(store, target);
  if (!figureState) return [];

  const figureEdges = await getEdgesFrom(store, target);
  const figureLinked = new Set(figureEdges.map(e => e.dest));
  const figureConTargets = [...figureLinked];
  const figureSegs = figureState._fold?.segmentMemberships ?? [];
  const figureAgents = figureState._fold?.touchedAgents ?? [];
  const figureOpCounts = figureState._fold?.trajectoryFingerprint?.opCounts;
  const figureCrystal = figureState._fold?.crystallizedIn;
  const figureLastMs = figureState._fold?.lastEventTs
    ? new Date(figureState._fold.lastEventTs).getTime() : 0;

  const siblings = await getStateByPrefix(store, collectionPrefix + '.');
  const candidates: SimilarRecord[] = [];

  for (const sib of siblings) {
    if (sib.target === target) continue;
    if (sib.value?._alias) continue;
    if (sib.target.split('.').length !== parts.length) continue;

    const reasons: SimilarityReason[] = [];
    let score = 0;

    // ─── 1. Shared CON targets ───
    const sibEdges = await getEdgesFrom(store, sib.target);
    const sibLinked = new Set(sibEdges.map(e => e.dest));
    const sharedCon = figureConTargets.filter(t => sibLinked.has(t));
    if (sharedCon.length > 0) {
      const weight = sharedCon.length >= 2 ? 0.28 : 0.18;
      score += weight;
      const label = sharedCon.length === 1
        ? sharedCon[0].split('.').pop() || sharedCon[0]
        : `${sharedCon.length} shared connections`;
      reasons.push({
        type: 'con', weight,
        text: sharedCon.length === 1
          ? `Both connected to ${label}`
          : `${sharedCon.length} shared connections`,
        icon: '⬡', color: '#3b82f6',
      });
    }

    // ─── 2. Shared segment membership ───
    const sibSegs = sib._fold?.segmentMemberships ?? [];
    const sharedSegs = figureSegs.filter(s => sibSegs.includes(s));
    if (sharedSegs.length >= 2) {
      score += 0.20;
      const segLabel = sharedSegs.slice(0, 2).map(s => s.replace(/-/g, ' ')).join(', ');
      reasons.push({ type: 'seg', weight: 0.20, text: `Same group: ${segLabel}`, icon: '◈', color: '#8b5cf6' });
    } else if (sharedSegs.length === 1) {
      score += 0.10;
      reasons.push({ type: 'seg', weight: 0.10, text: `Same group: ${sharedSegs[0].replace(/-/g, ' ')}`, icon: '◈', color: '#8b5cf6' });
    }

    // ─── 3. Co-constituent of same derived entity ───
    if (figureCrystal && figureCrystal === sib._fold?.crystallizedIn) {
      score += 0.22;
      reasons.push({ type: 'crystal', weight: 0.22, text: 'Co-produced an emergent group together', icon: '✦', color: '#f59e0b' });
    }

    // ─── 4. Shared agent ───
    const sibAgents = sib._fold?.touchedAgents ?? [];
    const sharedAgents = figureAgents.filter(a => sibAgents.includes(a));
    if (sharedAgents.length > 0) {
      score += 0.12;
      const agentName = sharedAgents[0].replace(/^@/, '');
      reasons.push({ type: 'agent', weight: 0.12, text: `Both touched by ${agentName}`, icon: '◉', color: '#6b7280' });
    }

    // ─── 5. Similar op shape ───
    const sibOpCounts = sib._fold?.trajectoryFingerprint?.opCounts;
    if (figureOpCounts && sibOpCounts) {
      const allOps = new Set([...Object.keys(figureOpCounts), ...Object.keys(sibOpCounts)]);
      const opMatch = [...allOps].every(op =>
        Math.abs((figureOpCounts[op as LoggableOperator] ?? 0) - (sibOpCounts[op as LoggableOperator] ?? 0)) <= 1
      );
      if (opMatch) {
        score += 0.12;
        reasons.push({ type: 'ops', weight: 0.12, text: 'Went through the same process steps', icon: '→', color: '#10b981' });
      }
    }

    // ─── 6. REC oscillating on both ───
    if (figureState._lastRecSeq !== undefined && sib._lastRecSeq !== undefined) {
      const padded = String(sib._lastRecSeq).padStart(12, '0');
      const sibRecEvent = await store.get(`log:${padded}`) as EoEvent | null;
      if (sibRecEvent && sibRecEvent.operand?.converged === false) {
        score += 0.18;
        reasons.push({ type: 'rec', weight: 0.18, text: 'Both have unresolved feedback loops', icon: '⟳', color: '#ec4899' });
      }
    }

    // ─── 7. Temporal proximity (no shared agent) ───
    const sibLastMs = sib._fold?.lastEventTs ? new Date(sib._fold.lastEventTs).getTime() : 0;
    if (figureLastMs > 0 && sibLastMs > 0 && sharedAgents.length === 0) {
      const daysDiff = Math.abs(figureLastMs - sibLastMs) / (1000 * 60 * 60 * 24);
      if (daysDiff <= 3) {
        score += 0.08;
        reasons.push({ type: 'temporal', weight: 0.08, text: 'Active at the same time, no shared connection yet', icon: '◷', color: '#6b7280' });
      }
    }

    if (reasons.length === 0) continue;

    reasons.sort((a, b) => b.weight - a.weight);
    const cappedScore = Math.min(Math.round(score * 100), 99);
    candidates.push({ target: sib.target, score: cappedScore, reasons: reasons.slice(0, 3) });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 10);
}

// --- Layer 3b: Observations ---

/** Extract a human-readable display name from a state record. */
function displayNameFromState(state: EoState): string {
  const v = state.value;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (typeof v.name === 'string') return v.name;
    if (typeof v.displayName === 'string') return v.displayName;
    if (typeof v.title === 'string') return v.title;
  }
  return state.target.split('.').pop() || state.target;
}

/** Format an ISO timestamp as "Month Day" (e.g. "March 15"). */
function formatObsDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

async function getObservations(store: EoStore, target: string): Promise<Observation[]> {
  const parts = target.split('.');
  if (parts.length < 3) return [];
  const collectionPrefix = parts.slice(0, 2).join('.');

  const focalState = await getState(store, target);
  if (!focalState) return [];

  const siblings = await getStateByPrefix(store, collectionPrefix + '.');
  const population = siblings.filter(s =>
    s.target !== target &&
    !s.value?._alias &&
    s.target.split('.').length === parts.length,
  );

  const observations: Observation[] = [];

  // ─── 1. REC oscillation ───
  for (const sib of population) {
    if (sib._lastRecSeq === undefined) continue;
    const padded = String(sib._lastRecSeq).padStart(12, '0');
    const recEvent = await store.get(`log:${padded}`) as EoEvent | null;
    if (!recEvent || recEvent.operand?.converged !== false) continue;
    const sibName = displayNameFromState(sib);
    const fieldPath: string = recEvent.operand?.pivot ?? recEvent.operand?.target ?? 'a field';
    const fieldName = fieldPath.split('.').pop() || fieldPath;
    const date = recEvent.acquired_ts ? formatObsDate(recEvent.acquired_ts) : 'recently';
    observations.push({
      icon: '⟳',
      color: '#ec4899',
      text: `${sibName}'s ${fieldName} has been oscillating since ${date}. The rule governing it hasn't converged.`,
      action: 'Review rule →',
      actionTarget: sib.target,
    });
    if (observations.length >= 4) return observations;
  }

  // ─── 2. Temporal gap — pairs active at same time with no CON edge between them ───
  const focalSegs = focalState._fold?.segmentMemberships ?? [];
  const focalAgents = focalState._fold?.touchedAgents ?? [];
  for (let i = 0; i < population.length && observations.length < 4; i++) {
    const a = population[i];
    const b = population[i + 1];
    if (!b) break;
    const aMs = a._fold?.lastEventTs ? new Date(a._fold.lastEventTs).getTime() : 0;
    const bMs = b._fold?.lastEventTs ? new Date(b._fold.lastEventTs).getTime() : 0;
    if (aMs === 0 || bMs === 0) continue;
    const daysDiff = Math.abs(aMs - bMs) / (1000 * 60 * 60 * 24);
    if (daysDiff > 3) continue;
    // No CON edge between them
    const aEdges = await getEdgesFrom(store, a.target);
    const aLinked = new Set(aEdges.map(e => e.dest));
    if (aLinked.has(b.target)) continue;
    // At least one shares a segment or agent with the focal record
    const aSegs = a._fold?.segmentMemberships ?? [];
    const bSegs = b._fold?.segmentMemberships ?? [];
    const aAgents = a._fold?.touchedAgents ?? [];
    const bAgents = b._fold?.touchedAgents ?? [];
    const relatedToFocal =
      aSegs.some(s => focalSegs.includes(s)) || bSegs.some(s => focalSegs.includes(s)) ||
      aAgents.some(ag => focalAgents.includes(ag)) || bAgents.some(ag => focalAgents.includes(ag));
    if (!relatedToFocal) continue;
    const aName = displayNameFromState(a);
    const bName = displayNameFromState(b);
    const dateStr = formatObsDate(new Date(Math.max(aMs, bMs)).toISOString());
    observations.push({
      icon: '◷',
      color: '#6b7280',
      text: `${aName} and ${bName} were both active on ${dateStr} but share no connection. They may be working the same matter independently.`,
      action: 'Connect them →',
      actionTarget: a.target,
    });
  }

  // ─── 3. Crystallization — co-constituents + potential expansion ───
  if (observations.length < 4) {
    const focalCrystalId = focalState._fold?.crystallizedIn;
    if (focalCrystalId) {
      const derived = await store.get(`derived:${focalCrystalId}`) as DerivedEntity | null;
      if (derived && derived.constituents.length >= 2) {
        const constituentNames: string[] = [];
        for (const c of derived.constituents) {
          const cs = await getState(store, c);
          constituentNames.push(cs ? displayNameFromState(cs) : c.split('.').pop() || c);
        }
        const qualifyingCount = population.filter(s =>
          !derived.constituents.includes(s.target) && !s._fold?.crystallizedIn,
        ).length;
        const extra = qualifyingCount > 0
          ? ` ${qualifyingCount} other record${qualifyingCount > 1 ? 's' : ''} in this table may qualify to join it.`
          : '';
        observations.push({
          icon: '✦',
          color: '#f59e0b',
          text: `${constituentNames[0]} and ${constituentNames[1]} co-produced a ${derived.topology} cohort.${extra}`,
          action: 'View cohort →',
          actionTarget: focalCrystalId,
        });
      }
    }
  }

  // ─── 4. Reviewed with no field changes (last_op NUL, inactive > 14 days) ───
  if (observations.length < 4) {
    const cutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
    for (const sib of population) {
      if (sib.last_op !== 'NUL') continue;
      const lastMs = sib.last_ts ? new Date(sib.last_ts).getTime() : 0;
      if (lastMs === 0 || lastMs > cutoffMs) continue;
      const sibName = displayNameFromState(sib);
      const dateStr = formatObsDate(sib.last_ts);
      observations.push({
        icon: '👁',
        color: '#9ca3af',
        text: `${sibName} was reviewed on ${dateStr} with no field changes made. It hasn't been opened since.`,
      });
      break;
    }
  }

  return observations.slice(0, 4);
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
      const isOutlier = Math.abs(z) > 1.5;
      const description = isOutlier
        ? `${field} is ${z > 0 ? 'unusually high' : 'unusually low'} (z=${z.toFixed(2)})`
        : z > 0.2
        ? `${field} is above average (z=${z.toFixed(2)})`
        : z < -0.2
        ? `${field} is below average (z=${z.toFixed(2)})`
        : `${field} is near the population average`;
      signals.push({
        description,
        measure: field,
        value: { target_value: targetFieldState.value, population_mean: mean, z_score: z, isOutlier },
        population: collectionPrefix,
        n: values.length,
        computed_at: new Date().toISOString(),
      });
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

// ─── Resolution-axis read path (Phase C) ────────────────────────────────────

/**
 * A single fold record indexed by resolution coordinate. Phase C widened
 * this from the Phase A slice 6 placeholder to include value, ts, and
 * operator — the fields callers need to render resolution-tagged state
 * without re-walking the log.
 *
 * Today only NUL observations populate these records (via NulHorizon).
 * When future slices index non-NUL resolution-stamped events (e.g.
 * DEF × Making), the same shape carries without a type change.
 */
export interface HorizonRecord {
  site: string;
  resolution: Resolution;
  seq: number;
  /** Operator that produced this record. Currently always 'NUL'. */
  op: LoggableOperator;
  /** Timestamp (ISO 8601) of the event that produced this record. */
  ts: string | undefined;
  /**
   * The operand/value the event carried. For NUL events this is
   * undefined — NUL is a pure observation with no payload. For future
   * non-NUL resolution records (e.g. DEF × Making), this will carry
   * the operand.
   */
  value: unknown;
}

/**
 * getRecordsByResolution — resolution-aware read path for a site.
 *
 * Returns a Map keyed by Resolution, where each entry is the **latest**
 * HorizonRecord at that resolution coordinate. "Latest" means highest-seq
 * observation — if a site has been NUL'd at 'Clearing' twice, only the
 * most recent one appears in the map.
 *
 * Data source: NulHorizon. This is the only resolution-indexed store today.
 * When future slices add non-NUL resolution tracking (e.g. DEF × Making
 * indexed by resolution), they will extend this function to merge records
 * from additional stores. The public API (Map<Resolution, HorizonRecord>)
 * is designed to absorb that without a breaking change.
 *
 * Performance: O(k) where k is the number of NUL observations on the site
 * (typically small — a site accumulates one NUL per explicit absence
 * observation). No log scan required.
 */
export async function getRecordsByResolution(
  store: EoStore,
  site: string,
): Promise<Map<Resolution, HorizonRecord>> {
  const nulHorizon = new StoreNulHorizon(store);
  const observations = await nulHorizon.getObservations(site);
  const map = new Map<Resolution, HorizonRecord>();

  // Walk in seq-ascending order so the last write at each resolution wins.
  for (const obs of observations) {
    map.set(obs.resolution, {
      site: obs.site,
      resolution: obs.resolution,
      seq: obs.seq,
      op: 'NUL',
      ts: undefined,  // NulObservation does not carry ts; future slices may enrich
      value: undefined, // NUL is a pure observation — no payload
    });
  }

  return map;
}
