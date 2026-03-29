import { EoDb, encode, decode, nextSeq } from './level.js';
import { appendToLog } from './log.js';
import { getState, setState } from './state.js';
import { addEdge, removeEdge, getEdgesFrom, getEdgesTo } from './graph.js';
import { addDepEdge, clearDepEdgesFrom, getDepEdgesFrom, getDepEdgesTo, getConnectedComponent } from './dep-graph.js';
import { resolveAlias, checkExists } from './helpers.js';
import type { EoEvent, EoEventInput, EoState, EvaRegistration, RecResult, ExternalOperator, DerivedEntity } from './types.js';
import { isEncryptedOperand } from './crypto-types.js';
import type { Feed } from './feed.js';
import { seedHash, chainHash, eventHash } from './hash.js';

/** Configuration for REC loop runner. */
export interface RecConfig {
  /** Maximum iterations before bailout. Safety net for genuinely non-converging cases. Default 100. */
  maxIterations: number;
  /** Floating-point tolerance for convergence. "Close enough" threshold. Default 1e-9. */
  convergenceTolerance: number;
}

const DEFAULT_REC_CONFIG: RecConfig = {
  maxIterations: 100,
  convergenceTolerance: 1e-9,
};

let recConfig: RecConfig = { ...DEFAULT_REC_CONFIG };

/** Set REC configuration. Partial updates merged with defaults. */
export function setRecConfig(config: Partial<RecConfig>): void {
  recConfig = { ...DEFAULT_REC_CONFIG, ...config };
}

/** Get current REC configuration. */
export function getRecConfig(): RecConfig {
  return { ...recConfig };
}

/**
 * Process a single EO event through the fold.
 * This is the heart of the database — every event flows through here.
 */
export async function processEvent(
  db: EoDb,
  event: EoEventInput,
  feed?: Feed
): Promise<number> {
  // 0. REC is system-generated — reject external submissions
  if (event.op === 'REC') {
    throw new Error('REC is system-generated and cannot be submitted externally');
  }

  // 0.5. Deterministic event hashing — assign client_event_id from content hash
  //       if not already provided, to prevent duplicate logging across sync paths
  if (!event.client_event_id) {
    event = { ...event, client_event_id: eventHash(event) };
  }

  // 1. Idempotency check
  if (event.client_event_id) {
    try {
      const buf = await db.get(`idem:${event.client_event_id}`);
      return decode(buf) as number;
    } catch (e: any) {
      if (e.code !== 'LEVEL_NOT_FOUND') throw e;
    }
  }

  // 2. No-op check: skip if update would not change state
  const noOpSeq = await checkNoOp(db, event);
  if (noOpSeq !== null) return noOpSeq;

  // 3. Assign sequence number
  const seq = await nextSeq(db);
  const fullEvent: EoEvent = { ...event, seq };

  // 4. Append to log
  await appendToLog(db, fullEvent);

  // 5. Store idempotency key
  if (event.client_event_id) {
    await db.put(`idem:${event.client_event_id}`, encode(seq));
  }

  // 6. Execute operator-specific logic (helix dispatch)
  await executeOperator(db, fullEvent);

  // 7. Recompute fold-computed EVA-active dependents (with cycle guard)
  await recomputeDependents(db, fullEvent.target, new Set());

  // 8. Detect dependency cycles and emit system-generated REC if found
  await detectAndEmitREC(db, fullEvent.target, fullEvent, feed);

  // 9. Cascade upward: if this target is a constituent of any derived entity, re-evaluate it
  await cascadeUpward(db, fullEvent.target, fullEvent, feed);

  // 10. Notify changefeed
  if (feed) {
    feed.notify(fullEvent);
  }

  return seq;
}

/**
 * Operator dispatch — routes to helix-aware handler.
 * Each handler may invoke lower handlers in the helix.
 */
export async function executeOperator(db: EoDb, event: EoEvent): Promise<void> {
  switch (event.op) {
    case 'NUL': return handleNUL(db, event);
    case 'INS': return handleINS(db, event);
    case 'SEG': return handleSEG(db, event);
    case 'CON': return handleCON(db, event);
    case 'SYN': return handleSYN(db, event);
    case 'DEF': return handleDEF(db, event);
    case 'EVA': return handleEVA(db, event);
    // REC is not dispatched from outside — it is produced by the fold
    // when it detects a circular dependency after applying a human-initiated event.
  }
}

// Builds the common state metadata fields from an event
function stateFromEvent(event: EoEvent, op: EoEvent['op']) {
  return {
    last_seq: event.seq,
    last_op: op,
    last_agent: event.agent,
    last_ts: event.ts,
    last_acquired_ts: event.acquired_ts,
  };
}

// --- NUL: Observation ---
// Pure observation — state goes in, state comes out unchanged.
// The event is logged but no state mutation occurs.
async function handleNUL(_db: EoDb, _event: EoEvent): Promise<void> {
  // Identity operator: no state change. The log entry is written by processEvent.
}

