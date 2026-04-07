/**
 * Operator Implementation Map — Where each of the nine operators lives in code.
 *
 * This is the third layer: the code doesn't just *use* the nine operators,
 * it *is* the nine operators. Each operator has a handler in the fold,
 * storage in IndexedDB, a read path through Horizon, and a UI surface.
 *
 * The map traces each operator through four strata:
 *   1. Definition  — where the operator is defined as a type
 *   2. Write path  — where the operator mutates state (fold handler)
 *   3. Read path   — where the operator's effects are read (Horizon layer)
 *   4. UI surface  — where the operator's results are displayed
 */

import type { AnalysisEvent } from './types.js';

export interface OperatorImplementation {
  op: string;
  name: string;
  semantics: string;
  /** Where the operator type is defined */
  definition: CodeSite;
  /** Server-side fold handler */
  serverHandler: CodeSite;
  /** Browser-side fold handler */
  browserHandler: CodeSite;
  /** Storage affected */
  storage: string[];
  /** Horizon layer that reads this operator's effects */
  horizonLayer: string;
  /** UI components that surface this operator */
  uiSurfaces: string[];
  /** How this operator connects to the others — the inheritance chain */
  inherits: string[];
}

interface CodeSite {
  file: string;
  function: string;
  line: number;
}

export const OPERATOR_MAP: OperatorImplementation[] = [
  {
    op: 'NUL',
    name: 'Observation',
    semantics: 'Something is encountered and recorded, but nothing changes. Pure witness.',
    definition: { file: 'src/db/types.ts', function: "type Operator = 'NUL' | ...", line: 2 },
    serverHandler: { file: 'src/db/fold.ts', function: 'handleNUL', line: 374 },
    browserHandler: { file: 'github-matrix-dev/app/src/db/fold.ts', function: '(inline no-op)', line: 231 },
    storage: ['log'],
    horizonLayer: 'Trajectory — NUL appears in the operation history',
    uiSurfaces: ['LogView — raw event browser', 'TimeScrubber — replay includes NUL events'],
    inherits: [],
  },
  {
    op: 'SIG',
    name: 'Signal',
    semantics: 'Ephemeral attention directed. Not persisted to log — exists only in memory.',
    definition: { file: 'src/db/types.ts', function: "type Operator = ... | 'SIG' | ...", line: 2 },
    serverHandler: { file: 'src/db/fold.ts', function: 'SIG handling in processEvent', line: 63 },
    browserHandler: { file: 'github-matrix-dev/app/src/db/fold.ts', function: 'SIG handling', line: 63 },
    storage: ['(none — ephemeral, in-memory only)'],
    horizonLayer: 'Signals — statistical patterns detected across populations',
    uiSurfaces: ['HeadlineMetrics — cadence indicators', 'Horizon — signals layer'],
    inherits: [],
  },
  {
    op: 'INS',
    name: 'Instantiation',
    semantics: 'Something comes into existence. Creates the target. Level 1 = human, 2+ = system-discovered.',
    definition: { file: 'src/db/types.ts', function: "type Operator = ... | 'INS' | ...", line: 2 },
    serverHandler: { file: 'src/db/fold.ts', function: 'handleINS', line: 381 },
    browserHandler: { file: 'github-matrix-dev/app/src/db/fold.ts', function: 'handleINS', line: 251 },
    storage: ['log', 'state'],
    horizonLayer: 'Figure — the projected state of the instantiated entity',
    uiSurfaces: ['TableView — record rows', 'RecordView — single record', 'ComposeView — create new'],
    inherits: ['NUL'],
  },
  {
    op: 'SEG',
    name: 'Segmentation',
    semantics: 'A boundary is drawn. Spatial/temporal containment. Defines regions and ambient conditions.',
    definition: { file: 'src/db/types.ts', function: "type Operator = ... | 'SEG' | ...", line: 2 },
    serverHandler: { file: 'src/db/fold.ts', function: 'handleSEG', line: 399 },
    browserHandler: { file: 'github-matrix-dev/app/src/db/fold.ts', function: 'handleSEG', line: 271 },
    storage: ['log', 'state'],
    horizonLayer: 'Grounds — ambient conditions inherited from ancestor SEG boundaries',
    uiSurfaces: ['Horizon — grounds layer', 'ScopePicker — boundary navigation'],
    inherits: ['INS'],
  },
  {
    op: 'CON',
    name: 'Connection',
    semantics: 'Two things are linked. Directed graph edge. Can connect or disconnect.',
    definition: { file: 'src/db/types.ts', function: "type Operator = ... | 'CON' | ...", line: 2 },
    serverHandler: { file: 'src/db/fold.ts', function: 'handleCON', line: 417 },
    browserHandler: { file: 'github-matrix-dev/app/src/db/fold.ts', function: 'handleCON', line: 286 },
    storage: ['log', 'state', 'graph_fwd', 'graph_rev'],
    horizonLayer: 'Nearby — structural twins connected by shared edges',
    uiSurfaces: ['GraphView — force-directed CON visualization', 'RecordView — relationships tab'],
    inherits: ['INS', 'SEG'],
  },
  {
    op: 'SYN',
    name: 'Synthesis',
    semantics: 'Two things are the same. Deduplication. Merges source into target.',
    definition: { file: 'src/db/types.ts', function: "type Operator = ... | 'SYN' | ...", line: 2 },
    serverHandler: { file: 'src/db/fold.ts', function: 'handleSYN', line: 467 },
    browserHandler: { file: 'github-matrix-dev/app/src/db/fold.ts', function: 'handleSYN', line: 335 },
    storage: ['log', 'state', 'graph_fwd', 'graph_rev'],
    horizonLayer: 'Figure — merged state reflects synthesized value',
    uiSurfaces: ['ComposeView — merge records', 'RecordView — merge history'],
    inherits: ['CON', 'SEG', 'INS'],
  },
  {
    op: 'DEF',
    name: 'Definition',
    semantics: 'Something is given a value. The workhorse — most data entry is DEF. Auto-instantiates if needed.',
    definition: { file: 'src/db/types.ts', function: "type Operator = ... | 'DEF' | ...", line: 2 },
    serverHandler: { file: 'src/db/fold.ts', function: 'handleDEF', line: 535 },
    browserHandler: { file: 'github-matrix-dev/app/src/db/fold.ts', function: 'handleDEF', line: 399 },
    storage: ['log', 'state', 'eva (if formula)'],
    horizonLayer: 'Figure — the projected value from accumulated DEFs',
    uiSurfaces: ['TableView — cell values', 'RecordView — field editor', 'SchemaView — field definitions'],
    inherits: ['SYN', 'SEG', 'INS', 'CON'],
  },
  {
    op: 'EVA',
    name: 'Evaluation',
    semantics: 'A rule governs. Registers constraints, validation policies, resolution strategies.',
    definition: { file: 'src/db/types.ts', function: "type Operator = ... | 'EVA' | ...", line: 2 },
    serverHandler: { file: 'src/db/fold.ts', function: 'handleEVA', line: 583 },
    browserHandler: { file: 'github-matrix-dev/app/src/db/fold.ts', function: 'handleEVA', line: 448 },
    storage: ['log', 'state', 'eva'],
    horizonLayer: 'Governance — EVA policies that apply to this target and region',
    uiSurfaces: ['Governance — policy editor', 'ConstraintComposer — rule builder', 'FieldPermissions'],
    inherits: ['DEF', 'SYN', 'SEG', 'INS', 'CON', 'NUL', 'SIG'],
  },
  {
    op: 'REC',
    name: 'Recursion',
    semantics: 'Fixed-point iteration. System-generated when dependency cycles detected. Converges or oscillates.',
    definition: { file: 'src/db/types.ts', function: "type Operator = ... | 'REC'", line: 2 },
    serverHandler: { file: 'src/db/fold.ts', function: 'detectAndEmitREC / handleREC', line: 118 },
    browserHandler: { file: 'github-matrix-dev/app/src/db/fold.ts', function: 'detectAndEmitREC / handleREC', line: 608 },
    storage: ['log', 'state'],
    horizonLayer: 'recCycle — cycle participants, convergence result',
    uiSurfaces: ['Horizon — REC cycle visualization', 'GraphView — cycle highlighting'],
    inherits: ['(system-generated, cannot be submitted externally)'],
  },
];

