/**
 * Meant-Graph (M) — the mutable space of interpretations.
 *
 * Every interpretation carries:
 *   - A link to Given-Log entries it is grounded in (via π)
 *   - A position in the Structure-Lattice from which it was produced
 *   - A window specification — grain and bounds of the read that produced it
 *   - Content — what the interpretation asserts
 *   - Supersession relationships to other interpretations
 *
 * Unlike the Given-Log, the Meant-Graph CAN be restructured.
 * Interpretations can be added, superseded, recontextualized, and retired.
 * The provenance chain must remain intact for audit (Rule 7).
 *
 * Storage keyspace: meant:<target>:<id>
 * Index keyspace:   meant_idx:seq:<seq>:<id>   (provenance reverse index)
 *                   meant_idx:super:<id>:<by>   (supersession index)
 */

import { EoDb, encode, decode } from './level.js';
import type { EoEvent } from './types.js';
import type { Interpretation, Window, ProvenanceChain } from './ee-types.js';
import { v4 as uuid } from 'uuid';

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

/**
 * Assert a new interpretation into the Meant-Graph.
 * Returns the interpretation ID.
 */
export async function assertInterpretation(
  db: EoDb,
  interp: Omit<Interpretation, 'id' | 'status' | 'superseded_by'>,
): Promise<string> {
  const id = uuid();
  const full: Interpretation = {
    ...interp,
    id,
    status: 'active',
    superseded_by: [],
  };

  // Store interpretation
  await db.put(`meant:${interp.target}:${id}`, encode(full));

  // Index by grounded_in seqs for provenance lookups
  for (const seq of interp.grounded_in) {
    await db.put(`meant_idx:seq:${String(seq).padStart(12, '0')}:${id}`, encode(id));
  }

  // Index supersession relationships
  for (const supersededId of interp.supersedes) {
    await db.put(`meant_idx:super:${supersededId}:${id}`, encode(id));

    // Update the superseded interpretation's superseded_by list
    const superseded = await getInterpretation(db, interp.target, supersededId);
    if (superseded) {
      superseded.superseded_by.push(id);
      if (superseded.status === 'active') {
        superseded.status = 'superseded';
      }
      await db.put(`meant:${superseded.target}:${supersededId}`, encode(superseded));
    }
  }

  return id;
}

/**
 * Get a single interpretation by target and ID.
 */