// --- INS: Instantiate ---
// Inherited: NUL (existence check), SIG (coordinate targeting)
// External INS is always level 1. System-generated INS (from REC convergence) carries level 2+.
async function handleINS(db: EoDb, event: EoEvent): Promise<void> {
  // NUL capacity: observe keyspace to check for duplicates
  const existing = await checkExists(db, event.target);
  if (existing) {
    throw new Error(`Target already instantiated: ${event.target}`);
  }

  await setState(db, {
    target: event.target,
    value: event.operand ?? {},
    hash: seedHash(event),
    level: event.level ?? 1,
    ...stateFromEvent(event, 'INS'),
  });
}

// --- SEG: Segment (Boundary) ---
// Inherited: INS (confirm target exists)
async function handleSEG(db: EoDb, event: EoEvent): Promise<void> {
  // INS capacity: confirm target exists before partitioning
  const existing = await checkExists(db, event.target);
  if (!existing) {
    throw new Error(`SEG target does not exist: ${event.target}`);
  }

  await setState(db, {
    target: event.target,
    value: event.operand,
    hash: chainHash(existing.hash, event),
    level: existing.level,
    ...stateFromEvent(event, 'SEG'),
  });
}

// --- CON: Connect ---
// Inherited: INS (existence check on endpoints), SEG (partition awareness)
async function handleCON(db: EoDb, event: EoEvent): Promise<void> {
  const operand = event.operand;

  // INS capacity: verify endpoints exist
  if (operand.added) {
    for (const dest of operand.added) {
      const destExists = await checkExists(db, dest);
      if (!destExists) {
        throw new Error(`CON target does not exist: ${dest}`);
      }
    }
  }

  // Add edges
  if (operand.added) {
    for (const dest of operand.added) {
      await addEdge(db, {
        source: event.target,
        dest,
        edge_type: operand.edge_type,
        seq: event.seq,
      });
    }
  }

  // Remove edges
  if (operand.removed) {
    for (const dest of operand.removed) {
      await removeEdge(db, event.target, dest);
    }
  }

  // Update state to reflect current link set
  const currentEdges = await getEdgesFrom(db, event.target);
  const sourceState = await getState(db, event.target);
  await setState(db, {
    target: event.target,
    value: { linked: currentEdges.map(e => e.dest), edge_type: operand.edge_type },
    hash: chainHash(sourceState!.hash, event),
    level: sourceState!.level,
    ...stateFromEvent(event, 'CON'),
  });
}

// --- SYN: Synthesis (Merge) ---
// Inherited: CON (merge edges), SEG (dissolve boundaries), INS (mint merged identity)
async function handleSYN(db: EoDb, event: EoEvent): Promise<void> {
  const operand = event.operand;

  if (operand.merge) {
    const [a, b] = operand.merge;

    // INS capacity: confirm both targets exist
    const stateA = await checkExists(db, a);
    const stateB = await checkExists(db, b);
    if (!stateA || !stateB) {
      throw new Error(`SYN merge targets must both exist: ${a}, ${b}`);
    }

    const mergedTarget = operand.into || event.target;

    // Merge state values
    const mergedValue = mergeOperand(stateA.value, stateB.value);

    // INS capacity: mint the merged target's identity
    // The merged target gets a seed hash — it is a new entity born from the SYN event
    await setState(db, {
      target: mergedTarget,
      value: mergedValue,
      hash: seedHash(event),
      level: 1,
      ...stateFromEvent(event, 'SYN'),
    });

    // CON capacity: merge edges from both targets to the merged target
    const edgesFromA = await getEdgesFrom(db, a);
    const edgesFromB = await getEdgesFrom(db, b);
    const edgesToA = await getEdgesTo(db, a);
    const edgesToB = await getEdgesTo(db, b);

    for (const edge of [...edgesFromA, ...edgesFromB]) {
      if (edge.dest !== a && edge.dest !== b) {
        await addEdge(db, { ...edge, source: mergedTarget, seq: event.seq });
      }
    }
    for (const edge of [...edgesToA, ...edgesToB]) {
      if (edge.source !== a && edge.source !== b) {
        await addEdge(db, { ...edge, dest: mergedTarget, seq: event.seq });
      }
    }

    // Store alias records so queries for A or B resolve to merged target
    // Alias targets chain from their existing hash — they carry the SYN participation
    await setState(db, {
      target: a,
      value: { _alias: mergedTarget },
      hash: chainHash(stateA.hash, event),
      level: stateA.level,
      ...stateFromEvent(event, 'SYN'),
    });
    if (b !== mergedTarget) {
      await setState(db, {
        target: b,
        value: { _alias: mergedTarget },
        hash: chainHash(stateB.hash, event),
        level: stateB.level,
        ...stateFromEvent(event, 'SYN'),
      });
    }
  }
}

