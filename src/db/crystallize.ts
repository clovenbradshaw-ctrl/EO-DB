/**
 * Crystallization — recursive entity generation from stabilized layers.
 *
 * When a region of state holds a stable configuration across enough events,
 * the fold precipitates a new entity (INS2+) from that configuration.
 * The crystallized entity is a real target in the keyspace — it can receive
 * CON edges, DEFs, EVA formulas, and participate in further crystallization.
 *
 * Two predicates:
 *   - cohort_forms: targets under a scope share trait values and the grouping
 *     persists across `window` consecutive events touching the scope.
 *   - hash_stable: the set of {target → transformation hash} under a scope
 *     is unchanged for `window` consecutive events.
 *
 * INCREMENTAL: no full-scope scans at fold time. The fold knows what changed
 * (one target, old state → new state). The cohort index is maintained as a
 * side effect of each event, not recomputed from scratch.
 *
 * Storage keys:
 *   cryst-rule:{scope}                     — the crystallization rule
 *   cryst-snap:{scope}                     — stability state (counter + snapshot hash)
 *   cryst-trait:{scope}:{target}           — current trait key for a target in this scope
 *   cryst-cohort:{scope}:{traitKey}        — serialized member list for a cohort
 *   derived:{target}                       — DerivedEntity registration (shared with REC)
 *   rdep:{constituent}:{derived}           — reverse dep index (shared with REC)
 */

import { createHash } from 'crypto';
import { EoDb, encode, decode, nextSeq } from './level.js';
import { getState, setState } from './state.js';
import { appendToLog } from './log.js';
import { seedHash } from './hash.js';
import type {
  EoEvent, EoState, CrystallizationRule, CrystStabilityState, DerivedEntity,
} from './types.js';
import type { Feed } from './feed.js';

// ─── Rule Registration ───────────────────────────────────────────────

export async function registerCrystallizationRule(
  db: EoDb,
  rule: CrystallizationRule,
): Promise<void> {
  await db.put(`cryst-rule:${rule.scope}`, encode(rule));
}

