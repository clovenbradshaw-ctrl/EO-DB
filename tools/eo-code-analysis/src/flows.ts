/**
 * Transformation Flow Analysis — How data moves through the system.
 *
 * This is the second layer of analysis. The first layer (mapper.ts) captures
 * static structure — what exists, how it connects. This layer captures
 * the *living pipeline* — how an event enters the system, gets folded into
 * state, read through Horizon, displayed in UI, synced to other devices,
 * and triggers new events.
 *
 * The flow is circular: Event → Fold → State → Horizon → UI → Event.
 * This circularity is itself a REC — the system is a fixed-point iteration
 * over its own state.
 */

import type { AnalysisEvent } from './types.js';

export interface FlowStage {
  id: string;
  name: string;
  description: string;
  /** The code site that implements this stage */
  implementation: {
    file: string;
    function: string;
    line: number;
  };
  /** Which EO operator best describes what this stage does */
  operatorAnalogy: string;
  /** What data enters this stage */
  input: string;
  /** What data leaves this stage */
  output: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  description: string;
  /** sync or async */
  mode: 'sync' | 'async';
}

/**
 * The primary data transformation pipeline.
 * An event's journey from user action to distributed state.
 */
export const PRIMARY_FLOW: FlowStage[] = [
  {
    id: 'compose',
    name: 'Event Composition',
    description: 'User composes an EO event — selects operator, sets target path, fills operand',
    implementation: {
      file: 'github-matrix-dev/app/src/components/ComposeView.tsx',
      function: 'handleSubmit',
      line: 222,
    },
    operatorAnalogy: 'INS — the event itself comes into existence',
    input: 'User intent (operator, target, operand)',
    output: 'EoEventInput (op, target, operand, agent, ts)',
  },
  {
    id: 'dispatch',
    name: 'Store Dispatch',
    description: 'Zustand store receives the event and routes it to the fold engine',
    implementation: {
      file: 'github-matrix-dev/app/src/store/eo-store.ts',
      function: 'dispatch',
      line: 188,
    },
    operatorAnalogy: 'CON — connects UI intent to the fold engine',
    input: 'EoEventInput',
    output: 'seq number (or routed to syncManager)',
  },
  {
    id: 'fold',
    name: 'Fold Processing',
    description: 'The heart — processes the event through the nine-operator switch, updates state',
    implementation: {
      file: 'github-matrix-dev/app/src/db/fold.ts',
      function: 'processEvent',
      line: 51,
    },
    operatorAnalogy: 'DEF — assigns new projected state to the target',
    input: 'EoEventInput + current state',
    output: 'Updated state + side effects (graph edges, EVA registrations, REC)',
  },
  {
    id: 'operator-switch',
    name: 'Operator Dispatch',
    description: 'Switch on op type — each operator has a distinct handler that transforms state differently',
    implementation: {
      file: 'github-matrix-dev/app/src/db/fold.ts',
      function: 'executeOperator',
      line: 223,
    },
    operatorAnalogy: 'SEG — each operator draws a boundary around what kind of change is happening',
    input: 'Event + op type',
    output: 'Handler-specific state mutation',
  },
  {
    id: 'log-append',
    name: 'Log Append',
    description: 'Event appended to immutable log in IndexedDB — source of truth',
    implementation: {
      file: 'github-matrix-dev/app/src/db/idb.ts',
      function: 'appendToLog',
      line: 0,
    },
    operatorAnalogy: 'NUL — the event is observed and recorded, unchanged',
    input: 'EoEvent (with assigned seq)',
    output: 'Persisted log entry',
  },
  {
    id: 'state-project',
    name: 'State Projection',
    description: 'Projected state updated in IndexedDB — mutable, derived from fold',
    implementation: {
      file: 'github-matrix-dev/app/src/db/idb.ts',
      function: 'setState',
      line: 0,
    },
    operatorAnalogy: 'DEF — target given its new value',
    input: 'Previous state + event operand',
    output: 'New EoState (value, hash, last_seq, last_op)',
  },
  {
    id: 'cascade',
    name: 'Dependent Recomputation',
    description: 'EVA-active formulas that depend on changed state are recomputed',
    implementation: {
      file: 'github-matrix-dev/app/src/db/fold.ts',
      function: 'recomputeDependents',
      line: 115,
    },
    operatorAnalogy: 'EVA — rules governing dependent state fire automatically',
    input: 'Changed target + EVA registrations',
    output: 'Cascaded state updates',
  },
  {
    id: 'rec-detect',
    name: 'Cycle Detection',
    description: 'Dependency graph checked for cycles — if found, REC emitted as system event',
    implementation: {
      file: 'github-matrix-dev/app/src/db/fold.ts',
      function: 'detectAndEmitREC',
      line: 118,
    },
    operatorAnalogy: 'REC — the system discovers its own cycles',
    input: 'Dependency graph',
    output: 'REC events (convergence/oscillation result)',
  },
  {
    id: 'horizon',
    name: 'Horizon Read',
    description: 'Six-layer read model computed on demand — figure, grounds, nearby, governance, signals, trajectory',
    implementation: {
      file: 'github-matrix-dev/app/src/db/horizon.ts',
      function: 'horizonGet',
      line: 27,
    },
    operatorAnalogy: 'SIG — surfaces the full picture of what this target means right now',
    input: 'Target path + state store',
    output: 'HorizonResponse (6 layers in parallel)',
  },
  {
    id: 'ui-render',
    name: 'UI Render',
    description: 'React components read state/horizon and render — tables, graphs, records, schema',
    implementation: {
      file: 'github-matrix-dev/app/src/components/TableView.tsx',
      function: 'render',
      line: 0,
    },
    operatorAnalogy: 'NUL — observation: the system looks at its own state',
    input: 'EoState / HorizonResponse',
    output: 'Visual representation (DOM)',
  },
  {
    id: 'sync-send',
    name: 'Matrix Sync (outbound)',
    description: 'Event sent to Matrix room as custom event type — becomes visible to all room members',
    implementation: {
      file: 'github-matrix-dev/app/src/matrix/sync-manager.ts',
      function: 'processLocalEvent',
      line: 488,
    },
    operatorAnalogy: 'CON — connects this device to the distributed state',
    input: 'EoEvent',
    output: 'Matrix room event (com.aminoimmigration.eo.event)',
  },
  {
    id: 'sync-receive',
    name: 'Matrix Sync (inbound)',
    description: 'Events received from other devices — deduplicated, then folded locally',
    implementation: {
      file: 'github-matrix-dev/app/src/matrix/sync-manager.ts',
      function: 'processIncomingEvent',
      line: 535,
    },
    operatorAnalogy: 'SYN — two devices\' states merged into one',
    input: 'Matrix room event',
    output: 'EoEvent → processEvent() → local state update',
  },
];

