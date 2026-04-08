import type { EoStore } from './encrypted-store';
import { appendToLog } from './log';
import { getState, setState } from './state';
import { addEdge, removeEdge, getEdgesFrom, getEdgesTo } from './graph';
import { resolveAlias, checkExists } from './helpers';
import { AsyncMutex } from './mutex';
import { eventHash } from './hash';
import { validateEvent, formatValidationErrors } from './validate';
import { updateFoldCache, refreshGraphMetrics } from './fold-cache';
import type { EoEvent, EoEventInput, EoState, EvaRegistration, RecResult, ExternalOperator, DerivedEntity } from './types';

/** Fold mutex — ensures only one processEvent executes at a time. */
const foldMutex = new AsyncMutex();

/**
 * Process a single EO event through the fold.
 * This is the heart of the database — every event flows through here.
 *
 * Protected by foldMutex: concurrent calls queue and execute serially.
 * Uses content-addressable hashing for idempotency when client_event_id
 * is not provided.
 */
export async function processEvent(
  store: EoStore,
  event: EoEventInput,
  onEvent?: (event: EoEvent) => void,
): Promise<number> {
  return foldMutex.run(() => processEventInner(store, event, onEvent));
}

/**
 * Bulk-import mode: process events quickly by deferring expensive
 * recomputation (recomputeDependents, detectAndEmitREC, cascadeUpward)
 * until after all events are ingested.  Runs the deferred work once
 * per unique target instead of once per event.
 */
export async function processEventsBulk(
  store: EoStore,
  events: EoEventInput[],
  onProgress?: (current: number, total: number) => void,
  onEvent?: (event: EoEvent) => void,
): Promise<number> {
  return foldMutex.run(async () => {
    const touchedTargets = new Set<string>();
    let lastSeq = 0;

    // Phase 1: ingest all events (skip deferred recomputation)
    for (let i = 0; i < events.length; i++) {
      lastSeq = await processEventCore(store, events[i], onEvent);
      touchedTargets.add(events[i].target);
      onProgress?.(i + 1, events.length);
    }

    // Phase 2: run deferred recomputation once per unique target
    for (const target of touchedTargets) {
      await recomputeDependents(store, target, new Set());
    }

    // Phase 3: detect cycles once per unique target
    // Build a synthetic triggering event for cascading
    const now = new Date().toISOString();
    const syntheticTrigger: EoEvent = {
      seq: lastSeq,
      op: 'INS',
      target: '__bulk_import__',
      operand: {},
      agent: 'system:bulk',
      ts: now,
      acquired_ts: now,
    };
    for (const target of touchedTargets) {
      await detectAndEmitREC(store, target, syntheticTrigger, onEvent);
      await cascadeUpward(store, target, syntheticTrigger, onEvent);
    }

    return lastSeq;
  });
}

/**
 * Core event processing — steps 1-7 only (no deferred recomputation).
 * Used by bulk import to defer steps 7b-9 until after all events are ingested.
 */
