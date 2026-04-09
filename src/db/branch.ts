/**
 * Branch management for branching timelines.
 *
 * Storage keys:
 *   branches/{branchId}          → Branch metadata
 *   state/{branchId}/{target}    → Branch-scoped state (non-main branches only)
 *
 * Key schema note: slash vs colon is intentional.
 *   - Main state:   state:{target}          (colon separator, existing)
 *   - Branch state: state/{branchId}/{target} (slash separator, new)
 *
 * This separates them in LevelDB's key ordering, preventing accidental prefix scan
 * collisions between main state and branch state.
 *
 * NOTE: getBranchState falls back through the parent chain to main. This means
 * a branch that has not written a target reads the value from its closest ancestor
 * that has. This is correct — branches inherit their parent's state.
 */

import { EoDb, encode, decode, nextSeq } from './level.js';
import { getState, setState } from './state.js';
import { appendToLog } from './log.js';
import { logScanByBranch } from './log.js';
import type { Branch, EoEvent, EoState } from './types.js';

// ─── Branch metadata ───────────────────────────────────────────────────────

/** Get a branch by ID. Returns a synthetic Branch for 'main' (not stored). */
export async function getBranch(db: EoDb, branchId: string): Promise<Branch | null> {
  if (branchId === 'main') {
    // Main is implicit — never stored, always available
    return {
      id: 'main',
      name: 'Main',
      parent: undefined,
      forkSeq: -1,       // scan from seq 0 (logScanByBranch uses fromSeq exclusive, so -1 → seq >= 0)
      createdAt: '',
      agent: 'system',
    };
  }
  try {
    const buf = await db.get(`branches/${branchId}`);
    return decode(buf) as Branch;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

/** Persist a branch record. */
export async function createBranch(db: EoDb, branch: Branch): Promise<void> {
  // NOTE: In a distributed setting, branch metadata needs to be sync'd via Matrix
  // (or another consensus mechanism) before other peers can read from this branch.
  // That coordination is handled by the Matrix sync PR.
  await db.put(`branches/${branch.id}`, encode(branch));
}

/** List all branches (excludes implicit 'main'). */
export async function listBranches(db: EoDb): Promise<Branch[]> {
  const branches: Branch[] = [];
  const startKey = 'branches/';
  const endKey = 'branches/\xff';

  for await (const [, value] of db.iterator({ gte: startKey, lte: endKey })) {
    branches.push(decode(value) as Branch);
  }
  return branches;
}

// ─── Branch-scoped state ────────────────────────────────────────────────────

/**
 * Read the projected state for a target on the given branch.
 *
 * Fallback chain:
 *   1. scope check — if the branch has a scope and the target falls outside it,
 *      bypass branch-specific state and read directly from the parent branch (or main).
 *      This is what makes a "cases table review" branch only diverge for cases.* targets.
 *   2. branch-specific key (state/{branchId}/{target})
 *   3. parent branch (recursively)
 *   4. main (state:{target})
 *
 * This ensures a branch inherits all pre-fork state from its ancestors and only
 * holds divergent state for the targets within its declared scope.
 */
export async function getBranchState(
  db: EoDb,
  branchId: string,
  target: string,
): Promise<EoState | null> {
  if (branchId === 'main') return getState(db, target);

  const branch = await getBranch(db, branchId);

  // Scope guard: if this branch is scoped to a particular table prefix and the
  // requested target lives outside that prefix, skip straight to the parent.
  // Example: Bob's review is scoped to 'firm.cases' — firm.config.* reads from main.
  if (branch?.scope && !target.startsWith(branch.scope)) {
    if (branch.parent) return getBranchState(db, branch.parent, target);
    return getState(db, target);
  }

  try {
    const buf = await db.get(`state/${branchId}/${target}`);
    return decode(buf) as EoState;
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }

  // Not found on this branch — walk up to parent
  if (branch?.parent) return getBranchState(db, branch.parent, target);

  return null;
}

/**
 * Write the projected state for a target on the given branch.
 *
 * For main: delegates to setState (maintains hash-cohort index).
 * For other branches: writes to branch-specific keyspace (no hash-cohort maintenance).
 *
 * NOTE: Branch state writes do NOT update the hash-cohort index. Structural twin
 * queries on non-main branches will reflect main's cohorts. Branch-aware cohorts
 * are deferred to a future PR.
 */
export async function setBranchState(
  db: EoDb,
  branchId: string,
  target: string,
  state: EoState,
): Promise<void> {
  if (branchId === 'main') {
    await setState(db, state);
    return;
  }
  await db.put(`state/${branchId}/${target}`, encode(state));
}

// ─── Branch cursor ─────────────────────────────────────────────────────────

/**
 * Branch cursor — yields all events in this branch's complete history in seq order.
 *
 * Stitches ancestor segments: first yields parent events up to the fork point,
 * then yields this branch's own events starting after the fork point.
 *
 * For a three-level chain (child → alice → main):
 *   1. main events with seq ≤ alice.forkSeq
 *   2. alice events with seq ≤ child.forkSeq
 *   3. child events with seq > child.forkSeq
 *
 * NOTE: O(total log) — scans the global log filtered by branch field. For databases
 * with >100k events, replace with a secondary index (branch-log:{branchId}:{padSeq})
 * in the next PR.
 *
 * @param upTo Inclusive upper bound on seq (for time-travel queries).
 */
export async function* branchCursor(
  db: EoDb,
  branchId: string,
  upTo?: number,
): AsyncGenerator<EoEvent> {
  const branch = await getBranch(db, branchId);
  if (!branch) throw new Error(`Branch not found: ${branchId}`);

  if (branch.parent) {
    // Yield parent history up to and including the fork point
    yield* branchCursor(db, branch.parent, branch.forkSeq);
  }

  // Yield this branch's own events (after the fork point)
  // forkSeq is the exclusive lower bound: child events start at forkSeq + 1
  yield* logScanByBranch(db, branchId, branch.forkSeq, upTo);
}

// ─── Fork ──────────────────────────────────────────────────────────────────

/** Options for creating a fork. */
export interface ForkOptions {
  /**
   * Table/prefix scope for this branch. When set, the branch only holds divergent state
   * for targets that start with this prefix. Reads outside the scope fall to the parent.
   *
   * Example: 'firm.cases' — Bob's review branch diverges only for cases.* targets.
   * Reads for firm.config.* bypass Bob's branch entirely and read from main.
   */
  scope?: string;
  /**
   * Role associated with this branch. Enables role-scoped parallel versioning:
   * multiple users can hold simultaneous role branches on the same table
   * (e.g. 'attorney', 'reviewer', 'caseworker' all reviewing cases simultaneously).
   */
  role?: string;
}

/**
 * Fork a new branch from an existing one.
 *
 * This writes two events to the parent branch's log:
 *   1. SEG — marks the fork point on the parent
 *   2. NUL (witnessed) — the fork attestation; its seq becomes forkSeq
 *
 * The fork NUL's siteCondition is 'instantiated' because the fork marker target
 * is being created at this moment. The NUL enrichment that normally happens in
 * processEvent (before appendToLog) is applied inline here.
 *
 * Use `scope` to create a table-scoped branch (e.g. Bob's review of the cases table).
 * Use `role` to tag the branch with the reviewing role.
 */
export async function fork(
  db: EoDb,
  parentBranchId: string,
  newBranchId: string,
  newBranchName: string,
  agent: string,
  opts: ForkOptions = {},
): Promise<Branch> {
  const now = new Date().toISOString();
  const markerTarget = `branch.${newBranchId}.fork`;

  // SEG on parent — marks the fork point
  const segSeq = await nextSeq(db);
  await appendToLog(db, {
    seq: segSeq,
    op: 'SEG',
    target: markerTarget,
    operand: { type: 'fork', parent: parentBranchId, scope: opts.scope, role: opts.role },
    agent,
    branch: parentBranchId,
    source: 'agent',
    ts: now,
    acquired_ts: now,
  });

  // NUL (witnessed) — fork attestation.
  // siteCondition is 'instantiated' because the marker target is being created here.
  // forkSeq = this NUL's seq; child events start at forkSeq + 1.
  const nullSeq = await nextSeq(db);
  await appendToLog(db, {
    seq: nullSeq,
    op: 'NUL',
    target: markerTarget,
    operand: { witnessed: true, siteCondition: 'instantiated', forkFrom: parentBranchId },
    agent,
    branch: parentBranchId,
    source: 'agent',
    ts: now,
    acquired_ts: now,
  });

  const branch: Branch = {
    id: newBranchId,
    name: newBranchName,
    parent: parentBranchId,
    forkSeq: nullSeq,   // last shared event; child events start at nullSeq + 1
    createdAt: now,
    agent,
    ...(opts.scope !== undefined && { scope: opts.scope }),
    ...(opts.role !== undefined && { role: opts.role }),
  };
  await createBranch(db, branch);
  return branch;
}