// --- DEF: Define Value or Register Computation ---
// Inherited: SYN (alias resolution), SEG (boundary respect), INS (auto-instantiation), CON (dependency recomputation)
async function handleDEF(db: EoDb, event: EoEvent): Promise<void> {
  // SYN capacity: resolve alias if target was merged
  const target = await resolveAlias(db, event.target);

  // INS capacity: auto-instantiate if target doesn't exist
  let existing = await getState(db, target);
  if (!existing) {
    existing = {
      target,
      value: {},
      hash: seedHash(event),
      level: 1,
      ...stateFromEvent(event, 'INS'),
    };
    await setState(db, existing);
  }

  // Level guard: reject DEFs on core content of derived entities (INS2+).
  // Annotations at sub-paths are allowed — only the core path is protected.
  if (existing.level > 1 && event.agent !== 'system') {
    throw new Error(
      `Cannot DEF core content of derived entity at level ${existing.level}: ${target}`
    );
  }

  // DEF's own logic: merge operand into existing state
  const merged = mergeOperand(existing.value, event.operand);

  await setState(db, {
    target,
    value: merged,
    hash: chainHash(existing.hash, event),
    level: existing.level,
    ...stateFromEvent(event, 'DEF'),
  });

  // Check if operand is a formula definition
  if (isFormulaOperand(event.operand)) {
    const result = await registerEvaActive(db, target, event.operand);
    // Stash merge info on the event for detectAndEmitREC to pick up
    if (result.mergedComponent) {
      (event as any)._mergedComponent = result.mergedComponent;
    }
  }
}

// --- EVA: Evaluate ---
// Inherited: All eight capacities below. Full 8-step pipeline.
async function handleEVA(db: EoDb, event: EoEvent): Promise<void> {
  // SYN capacity: resolve alias
  const target = await resolveAlias(db, event.target);

  const existing = await getState(db, target);

  // Write evaluation policy to state
  await setState(db, {
    target,
    value: event.operand,
    hash: existing ? chainHash(existing.hash, event) : seedHash(event),
    level: existing?.level ?? 1,
    ...stateFromEvent(event, 'EVA'),
  });
}

// --- REC: Recursion (Fixed-Point Iteration) ---
// Inherited: Everything. Applies operator sequences to their own outputs until structure stabilizes.
// REC is the only operator whose execution is not a single pass through the combining function.
// It runs the contains array, checks whether the output changed the inputs to its own computation,
// and if it did, runs the sequence again. It repeats until the state stabilizes or until it detects a cycle.
//
// Three outcomes: convergence (state stops changing), oscillation (state cycles between configurations),
// or max-iteration bailout (safety valve — should not occur with finite state spaces).

async function handleREC(db: EoDb, event: EoEvent): Promise<void> {
  const subOps = event.operand?.contains || [];
  const pivot = event.operand?.pivot || null;
  const maxIterations = event.operand?.max_iterations || recConfig.maxIterations;

  // Collect all targets the loop body touches, plus the pivot if specified
  const watchedTargets = new Set<string>();
  for (const subOp of subOps) {
    if (subOp.target) watchedTargets.add(subOp.target);
  }
  if (pivot) watchedTargets.add(pivot);

  // Snapshot: capture current projected state of all watched targets
  async function snapshot(): Promise<Record<string, any>> {
    const snap: Record<string, any> = {};
    for (const t of watchedTargets) {
      const state = await getState(db, t);
      snap[t] = state?.value ?? null;
    }
    return snap;
  }

  // Build sub-event template (shares the REC's seq — sub-ops are not individually logged)
  function subEvent(subOp: any): EoEvent {
    return {
      ...subOp,
      seq: event.seq,
      agent: event.agent,
      ts: event.ts,
      acquired_ts: event.acquired_ts,
    };
  }

  // Take initial snapshot before any pass
  const initialSnap = await snapshot();
  const history: Array<Record<string, any>> = [initialSnap];

  let iterations = 0;
  let converged = false;
  let cycleLength = 0;

  while (iterations < maxIterations) {
    // Run all sub-operations (one full pass through the loop body)
    for (const subOp of subOps) {
      await executeOperator(db, subEvent(subOp));
      // Recompute dependents after each sub-op so feedback propagates within the pass
      await recomputeDependents(db, subOp.target, new Set());
    }

    iterations++;
    const currentSnap = await snapshot();

    // Check against all previous snapshots
    let matched = -1;
    for (let i = 0; i < history.length; i++) {
      if (deepEqual(currentSnap, history[i])) {
        matched = i;
        break;
      }
    }

    if (matched >= 0) {
      if (matched === history.length - 1) {
        // Current state matches the immediately preceding state — converged
        converged = true;
      } else {
        // Current state matches an earlier state — oscillation detected
        cycleLength = history.length - matched;
      }
      break;
    }

    history.push(currentSnap);
  }

  // Build result record
  const result: RecResult = {
    converged,
    iterations,
  };

  if (!converged && cycleLength > 0) {
    result.cycle_length = cycleLength;
    // Capture the cycling states: from the matched point to the end of history
    result.states = history.slice(history.length - cycleLength);
  } else if (converged) {
    const finalSnap = await snapshot();
    result.stable_state = finalSnap;
  }

  // Mark the REC event itself in state
  const existing = await getState(db, event.target);
  await setState(db, {
    target: event.target,
    value: {
      recursion: true,
      pivot,
      sub_ops: subOps.length,
      reason: event.operand?.reason,
      result,
    },
    hash: existing ? chainHash(existing.hash, event) : seedHash(event),
    level: existing?.level ?? 1,
    ...stateFromEvent(event, 'REC'),
  });
}