/**
 * Edges connecting flow stages — the arrows in the transformation pipeline.
 */
export const FLOW_EDGES: FlowEdge[] = [
  { from: 'compose', to: 'dispatch', description: 'User submits event', mode: 'sync' },
  { from: 'dispatch', to: 'fold', description: 'Store routes to fold', mode: 'sync' },
  { from: 'fold', to: 'operator-switch', description: 'Fold delegates to operator handler', mode: 'sync' },
  { from: 'operator-switch', to: 'log-append', description: 'Event persisted to immutable log', mode: 'sync' },
  { from: 'operator-switch', to: 'state-project', description: 'State projected from event', mode: 'sync' },
  { from: 'state-project', to: 'cascade', description: 'Dependents recomputed', mode: 'sync' },
  { from: 'cascade', to: 'rec-detect', description: 'Cycles detected after cascade', mode: 'sync' },
  { from: 'state-project', to: 'horizon', description: 'UI requests current state', mode: 'async' },
  { from: 'horizon', to: 'ui-render', description: 'Horizon feeds UI', mode: 'async' },
  { from: 'ui-render', to: 'compose', description: 'User acts again — the cycle', mode: 'async' },
  { from: 'dispatch', to: 'sync-send', description: 'Event sent to Matrix', mode: 'async' },
  { from: 'sync-receive', to: 'fold', description: 'Remote event enters local fold', mode: 'async' },
  { from: 'sync-send', to: 'sync-receive', description: 'Matrix relays to other devices', mode: 'async' },
];

/**
 * The self-reference cycle: the analysis framework mirrors the thing it analyzes.
 */
