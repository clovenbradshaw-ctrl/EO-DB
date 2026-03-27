import type { EoStore } from './encrypted-store';
import { appendToLog } from './log';
import { getState, setState } from './state';
import { addEdge, removeEdge, getEdgesFrom, getEdgesTo } from './graph';
import { resolveAlias, checkExists } from './helpers';
import type { EoEvent, EoEventInput, EoState, EvaRegistration } from './types';

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

// --- INS: Instantiate ---
async function handleINS(store: EoStore, event: EoEvent): Promise<void> {
  const existing = await checkExists(store, event.target);
  if (existing) {
    throw new Error(`Target already instantiated: ${event.target}`);
  }

  await setState(store, {
    target: event.target,
    value: event.operand ?? {},
    last_seq: event.seq,
    last_op: 'INS',
    last_agent: event.agent,
    last_ts: event.ts,
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
    last_seq: event.seq,
    last_op: 'SEG',
    last_agent: event.agent,
    last_ts: event.ts,
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
    last_seq: event.seq,
    last_op: 'CON',
    last_agent: event.agent,
    last_ts: event.ts,
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
      last_seq: event.seq,
      last_op: 'SYN',
      last_agent: event.agent,
      last_ts: event.ts,
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
      last_seq: event.seq,
      last_op: 'SYN',
      last_agent: event.agent,
      last_ts: event.ts,
    });
    if (b !== mergedTarget) {
      await setState(store, {
        target: b,
        value: { _alias: mergedTarget },
        last_seq: event.seq,
        last_op: 'SYN',
        last_agent: event.agent,
        last_ts: event.ts,
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
      last_seq: event.seq,
      last_op: 'INS',
      last_agent: event.agent,
      last_ts: event.ts,
    };
    await setState(store, existing);
  }

  const merged = mergeOperand(existing.value, event.operand);

  await setState(store, {
    target,
    value: merged,
    last_seq: event.seq,
    last_op: 'DEF',
    last_agent: event.agent,
    last_ts: event.ts,
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
    last_seq: event.seq,
    last_op: 'EVA',
    last_agent: event.agent,
    last_ts: event.ts,
  });
}

// --- REC: Recontextualize (Atomic Frame Change) ---
async function handleREC(store: EoStore, event: EoEvent): Promise<void> {
  const subOps = event.operand?.contains || [];

  for (const subOp of subOps) {
    await executeOperator(store, {
      ...subOp,
      seq: event.seq,
      agent: event.agent,
      ts: event.ts,
    });
  }

  await setState(store, {
    target: event.target,
    value: { frame_change: true, sub_ops: subOps.length, reason: event.operand?.reason },
    last_seq: event.seq,
    last_op: 'REC',
    last_agent: event.agent,
    last_ts: event.ts,
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
  await setState(store, {
    target: registration.target,
    value: { ...existing?.value, _computed: result },
    last_seq: existing?.last_seq || 0,
    last_op: existing?.last_op || 'DEF',
    last_agent: 'system:eva',
    last_ts: new Date().toISOString(),
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

export { mergeOperand, isFormulaOperand };
