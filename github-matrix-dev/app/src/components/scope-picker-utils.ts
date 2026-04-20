/**
 * Shared utilities for holonic tree building, item resolution,
 * and scope-picker selection modes.
 *
 * Extracted from HolonNav.tsx for reuse across ScopePicker and other components.
 */

import type { EoState } from '../db/types';
import { isDeleted } from '../db/tombstone';
import type { FilterDefinition } from './filter-types';

// ---------------------------------------------------------------------------
// Tree Node
// ---------------------------------------------------------------------------

export interface TreeNode {
  segment: string;       // just this level's name (e.g. "tblClients")
  fullPath: string;      // full dot-path (e.g. "app.tblClients")
  children: TreeNode[];
  childCount: number;    // number of direct children with state
  conCount: number;      // children whose last_op is CON
  segCount: number;      // children whose last_op is SEG
  recCount: number;      // children whose last_op is REC
  derivedCount: number;  // children at INS level 2+ (system-discovered)
  segments?: Record<string, FilterDefinition>;
  state?: EoState;       // the EoState for this node (if any)
}

// ---------------------------------------------------------------------------
// Format name — strip tbl/rec/fld prefixes, add spaces before capitals
// ---------------------------------------------------------------------------

export function formatName(segment: string): string {
  let name = segment.replace(/^(tbl|rec|fld)/, '');
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  return name || segment;
}

// ---------------------------------------------------------------------------
// Build holonic tree from flat state list
// ---------------------------------------------------------------------------

export function buildTree(states: EoState[], statePrefix: string): TreeNode[] {
  const pathSet = new Map<string, { childPaths: Set<string>; state?: EoState }>();

  for (const s of states) {
    if (s.value?._alias) continue;
    // Tombstoned records are soft-deleted via db/tombstone.ts. The grid
    // filters them out in filterDirect(), so the sidebar must too — otherwise
    // counts disagree with what the user actually sees.
    if (isDeleted(s)) continue;
    // Skip space-level entries — space navigation is handled by the space selector,
    // not the objects tree. Each space has its own isolated IDB so showing the
    // "space" category is redundant.
    if (s.target.startsWith('space')) continue;
    const parts = s.target.split('.');

    // Register every prefix level and link each to its parent
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('.');
      if (!pathSet.has(path)) {
        pathSet.set(path, { childPaths: new Set() });
      }
      // Register intermediate path as child of its parent
      if (i > 1) {
        const parentPath = parts.slice(0, i - 1).join('.');
        pathSet.get(parentPath)!.childPaths.add(path);
      }
    }

    // Register this target's state at its path
    const entry = pathSet.get(s.target)!;
    entry.state = s;
  }

  function buildNode(fullPath: string): TreeNode {
    const entry = pathSet.get(fullPath)!;
    const segment = fullPath.split('.').pop()!;
    const childPaths = [...entry.childPaths].sort();
    const visibleChildPaths = childPaths.filter(cp => {
      if (!pathSet.has(cp)) return false;
      // Hide internal entities (e.g. _schema) from the tree
      const seg = cp.split('.').pop();
      return !seg || !seg.startsWith('_');
    });

    const allChildren = visibleChildPaths.map(cp => buildNode(cp));

    // If every child is a leaf (no grandchildren), they are records that belong
    // IN this node's table view — not navigable tree nodes. Stop the tree here
    // at n-1 so the lowest nav level shows its records in the table, not the tree.
    const children = allChildren.some(c => c.children.length > 0 || c.childCount > 0)
      ? allChildren
      : [];

    const segments = entry.state?.value?._segments as Record<string, FilterDefinition> | undefined;

    // Count children by operator type and derived status (excluding internal entities)
    let conCount = 0;
    let segCount = 0;
    let recCount = 0;
    let derivedCount = 0;
    for (const cp of entry.childPaths) {
      const cpSeg = cp.split('.').pop();
      if (cpSeg?.startsWith('_')) continue;
      const childEntry = pathSet.get(cp);
      if (childEntry?.state && !isDeleted(childEntry.state)) {
        const op = childEntry.state.last_op;
        if (op === 'CON') conCount++;
        else if (op === 'SEG') segCount++;
        else if (op === 'REC') recCount++;
        if ((childEntry.state.level ?? 1) >= 2) derivedCount++;
      }
    }

    return {
      segment,
      fullPath,
      children,
      childCount: [...entry.childPaths].filter(cp => {
        const seg = cp.split('.').pop();
        return !seg?.startsWith('_');
      }).length,
      conCount,
      segCount,
      recCount,
      derivedCount,
      segments,
      state: entry.state,
    };
  }

  // Find root nodes — scoped to the statePrefix depth
  const prefixDepth = statePrefix
    ? statePrefix.split('.').filter(Boolean).length
    : 0;

  const roots: TreeNode[] = [];
  for (const [path] of pathSet) {
    const depth = path.split('.').length;
    if (depth === prefixDepth + 1) {
      roots.push(buildNode(path));
    }
  }

  // If there's exactly one root node, skip down a level and show its children
  // directly. Since each space has its own isolated IDB, the single root
  // (typically "spaces") is redundant — the user is already scoped to one space.
  if (roots.length === 1 && roots[0].children.length > 0) {
    return roots[0].children;
  }

  return roots;
}

