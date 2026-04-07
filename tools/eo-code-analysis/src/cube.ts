/**
 * The Capacity Cube — The Three-Dimensional Structure Behind the Nine Operators.
 *
 * The nine operators are NOT a flat list. They are one FACE of a 3D structure.
 *
 * Three axes: Mode × Domain × Object
 * 27 cells = the capacity ground (product category)
 * Three faces (projection functors):
 *   Act        = Mode × Domain    → the 9 operators (what transformation happens)
 *   Site       = Mode × Object    → the 9 observation positions (where you look)
 *   Resolution = Domain × Object  → the 9 conflict strategies (how it resolves)
 *
 * The operators are the most visible face because the fold implements them directly.
 * But Site (Horizon) and Resolution (EVA governance) are equally fundamental —
 * they're the other two faces of the same cube.
 *
 * Reference: about.md §10 — "The three axes are a product category — Mode × Domain × Object.
 * The 27-cell capacity ground is the product. The faces (Act, Site, Resolution)
 * are projection functors from the product to a two-axis subcategory."
 */

import type { AnalysisEvent } from './types.js';

// ─── The Three Axes ──────────────────────────────────────────────────────────

/**
 * Mode — HOW the transformation acts.
 * The progression within each triad of the operator helix.
 */
export const MODE_AXIS = {
  name: 'Mode',
  description: 'How the transformation acts — the progression within each operator triad',
  values: [
    {
      id: 'encounter',
      name: 'Encounter',
      description: 'Passive reception — the system meets something and registers it',
      operators: ['NUL', 'SEG', 'DEF'],
    },
    {
      id: 'direct',
      name: 'Direct',
      description: 'Active routing — the system directs attention or establishes relationship',
      operators: ['SIG', 'CON', 'EVA'],
    },
    {
      id: 'complete',
      name: 'Complete',
      description: 'Reflexive closure — the system resolves to a stable identity',
      operators: ['INS', 'SYN', 'REC'],
    },
  ],
} as const;

/**
 * Domain — WHAT domain the transformation operates on.
 * The three triads of the operator helix.
 */
export const DOMAIN_AXIS = {
  name: 'Domain',
  description: 'What domain the transformation addresses — the three triads of the helix',
  values: [
    {
      id: 'existence',
      name: 'Existence',
      description: 'Does the thing exist? Ontological threshold. Pre-INS is ephemeral, post-INS endures.',
      operators: ['NUL', 'SIG', 'INS'],
    },
    {
      id: 'structure',
      name: 'Structure',
      description: 'How things relate. Boundaries, connections, merges. Topology without content.',
      operators: ['SEG', 'CON', 'SYN'],
    },
    {
      id: 'value',
      name: 'Value',
      description: 'What things mean. Content, rules, recursion. Semantics within structure.',
      operators: ['DEF', 'EVA', 'REC'],
    },
  ],
} as const;

/**
 * Object — WHERE/WHO the transformation is observed from.
 * The third axis that produces Site and Resolution when crossed with Mode and Domain.
 */
export const OBJECT_AXIS = {
  name: 'Object',
  description: 'The position of the observer — who/where the transformation is experienced from',
  values: [
    {
      id: 'self',
      name: 'Self',
      description: 'The entity looking at itself. Figure state. Local resolution.',
    },
    {
      id: 'container',
      name: 'Container',
      description: 'The parent/boundary looking down. Grounds. Inherited resolution.',
    },
    {
      id: 'peer',
      name: 'Peer',
      description: 'Siblings/neighbors looking across. Nearby. Negotiated resolution.',
    },
  ],
} as const;

// ─── Face 1: Act (Mode × Domain) — The Nine Operators ───────────────────────

/**
 * The Act face — what transformation happens.
 * This is the face the fold implements directly.
 *
 *                 Existence    Structure    Value
 *   Encounter:    NUL          SEG          DEF
 *   Direct:       SIG          CON          EVA
 *   Complete:     INS          SYN          REC
 */
