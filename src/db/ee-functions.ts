/**
 * The three functions of the Experience Engine Horizon.
 *
 * The Horizon is not a data structure. It is a projection: an INS of a query
 * run against G, S, and M from a position within S. Every observation
 * instantiates a projection. There is no unmediated access.
 *
 * π (provenance):    interpretation → chain to raw experience
 * γ (availability):  position → accessible entries and interpretations
 * σ (supersession):  (position, interpretation) → overridable interpretations
 */

import type { EoDb } from './level.js';
import { decode } from './level.js';
import { getState, getStateByPrefix } from './state.js';
import { getEdgesFrom, getEdgesTo } from './graph.js';
import { resolveAlias } from './helpers.js';
import { readLogForTarget } from './log.js';
import type { EoEvent, EoState } from './types.js';
import type {
  LatticePosition,
  Availability,
  SupersessionScope,
  Window,
} from './ee-types.js';
import {
  getInterpretationsForTarget,
  getActiveInterpretations,
  traceProvenance,
} from './meant-graph.js';
import type { Interpretation, ProvenanceChain } from './ee-types.js';
import { isGroupBoundary } from './network-types.js';

// ---------------------------------------------------------------------------
// γ (availability): From this position, what is visible?
// ---------------------------------------------------------------------------

/**
 * Compute the lattice position for an agent at a given anchor.
 *
 * Position emerges from:
 * - The agent's identity
 * - The anchor point in the target path hierarchy
 * - SEG boundaries enclosing the anchor (from innermost to outermost)
 * - CON edges accessible from the anchor and its ancestors
 * - SYN composites the agent participates in
 */
export async function computePosition(
  db: EoDb,
  agent: string,
  anchor: string,
): Promise<LatticePosition> {
  const resolved = await resolveAlias(db, anchor);
  const agentResolved = await resolveAlias(db, agent);

  // Walk ancestry to find enclosing boundaries
  const boundaries: string[] = [];
  const parts = resolved.split('.');
  for (let depth = parts.length; depth >= 1; depth--) {
    const ancestor = parts.slice(0, depth).join('.');
    const state = await getState(db, ancestor);
    if (state?.value?.boundary) {
      boundaries.push(ancestor);
    }
  }

  // Find CON edges accessible from this position
  const connections: string[] = [];
  const edges = await getEdgesFrom(db, resolved);
  for (const edge of edges) {
    connections.push(edge.dest);
  }
  // Also include edges from ancestors (inherited connectivity)
  for (const boundary of boundaries) {
    const ancestorEdges = await getEdgesFrom(db, boundary);
    for (const edge of ancestorEdges) {
      if (!connections.includes(edge.dest)) {
        connections.push(edge.dest);
      }
    }
  }

  // Find SYN composites this agent participates in
  const composites: string[] = [];
  // Check if the agent's identity has been SYN'd with anything
  const agentState = await getState(db, agentResolved);
  if (agentState?.value?._alias) {
    composites.push(agentState.value._alias);
  }

  return {
    agent: agentResolved,
    anchor: resolved,
    boundaries,
    connections,
    composites,
  };
}

/**
 * γ: Compute availability from a position.
 *
 * Rule 4 (Anti-Omniscience): All availability is mediated by position.
 * Rule 5 (Restrictivity): Refinement only restricts. A more specific position
 *   sees a subset, never a superset.
 * Rule 6 (Coherence): Where two positions both see an entry, they agree on existence.
 */