// ---------------------------------------------------------------------------
// Resolve by depth — all items at a given depth level
// ---------------------------------------------------------------------------

export function resolveByDepth(
  states: EoState[],
  level: number,
  root?: string,
): EoState[] {
  return states.filter(s => {
    if (s.value?._alias) return false;
    const target = s.target;
    if (root && !target.startsWith(root + '.') && target !== root) return false;
    const depth = target.split('.').length;
    return depth === level;
  });
}

// ---------------------------------------------------------------------------
// Resolve by type — all items matching a _type value
// ---------------------------------------------------------------------------

export function resolveByType(
  states: EoState[],
  typeFilter: string,
  root?: string,
): EoState[] {
  return states.filter(s => {
    if (s.value?._alias) return false;
    if (root && !s.target.startsWith(root + '.') && s.target !== root) return false;
    return s.value?._type === typeFilter;
  });
}

// ---------------------------------------------------------------------------
// Resolve by hierarchy — direct children or all descendants of a target
// ---------------------------------------------------------------------------

export function resolveByHierarchy(
  states: EoState[],
  target: string,
  depth: 'children' | 'all' = 'children',
): EoState[] {
  const prefix = target + '.';
  const targetDepth = target.split('.').length;

  return states.filter(s => {
    if (s.value?._alias) return false;
    if (!s.target.startsWith(prefix)) return false;
    if (depth === 'children') {
      return s.target.split('.').length === targetDepth + 1;
    }
    return true; // 'all' — any descendant
  });
}

// ---------------------------------------------------------------------------
// Collect all unique _type values with counts
// ---------------------------------------------------------------------------

export function collectTypes(
  states: EoState[],
  root?: string,
): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of states) {
    if (s.value?._alias) continue;
    if (root && !s.target.startsWith(root + '.') && s.target !== root) continue;
    const t = s.value?._type;
    if (t) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Collect max depth in the data set
// ---------------------------------------------------------------------------

export function getMaxDepth(states: EoState[], root?: string): number {
  let max = 0;
  for (const s of states) {
    if (s.value?._alias) continue;
    if (root && !s.target.startsWith(root + '.') && s.target !== root) continue;
    const depth = s.target.split('.').length;
    if (depth > max) max = depth;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Collect CON edge types from a target (from value or edges)
// ---------------------------------------------------------------------------

export function collectRelationshipFields(state: EoState): string[] {
  const fields: string[] = [];
  if (!state.value || typeof state.value !== 'object') return fields;

  for (const [key, val] of Object.entries(state.value)) {
    if (key.startsWith('_')) continue;

    // Check if the value looks like a target path or array of paths
    if (typeof val === 'string' && val.includes('.') && !val.includes(' ')) {
      fields.push(key);
    } else if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'string' && val[0].includes('.')) {
      fields.push(key);
    }
  }
  return fields;
}