export const ACT_FACE = {
  name: 'Act',
  axes: ['Mode', 'Domain'],
  description: 'What transformation happens — the 9 operators. Implemented by the fold.',
  cells: [
    // Row 1: Encounter
    { mode: 'encounter', domain: 'existence', op: 'NUL', label: 'Observe', impl: 'fold.ts — handleNUL: no state change, identity' },
    { mode: 'encounter', domain: 'structure', op: 'SEG', label: 'Boundary', impl: 'fold.ts — handleSEG: draw partition boundary' },
    { mode: 'encounter', domain: 'value',     op: 'DEF', label: 'Define',   impl: 'fold.ts — handleDEF: assign value, register formula' },
    // Row 2: Direct
    { mode: 'direct', domain: 'existence', op: 'SIG', label: 'Signal',   impl: 'fold.ts — SIG: ephemeral attention, in-memory only' },
    { mode: 'direct', domain: 'structure', op: 'CON', label: 'Connect',  impl: 'fold.ts — handleCON: bidirectional graph edges' },
    { mode: 'direct', domain: 'value',     op: 'EVA', label: 'Govern',   impl: 'fold.ts — handleEVA: register constraint/policy' },
    // Row 3: Complete
    { mode: 'complete', domain: 'existence', op: 'INS', label: 'Create',  impl: 'fold.ts — handleINS: mint identity, anchor' },
    { mode: 'complete', domain: 'structure', op: 'SYN', label: 'Merge',   impl: 'fold.ts — handleSYN: alias + edge merge' },
    { mode: 'complete', domain: 'value',     op: 'REC', label: 'Recurse', impl: 'fold.ts — handleREC: iterate to fixed point' },
  ],
} as const;

// ─── Face 2: Site (Mode × Object) — The Nine Observation Positions ───────────

/**
 * The Site face — where/how you observe the entity.
 * This is what the Horizon implements: each cell is a different
 * perspective on the same target.
 *
 *                 Self              Container         Peer
 *   Encounter:    Figure            Grounds           Nearby
 *   Direct:       Trajectory        Ancestry          Governance
 *   Complete:     Anchor/Hash       Signals           Graph Metrics
 */
export const SITE_FACE = {
  name: 'Site',
  axes: ['Mode', 'Object'],
  description: 'Where you look from — the 9 observation positions. Implemented by Horizon.',
  cells: [
    // Row 1: Encounter × Object — passive observation from each position
    {
      mode: 'encounter', object: 'self',
      label: 'Figure',
      description: 'The entity as it sees itself — projected state, fields as columns',
      impl: 'horizon.ts — getFigureState(): current value + EVA formula evaluation',
    },
    {
      mode: 'encounter', object: 'container',
      label: 'Grounds',
      description: 'What the container pervades — ambient conditions inherited from ancestor SEGs',
      impl: 'horizon.ts — getGrounds(): walk prefix chain, collect inherited fields',
    },
    {
      mode: 'encounter', object: 'peer',
      label: 'Nearby',
      description: 'What peers share — sibling records with common traits and edges',
      impl: 'horizon.ts — getNearby(): find siblings with shared field signatures',
    },
    // Row 2: Direct × Object — active routing from each position
    {
      mode: 'direct', object: 'self',
      label: 'Trajectory',
      description: 'The entity\'s own history — sequence of operators that built this state',
      impl: 'horizon.ts — getTrajectory(): operation sequence with running hash chain',
    },
    {
      mode: 'direct', object: 'container',
      label: 'Ancestry',
      description: 'The chain of containers — parent figures up to root, with sibling counts',
      impl: 'horizon.ts — getAncestry(): walk ontology chain, mini-Horizon per ancestor',
    },
    {
      mode: 'direct', object: 'peer',
      label: 'Governance',
      description: 'What rules apply from peers — EVA policies that govern this region',
      impl: 'horizon.ts — getGovernance(): EVA registrations in scope (direct, collection, ancestor)',
    },
    // Row 3: Complete × Object — resolved identity from each position
    {
      mode: 'complete', object: 'self',
      label: 'Anchor / Hash',
      description: 'The entity\'s stable identity — content-addressed hash, transformation fingerprint',
      impl: 'fold.ts — seedHash/chainHash: the hash IS the identity',
    },
    {
      mode: 'complete', object: 'container',
      label: 'Signals',
      description: 'Statistical patterns from the container population — outliers, distributions',
      impl: 'horizon.ts — detectSignals(): on-demand, expensive population analysis',
    },
    {
      mode: 'complete', object: 'peer',
      label: 'Graph Metrics',
      description: 'The entity\'s structural role among peers — hub, bridge, leaf, degree',
      impl: 'horizon.ts — graphMetrics: CON graph role and in/out degree',
    },
  ],
} as const;