/**
 * The operator inheritance lattice.
 * Each operator inherits all capabilities of the operators below it.
 *
 * ```
 *        EVA (governs — inherits all 8)
 *         |
 *        DEF (defines — inherits SYN+SEG+INS+CON)
 *        /|\
 *       / | \
 *     SYN CON SEG (merge, connect, segment — each inherits INS)
 *       \ | /
 *        INS (instantiate — inherits NUL)
 *         |
 *        NUL (observe — base)
 *
 *     SIG (signal — ephemeral, outside the persistence lattice)
 *     REC (recursion — system-generated, outside the submission lattice)
 * ```
 */
export const INHERITANCE_LATTICE = {
  layers: [
    { level: 0, ops: ['NUL'], label: 'Observation (base)' },
    { level: 0, ops: ['SIG'], label: 'Signal (ephemeral, outside persistence)' },
    { level: 1, ops: ['INS'], label: 'Instantiation (inherits NUL)' },
    { level: 2, ops: ['SEG', 'CON', 'SYN'], label: 'Structure (each inherits INS)' },
    { level: 3, ops: ['DEF'], label: 'Definition (inherits SYN+SEG+INS+CON)' },
    { level: 4, ops: ['EVA'], label: 'Governance (inherits all 8 capacities)' },
    { level: -1, ops: ['REC'], label: 'Recursion (system-generated, outside submission)' },
  ],
  description: 'Each operator can do everything the operators below it can do. ' +
    'DEF can instantiate (INS), draw boundaries (SEG), connect (CON), and merge (SYN). ' +
    'EVA can do all of that plus govern. This is why DEF is the workhorse — it auto-instantiates.',
};