export async function getCrystallizationRule(
  db: EoDb,
  scope: string,
): Promise<CrystallizationRule | null> {
  try {
    const buf = await db.get(`cryst-rule:${scope}`);
    return decode(buf) as CrystallizationRule;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

export async function removeCrystallizationRule(
  db: EoDb,
  scope: string,
): Promise<void> {
  try {
    await db.del(`cryst-rule:${scope}`);
    await db.del(`cryst-snap:${scope}`);
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
  // Clean up cohort index entries for this scope
  for await (const [key] of db.iterator({
    gte: `cryst-trait:${scope}:`,
    lte: `cryst-trait:${scope}:\xff`,
  })) {
    try { await db.del(key); } catch {}
  }
  for await (const [key] of db.iterator({
    gte: `cryst-cohort:${scope}:`,
    lte: `cryst-cohort:${scope}:\xff`,
  })) {
    try { await db.del(key); } catch {}
  }
}

/**
 * Find all crystallization rules whose scope is a prefix of the changed target.
 * Only checks scopes that are proper ancestors — the target must be a
 * direct child of the scope (record-level) for the rule to apply.
 */
async function getRulesForTarget(
  db: EoDb,
  target: string,
): Promise<{ rule: CrystallizationRule; targetInScope: boolean }[]> {
  const parts = target.split('.');
  const results: { rule: CrystallizationRule; targetInScope: boolean }[] = [];

  // Walk up the prefix chain. A rule at depth D applies to targets at depth D+1.
  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const scope = parts.slice(0, depth).join('.');
    const rule = await getCrystallizationRule(db, scope);
    if (rule) {
      // Target is a direct child of scope if it's exactly one level deeper
      const targetInScope = parts.length === depth + 1;
      results.push({ rule, targetInScope });
    }
  }

  return results;
}

// ─── Stability Tracking ──────────────────────────────────────────────

async function getStabilityState(db: EoDb, scope: string): Promise<CrystStabilityState | null> {
  try {
    const buf = await db.get(`cryst-snap:${scope}`);
    return decode(buf) as CrystStabilityState;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

async function setStabilityState(db: EoDb, state: CrystStabilityState): Promise<void> {
  await db.put(`cryst-snap:${state.scope}`, encode(state));
}

// ─── Incremental Cohort Index ────────────────────────────────────────

/**
 * Get the current trait key for a target in a scope.
 */
async function getTargetTraitKey(db: EoDb, scope: string, target: string): Promise<string | null> {
  try {
    const buf = await db.get(`cryst-trait:${scope}:${target}`);
    return decode(buf) as string;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

/**
 * Get the current members of a cohort.
 */
async function getCohortMembers(db: EoDb, scope: string, traitKey: string): Promise<string[]> {
  try {
    const buf = await db.get(`cryst-cohort:${scope}:${traitKey}`);
    return decode(buf) as string[];
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return [];
    throw e;
  }
}

/**
 * Update a target's cohort membership. Returns whether the cohort structure changed.
 *
 * This is the incremental core. One target changed — we update two index entries
 * (old cohort, new cohort) and one trait mapping. No scan.
 */
async function updateCohortMembership(
  db: EoDb,
  scope: string,
  target: string,
  state: EoState | null,
  rule: CrystallizationRule,
): Promise<boolean> {
  const oldTraitKey = await getTargetTraitKey(db, scope, target);
  const newTraitKey = state ? computeTraitKey(state, rule.traits) : null;

  // No change in trait assignment
  if (oldTraitKey === newTraitKey) return false;

  // Remove from old cohort
  if (oldTraitKey !== null) {
    const oldMembers = await getCohortMembers(db, scope, oldTraitKey);
    const filtered = oldMembers.filter(m => m !== target);
    if (filtered.length === 0) {
      try { await db.del(`cryst-cohort:${scope}:${oldTraitKey}`); } catch {}
    } else {
      await db.put(`cryst-cohort:${scope}:${oldTraitKey}`, encode(filtered));
    }
    try { await db.del(`cryst-trait:${scope}:${target}`); } catch {}
  }

  // Add to new cohort
  if (newTraitKey !== null) {
    const newMembers = await getCohortMembers(db, scope, newTraitKey);
    if (!newMembers.includes(target)) {
      newMembers.push(target);
      newMembers.sort();
    }
    await db.put(`cryst-cohort:${scope}:${newTraitKey}`, encode(newMembers));
    await db.put(`cryst-trait:${scope}:${target}`, encode(newTraitKey));
  }

  return true; // Structure changed
}

/**
 * Compute the trait key for a state, or null if the state lacks required traits.
 */
function computeTraitKey(state: EoState, traitKeys: string[]): string | null {
  if (!state.value || typeof state.value !== 'object') return null;
  if (state.value._alias || state.value._deleted) return null;

  const parts: string[] = [];
  for (const key of traitKeys) {
    const val = state.value[key];
    if (val === undefined || val === null) return null;
    parts.push(`${key}:${JSON.stringify(val)}`);
  }
  parts.sort();
  return parts.join('|');
}

/**
 * Read all qualifying cohorts from the index (no full-scope scan).
 */
async function getQualifyingCohorts(
  db: EoDb,
  scope: string,
  minMembers: number,
): Promise<Array<{ traitKey: string; members: string[] }>> {
  const cohorts: Array<{ traitKey: string; members: string[] }> = [];
  const prefix = `cryst-cohort:${scope}:`;

  for await (const [key, buf] of db.iterator({ gte: prefix, lte: `${prefix}\xff` })) {
    const members = decode(buf) as string[];
    if (members.length >= minMembers) {
      const traitKey = key.slice(prefix.length);
      cohorts.push({ traitKey, members });
    }
  }

  return cohorts;
}

// ─── Crystallized Entity Target ──────────────────────────────────────

function crystallizedEntityTarget(scope: string, traitKey: string, members: string[]): string {
  const identity = `${scope}|${traitKey}|${members.join(',')}`;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  return `system.cryst.${hash}`;
}

function hashStableEntityTarget(scope: string, snapshotHash: string): string {
  const identity = `stable|${scope}|${snapshotHash}`;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  return `system.cryst.${hash}`;
}

// ─── Reverse Dependency Index (shared pattern with fold.ts) ──────────

async function addReverseDep(db: EoDb, constituent: string, derivedTarget: string): Promise<void> {
  const key = `rdep:${constituent}:${derivedTarget}`;
  await db.put(key, encode(derivedTarget));
}

// ─── Main Entry Point ────────────────────────────────────────────────

/**
 * Detect whether any crystallization rule fires for the changed target.
 * Called by the fold after every event, at the same level as detectAndEmitREC.
 *
 * INCREMENTAL: does not scan the scope. Looks up the changed target's old
 * and new trait keys, updates two index entries, and bumps a counter.
 * Only does a (cheap) index scan when the counter hits the window threshold.
 */
export async function detectAndEmitCrystallization(
  db: EoDb,
  changedTarget: string,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  const matches = await getRulesForTarget(db, changedTarget);
  if (matches.length === 0) return;

  // Get the current state of the changed target (just written by the fold)
  const currentState = await getState(db, changedTarget);

  for (const { rule, targetInScope } of matches) {
    if (rule.predicate === 'cohort_forms') {
      await processCohortRule(db, rule, changedTarget, currentState, targetInScope, triggeringEvent, feed);
    } else if (rule.predicate === 'hash_stable') {
      await processHashStableRule(db, rule, changedTarget, currentState, targetInScope, triggeringEvent, feed);
    }
  }
}

// ─── Cohort Forms (incremental) ──────────────────────────────────────

async function processCohortRule(
  db: EoDb,
  rule: CrystallizationRule,
  changedTarget: string,
  currentState: EoState | null,
  targetInScope: boolean,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  // Only update index for direct children of the scope
  if (!targetInScope) return;

  // Incrementally update cohort membership for the changed target
  const structureChanged = await updateCohortMembership(
    db, rule.scope, changedTarget, currentState, rule,
  );

  // Update stability counter
  const stability = await getStabilityState(db, rule.scope);

  if (structureChanged) {
    // Structure changed — reset counter
    await setStabilityState(db, {
      scope: rule.scope,
      snapshot_hash: '', // irrelevant for cohort_forms — we track via structureChanged
      counter: 0,
      last_seq: triggeringEvent.seq,
    });
  } else {
    // Structure held — increment counter
    const newCounter = (stability?.counter ?? 0) + 1;

    if (newCounter >= rule.window) {
      // Window reached — crystallize qualifying cohorts
      const cohorts = await getQualifyingCohorts(db, rule.scope, rule.min_members);
      for (const cohort of cohorts) {
        await crystallizeCohort(db, rule, cohort.traitKey, cohort.members, triggeringEvent, feed);
      }
      // Reset counter — birth of new entities changes the landscape
      await setStabilityState(db, {
        scope: rule.scope,
        snapshot_hash: '',
        counter: 0,
        last_seq: triggeringEvent.seq,
      });
    } else {
      await setStabilityState(db, {
        scope: rule.scope,
        snapshot_hash: '',
        counter: newCounter,
        last_seq: triggeringEvent.seq,
      });
    }
  }
}

async function crystallizeCohort(
  db: EoDb,
  rule: CrystallizationRule,
  traitKey: string,
  members: string[],
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  const derivedTargetId = crystallizedEntityTarget(rule.scope, traitKey, members);

  // Determine level: one above the highest constituent
  let maxLevel = 1;
  for (const member of members) {
    const state = await getState(db, member);
    if (state && state.level > maxLevel) maxLevel = state.level;
  }
  const derivedLevel = maxLevel + 1;

  // Parse trait values back from the key for the operand
  const traits: Record<string, any> = {};
  for (const part of traitKey.split('|')) {
    const colonIdx = part.indexOf(':');
    if (colonIdx > 0) {
      const k = part.slice(0, colonIdx);
      try { traits[k] = JSON.parse(part.slice(colonIdx + 1)); } catch {
        traits[k] = part.slice(colonIdx + 1);
      }
    }
  }

  const derivedOperand = {
    constituents: members,
    traits,
    scope: rule.scope,
    topology: 'cohort',
    predicate: rule.predicate,
  };

  const existing = await getState(db, derivedTargetId);
  const now = new Date().toISOString();

  if (existing) {
    // Cohort already crystallized — only update if members changed
    const existingConstituents = existing.value?.constituents;
    if (Array.isArray(existingConstituents) &&
        existingConstituents.length === members.length &&
        existingConstituents.every((c: string, i: number) => c === members[i])) {
      return;
    }

    const updateSeq = await nextSeq(db);
    const updateEvent: EoEvent = {
      seq: updateSeq,
      op: 'DEF',
      target: derivedTargetId,
      operand: derivedOperand,
      agent: 'system:crystallize',
      ts: now,
      acquired_ts: now,
      triggered_by: triggeringEvent.seq,
    };
    await appendToLog(db, updateEvent);
    await setState(db, {
      target: derivedTargetId,
      value: derivedOperand,
      hash: createHash('sha256').update(existing.hash + 'DEF' + JSON.stringify(derivedOperand)).digest('hex'),
      level: existing.level,
      last_seq: updateSeq,
      last_op: 'DEF',
      last_agent: 'system:crystallize',
      last_ts: now,
      last_acquired_ts: now,
    });
    if (feed) feed.notify(updateEvent);
  } else {
    // New crystallization — INS at the next level
    const insSeq = await nextSeq(db);
    const insEvent: EoEvent = {
      seq: insSeq,
      op: 'INS',
      target: derivedTargetId,
      operand: derivedOperand,
      agent: 'system:crystallize',
      level: derivedLevel,
      ts: now,
      acquired_ts: now,
      triggered_by: triggeringEvent.seq,
    };
    await appendToLog(db, insEvent);
    await setState(db, {
      target: derivedTargetId,
      value: derivedOperand,
      hash: seedHash(insEvent),
      level: derivedLevel,
      last_seq: insSeq,
      last_op: 'INS',
      last_agent: 'system:crystallize',
      last_ts: now,
      last_acquired_ts: now,
    });

    const derived: DerivedEntity = {
      target: derivedTargetId,
      level: derivedLevel,
      constituents: members,
      topology: 'cohort',
      inert: false,
    };
    await db.put(`derived:${derivedTargetId}`, encode(derived));

    for (const member of members) {
      await addReverseDep(db, member, derivedTargetId);
    }

    if (feed) feed.notify(insEvent);
  }
}

// ─── Hash Stable (incremental) ───────────────────────────────────────

async function processHashStableRule(
  db: EoDb,
  rule: CrystallizationRule,
  changedTarget: string,
  currentState: EoState | null,
  targetInScope: boolean,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  if (!targetInScope) return;

  // The fold just wrote a new state for changedTarget.
  // If the hash changed, the scope's configuration shifted. If not, it's stable.
  // We store the previous hash per-target to compare without scanning.
  const prevHashKey = `cryst-prevhash:${rule.scope}:${changedTarget}`;
  let prevHash: string | null = null;
  try {
    const buf = await db.get(prevHashKey);
    prevHash = decode(buf) as string;
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }

  const newHash = currentState?.hash ?? null;

  // Update stored hash
  if (newHash !== null) {
    await db.put(prevHashKey, encode(newHash));
  } else {
    try { await db.del(prevHashKey); } catch {}
  }

  const hashChanged = prevHash !== newHash;
  const stability = await getStabilityState(db, rule.scope);

  if (hashChanged) {
    await setStabilityState(db, {
      scope: rule.scope,
      snapshot_hash: newHash ?? '',
      counter: 0,
      last_seq: triggeringEvent.seq,
    });
  } else {
    const newCounter = (stability?.counter ?? 0) + 1;

    if (newCounter >= rule.window) {
      await crystallizeStableScope(db, rule, triggeringEvent, feed);
      await setStabilityState(db, {
        scope: rule.scope,
        snapshot_hash: newHash ?? '',
        counter: 0,
        last_seq: triggeringEvent.seq,
      });
    } else {
      await setStabilityState(db, {
        scope: rule.scope,
        snapshot_hash: newHash ?? '',
        counter: newCounter,
        last_seq: triggeringEvent.seq,
      });
    }
  }
}

/**
 * When hash_stable fires, collect current members from the per-target hash index.
 * This is the only scan — and it only runs when the window threshold is hit,
 * not on every event.
 */
async function crystallizeStableScope(
  db: EoDb,
  rule: CrystallizationRule,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  // Collect all targets we're tracking hashes for in this scope
  const members: string[] = [];
  const prefix = `cryst-prevhash:${rule.scope}:`;
  for await (const [key] of db.iterator({ gte: prefix, lte: `${prefix}\xff` })) {
    members.push(key.slice(prefix.length));
  }
  members.sort();

  if (members.length < rule.min_members) return;

  // Build a composite hash of all member hashes for deterministic identity
  const compositeHash = createHash('sha256').update(members.join('|')).digest('hex').slice(0, 16);
  const derivedTargetId = hashStableEntityTarget(rule.scope, compositeHash);

  const existing = await getState(db, derivedTargetId);
  if (existing) return;

  let maxLevel = 1;
  for (const member of members) {
    const state = await getState(db, member);
    if (state && state.level > maxLevel) maxLevel = state.level;
  }
  const derivedLevel = maxLevel + 1;

  const derivedOperand = {
    constituents: members,
    scope: rule.scope,
    topology: 'stable',
    predicate: rule.predicate,
  };

  const now = new Date().toISOString();
  const insSeq = await nextSeq(db);
  const insEvent: EoEvent = {
    seq: insSeq,
    op: 'INS',
    target: derivedTargetId,
    operand: derivedOperand,
    agent: 'system:crystallize',
    level: derivedLevel,
    ts: now,
    acquired_ts: now,
    triggered_by: triggeringEvent.seq,
  };
  await appendToLog(db, insEvent);
  await setState(db, {
    target: derivedTargetId,
    value: derivedOperand,
    hash: seedHash(insEvent),
    level: derivedLevel,
    last_seq: insSeq,
    last_op: 'INS',
    last_agent: 'system:crystallize',
    last_ts: now,
    last_acquired_ts: now,
  });

  const derived: DerivedEntity = {
    target: derivedTargetId,
    level: derivedLevel,
    constituents: members,
    topology: 'stable',
    inert: false,
  };
  await db.put(`derived:${derivedTargetId}`, encode(derived));

  for (const member of members) {
    await addReverseDep(db, member, derivedTargetId);
  }

  if (feed) feed.notify(insEvent);
}