// --- System-Generated REC: Cycle Detection and Emission ---

/**
 * Strip ephemeral fields (e.g. evaluated_at timestamps) from a value
 * so that convergence comparison is structural, not temporal.
 */
function stripEphemeral(val: any): any {
  if (val == null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(stripEphemeral);
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(val)) {
    if (k === 'evaluated_at') continue;
    result[k] = stripEphemeral(v);
  }
  return result;
}

/**
 * Detect dependency cycles involving the changed target.
 *
 * Two modes:
 * - Iterative REC: a single cycle is found, formulas are run repeatedly until convergence.
 * - Critical REC: a new dep edge merged previously separate connected components.
 *   The entire merged component is evaluated as one unit in a single pass. Phase transition.
 *
 * Critical REC fires when registerEvaActive detected a component merge.
 * Iterative REC fires when a cycle exists but no merge happened.
 */
async function detectAndEmitREC(
  db: EoDb,
  changedTarget: string,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  // Check for critical REC first — component merge takes precedence
  const mergedComponent: Set<string> | undefined = (triggeringEvent as any)._mergedComponent;
  if (mergedComponent && mergedComponent.size > 1) {
    await emitCriticalREC(db, changedTarget, mergedComponent, triggeringEvent, feed);
    return;
  }

  const cycleTargets = await findRecomputationCycle(db, changedTarget);
  if (!cycleTargets || cycleTargets.length === 0) return;

  // Collect EVA registrations for all cycle members
  const registrations: EvaRegistration[] = [];
  for (const target of cycleTargets) {
    try {
      const buf = await db.get(`eva:${target}`);
      const reg = decode(buf) as EvaRegistration;
      if (reg && reg.mode === 'fold') {
        registrations.push(reg);
      }
    } catch (e: any) {
      if (e.code !== 'LEVEL_NOT_FOUND') throw e;
    }
  }

  if (registrations.length === 0) return;

  // Determine the level of the constituents — INS level of the cycle members
  let maxConstituentLevel = 1;
  const constituentTargets: string[] = [];
  for (const target of cycleTargets) {
    constituentTargets.push(target);
    const state = await getState(db, target);
    if (state && state.level > maxConstituentLevel) {
      maxConstituentLevel = state.level;
    }
  }
  constituentTargets.push(changedTarget);
  const derivedLevel = maxConstituentLevel + 1;

  // Build the set of targets to watch for convergence
  const watchedTargets = new Set<string>(cycleTargets);
  watchedTargets.add(changedTarget);

  // Snapshot for convergence comparison — strips ephemeral evaluation timestamps
  // so that structurally identical states are recognized as equal.
  async function snapshot(): Promise<Record<string, any>> {
    const snap: Record<string, any> = {};
    for (const t of watchedTargets) {
      const state = await getState(db, t);
      snap[t] = stripEphemeral(state?.value ?? null);
    }
    return snap;
  }

  const initialSnap = await snapshot();
  const history: Array<Record<string, any>> = [initialSnap];

  let iterations = 0;
  let converged = false;
  let cycleLength = 0;

  while (iterations < recConfig.maxIterations) {
    // Run one pass: re-evaluate all formulas in the cycle
    for (const reg of registrations) {
      await evaluateFormula(db, reg);
    }

    iterations++;
    const currentSnap = await snapshot();

    // Check against all previous snapshots for convergence or oscillation.
    // Uses nearEqual: floating-point values within tolerance count as converged.
    let matched = -1;
    for (let i = 0; i < history.length; i++) {
      if (nearEqual(currentSnap, history[i])) {
        matched = i;
        break;
      }
    }

    if (matched >= 0) {
      if (matched === history.length - 1) {
        converged = true;
      } else {
        cycleLength = history.length - matched;
      }
      break;
    }

    history.push(currentSnap);
  }

  // Build result
  const result: RecResult = { converged, iterations };
  if (!converged && cycleLength > 0) {
    result.cycle_length = cycleLength;
    result.states = history.slice(history.length - cycleLength);
  } else if (converged) {
    result.stable_state = await snapshot();
  }

  // Build the contains array showing what operators ran in each pass
  const containsOps = registrations.map(reg => ({
    op: 'DEF' as const,
    target: reg.target,
    operand: reg.formula,
  }));

  // Produce the REC event with system as agent
  const recSeq = await nextSeq(db);
  const now = new Date().toISOString();
  const recEventInput: EoEventInput = {
    op: 'REC',
    target: changedTarget,
    operand: {
      contains: containsOps,
      pivot: changedTarget,
    },
    agent: 'system',
    ts: now,
    acquired_ts: now,
    triggered_by: triggeringEvent.seq,
  };
  const recEvent: EoEvent = {
    ...recEventInput,
    seq: recSeq,
    client_event_id: eventHash(recEventInput),
  };

  // Log the REC event and store idempotency key
  await appendToLog(db, recEvent);
  await db.put(`idem:${recEvent.client_event_id}`, encode(recSeq));

  // Store REC result in state (on the pivot target, preserving its existing level)
  const existingPivot = await getState(db, changedTarget);
  await setState(db, {
    target: changedTarget,
    value: {
      ...existingPivot?.value,
      _rec: {
        recursion: true,
        pivot: changedTarget,
        sub_ops: registrations.length,
        triggered_by: triggeringEvent.seq,
        result,
      },
    },
    hash: existingPivot ? chainHash(existingPivot.hash, recEvent) : seedHash(recEvent),
    level: existingPivot?.level ?? 1,
    ...stateFromEvent(recEvent, 'REC'),
  });

  // Notify changefeed for REC
  if (feed) {
    feed.notify(recEvent);
  }

  // --- INS2+: Produce a derived entity when REC discovers something ---
  // Generate a deterministic target for the derived entity based on constituents
  const sortedConstituents = [...new Set(constituentTargets)].sort();
  const derivedTargetId = derivedEntityTarget(sortedConstituents);

  // Check if a derived entity already exists for this cycle
  const existingDerived = await getState(db, derivedTargetId);

  const derivedOperand = {
    constituents: sortedConstituents,
    topology: 'cycle',
    result,
  };

  if (existingDerived) {
    // Update existing derived entity's result (same cycle, new data)
    const updateSeq = await nextSeq(db);
    const updateEvent: EoEvent = {
      seq: updateSeq,
      op: 'DEF',
      target: derivedTargetId,
      operand: derivedOperand,
      agent: 'system',
      ts: now,
      acquired_ts: now,
      triggered_by: triggeringEvent.seq,
    };
    await appendToLog(db, updateEvent);
    await setState(db, {
      target: derivedTargetId,
      value: derivedOperand,
      hash: chainHash(existingDerived.hash, updateEvent),
      level: existingDerived.level,
      ...stateFromEvent(updateEvent, 'DEF'),
    });
    if (feed) feed.notify(updateEvent);
  } else {
    // INS the new derived entity at the next level
    const insSeq = await nextSeq(db);
    const insEvent: EoEvent = {
      seq: insSeq,
      op: 'INS',
      target: derivedTargetId,
      operand: derivedOperand,
      agent: 'system',
      level: derivedLevel,
      ts: now,
      acquired_ts: now,
      triggered_by: triggeringEvent.seq,
    };
    await appendToLog(db, insEvent);
    await setState(db, {
      target: derivedTargetId,
      value: derivedOperand,
      hash: seedHash(insEvent),
      level: derivedLevel,
      ...stateFromEvent(insEvent, 'INS'),
    });

    // Register in the derived entity index
    const derived: DerivedEntity = {
      target: derivedTargetId,
      level: derivedLevel,
      constituents: sortedConstituents,
      topology: 'cycle',
      inert: false,
    };
    await db.put(`derived:${derivedTargetId}`, encode(derived));

    // Update reverse dependency index: constituent → derived entity
    for (const constituent of sortedConstituents) {
      await addReverseDep(db, constituent, derivedTargetId);
    }

    if (feed) feed.notify(insEvent);
  }

  // Cascade upward: if the changed target or its derived entity is itself
  // a constituent of higher-level entities, re-evaluate them
  await cascadeUpward(db, derivedTargetId, triggeringEvent, feed);
}

