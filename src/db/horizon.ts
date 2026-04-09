import { EoDb, decode } from './level.js';
import { getState, getStateByPrefix, getHashCohort } from './state.js';
import { getBranchState } from './branch.js';
import { getEdgesFrom, getEdgesTo } from './graph.js';
import { getDepEdgesFrom, getDepEdgesTo } from './dep-graph.js';
import { resolveAlias } from './helpers.js';
import { getResolutionPolicy, resolveConflict } from './conflict.js';
import type { ConflictState } from './types.js';
import { readLogForTarget } from './log.js';
import type {
  EoState, EvaRegistration, HorizonResponse, GroundEntry, SignalEntry,
  NearbyEntry, GovernanceEntry, AncestryEntry,
  GraphMetrics, GraphRole,
  RecResult, RecCycleInfo,
  CrystallizedInEntry,
  FieldSchemaEntry,
  DerivedEntity,
} from './types.js';
import { groupSchemaStates } from './schema-rules.js';
import { isEncryptedOperand } from './crypto-types.js';
import type { LocalKeyring } from './crypto-types.js';
import { decryptOperand, getKeyById } from '../crypto/segment-keys.js';

export interface HorizonOpts {
  prefix?: boolean;
  ancestry?: boolean;  // default true — the ontology chain
  signals?: boolean;
  grounds?: boolean;    // default true
  nearby?: boolean;     // default true
  governance?: boolean; // default true
  include_deleted?: boolean; // default false — if true, include soft-deleted entities
}

/**
 * Horizon read — current state of records.
 *
 * Four cheap layers:
 *   1. Figure  — what this target IS (projected state with fields as columns, alias resolution, Horizon-computed EVA)
 *   2. Ground  — what this target is IN (ambient conditions from ancestor prefixes)
 *   3. Nearby  — what's next to it (records sharing structural traits in the same collection)
 *   4. Governance — what rules apply (EVA policies governing this target and its region)
 *
 * One expensive layer (on-demand only):
 *   5. Signals — statistical patterns across populations
 */
/**
 * Horizon read — current state of records.
 *
 * @param branchId  Branch to read from. Defaults to 'main'.
 *                  On non-main branches, the figure layer reads from getBranchState
 *                  (which inherits from the parent chain). The nearby, ancestry, and
 *                  governance layers remain main-only in this PR.
 *                  KNOWN GAP: aggregateFieldColumns reads main state keyspace.
 *                  See getStateByPrefix note below.
 */
export async function horizonGet(
  db: EoDb,
  target: string,
  opts?: HorizonOpts,
  branchId: string = 'main',
): Promise<HorizonResponse | HorizonResponse[] | null> {
  if (opts?.prefix) {
    return horizonGetByPrefix(db, target, opts);
  }

  const resolved = await resolveAlias(db, target, branchId);

  // Layer 1: Figure (branch-aware)
  const figure = await getFigureState(db, resolved, branchId);
  if (!figure) return null;

  // Soft-delete check: unless include_deleted is set, treat deleted entities as not found
  if (figure.value?._deleted && !opts?.include_deleted) return null;

  // Ancestry: the ontology chain — each parent as a mini-Horizon
  const ancestry = opts?.ancestry !== false ? await getAncestry(db, resolved) : undefined;

  // Layer 2: Grounds (default on)
  const grounds = opts?.grounds !== false ? await getGrounds(db, resolved) : [];

  // Layer 3: Nearby (default on) — cheap prefix scan + field matching
  const nearby = opts?.nearby !== false ? await getNearby(db, resolved) : undefined;

  // Layer 4: Governance (default on) — scan eva: keyspace for applicable policies
  const governance = opts?.governance !== false ? await getGovernance(db, resolved) : undefined;

  // Layer 5: Signals (expensive, on-demand only)
  const signals = opts?.signals ? await detectSignals(db, resolved) : undefined;

  // ─── Pattern Surfacing (cheap, auto-computed alongside existing layers) ───

  // Hash cohort: structural twins sharing the same transformation hash
  const hashCohort = figure?.hash
    ? (await getHashCohort(db, figure.hash)).filter(t => t !== resolved)
    : undefined;

  // Graph metrics: CON graph role and degree
  const graphMetrics = await computeGraphMetrics(db, resolved);

  // REC cycle info: if this target participates in a dependency cycle
  const recCycle = await getRecCycleInfo(db, resolved);

  // Crystallized-in: derived entities this target is a constituent of
  const crystallizedIn = await getCrystallizedIn(db, resolved);

  return {
    target: resolved, figure, ancestry, grounds, nearby, governance, signals,
    hashCohort: hashCohort && hashCohort.length > 0 ? hashCohort : undefined,
    graphMetrics,
    recCycle,
    crystallizedIn: crystallizedIn.length > 0 ? crystallizedIn : undefined,
  };
}