// ─── Face 3: Resolution (Domain × Object) — The Nine Conflict Strategies ─────

/**
 * The Resolution face — how conflicts resolve.
 * This is what EVA governance and the merge pipeline implement.
 * When the same target receives competing transformations,
 * resolution depends on the domain and the observer position.
 *
 *                 Self                Container           Peer
 *   Existence:    Last-write-wins     Inherit existence   Consensus existence
 *   Structure:    Merge edges         Partition cascade   Negotiate topology
 *   Value:        Override locally    Cascade from above  Reconcile across
 */
export const RESOLUTION_FACE = {
  name: 'Resolution',
  axes: ['Domain', 'Object'],
  description: 'How conflicts resolve — the 9 resolution strategies. Implemented by EVA + sync.',
  cells: [
    // Row 1: Existence × Object — how existence conflicts resolve
    {
      domain: 'existence', object: 'self',
      label: 'Last-Write Identity',
      description: 'Self determines own existence — idempotent INS, client_event_id dedup',
      impl: 'fold.ts — idem key check: duplicate INS rejected by content hash',
    },
    {
      domain: 'existence', object: 'container',
      label: 'Inherited Existence',
      description: 'Container controls child existence — SEG boundary inclusion/exclusion',
      impl: 'fold.ts — checkBoundary(): parent SEG determines if child is active',
    },
    {
      domain: 'existence', object: 'peer',
      label: 'Consensus Existence',
      description: 'Peers converge on existence — Matrix timeline ordering resolves concurrent INS',
      impl: 'sync-manager.ts — processIncomingEvent: Matrix server determines event ordering',
    },
    // Row 2: Structure × Object — how structural conflicts resolve
    {
      domain: 'structure', object: 'self',
      label: 'Merge Locally',
      description: 'Self merges own edges — SYN alias + CON edge merge in one atomic operation',
      impl: 'fold.ts — handleSYN: atomically alias + merge edges + recompute dependents',
    },
    {
      domain: 'structure', object: 'container',
      label: 'Partition Cascade',
      description: 'Container restructures children — SEG boundary propagates down, edges respect partitions',
      impl: 'fold.ts — handleSEG: partition metadata cascades to contained targets',
    },
    {
      domain: 'structure', object: 'peer',
      label: 'Negotiate Topology',
      description: 'Peers negotiate shared edges — concurrent CON events merge via append-only graph',
      impl: 'fold.ts — addEdge: CON graph is append-only, concurrent edges coexist',
    },
    // Row 3: Value × Object — how value conflicts resolve
    {
      domain: 'value', object: 'self',
      label: 'Local Override',
      description: 'Self resolves own value — EVA policy: latest, priority, manual, formula',
      impl: 'fold.ts — handleDEF: conflict operand preserved, EVA policy determines Horizon display',
    },
    {
      domain: 'value', object: 'container',
      label: 'Cascade from Above',
      description: 'Container pushes value down — EVA recomputation cascade through dependency graph',
      impl: 'fold.ts — recomputeDependents: upstream DEF triggers downstream formula chain',
    },
    {
      domain: 'value', object: 'peer',
      label: 'Reconcile Across',
      description: 'Peers reconcile competing values — REC fixed-point iteration until convergence or oscillation',
      impl: 'fold.ts — handleREC: iterate contained ops until state stabilizes',
    },
  ],
} as const;

// ─── The Full Cube ───────────────────────────────────────────────────────────