/**
 * Critical REC: a phase transition.
 * Two or more previously separate connected components just merged into one.
 * Instead of running each sub-cycle iteratively, the entire merged component
 * is evaluated as a single unit in one pass. The reorganization is structural —
 * iteration count is 1. The system isn't computing a fixed point. It's recognizing
 * that a new configuration exists.
 */
async function emitCriticalREC(
  db: EoDb,
  changedTarget: string,
  component: Set<string>,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  // Collect all fold-mode EVA registrations in the merged component
  const registrations: EvaRegistration[] = [];
  const componentTargets = Array.from(component);

  for (const target of componentTargets) {
    try {
      const buf = await db.get(`eva:${target}`);
      const reg = decode(buf) as EvaRegistration;
      if (reg && reg.mode === 'fold') {
        registrations.push(reg);
      }
    } catch (e: any) {
      if (e.code !== 'LEVEL_NOT_FOUND') throw e;
    }
  }

  // Need at least 2 formula targets to constitute a critical mass
  if (registrations.length < 2) return;

  // Single pass: evaluate all formulas in the merged component simultaneously
  for (const reg of registrations) {
    await evaluateFormula(db, reg);
  }

  // Snapshot the result — this is what the reorganization produced
  const stableState: Record<string, any> = {};
  for (const target of componentTargets) {
    const state = await getState(db, target);
    stableState[target] = stripEphemeral(state?.value ?? null);
  }

  const result: RecResult = {
    converged: true,
    iterations: 1,
    stable_state: stableState,
  };

  // Determine derived level
  let maxLevel = 1;
  for (const target of componentTargets) {
    const state = await getState(db, target);
    if (state && state.level > maxLevel) maxLevel = state.level;
  }
  const derivedLevel = maxLevel + 1;

  // Build the contains array
  const containsOps = registrations.map(reg => ({
    op: 'DEF' as const,
    target: reg.target,
    operand: reg.formula,
  }));

  // Produce the REC event
  const recSeq = await nextSeq(db);
  const now = new Date().toISOString();
  const criticalRecInput: EoEventInput = {
    op: 'REC',
    target: changedTarget,
    operand: {
      contains: containsOps,
      pivot: changedTarget,
      critical: true,
      component_size: componentTargets.length,
    },
    agent: 'system',
    ts: now,
    acquired_ts: now,
    triggered_by: triggeringEvent.seq,
  };
  const recEvent: EoEvent = {
    ...criticalRecInput,
    seq: recSeq,
    client_event_id: eventHash(criticalRecInput),
  };

  await appendToLog(db, recEvent);
  await db.put(`idem:${recEvent.client_event_id}`, encode(recSeq));

  // Store REC result on the pivot target
  const existingPivot = await getState(db, changedTarget);
  await setState(db, {
    target: changedTarget,
    value: {
      ...existingPivot?.value,
      _rec: {
        recursion: true,
        critical: true,
        pivot: changedTarget,
        sub_ops: registrations.length,
        component_size: componentTargets.length,
        triggered_by: triggeringEvent.seq,
        result,
      },
    },
    hash: existingPivot ? chainHash(existingPivot.hash, recEvent) : seedHash(recEvent),
    level: existingPivot?.level ?? 1,
    ...stateFromEvent(recEvent, 'REC'),
  });

  if (feed) feed.notify(recEvent);

  // --- INS at next level for the merged component ---
  const sortedConstituents = componentTargets.sort();
  const derivedTargetId = derivedEntityTarget(sortedConstituents);

  const existingDerived = await getState(db, derivedTargetId);

  const derivedOperand = {
    constituents: sortedConstituents,
    topology: 'critical',
    result,
  };

  if (existingDerived) {
    const updateSeq = await nextSeq(db);
    const updateEvent: EoEvent = {
      seq: updateSeq,
      op: 'DEF',
      target: derivedTargetId,
      operand: derivedOperand,
      agent: 'system',
      ts: now,
      acquired_ts: now,
      triggered_by: triggeringEvent.seq,
    };
    await appendToLog(db, updateEvent);
    await setState(db, {
      target: derivedTargetId,
      value: derivedOperand,
      hash: chainHash(existingDerived.hash, updateEvent),
      level: existingDerived.level,
      ...stateFromEvent(updateEvent, 'DEF'),
    });
    if (feed) feed.notify(updateEvent);
  } else {
    const insSeq = await nextSeq(db);
    const insEvent: EoEvent = {
      seq: insSeq,
      op: 'INS',
      target: derivedTargetId,
      operand: derivedOperand,
      agent: 'system',
      level: derivedLevel,
      ts: now,
      acquired_ts: now,
      triggered_by: triggeringEvent.seq,
    };
    await appendToLog(db, insEvent);
    await setState(db, {
      target: derivedTargetId,
      value: derivedOperand,
      hash: seedHash(insEvent),
      level: derivedLevel,
      ...stateFromEvent(insEvent, 'INS'),
    });

    const derived: DerivedEntity = {
      target: derivedTargetId,
      level: derivedLevel,
      constituents: sortedConstituents,
      topology: 'critical',
      inert: false,
    };
    await db.put(`derived:${derivedTargetId}`, encode(derived));

    for (const constituent of sortedConstituents) {
      await addReverseDep(db, constituent, derivedTargetId);
    }

    if (feed) feed.notify(insEvent);
  }

  await cascadeUpward(db, derivedTargetId, triggeringEvent, feed);
}