async function horizonGetByPrefix(db: EoDb, prefix: string, opts?: HorizonOpts): Promise<HorizonResponse[]> {
  const states = await getStateByPrefix(db, prefix);
  const results: HorizonResponse[] = [];

  for (const state of states) {
    if (state.value?._alias) continue;
    if (state.value?._deleted && !opts?.include_deleted) continue;

    const figure = await getFigureState(db, state.target);
    const grounds = opts?.grounds !== false ? await getGrounds(db, state.target) : [];

    // For prefix queries, skip expensive per-record layers unless explicitly requested
    const nearby = opts?.nearby === true ? await getNearby(db, state.target) : undefined;
    const governance = opts?.governance === true ? await getGovernance(db, state.target) : undefined;
    const signals = opts?.signals ? await detectSignals(db, state.target) : undefined;

    results.push({ target: state.target, figure, grounds, nearby, governance, signals });
  }

  return results;
}

// ─── Layer 1: Figure ───────────────────────────────────────────────

async function getFigureState(
  db: EoDb,
  target: string,
  branchId: string = 'main',
): Promise<EoState | null> {
  // Branch-aware state read
  const state = branchId === 'main'
    ? await getState(db, target)
    : await getBranchState(db, branchId, target);
  if (!state) return null;

  if (state.value?._alias) {
    return getFigureState(db, state.value._alias, branchId);
  }

  // Conflict resolution at read time — if the state holds a ConflictState,
  // check for a registered resolution policy and apply it.
  if (state.value?.conflict === true) {
    const policy = await getResolutionPolicy(db, target);
    if (policy) {
      const resolved = resolveConflict(state.value as ConflictState, policy);
      const resolvedState = { ...state, value: resolved };
      // Aggregate columns on the resolved value
      return aggregateFieldColumns(db, target, resolvedState);
    }
    // No policy — Binding default: conflict IS the datum, return as-is
    return state;
  }

  // Aggregate child field targets as columns into the figure value.
  // KNOWN GAP: aggregateFieldColumns calls getStateByPrefix which reads main state keyspace.
  // On non-main branches, child columns reflect main's state, not the branch's projected state.
  // Fix deferred to next PR (branch-aware prefix scan).
  const withColumns = await aggregateFieldColumns(db, target, state);

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
      const resolved = await resolveAlias(db, dep, branchId);
      const depState = await getBranchState(db, branchId, resolved);
      inputs[dep] = depState?.value;
    }
    return {
      ...withColumns,
      value: {
        ...withColumns.value,
        _computed: {
          formula: registration.formula.formula || registration.formula,
          inputs,
          evaluated_at: new Date().toISOString(),
        },
      },
    };
  }

  return withColumns;
}

/**
 * Aggregate child field targets into the figure value as columns.
 * e.g. if target is app.tbl.rec001 and state:app.tbl.rec001.score exists with value 100,
 * the returned figure value will include { ..., score: 100 }.
 *
 * NOTE: Branch-blind — uses getStateByPrefix which reads main state keyspace (state:{prefix}).
 * On non-main branches this returns pre-fork state from main, not branch projected state.
 * Consequence: aggregateFieldColumns, getNearby, getGovernance, detectSignals, getAncestry
 * all read main state when called from a non-main branch Horizon.
 * Branch-aware prefix scan is deferred to next PR. DO NOT use in branch write paths.
 */
