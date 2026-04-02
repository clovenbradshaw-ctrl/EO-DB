/**
 * Key room topology — maps encryption scopes to Matrix rooms for key distribution.
 *
 * The core idea: different data scopes can have their keys distributed through
 * different Matrix rooms. Room membership = key access. If you're in the room,
 * you get the keys announced there. If you're not, those fields stay opaque.
 *
 * Examples:
 *   - "app.tblClients" keys → #client-keys:matrix.example.com (all staff)
 *   - "app.tblClients.*.fldSSN" keys → #pii-keys:matrix.example.com (compliance only)
 *   - "app.tblFinance" keys → #finance-keys:matrix.example.com (finance team)
 *
 * Storage: Topology mappings are persisted in the EO database under the
 * `meta:key-room-topology` key, alongside auth config and other metadata.
 *
 * Runtime: The client maintains a map of room memberships and uses it to
 * resolve which keys it can access for any given target.
 */

import type { EoDb } from '../db/level.js';
import { encode, decode } from '../db/level.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single mapping from a target scope to a key room. */
export interface KeyRoomBinding {
  /** Unique binding identifier */
  binding_id: string;
  /** Target scope prefix this binding covers (e.g., "app.tblClients") */
  scope: string;
  /** Matrix room ID where keys for this scope are distributed */
  key_room_id: string;
  /** Optional: glob pattern for field-level filtering (e.g., "*.fldSSN") */
  field_pattern?: string;
  /** Human-readable label */
  label?: string;
  /** Who created this binding */
  created_by: string;
  /** When */
  created_at: string;
}

/** The full topology: all scope-to-room mappings. */
export interface KeyRoomTopology {
  /** All active bindings */
  bindings: KeyRoomBinding[];
  /** When this topology was last modified */
  updated_at: string;
  /** Who last modified it */
  updated_by: string;
}

/** Result of resolving which key room(s) a target's keys live in. */
export interface KeyRoomResolution {
  /** The binding that matched */
  binding: KeyRoomBinding;
  /** The effective scope for key lookup */
  effective_scope: string;
}

// ─── DB Key ─────────────────────────────────────────────────────────────────

const TOPOLOGY_KEY = 'meta:key-room-topology';

// ─── Default ────────────────────────────────────────────────────────────────

function defaultTopology(): KeyRoomTopology {
  return {
    bindings: [],
    updated_at: new Date().toISOString(),
    updated_by: 'system',
  };
}

// ─── Read / Write ───────────────────────────────────────────────────────────

export async function getKeyRoomTopology(db: EoDb): Promise<KeyRoomTopology> {
  try {
    const buf = await db.get(TOPOLOGY_KEY);
    return { ...defaultTopology(), ...(decode(buf) as any) };
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return defaultTopology();
    throw e;
  }
}

export async function setKeyRoomTopology(db: EoDb, topology: KeyRoomTopology): Promise<void> {
  await db.put(TOPOLOGY_KEY, encode(topology));
}

// ─── Mutations ──────────────────────────────────────────────────────────────

/** Add a new scope-to-room binding. */
export async function addKeyRoomBinding(
  db: EoDb,
  binding: KeyRoomBinding,
  actor: string,
): Promise<KeyRoomTopology> {
  const topology = await getKeyRoomTopology(db);

  // Prevent duplicate scope+room combos
  const exists = topology.bindings.some(
    b => b.scope === binding.scope && b.key_room_id === binding.key_room_id,
  );
  if (exists) {
    throw new Error(`Binding already exists for scope "${binding.scope}" → room "${binding.key_room_id}"`);
  }

  topology.bindings.push(binding);
  topology.updated_at = new Date().toISOString();
  topology.updated_by = actor;
  await setKeyRoomTopology(db, topology);
  return topology;
}

/** Remove a binding by its ID. */
export async function removeKeyRoomBinding(
  db: EoDb,
  bindingId: string,
  actor: string,
): Promise<KeyRoomTopology> {
  const topology = await getKeyRoomTopology(db);
  topology.bindings = topology.bindings.filter(b => b.binding_id !== bindingId);
  topology.updated_at = new Date().toISOString();
  topology.updated_by = actor;
  await setKeyRoomTopology(db, topology);
  return topology;
}

// ─── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve which key room(s) hold keys for a given target.
 *
 * Walks from most-specific to least-specific scope match.
 * Returns ALL matching bindings (a target may have keys in multiple rooms
 * at different granularity levels).
 *
 * Example: target = "app.tblClients.rec123.fldSSN"
 *   - Binding for "app.tblClients.*.fldSSN" → matches (field-specific room)
 *   - Binding for "app.tblClients" → matches (table-level room)
 *   Both are returned; the client checks room membership to decide which keys it has.
 */
export function resolveKeyRooms(
  topology: KeyRoomTopology,
  target: string,
): KeyRoomResolution[] {
  const results: KeyRoomResolution[] = [];

  for (const binding of topology.bindings) {
    if (scopeMatches(binding.scope, target, binding.field_pattern)) {
      results.push({
        binding,
        effective_scope: binding.scope,
      });
    }
  }

  // Sort by specificity (longest scope first)
  results.sort((a, b) => b.effective_scope.length - a.effective_scope.length);
  return results;
}

/**
 * Given a set of room IDs the user is a member of, return the binding scopes
 * they can decrypt. This is the core access question: "what can I see?"
 */
export function resolvableScopes(
  topology: KeyRoomTopology,
  memberRoomIds: Set<string>,
): KeyRoomBinding[] {
  return topology.bindings.filter(b => memberRoomIds.has(b.key_room_id));
}

// ─── Scope Matching ─────────────────────────────────────────────────────────

/**
 * Check if a binding scope covers a target.
 *
 * Plain scope: "app.tblClients" covers "app.tblClients.rec123.fldSSN"
 * With field_pattern: "app.tblClients" + pattern "*.fldSSN" covers
 *   "app.tblClients.rec123.fldSSN" but NOT "app.tblClients.rec123.fldName"
 */
function scopeMatches(scope: string, target: string, fieldPattern?: string): boolean {
  // Basic prefix check
  if (target !== scope && !target.startsWith(scope + '.')) {
    return false;
  }

  // No field pattern = covers everything under scope
  if (!fieldPattern) return true;

  // Field pattern matching
  const remainder = target.slice(scope.length + 1); // e.g., "rec123.fldSSN"
  return globMatch(fieldPattern, remainder);
}

/**
 * Simple glob matching for field patterns.
 * Supports:
 *   - "*" matches one path segment
 *   - "**" matches any number of segments
 *   - Literal matches
 */
function globMatch(pattern: string, path: string): boolean {
  const patternParts = pattern.split('.');
  const pathParts = path.split('.');

  let pi = 0; // pattern index
  let si = 0; // path index

  while (pi < patternParts.length && si < pathParts.length) {
    const pp = patternParts[pi];

    if (pp === '**') {
      // ** matches zero or more segments
      if (pi === patternParts.length - 1) return true; // ** at end matches everything
      // Try matching remaining pattern at every position
      for (let k = si; k <= pathParts.length; k++) {
        if (globMatch(patternParts.slice(pi + 1).join('.'), pathParts.slice(k).join('.'))) {
          return true;
        }
      }
      return false;
    }

    if (pp === '*') {
      // * matches exactly one segment
      pi++;
      si++;
      continue;
    }

    // Literal match
    if (pp !== pathParts[si]) return false;
    pi++;
    si++;
  }

  return pi === patternParts.length && si === pathParts.length;
}
