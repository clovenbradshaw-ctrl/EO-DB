/**
 * Sandbox (draft) layer — an in-memory overlay over a real branch.
 *
 * A sandbox lets users explore speculative edits without touching the real branch.
 * It consists of a SIG-layer of pending changes (a Map of target → value) that
 * shadows the real state.
 *
 * Promotion converts the SIG entries into real operator events on the target branch.
 *
 * NOTE: The delta between SIG layer and real branch state is computed at promotion
 * time. If the real branch changed under the sandbox (concurrent edit), promotion
 * fires events for the sandbox values regardless — the caller should compare first
 * and resolve conflicts before promoting if needed. Full delta tracking deferred
 * to a future PR.
 */

import { EoDb } from './level.js';
import { getBranchState } from './branch.js';
import { processEvent } from './fold.js';
import type { EoEventInput } from './types.js';
import type { Feed } from './feed.js';

/** A single speculative change in the sandbox. */
export interface SigEntry {
  target: string;
  op: 'DEF' | 'INS' | 'EVA';
  operand: any;
}

/** An in-memory sandbox over a branch. */
export interface Sandbox {
  branchId: string;
  agent: string;
  /** Speculative changes — keyed by target. */
  entries: Map<string, SigEntry>;
}

/** Create a new empty sandbox on the given branch. */
export function createSandbox(branchId: string, agent: string): Sandbox {
  return { branchId, agent, entries: new Map() };
}

/** Stage a speculative change in the sandbox. */
export function stageSandboxEntry(sandbox: Sandbox, entry: SigEntry): void {
  sandbox.entries.set(entry.target, entry);
}

/** Remove a staged entry from the sandbox. */
export function unstageEntry(sandbox: Sandbox, target: string): void {
  sandbox.entries.delete(target);
}

/** Discard all staged changes. */
export function discardSandbox(sandbox: Sandbox): void {
  sandbox.entries.clear();
}

/**
 * Promote the sandbox: fire real operator events for each staged entry.
 *
 * Each SIG entry becomes a processEvent call on the target branch.
 * Returns the seq numbers of the committed events.
 *
 * NOTE: Promotion is not atomic. If a later event fails, earlier events are
 * already committed. The caller should check the result and handle partial
 * promotion. Atomic batch promotion is deferred to a future PR.
 */
export async function promoteSandbox(
  db: EoDb,
  sandbox: Sandbox,
  feed?: Feed,
): Promise<{ target: string; seq: number }[]> {
  const now = new Date().toISOString();
  const results: { target: string; seq: number }[] = [];

  for (const [target, entry] of sandbox.entries) {
    const event: EoEventInput = {
      op: entry.op,
      target: entry.target,
      operand: entry.operand,
      agent: sandbox.agent,
      ts: now,
      acquired_ts: now,
      branch: sandbox.branchId,
      source: 'sandbox',
    };
    const seq = await processEvent(db, event, feed, sandbox.branchId);
    results.push({ target, seq });
  }

  sandbox.entries.clear();
  return results;
}

/**
 * Read the projected state of a target through the sandbox lens.
 *
 * Priority:
 *   1. SIG layer (speculative edits staged in the sandbox)
 *   2. Real branch state (via getBranchState — inherits from parent chain)
 */
export async function sandboxRead(
  db: EoDb,
  sandbox: Sandbox,
  target: string,
): Promise<{ value: any; fromSandbox: boolean }> {
  const staged = sandbox.entries.get(target);
  if (staged) {
    return { value: staged.operand, fromSandbox: true };
  }

  const real = await getBranchState(db, sandbox.branchId, target);
  return { value: real?.value ?? null, fromSandbox: false };
}