/**
 * Generate a deterministic target path for a derived entity from its constituents.
 * The identity of a derived entity is its dependency cycle, not its result.
 */
function derivedEntityTarget(sortedConstituents: string[]): string {
  // Use a short hash of the sorted constituents for identity
  const key = sortedConstituents.join('|');
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  const hexId = (hash >>> 0).toString(16).padStart(8, '0');
  return `system.rec.${hexId}`;
}

/**
 * Add a reverse dependency: constituent → derived entity that depends on it.
 */
async function addReverseDep(db: EoDb, constituent: string, derivedTarget: string): Promise<void> {
  const key = `rdep:${constituent}:${derivedTarget}`;
  await db.put(key, encode(derivedTarget));
}

/**
 * Get all derived entities that depend on a given constituent.
 */
async function getReverseDeps(db: EoDb, constituent: string): Promise<string[]> {
  const deps: string[] = [];
  const prefix = `rdep:${constituent}:`;
  for await (const [, value] of db.iterator({
    gte: prefix,
    lte: `${prefix}\xff`,
  })) {
    deps.push(decode(value) as string);
  }
  return deps;
}

/**
 * Cascade re-evaluation upward through derived entity levels.
 * When a constituent changes, all derived entities that depend on it
 * need to re-run their REC loops.
 */