/**
 * Emit operator map as EO events.
 */
export function emitOperatorMapEvents(startSeq: number): AnalysisEvent[] {
  const events: AnalysisEvent[] = [];
  let seq = startSeq;
  const ts = new Date().toISOString();

  for (const impl of OPERATOR_MAP) {
    // The operator implementation itself — DEF (assigning properties)
    seq++;
    events.push({
      seq,
      op: 'DEF',
      target: `operator.${impl.op}`,
      operand: {
        name: impl.name,
        semantics: impl.semantics,
        serverHandler: impl.serverHandler,
        browserHandler: impl.browserHandler,
        storage: impl.storage,
        horizonLayer: impl.horizonLayer,
        uiSurfaces: impl.uiSurfaces,
        inherits: impl.inherits,
      },
      agent: 'eo-code-analysis',
      ts,
      client_event_id: `opmap-def-${impl.op.toLowerCase()}`,
    });

    // CON: server handler → browser handler (the SYN between implementations)
    seq++;
    events.push({
      seq,
      op: 'CON',
      target: `operator.${impl.op}.server`,
      operand: {
        dest: `operator.${impl.op}.browser`,
        edge_type: 'implements-same-semantics',
        serverSite: impl.serverHandler,
        browserSite: impl.browserHandler,
      },
      agent: 'eo-code-analysis',
      ts,
      client_event_id: `opmap-con-${impl.op.toLowerCase()}`,
    });
  }

  // The inheritance lattice as a SEG
  seq++;
  events.push({
    seq,
    op: 'SEG',
    target: 'operator.lattice',
    operand: INHERITANCE_LATTICE,
    agent: 'eo-code-analysis',
    ts,
    client_event_id: 'opmap-seg-lattice',
  });

  return events;
}