async function processEventCore(
  store: EoStore,
  event: EoEventInput,
  onEvent?: (event: EoEvent) => void,
): Promise<number> {
  if (event.op === 'REC') {
    throw new Error('REC is system-generated and cannot be submitted externally');
  }
  const validationErrors = validateEvent(event);
  if (validationErrors) {
    throw new Error(`Invalid event: ${formatValidationErrors(validationErrors)}`);
  }

  if (!event.client_event_id) {
    event = { ...event, client_event_id: await eventHash(event) };
  }

  // Idempotency check
  const existing = await store.get(`idem:${event.client_event_id}`);
  if (existing != null) {
    return existing as number;
  }

  const seq = await store.nextSeq();
  const fullEvent: EoEvent = { ...event, seq };

  await appendToLog(store, fullEvent);
  await store.put(`idem:${event.client_event_id!}`, seq);

  try {
    await executeOperator(store, fullEvent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.put(`error:${seq}`, {
      seq,
      client_event_id: event.client_event_id,
      op: event.op,
      target: event.target,
      error: message,
      ts: new Date().toISOString(),
    });
    if (onEvent) onEvent({ ...fullEvent, meta: { ...fullEvent.meta, _error: message } });
    return seq;
  }

  await updateFoldCache(store, fullEvent);

  if (onEvent) {
    onEvent(fullEvent);
  }

  return seq;
}

async function processEventInner(
  store: EoStore,
  event: EoEventInput,
  onEvent?: (event: EoEvent) => void,
): Promise<number> {
  // 0. Validate event structure before any state mutation.
  //    This catches malformed events from Matrix/peer sync before we
  //    assign a seq or touch the log.
  if (event.op === 'REC') {
    throw new Error('REC is system-generated and cannot be submitted externally');
  }
  const validationErrors = validateEvent(event);
  if (validationErrors) {
    throw new Error(`Invalid event: ${formatValidationErrors(validationErrors)}`);
  }

  // 1. Ensure event has a content-addressable ID for dedup.
  //    If the caller provided client_event_id, use it.
  //    Otherwise, derive one from the event content (hash chain).
  if (!event.client_event_id) {
    event = { ...event, client_event_id: await eventHash(event) };
  }

  // 2. Idempotency check — works for both caller-provided and derived IDs
  const existing = await store.get(`idem:${event.client_event_id}`);
  if (existing != null) {
    return existing as number;
  }

  // 3. Assign sequence number
  const seq = await store.nextSeq();
  const fullEvent: EoEvent = { ...event, seq };

  // 4. Append to log
  await appendToLog(store, fullEvent);

  // 5. Store idempotency key
  await store.put(`idem:${event.client_event_id!}`, seq);

  // 6. Execute operator-specific logic (helix dispatch)
  //    If the operator throws, the event is already logged — we record
  //    the error on the event's state so it can be diagnosed and replayed.
  try {
    await executeOperator(store, fullEvent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.put(`error:${seq}`, {
      seq,
      client_event_id: event.client_event_id,
      op: event.op,
      target: event.target,
      error: message,
      ts: new Date().toISOString(),
    });
    // Still notify so the UI can surface the error
    if (onEvent) onEvent({ ...fullEvent, meta: { ...fullEvent.meta, _error: message } });
    return seq;
  }

  // 7. Update the incrementally-maintained fold cache on the target's state
  //    (trajectory, trajectoryFingerprint, cadence, _lastRecSeq). This is the
  //    "current state fold" that horizonGet reads from — so views don't rescan
  //    the event log on every click.
  await updateFoldCache(store, fullEvent);

  // 7b. Recompute fold-computed EVA-active dependents (with cycle guard)
  await recomputeDependents(store, fullEvent.target, new Set());

  // 8. Detect dependency cycles and emit system-generated REC if found
  await detectAndEmitREC(store, fullEvent.target, fullEvent, onEvent);

  // 9. Cascade upward: if this target is a constituent of any derived entity, re-evaluate it
  await cascadeUpward(store, fullEvent.target, fullEvent, onEvent);

  // 10. Notify listeners (Zustand store callback replaces Feed)
  if (onEvent) {
    onEvent(fullEvent);
  }

  return seq;
}

/**
 * Operator dispatch — routes to helix-aware handler.
 */
export async function executeOperator(store: EoStore, event: EoEvent): Promise<void> {
  switch (event.op) {
    case 'INS': return handleINS(store, event);
    case 'SEG': return handleSEG(store, event);
    case 'CON': return handleCON(store, event);
    case 'SYN': return handleSYN(store, event);
    case 'DEF': return handleDEF(store, event);
    case 'EVA': return handleEVA(store, event);
    case 'SIG': return handleSIG(store, event);
    case 'NUL': return; // pure observation — logged by processEvent, no state mutation
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

// --- INS: Instantiate ---
// External INS is always level 1. System-generated INS carries level 2+.
// Stores `_created_by` on the record for Creator ownership enforcement.
async function handleINS(store: EoStore, event: EoEvent): Promise<void> {
  const existing = await checkExists(store, event.target);
  if (existing) {
    throw new Error(`Target already instantiated: ${event.target}`);
  }

  const operand = event.operand ?? {};
  const value = typeof operand === 'object' && !Array.isArray(operand)
    ? { ...operand, _created_by: event.agent }
    : operand;

  await setState(store, {
    target: event.target,
    value,
    level: event.level ?? 1,
    ...stateFromEvent(event, 'INS'),
  });
}

// --- SEG: Segment (Boundary) ---
async function handleSEG(store: EoStore, event: EoEvent): Promise<void> {
  const existing = await checkExists(store, event.target);
  if (!existing) {
    throw new Error(`SEG target does not exist: ${event.target}`);
  }

  await setState(store, {
    target: event.target,
    value: event.operand,
    level: existing.level,
    ...stateFromEvent(event, 'SEG'),
  });
}

// --- CON: Connect ---
async function handleCON(store: EoStore, event: EoEvent): Promise<void> {
  const operand = event.operand;

  if (operand.added) {
    for (const dest of operand.added) {
      const destExists = await checkExists(store, dest);
      if (!destExists) {
        throw new Error(`CON target does not exist: ${dest}`);
      }
    }
  }

  if (operand.added) {
    for (const dest of operand.added) {
      await addEdge(store, {
        source: event.target,
        dest,
        edge_type: operand.edge_type,
        seq: event.seq,
      });
    }
  }

  if (operand.removed) {
    for (const dest of operand.removed) {
      await removeEdge(store, event.target, dest);
    }
  }

  const currentEdges = await getEdgesFrom(store, event.target);
  const sourceState = await getState(store, event.target);
  await setState(store, {
    target: event.target,
    value: {
      ...(sourceState?.value ?? {}),
      _edges: currentEdges.map(e => ({ dest: e.dest, edge_type: e.edge_type })),
    },
    level: sourceState?.level ?? 1,
    ...stateFromEvent(event, 'CON'),
  });

  // Refresh cached graphMetrics on every endpoint whose edges changed.
  const touched = new Set<string>([event.target]);
  if (operand.added) for (const d of operand.added) touched.add(d);
  if (operand.removed) for (const d of operand.removed) touched.add(d);
  for (const t of touched) await refreshGraphMetrics(store, t);
}

// --- SYN: Synthesis (Merge) ---
async function handleSYN(store: EoStore, event: EoEvent): Promise<void> {
  const operand = event.operand;

  if (operand.merge) {
    const [a, b] = operand.merge;

    const stateA = await checkExists(store, a);
    const stateB = await checkExists(store, b);
    if (!stateA || !stateB) {
      throw new Error(`SYN merge targets must both exist: ${a}, ${b}`);
    }

    const mergedTarget = operand.into || event.target;
    const mergedValue = mergeOperand(stateA.value, stateB.value);

    await setState(store, {
      target: mergedTarget,
      value: mergedValue,
      level: 1,
      ...stateFromEvent(event, 'SYN'),
    });

    const edgesFromA = await getEdgesFrom(store, a);
    const edgesFromB = await getEdgesFrom(store, b);
    const edgesToA = await getEdgesTo(store, a);
    const edgesToB = await getEdgesTo(store, b);

    for (const edge of [...edgesFromA, ...edgesFromB]) {
      if (edge.dest !== a && edge.dest !== b) {
        await addEdge(store, { ...edge, source: mergedTarget, seq: event.seq });
      }
    }
    for (const edge of [...edgesToA, ...edgesToB]) {
      if (edge.source !== a && edge.source !== b) {
        await addEdge(store, { ...edge, dest: mergedTarget, seq: event.seq });
      }
    }

    await setState(store, {
      target: a,
      value: { _alias: mergedTarget },
      level: stateA.level,
      ...stateFromEvent(event, 'SYN'),
    });
    if (b !== mergedTarget) {
      await setState(store, {
        target: b,
        value: { _alias: mergedTarget },
        level: stateB.level,
        ...stateFromEvent(event, 'SYN'),
      });
    }

    // Refresh graphMetrics for the merged target and every endpoint of a rewired edge.
    const touched = new Set<string>([mergedTarget]);
    for (const e of [...edgesFromA, ...edgesFromB]) touched.add(e.dest);
    for (const e of [...edgesToA, ...edgesToB]) touched.add(e.source);
    for (const t of touched) await refreshGraphMetrics(store, t);
  }
}

// --- SIG: Signal (ephemeral editing intent) ---
// Writes a _sigs entry on the target's value to broadcast that an agent is
// editing a specific field. Cleared automatically when a DEF arrives for the
// same field, or explicitly when editing: false is sent.
async function handleSIG(store: EoStore, event: EoEvent): Promise<void> {
  const target = await resolveAlias(store, event.target);
  const existing = await getState(store, target);
  const operand = event.operand as { fieldKey: string; draft?: string; editing?: boolean };

  type SigEntry = { agent: string; draft: string; since: string };
  const currentSigs: Record<string, SigEntry> = existing?.value?._sigs ?? {};

  let updatedSigs: Record<string, SigEntry>;
  if (operand.editing === false) {
    // Cancel — remove the entry for this field
    const { [operand.fieldKey]: _removed, ...rest } = currentSigs;
    updatedSigs = rest;
  } else {
    // Start or update draft — upsert
    updatedSigs = {
      ...currentSigs,
      [operand.fieldKey]: {
        agent: event.agent,
        draft: operand.draft ?? '',
        since: event.ts,
      },
    };
  }

  await setState(store, {
    target,
    value: {
      ...(existing?.value ?? {}),
      _sigs: Object.keys(updatedSigs).length > 0 ? updatedSigs : undefined,
    },
    level: existing?.level ?? 1,
    ...stateFromEvent(event, 'SIG'),
  });
}

// --- DEF: Define Value or Register Computation ---
// Includes Creator ownership check: agents with PL 10-24 can only DEF
// records they created (identified by _created_by field).
async function handleDEF(store: EoStore, event: EoEvent): Promise<void> {
  const target = await resolveAlias(store, event.target);

  let existing = await getState(store, target);
  if (!existing) {
    existing = {
      target,
      value: {},
      level: 1,
      ...stateFromEvent(event, 'INS'),
    };
    await setState(store, existing);
  }

  // Level guard: reject DEFs on core content of derived entities (INS2+).
  if (existing.level > 1 && event.agent !== 'system') {
    throw new Error(
      `Cannot DEF core content of derived entity at level ${existing.level}: ${target}`
    );
  }

  // Creator ownership check: if meta._power_level is 10-24 (Creator),
  // only allow DEF on records they created. This is the only fold-level
  // permission check — everything else is Matrix-native.
  const agentPL = event.meta?._power_level;
  if (typeof agentPL === 'number' && agentPL >= 10 && agentPL < 25) {
    const createdBy = existing.value?._created_by;
    if (createdBy && createdBy !== event.agent) {
      throw new Error(
        `Creator-level agent cannot edit records created by others: ${target} (created by ${createdBy})`
      );
    }
  }

  const merged = mergeOperand(existing.value, event.operand);

  // Clear any active _sigs for the fields being committed by this DEF.
  let finalValue = merged;
  if (merged._sigs && typeof event.operand === 'object' && event.operand !== null) {
    const savedKeys = Object.keys(event.operand).filter((k) => !k.startsWith('_'));
    if (savedKeys.length > 0) {
      const updatedSigs = { ...merged._sigs };
      for (const k of savedKeys) delete updatedSigs[k];
      finalValue = {
        ...merged,
        _sigs: Object.keys(updatedSigs).length > 0 ? updatedSigs : undefined,
      };
    }
  }

  await setState(store, {
    target,
    value: finalValue,
    level: existing.level,
    ...stateFromEvent(event, 'DEF'),
  });

  if (isFormulaOperand(event.operand)) {
    await registerEvaActive(store, target, event.operand);
  }
}

// --- EVA: Evaluate ---
async function handleEVA(store: EoStore, event: EoEvent): Promise<void> {
  const target = await resolveAlias(store, event.target);
  const existing = await getState(store, target);

  await setState(store, {
    target,
    value: event.operand,
    level: existing?.level ?? 1,
    ...stateFromEvent(event, 'EVA'),
  });
}

// --- REC: Recursion (Fixed-Point Iteration) ---
// Applies operator sequences to their own outputs until structure stabilizes.
// Three outcomes: convergence, oscillation, or max-iteration bailout.

const DEFAULT_MAX_ITERATIONS = 100;

async function handleREC(store: EoStore, event: EoEvent): Promise<void> {
  const subOps = event.operand?.contains || [];
  const pivot = event.operand?.pivot || null;
  const maxIterations = event.operand?.max_iterations || DEFAULT_MAX_ITERATIONS;

  // Collect all targets the loop body touches
  const watchedTargets = new Set<string>();
  for (const subOp of subOps) {
    if (subOp.target) watchedTargets.add(subOp.target);
  }
  if (pivot) watchedTargets.add(pivot);

  async function snapshot(): Promise<Record<string, any>> {
    const snap: Record<string, any> = {};
    for (const t of watchedTargets) {
      const state = await getState(store, t);
      snap[t] = state?.value ?? null;
    }
    return snap;
  }

  function subEvent(subOp: any): EoEvent {
    return {
      ...subOp,
      seq: event.seq,
      agent: event.agent,
      ts: event.ts,
      acquired_ts: event.acquired_ts,
    };
  }

  const initialSnap = await snapshot();
  const history: Array<Record<string, any>> = [initialSnap];

  let iterations = 0;
  let converged = false;
  let cycleLength = 0;

  while (iterations < maxIterations) {
    for (const subOp of subOps) {
      await executeOperator(store, subEvent(subOp));
      await recomputeDependents(store, subOp.target, new Set());
    }

    iterations++;
    const currentSnap = await snapshot();

    let matched = -1;
    for (let i = 0; i < history.length; i++) {
      if (deepEqual(currentSnap, history[i])) {
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

  const result: RecResult = {
    converged,
    iterations,
  };

  if (!converged && cycleLength > 0) {
    result.cycle_length = cycleLength;
    result.states = history.slice(history.length - cycleLength);
  } else if (converged) {
    const finalSnap = await snapshot();
    result.stable_state = finalSnap;
  }

  const existingRec = await getState(store, event.target);
  await setState(store, {
    target: event.target,
    value: {
      recursion: true,
      pivot,
      sub_ops: subOps.length,
      reason: event.operand?.reason,
      result,
    },
    level: existingRec?.level ?? 1,
    ...stateFromEvent(event, 'REC'),
  });
}

// --- System-Generated REC: Cycle Detection and Emission ---

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

async function detectAndEmitREC(
  store: EoStore,
  changedTarget: string,
  triggeringEvent: EoEvent,
  onEvent?: (event: EoEvent) => void,
): Promise<void> {
  const cycleTargets = await findRecomputationCycle(store, changedTarget);
  if (!cycleTargets || cycleTargets.length === 0) return;

  const registrations: EvaRegistration[] = [];
  for (const target of cycleTargets) {
    const reg = await store.get(`eva:${target}`) as EvaRegistration | null;
    if (reg && reg.mode === 'fold') {
      registrations.push(reg);
    }
  }

  if (registrations.length === 0) return;

  // Determine the level of the constituents
  let maxConstituentLevel = 1;
  const constituentTargets: string[] = [];
  for (const target of cycleTargets) {
    constituentTargets.push(target);
    const state = await getState(store, target);
    if (state && state.level > maxConstituentLevel) {
      maxConstituentLevel = state.level;
    }
  }
  constituentTargets.push(changedTarget);
  const derivedLevel = maxConstituentLevel + 1;

  const watchedTargets = new Set<string>(cycleTargets);
  watchedTargets.add(changedTarget);

  async function snapshot(): Promise<Record<string, any>> {
    const snap: Record<string, any> = {};
    for (const t of watchedTargets) {
      const state = await getState(store, t);
      snap[t] = stripEphemeral(state?.value ?? null);
    }
    return snap;
  }

  const initialSnap = await snapshot();
  const history: Array<Record<string, any>> = [initialSnap];

  let iterations = 0;
  let converged = false;
  let cycleLength = 0;

  while (iterations < DEFAULT_MAX_ITERATIONS) {
    for (const reg of registrations) {
      await evaluateFormula(store, reg);
    }

    iterations++;
    const currentSnap = await snapshot();

    let matched = -1;
    for (let i = 0; i < history.length; i++) {
      if (deepEqual(currentSnap, history[i])) {
        matched = i;
        break;
      }
    }

    if (matched >= 0) {
      if (matched === history.length - 1) converged = true;
      else cycleLength = history.length - matched;
      break;
    }

    history.push(currentSnap);
  }

  const result: RecResult = { converged, iterations };
  if (!converged && cycleLength > 0) {
    result.cycle_length = cycleLength;
    result.states = history.slice(history.length - cycleLength);
  } else if (converged) {
    result.stable_state = await snapshot();
  }

  const containsOps = registrations.map(reg => ({
    op: 'DEF' as const,
    target: reg.target,
    operand: reg.formula,
  }));

  const recSeq = await store.nextSeq();
  const now = new Date().toISOString();
  const recEvent: EoEvent = {
    seq: recSeq,
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

  await appendToLog(store, recEvent);

  const existingPivot = await getState(store, changedTarget);
  await setState(store, {
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
    level: existingPivot?.level ?? 1,
    ...stateFromEvent(recEvent, 'REC'),
  });
  await updateFoldCache(store, recEvent);

  if (onEvent) onEvent(recEvent);

  // --- INS2+: Produce a derived entity ---
  const sortedConstituents = [...new Set(constituentTargets)].sort();
  const derivedTargetId = derivedEntityTarget(sortedConstituents);
  const existingDerived = await getState(store, derivedTargetId);

  const derivedOperand = {
    constituents: sortedConstituents,
    topology: 'cycle',
    result,
  };

  if (existingDerived) {
    const updateSeq = await store.nextSeq();
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
    await appendToLog(store, updateEvent);
    await setState(store, {
      target: derivedTargetId,
      value: derivedOperand,
      level: existingDerived.level,
      ...stateFromEvent(updateEvent, 'DEF'),
    });
    await updateFoldCache(store, updateEvent);
    if (onEvent) onEvent(updateEvent);
  } else {
    const insSeq = await store.nextSeq();
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
    await appendToLog(store, insEvent);
    await setState(store, {
      target: derivedTargetId,
      value: derivedOperand,
      level: derivedLevel,
      ...stateFromEvent(insEvent, 'INS'),
    });
    await updateFoldCache(store, insEvent);

    const derived: DerivedEntity = {
      target: derivedTargetId,
      level: derivedLevel,
      constituents: sortedConstituents,
      topology: 'cycle',
      inert: false,
    };
    await store.put(`derived:${derivedTargetId}`, derived);

    for (const constituent of sortedConstituents) {
      await store.put(`rdep:${constituent}:${derivedTargetId}`, derivedTargetId);
    }

    if (onEvent) onEvent(insEvent);
  }

  await cascadeUpward(store, derivedTargetId, triggeringEvent, onEvent);
}

async function findRecomputationCycle(store: EoStore, startTarget: string): Promise<string[] | null> {
  const visited = new Set<string>();
  const path: string[] = [];

  async function dfs(current: string): Promise<string[] | null> {
    const reverseEdges = await getEdgesTo(store, current);
    for (const edge of reverseEdges) {
      const source = edge.source;

      const reg = await store.get(`eva:${source}`) as EvaRegistration | null;
      if (!reg || reg.mode !== 'fold') continue;

      if (source === startTarget) {
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

function derivedEntityTarget(sortedConstituents: string[]): string {
  const key = sortedConstituents.join('|');
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  const hexId = (hash >>> 0).toString(16).padStart(8, '0');
  return `system.rec.${hexId}`;
}

async function getReverseDeps(store: EoStore, constituent: string): Promise<string[]> {
  const deps: string[] = [];
  const results = await store.iterator(`rdep:${constituent}:`);
  for (const [, value] of results) {
    deps.push(value as string);
  }
  return deps;
}

async function cascadeUpward(
  store: EoStore,
  changedTarget: string,
  triggeringEvent: EoEvent,
  onEvent?: (event: EoEvent) => void,
): Promise<void> {
  const dependentTargets = await getReverseDeps(store, changedTarget);
  for (const derivedTarget of dependentTargets) {
    const derived = await store.get(`derived:${derivedTarget}`) as DerivedEntity | null;
    if (!derived || derived.inert) continue;

    const constituentValues: Record<string, any> = {};
    for (const c of derived.constituents) {
      const state = await getState(store, c);
      constituentValues[c] = state?.value ?? null;
    }

    const reEvalSeq = await store.nextSeq();
    const now = new Date().toISOString();
    const reEvalEvent: EoEvent = {
      seq: reEvalSeq,
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
    await appendToLog(store, reEvalEvent);

    const existingDerived = await getState(store, derivedTarget);
    if (existingDerived) {
      await setState(store, {
        target: derivedTarget,
        value: {
          ...existingDerived.value,
          result: {
            ...existingDerived.value?.result,
            stable_state: constituentValues,
          },
        },
        level: existingDerived.level,
        ...stateFromEvent(reEvalEvent, 'REC'),
      });
      await updateFoldCache(store, reEvalEvent);
    }

    if (onEvent) onEvent(reEvalEvent);
    await cascadeUpward(store, derivedTarget, triggeringEvent, onEvent);
  }
}

// --- Dependent Recomputation ---

async function recomputeDependents(store: EoStore, changedTarget: string, visited: Set<string> = new Set()): Promise<void> {
  if (visited.has(changedTarget)) return; // cycle guard
  visited.add(changedTarget);

  const reverseEdges = await getEdgesTo(store, changedTarget);

  for (const edge of reverseEdges) {
    const registration = await store.get(`eva:${edge.source}`) as EvaRegistration | null;
    if (!registration) continue;

    if (registration.mode === 'fold') {
      await evaluateFormula(store, registration);
      await recomputeDependents(store, registration.target, visited);
    }
  }
}

async function evaluateFormula(store: EoStore, registration: EvaRegistration): Promise<void> {
  const inputs: Record<string, any> = {};
  for (const dep of registration.dependencies) {
    const resolved = await resolveAlias(store, dep);
    const state = await getState(store, resolved);
    inputs[dep] = state?.value;
  }

  const result = executeFormulaFunction(registration.formula, inputs);

  const existing = await getState(store, registration.target);
  const now = new Date().toISOString();
  await setState(store, {
    target: registration.target,
    value: { ...existing?.value, _computed: result },
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

async function registerEvaActive(store: EoStore, target: string, operand: any): Promise<void> {
  const edges = await getEdgesFrom(store, target);
  const dependencies = edges.map(e => e.dest);

  const mode = formulaReferencesExternal(operand.formula) ? 'horizon' : 'fold';

  const registration: EvaRegistration = {
    target,
    formula: operand,
    mode,
    dependencies,
  };

  await store.put(`eva:${target}`, registration);

  if (mode === 'fold') {
    await evaluateFormula(store, registration);
  }
}

function formulaReferencesExternal(formula: any): boolean {
  const externalPatterns = [
    'NOW()', 'TODAY()', 'DAYS_UNTIL(', 'DAYS_SINCE(',
    'CURRENT_TIME', 'CURRENT_DATE',
  ];
  const str = typeof formula === 'string' ? formula.toUpperCase() : '';
  return externalPatterns.some(p => str.includes(p));
}

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

export { mergeOperand, isFormulaOperand, deepEqual };