export async function getInterpretation(
  db: EoDb,
  target: string,
  id: string,
): Promise<Interpretation | null> {
  try {
    const buf = await db.get(`meant:${target}:${id}`);
    return decode(buf) as Interpretation;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

/**
 * Find an interpretation by ID across all targets.
 * Slower — scans the meant: keyspace. Use getInterpretation when target is known.
 */
export async function findInterpretation(
  db: EoDb,
  id: string,
): Promise<Interpretation | null> {
  for await (const [, value] of db.iterator({
    gte: 'meant:',
    lte: 'meant:\xff',
  })) {
    const interp = decode(value) as Interpretation;
    if (interp.id === id) return interp;
  }
  return null;
}

/**
 * Get all interpretations for a target.
 */
export async function getInterpretationsForTarget(
  db: EoDb,
  target: string,
): Promise<Interpretation[]> {
  const results: Interpretation[] = [];
  const prefix = `meant:${target}:`;

  for await (const [, value] of db.iterator({
    gte: prefix,
    lte: `${prefix}\xff`,
  })) {
    results.push(decode(value) as Interpretation);
  }
  return results;
}

/**
 * Get active interpretations for a target (not superseded or retired).
 */
export async function getActiveInterpretations(
  db: EoDb,
  target: string,
): Promise<Interpretation[]> {
  const all = await getInterpretationsForTarget(db, target);
  return all.filter(i => i.status === 'active');
}

/**
 * Supersede an interpretation.
 * The superseded interpretation's status changes to 'superseded'.
 * The provenance chain remains intact (Rule 7).
 */
export async function supersedeInterpretation(
  db: EoDb,
  target: string,
  existingId: string,
  newId: string,
): Promise<void> {
  const existing = await getInterpretation(db, target, existingId);
  if (!existing) return;

  existing.superseded_by.push(newId);
  existing.status = 'superseded';
  await db.put(`meant:${target}:${existingId}`, encode(existing));

  // Index the supersession
  await db.put(`meant_idx:super:${existingId}:${newId}`, encode(newId));
}

/**
 * Retire an interpretation. It is no longer active but remains for audit.
 * Provenance chain is preserved (Rule 7).
 */
export async function retireInterpretation(
  db: EoDb,
  target: string,
  id: string,
): Promise<void> {
  const interp = await getInterpretation(db, target, id);
  if (!interp) return;

  interp.status = 'retired';
  await db.put(`meant:${target}:${id}`, encode(interp));
}

// ---------------------------------------------------------------------------
// Interpretation creation from fold events
// ---------------------------------------------------------------------------

/**
 * Create an interpretation from a DEF/EVA/REC event.
 * This bridges the fold (which processes events) to the Meant-Graph
 * (which stores interpretations).
 *
 * The fold continues to write to state: as before (backwards compatible).
 * This function additionally writes the interpretation to meant: keyspace,
 * preserving the Given/Meant distinction the spec requires.
 */
export async function interpretationFromEvent(
  db: EoDb,
  event: EoEvent,
  groundingSeqs?: number[],
): Promise<string | null> {
  // Only Significance triad operators produce interpretations
  if (event.op !== 'DEF' && event.op !== 'EVA' && event.op !== 'REC') {
    return null;
  }

  const grounding = groundingSeqs ?? [event.seq];

  const window: Window = {
    grain: event.target.split('.').slice(0, -1).join('.') || event.target,
    bounds: { from: event.ts, to: event.ts },
    position: event.agent,
  };

  // Supersession: same operator type on the same target supersedes prior.
  // DEF supersedes prior DEF (new value replaces old value).
  // EVA supersedes prior EVA (new policy replaces old policy).
  // REC supersedes prior REC (new fixed-point replaces old).
  const existing = await getActiveInterpretations(db, event.target);
  const supersedes = existing
    .filter(i => i.op === event.op)
    .map(i => i.id);

  return assertInterpretation(db, {
    target: event.target,
    op: event.op as 'DEF' | 'EVA' | 'REC',
    content: event.operand,
    grounded_in: grounding,
    position: event.agent,
    window,
    supersedes,
    agent: event.agent,
    ts: event.ts,
  });
}

// ---------------------------------------------------------------------------
// Provenance (π)
// ---------------------------------------------------------------------------

/**
 * π: Trace an interpretation back to its grounding in raw experience.
 *
 * Walks the provenance chain: interpretation → grounded_in seqs → entries.
 * If grounded_in includes other interpretations (via their seqs), follows
 * those chains recursively until reaching Given-Log entries.
 */
export async function traceProvenance(
  db: EoDb,
  target: string,
  interpretationId: string,
): Promise<ProvenanceChain> {
  const interp = await getInterpretation(db, target, interpretationId);
  if (!interp) {
    return {
      interpretation_id: interpretationId,
      direct_grounds: [],
      intermediates: [],
      terminal_grounds: [],
      complete: false,
    };
  }

  const directGrounds = interp.grounded_in;
  const intermediates: string[] = [];
  const terminalGrounds = new Set<number>();
  const visited = new Set<string>();

  // Check if any grounding seqs are themselves interpretations
  // (they would be events whose op is DEF/EVA/REC)
  async function walk(seqs: number[]): Promise<void> {
    for (const seq of seqs) {
      // Read the event at this seq
      try {
        const buf = await db.get(`log:${String(seq).padStart(12, '0')}`);
        const event = decode(buf) as EoEvent;

        if (event.op === 'DEF' || event.op === 'EVA' || event.op === 'REC') {
          // This grounding is itself an interpretation — find its meant-graph entry
          const interps = await getInterpretationsForTarget(db, event.target);
          const matchingInterp = interps.find(i =>
            i.grounded_in.includes(seq) && !visited.has(i.id),
          );

          if (matchingInterp) {
            visited.add(matchingInterp.id);
            intermediates.push(matchingInterp.id);
            await walk(matchingInterp.grounded_in);
          } else {
            // No matching interpretation found — treat as terminal
            terminalGrounds.add(seq);
          }
        } else {
          // Existence or Structure triad event — this IS raw experience
          terminalGrounds.add(seq);
        }
      } catch (e: any) {
        if (e.code !== 'LEVEL_NOT_FOUND') throw e;
        // Missing log entry — broken chain
      }
    }
  }

  await walk(directGrounds);

  return {
    interpretation_id: interpretationId,
    direct_grounds: directGrounds,
    intermediates,
    terminal_grounds: Array.from(terminalGrounds),
    complete: terminalGrounds.size > 0,
  };
}

// ---------------------------------------------------------------------------
// Supersession queries
// ---------------------------------------------------------------------------

/**
 * Get the supersession chain for an interpretation.
 * Returns all interpretations that supersede this one, transitively.
 */
export async function getSupersessionChain(
  db: EoDb,
  target: string,
  id: string,
): Promise<string[]> {
  const chain: string[] = [];
  const visited = new Set<string>();
  const queue = [id];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const interp = await getInterpretation(db, target, current);
    if (!interp) continue;

    for (const by of interp.superseded_by) {
      chain.push(by);
      queue.push(by);
    }
  }

  return chain;
}