/**
 * The complete 27-cell capacity ground.
 * Each cell is a Mode × Domain × Object triple.
 */
export interface CubeCell {
  mode: string;
  domain: string;
  object: string;
  /** Which face this cell appears on and what it maps to */
  act: string;         // the operator (Act face projection)
  site: string;        // the observation position (Site face projection)
  resolution: string;  // the conflict strategy (Resolution face projection)
}

export function buildFullCube(): CubeCell[] {
  const cells: CubeCell[] = [];

  const actLookup = new Map(ACT_FACE.cells.map(c => [`${c.mode}:${c.domain}`, c.op]));
  const siteLookup = new Map(SITE_FACE.cells.map(c => [`${c.mode}:${c.object}`, c.label]));
  const resLookup = new Map(RESOLUTION_FACE.cells.map(c => [`${c.domain}:${c.object}`, c.label]));

  for (const mode of MODE_AXIS.values) {
    for (const domain of DOMAIN_AXIS.values) {
      for (const object of OBJECT_AXIS.values) {
        cells.push({
          mode: mode.id,
          domain: domain.id,
          object: object.id,
          act: actLookup.get(`${mode.id}:${domain.id}`) || '?',
          site: siteLookup.get(`${mode.id}:${object.id}`) || '?',
          resolution: resLookup.get(`${domain.id}:${object.id}`) || '?',
        });
      }
    }
  }

  return cells;
}

// ─── Emit cube events ────────────────────────────────────────────────────────

export function emitCubeEvents(startSeq: number): AnalysisEvent[] {
  const events: AnalysisEvent[] = [];
  let seq = startSeq;
  const ts = new Date().toISOString();

  // SEG: The cube itself as a boundary structure
  seq++;
  events.push({
    seq, op: 'SEG',
    target: 'cube',
    operand: {
      name: 'Capacity Cube',
      description: 'Mode × Domain × Object = 27 cells. Three faces: Act, Site, Resolution.',
      axes: [MODE_AXIS, DOMAIN_AXIS, OBJECT_AXIS],
    },
    agent: 'eo-code-analysis', ts,
    client_event_id: 'cube-seg-root',
  });

  // DEF: Each face as a value assignment
  for (const face of [ACT_FACE, SITE_FACE, RESOLUTION_FACE]) {
    seq++;
    events.push({
      seq, op: 'DEF',
      target: `cube.face.${face.name.toLowerCase()}`,
      operand: {
        name: face.name,
        axes: face.axes,
        description: face.description,
        cells: face.cells,
      },
      agent: 'eo-code-analysis', ts,
      client_event_id: `cube-def-${face.name.toLowerCase()}`,
    });
  }

  // CON: Each face connects to the others through shared axes
  const faceConnections = [
    { from: 'act', to: 'site', shared: 'Mode', description: 'Act and Site share the Mode axis' },
    { from: 'act', to: 'resolution', shared: 'Domain', description: 'Act and Resolution share the Domain axis' },
    { from: 'site', to: 'resolution', shared: 'Object', description: 'Site and Resolution share the Object axis' },
  ];
  for (const conn of faceConnections) {
    seq++;
    events.push({
      seq, op: 'CON',
      target: `cube.face.${conn.from}`,
      operand: {
        dest: `cube.face.${conn.to}`,
        edge_type: 'shared-axis',
        shared_axis: conn.shared,
        description: conn.description,
      },
      agent: 'eo-code-analysis', ts,
      client_event_id: `cube-con-${conn.from}-${conn.to}`,
    });
  }

  // INS: Each of the 27 cells
  const cube = buildFullCube();
  for (const cell of cube) {
    seq++;
    events.push({
      seq, op: 'INS',
      target: `cube.cell.${cell.mode}.${cell.domain}.${cell.object}`,
      operand: {
        mode: cell.mode,
        domain: cell.domain,
        object: cell.object,
        act: cell.act,
        site: cell.site,
        resolution: cell.resolution,
      },
      agent: 'eo-code-analysis', ts,
      client_event_id: `cube-ins-${cell.mode}-${cell.domain}-${cell.object}`,
    });
  }

  return events;
}
