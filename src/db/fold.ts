import { EoDb, encode, decode, nextSeq } from './level.js';
import { appendToLog } from './log.js';
import { getState, setState } from './state.js';
import { addEdge, removeEdge, getEdgesFrom, getEdgesTo } from './graph.js';
import { resolveAlias, checkExists } from './helpers.js';
import type { EoEvent, EoEventInput, EoState, EvaRegistration } from './types.js';
import type { Feed } from './feed.js';

/**
 * Process a single EO event through the fold.
 * This is the heart of the database — every event flows through here.
 */
export async function processEvent(
  db: EoDb,
  event: EoEventInput,
  feed?: Feed
): Promise<number> {
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

  // 7. Recompute fold-computed EVA-active dependents
  await recomputeDependents(db, fullEvent.target);

  // 8. Notify changefeed
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
    case 'INS': return handleINS(db, event);
    case 'SEG': return handleSEG(db, event);
    case 'CON': return handleCON(db, event);
    case 'SYN': return handleSYN(db, event);
    case 'DEF': return handleDEF(db, event);
    case 'EVA': return handleEVA(db, event);
    case 'REC': return handleREC(db, event);
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
// Inherited: NUL (existence check), SIG (coordinate targeting)
async function handleINS(db: EoDb, event: EoEvent): Promise<void> {
  // NUL capacity: observe keyspace to check for duplicates
  const existing = await checkExists(db, event.target);
  if (existing) {
    throw new Error(`Target already instantiated: ${event.target}`);
  }

  await setState(db, {
    target: event.target,
    value: event.operand ?? {},
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
  await setState(db, {
    target: event.target,
    value: { linked: currentEdges.map(e => e.dest), edge_type: operand.edge_type },
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
    await setState(db, {
      target: mergedTarget,
      value: mergedValue,
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
    await setState(db, {
      target: a,
      value: { _alias: mergedTarget },
      ...stateFromEvent(event, 'SYN'),
    });
    if (b !== mergedTarget) {
      await setState(db, {
        target: b,
        value: { _alias: mergedTarget },
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
      ...stateFromEvent(event, 'INS'),
    };
    await setState(db, existing);
  }

  // DEF's own logic: merge operand into existing state
  const merged = mergeOperand(existing.value, event.operand);

  await setState(db, {
    target,
    value: merged,
    ...stateFromEvent(event, 'DEF'),
  });

  // Check if operand is a formula definition
  if (isFormulaOperand(event.operand)) {
    await registerEvaActive(db, target, event.operand);
  }
}

// --- EVA: Evaluate ---
// Inherited: All eight capacities below. Full 8-step pipeline.
async function handleEVA(db: EoDb, event: EoEvent): Promise<void> {
  // SYN capacity: resolve alias
  const target = await resolveAlias(db, event.target);

  // Write evaluation policy to state
  await setState(db, {
    target,
    value: event.operand,
    ...stateFromEvent(event, 'EVA'),
  });
}

// --- REC: Recontextualize (Atomic Frame Change) ---
// Inherited: Everything. Dispatches sub-operations through the handler hierarchy.
async function handleREC(db: EoDb, event: EoEvent): Promise<void> {
  const subOps = event.operand?.contains || [];

  // Execute each sub-operation using the same event metadata
  // Sub-ops don't get their own seq numbers — they share the REC's seq
  for (const subOp of subOps) {
    await executeOperator(db, {
      ...subOp,
      seq: event.seq,
      agent: event.agent,
      ts: event.ts,
      acquired_ts: event.acquired_ts,
    });
  }

  // Mark the REC event itself in state
  await setState(db, {
    target: event.target,
    value: { frame_change: true, sub_ops: subOps.length, reason: event.operand?.reason },
    ...stateFromEvent(event, 'REC'),
  });
}

// --- Dependent Recomputation ---

async function recomputeDependents(db: EoDb, changedTarget: string): Promise<void> {
  const reverseEdges = await getEdgesTo(db, changedTarget);

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
      await recomputeDependents(db, registration.target);
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
  const existing = await getState(db, registration.target);
  const now = new Date().toISOString();
  await setState(db, {
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

async function registerEvaActive(db: EoDb, target: string, operand: any): Promise<void> {
  const edges = await getEdgesFrom(db, target);
  const dependencies = edges.map(e => e.dest);

  const mode = formulaReferencesExternal(operand.formula) ? 'horizon' : 'fold';

  const registration: EvaRegistration = {
    target,
    formula: operand,
    mode,
    dependencies,
  };

  await db.put(`eva:${target}`, encode(registration));

  if (mode === 'fold') {
    await evaluateFormula(db, registration);
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

/**
 * Deep equality check for no-op detection.
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

export { mergeOperand, isFormulaOperand, deepEqual };