export const SELF_REFERENCE_MAPPINGS: Array<{
  analysisOp: string;
  analysisAction: string;
  codeOp: string;
  codeAction: string;
  reflection: string;
}> = [
  {
    analysisOp: 'INS',
    analysisAction: 'Analysis creates entity records for files, functions, components',
    codeOp: 'INS',
    codeAction: 'handleINS() creates records in the database',
    reflection: 'The analysis instantiates descriptions of code that instantiates records',
  },
  {
    analysisOp: 'DEF',
    analysisAction: 'Analysis assigns properties (line count, exports) to each file',
    codeOp: 'DEF',
    codeAction: 'handleDEF() assigns field values to records',
    reflection: 'The analysis defines metrics about code that defines data',
  },
  {
    analysisOp: 'CON',
    analysisAction: 'Analysis maps import edges between modules',
    codeOp: 'CON',
    codeAction: 'handleCON() creates edges in the graph store',
    reflection: 'The analysis connects modules that implement connection logic',
  },
  {
    analysisOp: 'SEG',
    analysisAction: 'Analysis draws layer boundaries (server, browser, components)',
    codeOp: 'SEG',
    codeAction: 'handleSEG() draws boundaries around data regions',
    reflection: 'The analysis segments code that segments data',
  },
  {
    analysisOp: 'SYN',
    analysisAction: 'Analysis identifies server/browser code that is "the same thing"',
    codeOp: 'SYN',
    codeAction: 'handleSYN() merges duplicate records',
    reflection: 'The analysis merges descriptions of code that merges duplicates',
  },
  {
    analysisOp: 'EVA',
    analysisAction: 'Analysis registers governance rules (strict TS, immutable log)',
    codeOp: 'EVA',
    codeAction: 'handleEVA() registers constraint/formula policies',
    reflection: 'The analysis governs code that governs data',
  },
  {
    analysisOp: 'REC',
    analysisAction: 'Analysis detects import cycles in the dependency graph',
    codeOp: 'REC',
    codeAction: 'detectAndEmitREC() finds cycles in the CON graph',
    reflection: 'The analysis finds cycles in code that finds cycles — recursion on recursion',
  },
  {
    analysisOp: 'SIG',
    analysisAction: 'Analysis surfaces complexity hotspots and patterns',
    codeOp: 'SIG',
    codeAction: 'Horizon.detectSignals() surfaces statistical patterns across populations',
    reflection: 'The analysis signals about code that signals about data',
  },
  {
    analysisOp: 'NUL',
    analysisAction: 'Analysis observes simple modules, no action needed',
    codeOp: 'NUL',
    codeAction: 'handleNUL() observes a target, no state change',
    reflection: 'The analysis observes code that observes data — pure observation all the way down',
  },
];

/**
 * Emit flow analysis as EO events.
 */
export function emitFlowEvents(startSeq: number): AnalysisEvent[] {
  const events: AnalysisEvent[] = [];
  let seq = startSeq;
  const ts = new Date().toISOString();

  // Each flow stage is an INS
  for (const stage of PRIMARY_FLOW) {
    seq++;
    events.push({
      seq,
      op: 'INS',
      target: `flow.${stage.id}`,
      operand: {
        kind: 'flow-stage',
        name: stage.name,
        description: stage.description,
        implementation: stage.implementation,
        operatorAnalogy: stage.operatorAnalogy,
        input: stage.input,
        output: stage.output,
      },
      agent: 'eo-code-analysis',
      ts,
      client_event_id: `flow-ins-${stage.id}`,
    });
  }

  // Each flow edge is a CON
  for (const edge of FLOW_EDGES) {
    seq++;
    events.push({
      seq,
      op: 'CON',
      target: `flow.${edge.from}`,
      operand: {
        dest: `flow.${edge.to}`,
        edge_type: `flow-${edge.mode}`,
        description: edge.description,
      },
      agent: 'eo-code-analysis',
      ts,
      client_event_id: `flow-con-${edge.from}-${edge.to}`,
    });
  }

  // The circular flow is a REC
  seq++;
  events.push({
    seq,
    op: 'REC',
    target: 'flow.cycle',
    operand: {
      participants: PRIMARY_FLOW.map(s => `flow.${s.id}`),
      kind: 'transformation-cycle',
      description: 'The system is a fixed-point iteration: Event → Fold → State → Horizon → UI → Event',
      convergence: 'The system converges when user stops acting — otherwise it iterates indefinitely',
    },
    agent: 'eo-code-analysis',
    ts,
    client_event_id: 'flow-rec-cycle',
  });

  // Self-reference mappings as SYN events
  for (const mapping of SELF_REFERENCE_MAPPINGS) {
    seq++;
    events.push({
      seq,
      op: 'SYN',
      target: `meta.self_reference.${mapping.analysisOp}`,
      operand: {
        analysisAction: mapping.analysisAction,
        codeAction: mapping.codeAction,
        reflection: mapping.reflection,
      },
      agent: 'eo-code-analysis',
      ts,
      client_event_id: `meta-syn-${mapping.analysisOp.toLowerCase()}`,
    });
  }

  return events;
}
