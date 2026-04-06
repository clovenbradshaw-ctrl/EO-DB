/**
 * Soft-delete for tables (target prefixes).
 *
 * Marks every entity under a prefix as deleted by setting:
 *   _deleted: true, _deleted_at: ISO timestamp, _deleted_by: agent
 *
 * Edge handling: edges that cross the deletion boundary (one end deleted,
 * one end alive) are preserved as tombstones — the deleted entity's state
 * retains its `_edges` / `linked` data so the relationship is recoverable.
 * No edges are physically removed.
 *
 * There is no hard delete. Soft-deleted entities can be restored by
 * issuing a DEF that removes the `_deleted` flag.
 */

import type { EoDb } from './level.js';
import { getState, setState, getStateByPrefix } from './state.js';
import { getEdgesFrom, getEdgesTo } from './graph.js';
import type { EoState } from './types.js';

export interface SoftDeleteResult {
  /** Number of entities marked as deleted. */
  deleted: number;
  /** Number of edges that cross the deletion boundary (tombstoned). */
  tombstoned_edges: number;
  /** Targets that were marked deleted. */
  targets: string[];
}

/**
 * Soft-delete all entities under `prefix`.
 *
 * Each entity's value is augmented with `_deleted`, `_deleted_at`, and
 * `_deleted_by`. The rest of the value (including `_edges` / `linked`) is
 * preserved so that edge information survives as tombstones.
 */
export async function softDeleteByPrefix(
  db: EoDb,
  prefix: string,
  agent: string,
): Promise<SoftDeleteResult> {
  const states = await getStateByPrefix(db, prefix);
  if (states.length === 0) {
    throw new Error(`No entities found under prefix: ${prefix}`);
  }

  const now = new Date().toISOString();
  const deletedTargets = new Set<string>();
  let tombstonedEdges = 0;

  // Pass 1: mark every entity under the prefix as deleted
  for (const state of states) {
    // Skip already-deleted entities
    if (state.value?._deleted) continue;
    // Skip alias pointers — they aren't real entities
    if (state.value?._alias) continue;

    deletedTargets.add(state.target);

    await setState(db, {
      ...state,
      value: {
        ...state.value,
        _deleted: true,
        _deleted_at: now,
        _deleted_by: agent,
      },
    });
  }

  // Pass 2: count tombstoned edges (edges crossing the deletion boundary)
  for (const target of deletedTargets) {
    const outgoing = await getEdgesFrom(db, target);
    for (const edge of outgoing) {
      if (!deletedTargets.has(edge.dest)) {
        tombstonedEdges++;
      }
    }
    const incoming = await getEdgesTo(db, target);
    for (const edge of incoming) {
      if (!deletedTargets.has(edge.source)) {
        tombstonedEdges++;
      }
    }
  }

  return {
    deleted: deletedTargets.size,
    tombstoned_edges: tombstonedEdges,
    targets: Array.from(deletedTargets),
  };
}

/**
 * Restore a soft-deleted entity (or prefix of entities) by clearing
 * the `_deleted`, `_deleted_at`, and `_deleted_by` flags.
 */
export async function restoreByPrefix(
  db: EoDb,
  prefix: string,
): Promise<{ restored: number; targets: string[] }> {
  const states = await getStateByPrefix(db, prefix);
  const restored: string[] = [];

  for (const state of states) {
    if (!state.value?._deleted) continue;

    const { _deleted, _deleted_at, _deleted_by, ...rest } = state.value;
    await setState(db, {
      ...state,
      value: rest,
    });
    restored.push(state.target);
  }

  return { restored: restored.length, targets: restored };
}

/** Check whether a state is soft-deleted. */
export function isDeleted(state: EoState | null): boolean {
  return state?.value?._deleted === true;
}