export async function computeAvailability(
  db: EoDb,
  position: LatticePosition,
): Promise<Availability> {
  const visibleEntries: number[] = [];
  const accessibleInterpretations: string[] = [];

  // Visible entries: events at the anchor and its subtree,
  // plus events at connected targets, bounded by enclosing boundaries
  const targetsToScan = [position.anchor, ...position.connections];

  for (const target of targetsToScan) {
    const log = await readLogForTarget(db, target);
    for (const entry of log) {
      visibleEntries.push(entry.seq);
    }
  }

  // Also scan subtree under the anchor
  const subtreeStates = await getStateByPrefix(db, position.anchor);
  for (const state of subtreeStates) {
    const log = await readLogForTarget(db, state.target);
    for (const entry of log) {
      if (!visibleEntries.includes(entry.seq)) {
        visibleEntries.push(entry.seq);
      }
    }
  }

  // Accessible interpretations: meant-graph entries at visible targets
  const seenTargets = new Set<string>();
  seenTargets.add(position.anchor);
  for (const target of targetsToScan) {
    seenTargets.add(target);
  }
  for (const state of subtreeStates) {
    seenTargets.add(state.target);
  }

  for (const target of seenTargets) {
    const interps = await getActiveInterpretations(db, target);
    for (const interp of interps) {
      accessibleInterpretations.push(interp.id);
    }
  }

  return {
    position,
    visible_entries: visibleEntries,
    accessible_interpretations: accessibleInterpretations,
    constraining_boundaries: position.boundaries,
  };
}

// ---------------------------------------------------------------------------
// σ (supersession): From this position, what can be overridden?
// ---------------------------------------------------------------------------

/**
 * σ: Compute supersession scope.
 *
 * Determines which interpretations can be overridden by a given interpretation
 * at a given position. Bounded by:
 * - The position's boundaries (can't supersede outside your boundaries)
 * - The interpretation's provenance (can only supersede what you can ground)
 * - Rule 9 (no interpretation is globally immune — but some are locally immune
 *   based on position)
 */
export async function computeSupersession(
  db: EoDb,
  position: LatticePosition,
  interpretationId: string,
): Promise<SupersessionScope> {
  // Get the interpretation
  const allInterps: Interpretation[] = [];
  const seenTargets = new Set<string>();
  seenTargets.add(position.anchor);
  for (const conn of position.connections) {
    seenTargets.add(conn);
  }

  for (const target of seenTargets) {
    const interps = await getInterpretationsForTarget(db, target);
    allInterps.push(...interps);
  }

  // Can supersede: active interpretations within the position's boundaries
  // that share a target with the current interpretation
  const supersedable: string[] = [];
  const currentlyImmune: string[] = [];

  const sourceInterp = allInterps.find(i => i.id === interpretationId);

  for (const interp of allInterps) {
    if (interp.id === interpretationId) continue;
    if (interp.status !== 'active') continue;

    // Can supersede if: same target, and the position has authority
    if (sourceInterp && interp.target === sourceInterp.target) {
      supersedable.push(interp.id);
    } else {
      // Outside the position's direct target — currently immune at this position
      // But Rule 9: not globally immune
      currentlyImmune.push(interp.id);
    }
  }

  return {
    position,
    interpretation_id: interpretationId,
    supersedable,
    currently_immune: currentlyImmune,
  };
}

// ---------------------------------------------------------------------------
// Windowed reads
// ---------------------------------------------------------------------------

/**
 * Read the Given-Log through a window specification.
 *
 * "Single-entry reads are face-projections. Entity-type claims require a window."
 * The window's grain (SEG), connectivity (CON), and composite structure (SYN)
 * determine what trajectory signatures are recoverable.
 */
export async function windowedRead(
  db: EoDb,
  window: Window,
): Promise<EoEvent[]> {
  const events: EoEvent[] = [];

  // Read events at the grain level
  const log = await readLogForTarget(db, window.grain);

  for (const event of log) {
    // Apply temporal bounds
    if (window.bounds.from && event.ts < window.bounds.from) continue;
    if (window.bounds.to && event.ts > window.bounds.to) continue;

    events.push(event);
  }

  // Include events from scoped targets
  if (window.scope) {
    for (const target of window.scope) {
      const scopedLog = await readLogForTarget(db, target);
      for (const event of scopedLog) {
        if (window.bounds.from && event.ts < window.bounds.from) continue;
        if (window.bounds.to && event.ts > window.bounds.to) continue;
        if (!events.some(e => e.seq === event.seq)) {
          events.push(event);
        }
      }
    }
  }

  // Sort by seq
  events.sort((a, b) => a.seq - b.seq);
  return events;
}
