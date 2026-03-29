import type { EoStore } from './encrypted-store';
import { appendToLog } from './log';
import { getState, setState } from './state';
import { addEdge, removeEdge, getEdgesFrom, getEdgesTo } from './graph';
import { resolveAlias, checkExists } from './helpers';
import type { EoEvent, EoEventInput, EoState, EvaRegistration, RecResult } from './types';

/**
 * Process a single EO event through the fold.
 * This is the heart of the database — every event flows through here.
 */
export async function processEvent(
  store: EoStore,
  event: EoEventInput,
  onEvent?: (event: EoEvent) => void,
): Promise<number> {
  // 1. Idempotency check
  if (event.client_event_id) {
    const existing = await store.get(`idem:${event.client_event_id}`);
    if (existing != null) {
      return existing as number;
    }
  }

  // 2. Assign sequence number
  const seq = await store.nextSeq();
  const fullEvent: EoEvent = { ...event, seq };

  // 3. Append to log
  await appendToLog(store, fullEvent);

  // 4. Store idempotency key
  if (event.client_event_id) {
    await store.put(`idem:${event.client_event_id}`, seq);
  }

  // 5. Execute operator-specific logic (helix dispatch)
  await executeOperator(store, fullEvent);

  // 6. Recompute fold-computed EVA-active dependents
  await recomputeDependents(store, fullEvent.target);

  // 7. Notify listeners (Zustand store callback replaces Feed)
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
    case 'REC': return handleREC(store, event);
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
async function handleINS(store: EoStore, event: EoEvent): Promise<void> {
  const existing = await checkExists(store, event.target);
  if (existing) {
    throw new Error(`Target already instantiated: ${event.target}`);
  }

  await setState(store, {
    target: event.target,
    value: event.operand ?? {},
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
  await setState(store, {
    target: event.target,
    value: { linked: currentEdges.map(e => e.dest), edge_type: operand.edge_type },
    ...stateFromEvent(event, 'CON'),
  });
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
      ...stateFromEvent(event, 'SYN'),
    });
    if (b !== mergedTarget) {
      await setState(store, {
        target: b,
        value: { _alias: mergedTarget },
        ...stateFromEvent(event, 'SYN'),
      });
    }
  }
}

// --- DEF: Define Value or Register Computation ---
async function handleDEF(store: EoStore, event: EoEvent): Promise<void> {
  const target = await resolveAlias(store, event.target);

  let existing = await getState(store, target);
  if (!existing) {
    existing = {
      target,
      value: {},
      ...stateFromEvent(event, 'INS'),
    };
    await setState(store, existing);
  }

  const merged = mergeOperand(existing.value, event.operand);

  await setState(store, {
    target,
    value: merged,
    ...stateFromEvent(event, 'DEF'),
  });

  if (isFormulaOperand(event.operand)) {
    await registerEvaActive(store, target, event.operand);
  }
}

// --- EVA: Evaluate ---
async function handleEVA(store: EoStore, event: EoEvent): Promise<void> {
  const target = await resolveAlias(store, event.target);

  await setState(store, {
    target,
    value: event.operand,
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
      await recomputeDependents(store, subOp.target);
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

  await setState(store, {
    target: event.target,
    value: {
      recursion: true,
      pivot,
      sub_ops: subOps.length,
      reason: event.operand?.reason,
      result,
    },
    ...stateFromEvent(event, 'REC'),
  });
}

// --- Dependent Recomputation ---

async function recomputeDependents(store: EoStore, changedTarget: string): Promise<void> {
  const reverseEdges = await getEdgesTo(store, changedTarget);

  for (const edge of reverseEdges) {
    const registration = await store.get(`eva:${edge.source}`) as EvaRegistration | null;
    if (!registration) continue;

    if (registration.mode === 'fold') {
      await evaluateFormula(store, registration);
      await recomputeDependents(store, registration.target);
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