async function aggregateFieldColumns(db: EoDb, target: string, state: EoState): Promise<EoState> {
  const children = await getStateByPrefix(db, target + '.');
  if (children.length === 0) return state;

  // Only aggregate direct children (one level deeper)
  const targetDepth = target.split('.').length;
  const columns: Record<string, any> = {};

  for (const child of children) {
    const childParts = child.target.split('.');
    if (childParts.length !== targetDepth + 1) continue;
    if (child.value?._alias) continue;

    const fieldName = childParts[targetDepth];
    columns[fieldName] = child.value;
  }

  if (Object.keys(columns).length === 0) return state;

  // Merge columns into the figure value (existing record value takes precedence)
  const baseValue = state.value && typeof state.value === 'object' ? state.value : {};
  return {
    ...state,
    value: { ...columns, ...baseValue },
  };
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

// ─── Ancestry: The Ontology Chain ──────────────────────────────────
// Climb up the target path. Each ancestor is a mini-Horizon:
// its own figure, its own grounds from above, count of siblings and children.
// fldStatus → rec101 → tblCases → app
// Cheap: one state lookup + one prefix count per ancestor level.

async function getAncestry(db: EoDb, target: string): Promise<AncestryEntry[]> {
  const parts = target.split('.');
  if (parts.length <= 1) return [];

  const ancestry: AncestryEntry[] = [];

  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const ancestorTarget = parts.slice(0, depth).join('.');
    const distance = parts.length - depth;

    // This ancestor's figure
    const figure = await getState(db, ancestorTarget);

    // This ancestor's own grounds (from levels above it)
    const ancestorParts = ancestorTarget.split('.');
    const ancestorGrounds: GroundEntry[] = [];
    const ancestorKeys = new Set<string>();
    if (figure?.value && typeof figure.value === 'object') {
      Object.keys(figure.value).forEach(k => ancestorKeys.add(k));
    }
    for (let gd = ancestorParts.length - 1; gd >= 1; gd--) {
      const gAncestor = ancestorParts.slice(0, gd).join('.');
      const gDist = ancestorParts.length - gd;
      const gState = await getState(db, gAncestor);
      if (gState?.value && typeof gState.value === 'object' && !gState.value._alias) {
        for (const [key, value] of Object.entries(gState.value)) {
          if (!key.startsWith('_') && !ancestorKeys.has(key)) {
            ancestorGrounds.push({ source: gAncestor, key, value, distance: gDist });
          }
        }
      }
    }

    // Count children under this ancestor (direct children = one segment deeper)
    const childPrefix = ancestorTarget + '.';
    const allChildren = await getStateByPrefix(db, childPrefix);
    const directChildren = allChildren.filter(s => {
      const childParts = s.target.split('.');
      return childParts.length === depth + 1 && !s.value?._alias;
    });

    // Count siblings (peers at the same level, under the same parent)
    let nearbyCount = 0;
    if (depth >= 2) {
      const parentTarget = parts.slice(0, depth - 1).join('.');
      const sibPrefix = parentTarget + '.';
      const siblings = await getStateByPrefix(db, sibPrefix);
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

// ─── Layer 5: Signals (expensive, on-demand) ───────────────────────

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

// ─── Pattern Surfacing: Graph Metrics ────────────────────────────

async function computeGraphMetrics(db: EoDb, target: string): Promise<GraphMetrics | undefined> {
  const outEdges = await getEdgesFrom(db, target);
  const inEdges = await getEdgesTo(db, target);

  const outDegree = outEdges.length;
  const inDegree = inEdges.length;
  const degree = outDegree + inDegree;

  if (degree === 0) return undefined;

  // Count mutual connections (A→B and B→A)
  const outTargets = new Set(outEdges.map(e => e.dest));
  const inSources = new Set(inEdges.map(e => e.source));
  let mutualCount = 0;
  for (const t of outTargets) {
    if (inSources.has(t)) mutualCount++;
  }

  // Classify role
  let role: GraphRole;
  if (degree === 0) {
    role = 'isolated';
  } else if (degree === 1) {
    role = 'leaf';
  } else if (degree >= 6) {
    role = 'hub';
  } else {
    // Check if bridge: connected to nodes in different collections
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

async function getRecCycleInfo(db: EoDb, target: string): Promise<RecCycleInfo | undefined> {
  // Check if this target has an EVA registration (formula)
  let registration: EvaRegistration | null = null;
  try {
    const buf = await db.get(`eva:${target}`);
    registration = decode(buf) as EvaRegistration;
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
  if (!registration) return undefined;

  // Check forward and reverse dep edges to find cycle
  const fwd = await getDepEdgesFrom(db, target);
  const rev = await getDepEdgesTo(db, target);
  if (fwd.length === 0 && rev.length === 0) return undefined;

  // Quick cycle detection: follow forward deps from this target
  // and check if any path leads back to this target
  const visited = new Set<string>();
  const queue = fwd.map(e => e.dest);
  const edges: Array<{ source: string; dest: string }> = fwd.map(e => ({ source: e.source, dest: e.dest }));

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (current === target) {
      // Found a cycle — collect all participants
      const participants = [target, ...visited];

      // Look for the most recent REC event on this target
      const events = await readLogForTarget(db, target);
      const recEvent = [...events].reverse().find(e => e.op === 'REC');
      const result: RecResult = recEvent?.operand
        ? {
          converged: recEvent.operand.converged ?? true,
          iterations: recEvent.operand.iterations ?? 0,
          cycle_length: recEvent.operand.cycle_length,
          states: recEvent.operand.states,
          stable_state: recEvent.operand.stable_state,
        }
        : { converged: true, iterations: 0 };

      return {
        participants,
        triggeringSeq: recEvent?.triggered_by,
        result,
        edges,
      };
    }
    if (visited.has(current)) continue;
    visited.add(current);
    const nextEdges = await getDepEdgesFrom(db, current);
    for (const e of nextEdges) {
      edges.push({ source: e.source, dest: e.dest });
      queue.push(e.dest);
    }
  }

  return undefined;
}

// ─── Pattern Surfacing: Crystallized-In ─────────────────────────

/**
 * Find all crystallized entities that this target is a constituent of.
 * Scans the rdep: index for the target and filters for cohort-topology
 * derived entities. Cheap: one prefix scan on rdep:{target}:, then one
 * derived: lookup per result.
 */
async function getCrystallizedIn(db: EoDb, target: string): Promise<CrystallizedInEntry[]> {
  const results: CrystallizedInEntry[] = [];
  const prefix = `rdep:${target}:`;

  for await (const [, buf] of db.iterator({ gte: prefix, lte: `${prefix}\xff` })) {
    const derivedTarget = decode(buf) as string;

    // Look up the derived entity registration
    let derived: DerivedEntity | null = null;
    try {
      const dBuf = await db.get(`derived:${derivedTarget}`);
      derived = decode(dBuf) as DerivedEntity;
    } catch (e: any) {
      if (e.code === 'LEVEL_NOT_FOUND') continue;
      throw e;
    }

    if (!derived || derived.topology !== 'cohort') continue;

    // Get the crystallized entity's state for traits and member count
    const state = await getState(db, derivedTarget);
    if (!state) continue;

    results.push({
      target: derivedTarget,
      traits: state.value?.traits ?? {},
      member_count: Array.isArray(state.value?.constituents) ? state.value.constituents.length : 0,
      inert: derived.inert,
    });
  }

  return results;
}

// ─── Decryption Wrapper ───────────────────────────────────────────
// Transparently decrypt encrypted operands in a HorizonResponse.
// If the key is missing, replace the value with a redacted marker.

/**
 * Decrypt any EncryptedOperand values found in a HorizonResponse.
 * Operates on a single response or an array of responses.
 * Values whose key is not in the keyring are replaced with a redacted marker
 * that preserves the key_id and scope for discoverability.
 */
export async function decryptHorizonResponse(
  response: HorizonResponse | HorizonResponse[] | null,
  keyring: LocalKeyring,
): Promise<HorizonResponse | HorizonResponse[] | null> {
  if (response === null) return null;

  if (Array.isArray(response)) {
    return Promise.all(response.map(r => decryptSingleResponse(r, keyring)));
  }

  return decryptSingleResponse(response, keyring);
}

async function decryptSingleResponse(
  response: HorizonResponse,
  keyring: LocalKeyring,
): Promise<HorizonResponse> {
  const result = { ...response };

  // Decrypt figure value
  if (result.figure) {
    result.figure = { ...result.figure };
    result.figure.value = await decryptValueOrRedact(result.figure.value, keyring);
  }

  // Decrypt ancestry figures
  if (result.ancestry) {
    result.ancestry = await Promise.all(
      result.ancestry.map(async (entry) => ({
        ...entry,
        figure: entry.figure
          ? { ...entry.figure, value: await decryptValueOrRedact(entry.figure.value, keyring) }
          : null,
      })),
    );
  }

  // Decrypt ground values
  if (result.grounds) {
    result.grounds = await Promise.all(
      result.grounds.map(async (g) => ({
        ...g,
        value: await decryptValueOrRedact(g.value, keyring),
      })),
    );
  }

  return result;
}

async function decryptValueOrRedact(value: any, keyring: LocalKeyring): Promise<any> {
  if (!isEncryptedOperand(value)) return value;

  const entry = getKeyById(keyring, value.key_id);
  if (!entry) {
    // Key not available — return redacted marker with metadata
    return {
      _encrypted: true,
      _redacted: true,
      key_id: value.key_id,
      key_version: value.key_version,
    };
  }

  try {
    return await decryptOperand(entry.key, value);
  } catch {
    // Decryption failed (wrong key version, corrupted data, etc.)
    return {
      _encrypted: true,
      _redacted: true,
      _error: 'decryption_failed',
      key_id: value.key_id,
      key_version: value.key_version,
    };
  }
}

// ─── Schema rules ────────────────────────────────────────────────────

/**
 * Get aggregated schema rules for a scope.
 *
 * Projects all ._schema.* states and groups them into per-field summaries
 * with DEF/EVA counts. REC count is deferred (requires log scan infrastructure).
 */
export async function getSchemaRules(db: EoDb, scope: string): Promise<FieldSchemaEntry[]> {
  const prefix = scope + '._schema.';
  const states = await getStateByPrefix(db, prefix);
  const grouped = groupSchemaStates(states, prefix);

  return Array.from(grouped.values()).map(fs => ({
    fieldKey: fs.fieldKey,
    defCount: (fs.typeDef ? 1 : 0) + fs.constraints.length,
    evaCount: fs.resolve ? 1 : 0,
    typeDef: fs.typeDef?.value,
    constraints: fs.constraints.map(c => ({ name: c.name, value: c.value })),
    resolve: fs.resolve?.value,
  }));
}
