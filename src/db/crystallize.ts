/**
 * Crystallization — recursive entity generation from stabilized layers.
 *
 * When a region of state holds a stable configuration across enough events,
 * the fold precipitates a new entity (INS2+) from that configuration.
 * The crystallized entity is a real target in the keyspace — it can receive
 * CON edges, DEFs, EVA formulas, and participate in further crystallization.
 *
 * Predicate:
 *   - cohort_forms: targets under a scope share trait values and the grouping
 *     persists across `window` consecutive events touching the scope.
 *     "Stable" means the trait groupings don't change — not that nothing happens.
 *     Events keep flowing, but the cohort structure holds.
 *
 * INCREMENTAL: no full-scope scans at fold time. The fold knows what changed
 * (one target, old state → new state). The cohort index is maintained as a
 * side effect of each event, not recomputed from scratch.
 *
 * Cohort identity is keyed by scope + trait signature (e.g. "attorney:sarah|type:regulatory"),
 * NOT by its members. If a cohort grows or shrinks, the same derived entity is updated.
 * New cohort forming = new entity. Existing cohort gaining a member = DEF on same entity.
 *
 * Storage keys:
 *   cryst-rule:{scope}                     — the crystallization rule
 *   cryst-snap:{scope}                     — stability state (counter)
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
  // Clean up all index entries for this scope
  const prefixes = [`cryst-trait:${scope}:`, `cryst-cohort:${scope}:`];
  for (const pfx of prefixes) {
    for await (const [key] of db.iterator({ gte: pfx, lte: `${pfx}\xff` })) {
      try { await db.del(key); } catch {}
    }
  }
}

/**
 * Find the crystallization rule for the scope that is the direct parent
 * of the changed target. A target "firm.cases.rec001" matches a rule
 * at "firm.cases" (its parent). We only check the direct parent scope
 * because targets must be direct children of the scope.
 */
async function getRuleForTarget(
  db: EoDb,
  target: string,
): Promise<CrystallizationRule | null> {
  const parts = target.split('.');
  if (parts.length < 2) return null;

  // The scope is the parent prefix: firm.cases for firm.cases.rec001
  const scope = parts.slice(0, parts.length - 1).join('.');
  return getCrystallizationRule(db, scope);
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

async function getTargetTraitKey(db: EoDb, scope: string, target: string): Promise<string | null> {
  try {
    const buf = await db.get(`cryst-trait:${scope}:${target}`);
    return decode(buf) as string;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

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
 * This is the incremental core. One target changed — we look up its old trait key,
 * compute the new one from the current state, and if they differ we move it
 * between cohorts. Two index writes, no scan.
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

  return true;
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
 * Read all qualifying cohorts from the index.
 * Only runs when the stability window is hit — not on every event.
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

/**
 * Deterministic target for a crystallized cohort.
 *
 * Identity is scope + trait signature — NOT the members.
 * The cohort "attorney:sarah|type:regulatory" under "firm.cases" is always
 * the same entity regardless of how many cases match. If a new case joins
 * the cohort, the entity is updated (DEF), not duplicated.
 */
function crystallizedEntityTarget(scope: string, traitKey: string): string {
  const identity = `${scope}|${traitKey}`;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  return `system.cryst.${hash}`;
}

// ─── Reverse Dependency Index (shared pattern with fold.ts) ──────────

async function addReverseDep(db: EoDb, constituent: string, derivedTarget: string): Promise<void> {
  await db.put(`rdep:${constituent}:${derivedTarget}`, encode(derivedTarget));
}

async function removeReverseDep(db: EoDb, constituent: string, derivedTarget: string): Promise<void> {
  try { await db.del(`rdep:${constituent}:${derivedTarget}`); } catch {}
}

// ─── Main Entry Point ────────────────────────────────────────────────

/**
 * Detect whether any crystallization rule fires for the changed target.
 * Called by the fold after every event, at the same level as detectAndEmitREC.
 *
 * INCREMENTAL: looks up the changed target's old and new trait keys,
 * updates two index entries if they differ, and bumps a counter.
 * Only reads the cohort index when the counter hits the window.
 */
export async function detectAndEmitCrystallization(
  db: EoDb,
  changedTarget: string,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  const rule = await getRuleForTarget(db, changedTarget);
  if (!rule) return;

  const currentState = await getState(db, changedTarget);
  await processCohortRule(db, rule, changedTarget, currentState, triggeringEvent, feed);
}

// ─── Cohort Forms (incremental) ──────────────────────────────────────

async function processCohortRule(
  db: EoDb,
  rule: CrystallizationRule,
  changedTarget: string,
  currentState: EoState | null,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  // Incrementally update cohort membership for the changed target
  const structureChanged = await updateCohortMembership(
    db, rule.scope, changedTarget, currentState, rule,
  );

  const stability = await getStabilityState(db, rule.scope);

  if (structureChanged) {
    // Cohort structure shifted — reset counter
    await setStabilityState(db, {
      scope: rule.scope,
      snapshot_hash: '',
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
      // Reset counter — the birth of new entities changes the landscape
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
  // Identity is scope + trait signature, NOT members
  const derivedTargetId = crystallizedEntityTarget(rule.scope, traitKey);

  // Parse trait values from the key for the operand
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
  };

  const existing = await getState(db, derivedTargetId);
  const now = new Date().toISOString();

  if (existing) {
    // Cohort already crystallized — update with current members if they changed
    const existingConstituents: string[] = existing.value?.constituents ?? [];
    if (existingConstituents.length === members.length &&
        existingConstituents.every((c: string, i: number) => c === members[i])) {
      return; // Same members — nothing to update
    }

    // Members changed — update the entity and fix reverse deps
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

    // Update reverse deps: remove old, add new
    for (const old of existingConstituents) {
      if (!members.includes(old)) {
        await removeReverseDep(db, old, derivedTargetId);
      }
    }
    for (const member of members) {
      if (!existingConstituents.includes(member)) {
        await addReverseDep(db, member, derivedTargetId);
      }
    }

    // Update derived entity registration
    const derived: DerivedEntity = {
      target: derivedTargetId,
      level: existing.level,
      constituents: members,
      topology: 'cohort',
      inert: false,
    };
    await db.put(`derived:${derivedTargetId}`, encode(derived));

    if (feed) feed.notify(updateEvent);
  } else {
    // New crystallization — INS at the next level
    let maxLevel = 1;
    for (const member of members) {
      const state = await getState(db, member);
      if (state && state.level > maxLevel) maxLevel = state.level;
    }
    const derivedLevel = maxLevel + 1;

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