async function cascadeUpward(
  db: EoDb,
  changedTarget: string,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  const dependentTargets = await getReverseDeps(db, changedTarget);
  for (const derivedTarget of dependentTargets) {
    // Look up the derived entity registration
    let derived: DerivedEntity | null = null;
    try {
      const buf = await db.get(`derived:${derivedTarget}`);
      derived = decode(buf) as DerivedEntity;
    } catch (e: any) {
      if (e.code === 'LEVEL_NOT_FOUND') continue;
      throw e;
    }

    if (!derived || derived.inert) continue;

    // Re-evaluate: collect current values of all constituents
    const constituentValues: Record<string, any> = {};
    for (const c of derived.constituents) {
      const state = await getState(db, c);
      constituentValues[c] = state?.value ?? null;
    }

    // Log a REC re-evaluation event on the derived entity
    const reEvalSeq = await nextSeq(db);
    const now = new Date().toISOString();
    const reEvalInput: EoEventInput = {
      op: 'REC',
      target: derivedTarget,
      operand: {
        re_evaluation: true,
        changed_constituent: changedTarget,
        constituent_values: constituentValues,
      },
      agent: 'system',
      ts: now,
      acquired_ts: now,
      triggered_by: triggeringEvent.seq,
    };
    const reEvalEvent: EoEvent = {
      ...reEvalInput,
      seq: reEvalSeq,
      client_event_id: eventHash(reEvalInput),
    };
    await appendToLog(db, reEvalEvent);
    await db.put(`idem:${reEvalEvent.client_event_id}`, encode(reEvalSeq));

    // Update the derived entity's value with current constituent data
    const existingDerived = await getState(db, derivedTarget);
    if (existingDerived) {
      await setState(db, {
        target: derivedTarget,
        value: {
          ...existingDerived.value,
          result: {
            ...existingDerived.value?.result,
            stable_state: constituentValues,
          },
        },
        hash: chainHash(existingDerived.hash, reEvalEvent),
        level: existingDerived.level,
        ...stateFromEvent(reEvalEvent, 'REC'),
      });
    }

    if (feed) feed.notify(reEvalEvent);

    // Continue cascading upward if this derived entity is itself a constituent
    await cascadeUpward(db, derivedTarget, triggeringEvent, feed);
  }
}

/**
 * Find a dependency cycle involving the start target.
 * Standard DFS with visited set. Walks the dependency graph (dep:rev edges)
 * forward from the changed target. If the walk returns to the starting target,
 * there's a cycle. Terminates in time proportional to reachable edges.
 * No depth limit needed — visited set prevents revisiting nodes.
 * Returns the list of cycle member targets, or null if no cycle exists.
 */
async function findRecomputationCycle(db: EoDb, startTarget: string): Promise<string[] | null> {
  const visited = new Set<string>();
  const path: string[] = [];

  async function dfs(current: string): Promise<string[] | null> {
    // Use dep graph (computational dependencies), not CON graph (entity relationships)
    const reverseEdges = await getDepEdgesTo(db, current);
    for (const edge of reverseEdges) {
      const source = edge.source;

      // Check if this source has an EVA-active fold registration
      let hasReg = false;
      try {
        const buf = await db.get(`eva:${source}`);
        const reg = decode(buf) as EvaRegistration;
        hasReg = reg != null && reg.mode === 'fold';
      } catch (e: any) {
        if (e.code !== 'LEVEL_NOT_FOUND') throw e;
      }

      if (!hasReg) continue;

      if (source === startTarget) {
        // Cycle found — return the targets in the cycle
        return [...path, current];
      }

      if (!visited.has(source)) {
        visited.add(source);
        path.push(current);
        const result = await dfs(source);
        if (result) return result;
        path.pop();
      }
    }
    return null;
  }

  return dfs(startTarget);
}

// --- Dependent Recomputation ---

async function recomputeDependents(db: EoDb, changedTarget: string, visited: Set<string> = new Set()): Promise<void> {
  if (visited.has(changedTarget)) return; // cycle guard — prevents infinite recursion
  visited.add(changedTarget);

  // Use dep graph: "who has a formula that references changedTarget?"
  const reverseEdges = await getDepEdgesTo(db, changedTarget);

  for (const edge of reverseEdges) {
    let registration: EvaRegistration | null = null;
    try {
      const buf = await db.get(`eva:${edge.source}`);
      registration = decode(buf) as EvaRegistration;
    } catch (e: any) {
      if (e.code === 'LEVEL_NOT_FOUND') continue;
      throw e;
    }

    if (registration && registration.mode === 'fold') {
      await evaluateFormula(db, registration);
      // Recurse: if this formula's result changed, its dependents may need recomputation
      await recomputeDependents(db, registration.target, visited);
    }
  }
}

async function evaluateFormula(db: EoDb, registration: EvaRegistration): Promise<void> {
  // Gather dependency values
  const inputs: Record<string, any> = {};
  for (const dep of registration.dependencies) {
    // SYN capacity: resolve aliases on dependencies
    const resolved = await resolveAlias(db, dep);
    const state = await getState(db, resolved);
    inputs[dep] = state?.value;
  }

  // Execute formula (placeholder — returns formula + inputs)
  const result = executeFormulaFunction(registration.formula, inputs);

  // Write result to projected state (NOT to the log)
  // Hash is preserved — formula recomputation is not a transformation event
  const existing = await getState(db, registration.target);
  const now = new Date().toISOString();
  await setState(db, {
    target: registration.target,
    value: { ...existing?.value, _computed: result },
    hash: existing?.hash || '',
    level: existing?.level ?? 1,
    last_seq: existing?.last_seq || 0,
    last_op: existing?.last_op || 'DEF',
    last_agent: 'system:eva',
    last_ts: now,
    last_acquired_ts: now,
  });
}

function executeFormulaFunction(formula: any, inputs: Record<string, any>): any {
  return { formula: formula.formula || formula, inputs, evaluated_at: new Date().toISOString() };
}

// --- Helpers ---

function mergeOperand(existing: any, incoming: any): any {
  // Encrypted operands are atomic blobs — no shallow merge into/from them
  if (isEncryptedOperand(incoming)) return incoming;
  if (isEncryptedOperand(existing)) return incoming;

  if (
    existing && typeof existing === 'object' && !Array.isArray(existing) &&
    incoming && typeof incoming === 'object' && !Array.isArray(incoming)
  ) {
    return { ...existing, ...incoming };
  }
  return incoming;
}

function isFormulaOperand(operand: any): boolean {
  return operand && typeof operand === 'object' && 'formula' in operand;
}

/**
 * Result of EVA registration — tracks whether adding this formula's
 * dep edges caused previously separate connected components to merge.
 */
interface EvaRegistrationResult {
  registration: EvaRegistration;
  /** If the new edges bridged separate components, the merged component. Null otherwise. */
  mergedComponent: Set<string> | null;
}

async function registerEvaActive(db: EoDb, target: string, operand: any): Promise<EvaRegistrationResult> {
  // Extract dependencies from the formula operand.
  // Formula operands declare references explicitly: { formula: '...', references: ['target.A', 'target.B'] }
  // If no explicit references, fall back to CON graph edges (backward compat).
  let dependencies: string[];
  if (Array.isArray(operand.references) && operand.references.length > 0) {
    dependencies = operand.references;
  } else {
    const edges = await getEdgesFrom(db, target);
    dependencies = edges.map(e => e.dest);
  }

  const mode = formulaReferencesExternal(operand.formula) ? 'horizon' : 'fold';

  const registration: EvaRegistration = {
    target,
    formula: operand,
    mode,
    dependencies,
  };

  await db.put(`eva:${target}`, encode(registration));

  // --- Component merge detection (the snap) ---
  // Before adding new edges, snapshot which components exist.
  // A component merge = phase transition.
  let mergedComponent: Set<string> | null = null;

  if (mode === 'fold' && dependencies.length > 0) {
    // Get the component that `target` currently belongs to (before new edges)
    const sourceComponent = await getConnectedComponent(db, target);

    // Check: will any of the new dependencies bridge to a different component?
    const destComponents: Set<string>[] = [];
    for (const dep of dependencies) {
      if (!sourceComponent.has(dep)) {
        // This dep is in a different component — the edge will bridge them
        destComponents.push(await getConnectedComponent(db, dep));
      }
    }

    // Clear old and add new dep edges
    await clearDepEdgesFrom(db, target);
    for (const dep of dependencies) {
      await addDepEdge(db, { source: target, dest: dep });
    }

    // If we bridged components, compute the merged result
    if (destComponents.length > 0) {
      mergedComponent = await getConnectedComponent(db, target);
    }
  } else {
    // Non-fold or no dependencies — just update edges, no merge detection
    await clearDepEdgesFrom(db, target);
    for (const dep of dependencies) {
      await addDepEdge(db, { source: target, dest: dep });
    }
  }

  if (mode === 'fold') {
    await evaluateFormula(db, registration);
  }

  return { registration, mergedComponent };
}

function formulaReferencesExternal(formula: any): boolean {
  const externalPatterns = [
    'NOW()', 'TODAY()', 'DAYS_UNTIL(', 'DAYS_SINCE(',
    'CURRENT_TIME', 'CURRENT_DATE',
  ];
  const str = typeof formula === 'string' ? formula.toUpperCase() : '';
  return externalPatterns.some(p => str.includes(p));
}

/**
 * Deep equality check for no-op detection.
 * Strict equality — no floating-point tolerance.
 */
function deepEqual(a: any, b: any): boolean {
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

/**
 * Near-equality check for convergence detection.
 * Numbers within recConfig.convergenceTolerance count as equal.
 * Two values that are close enough should count as converged, not oscillating.
 */
function nearEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;

  // Floating-point tolerance for numbers
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    const diff = Math.abs(a - b);
    // Absolute tolerance for values near zero, relative tolerance otherwise
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    return diff <= recConfig.convergenceTolerance * scale;
  }

  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((val: any, i: number) => nearEqual(val, b[i]));
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(key => nearEqual(a[key], b[key]));
}

/**
 * Check if an event would be a no-op (state already matches).
 * Returns the existing last_seq if no change, null otherwise.
 */
async function checkNoOp(db: EoDb, event: EoEventInput): Promise<number | null> {
  if (event.op === 'DEF') {
    const target = await resolveAlias(db, event.target);
    const existing = await getState(db, target);
    if (!existing) return null; // Will auto-instantiate — not a no-op
    const merged = mergeOperand(existing.value, event.operand);
    if (deepEqual(existing.value, merged)) return existing.last_seq;
  }
  return null;
}

export { mergeOperand, isFormulaOperand, deepEqual, nearEqual };
