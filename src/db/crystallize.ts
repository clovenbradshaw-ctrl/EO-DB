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
 * Cohort identity is keyed by scope + trait signature hash,
 * NOT by its members. If a cohort grows or shrinks, the same derived entity
 * is updated. New cohort forming = new entity. Existing cohort gaining a
 * member = DEF on same entity. Cohort shrinking below min_members = inert.
 *
 * Storage keys:
 *   cryst-rule:{scope}                     — the crystallization rule
 *   cryst-snap:{scope}                     — stability state (counter)
 *   cryst-trait:{scope}:{target}           — current trait key hash for a target
 *   cryst-cohort:{scope}:{traitKeyHash}    — { members: string[], traits: Record<string,any> }
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

// ─── Cohort index entry ──────────────────────────────────────────────
// Stored as the value of cryst-cohort:{scope}:{traitKeyHash}.
// Contains the actual traits object so we never need to reverse-parse a key.
interface CohortEntry {
  members: string[];
  traits: Record<string, any>;
}

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
  const prefixes = [`cryst-trait:${scope}:`, `cryst-cohort:${scope}:`];
  for (const pfx of prefixes) {
    for await (const [key] of db.iterator({ gte: pfx, lte: `${pfx}\xff` })) {
      try { await db.del(key); } catch {}
    }
  }
}

/**
 * Find the crystallization rule for the direct parent scope of the target.
 * firm.cases.rec001 → check firm.cases.
 */
async function getRuleForTarget(
  db: EoDb,
  target: string,
): Promise<CrystallizationRule | null> {
  const parts = target.split('.');
  if (parts.length < 2) return null;
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

// ─── Trait Key Hashing ───────────────────────────────────────────────
// Traits are hashed to a short hex string for use as a LevelDB key segment.
// The actual trait values are stored in the CohortEntry, never parsed back
// from the key. This avoids delimiter-in-value bugs entirely.

function hashTraits(traits: Record<string, any>): string {
  const keys = Object.keys(traits).sort();
  const parts = keys.map(k => `${k}\0${JSON.stringify(traits[k])}`);
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

// ─── Incremental Cohort Index ────────────────────────────────────────

async function getTargetTraitHash(db: EoDb, scope: string, target: string): Promise<string | null> {
  try {
    const buf = await db.get(`cryst-trait:${scope}:${target}`);
    return decode(buf) as string;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

async function getCohortEntry(db: EoDb, scope: string, traitHash: string): Promise<CohortEntry | null> {
  try {
    const buf = await db.get(`cryst-cohort:${scope}:${traitHash}`);
    return decode(buf) as CohortEntry;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

async function putCohortEntry(db: EoDb, scope: string, traitHash: string, entry: CohortEntry): Promise<void> {
  await db.put(`cryst-cohort:${scope}:${traitHash}`, encode(entry));
}

async function delCohortEntry(db: EoDb, scope: string, traitHash: string): Promise<void> {
  try { await db.del(`cryst-cohort:${scope}:${traitHash}`); } catch {}
}

/**
 * Extract trait values from a state. Returns null if any trait key is missing.
 */
function extractTraits(state: EoState, traitKeys: string[]): Record<string, any> | null {
  if (!state.value || typeof state.value !== 'object') return null;
  if (state.value._alias || state.value._deleted) return null;

  const traits: Record<string, any> = {};
  for (const key of traitKeys) {
    const val = state.value[key];
    if (val === undefined || val === null) return null;
    traits[key] = val;
  }
  return traits;
}

/**
 * Update a target's cohort membership. Returns whether the cohort structure changed.
 *
 * One target changed → look up old trait hash, compute new trait hash.
 * If same → no structural change. If different → move between cohorts.
 * Two index writes, no scan.
 */
async function updateCohortMembership(
  db: EoDb,
  scope: string,
  target: string,
  state: EoState | null,
  rule: CrystallizationRule,
): Promise<boolean> {
  const oldTraitHash = await getTargetTraitHash(db, scope, target);

  let newTraitHash: string | null = null;
  let newTraits: Record<string, any> | null = null;
  if (state) {
    newTraits = extractTraits(state, rule.traits);
    newTraitHash = newTraits ? hashTraits(newTraits) : null;
  }

  if (oldTraitHash === newTraitHash) return false;

  // Remove from old cohort
  if (oldTraitHash !== null) {
    const entry = await getCohortEntry(db, scope, oldTraitHash);
    if (entry) {
      entry.members = entry.members.filter(m => m !== target);
      if (entry.members.length === 0) {
        await delCohortEntry(db, scope, oldTraitHash);
      } else {
        await putCohortEntry(db, scope, oldTraitHash, entry);
      }
    }
    try { await db.del(`cryst-trait:${scope}:${target}`); } catch {}
  }

  // Add to new cohort
  if (newTraitHash !== null && newTraits !== null) {
    const entry = await getCohortEntry(db, scope, newTraitHash);
    if (entry) {
      if (!entry.members.includes(target)) {
        entry.members.push(target);
        entry.members.sort();
      }
      await putCohortEntry(db, scope, newTraitHash, entry);
    } else {
      await putCohortEntry(db, scope, newTraitHash, {
        members: [target],
        traits: newTraits,
      });
    }
    await db.put(`cryst-trait:${scope}:${target}`, encode(newTraitHash));
  }

  return true;
}

/**
 * Read all cohorts from the index, partitioned by qualifying (≥ min) and sub-threshold.
 * Only runs when the stability window is hit — not on every event.
 */
async function getAllCohorts(
  db: EoDb,
  scope: string,
): Promise<Array<{ traitHash: string; entry: CohortEntry }>> {
  const cohorts: Array<{ traitHash: string; entry: CohortEntry }> = [];
  const prefix = `cryst-cohort:${scope}:`;

  for await (const [key, buf] of db.iterator({ gte: prefix, lte: `${prefix}\xff` })) {
    const entry = decode(buf) as CohortEntry;
    const traitHash = key.slice(prefix.length);
    cohorts.push({ traitHash, entry });
  }

  return cohorts;
}

// ─── Crystallized Entity Target ──────────────────────────────────────

/**
 * Deterministic target for a crystallized cohort.
 * Identity is scope + trait hash — NOT the members.
 */
function crystallizedEntityTarget(scope: string, traitHash: string): string {
  // Use scope + traitHash directly — traitHash is already a sha256 prefix
  const identity = `${scope}|${traitHash}`;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  return `system.cryst.${hash}`;
}

// ─── Reverse Dependency Index ────────────────────────────────────────

async function addReverseDep(db: EoDb, constituent: string, derivedTarget: string): Promise<void> {
  await db.put(`rdep:${constituent}:${derivedTarget}`, encode(derivedTarget));
}

async function removeReverseDep(db: EoDb, constituent: string, derivedTarget: string): Promise<void> {
  try { await db.del(`rdep:${constituent}:${derivedTarget}`); } catch {}
}

// ─── Main Entry Point ────────────────────────────────────────────────

/**
 * Called by the fold after every event. Incremental — O(1) on most events,
 * O(cohorts) when the stability window is hit.
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

  // Update the cohort index for this one target
  const structureChanged = await updateCohortMembership(
    db, rule.scope, changedTarget, currentState, rule,
  );

  const stability = await getStabilityState(db, rule.scope);

  if (structureChanged) {
    // Cohort structure shifted — reset counter, check for zombies
    await setStabilityState(db, {
      scope: rule.scope,
      snapshot_hash: '',
      counter: 0,
      last_seq: triggeringEvent.seq,
    });

    // A member moved between cohorts. The old cohort may have shrunk below
    // min_members. If it had a crystallized entity, mark it inert.
    await retireSubThresholdEntities(db, rule);
  } else {
    // Structure held — increment counter
    const newCounter = (stability?.counter ?? 0) + 1;

    if (newCounter >= rule.window) {
      // Window reached — crystallize qualifying cohorts
      const cohorts = await getAllCohorts(db, rule.scope);
      for (const { traitHash, entry } of cohorts) {
        if (entry.members.length >= rule.min_members) {
          await crystallizeCohort(db, rule, traitHash, entry, triggeringEvent, feed);
        }
      }
      // Reset counter
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

// ─── Zombie Retirement ───────────────────────────────────────────────

/**
 * When a cohort shrinks below min_members, mark its crystallized entity inert.
 * Scans the cohort index (cheap — proportional to distinct cohorts, not records)
 * and checks each sub-threshold cohort for an existing crystallized entity.
 */
async function retireSubThresholdEntities(
  db: EoDb,
  rule: CrystallizationRule,
): Promise<void> {
  const cohorts = await getAllCohorts(db, rule.scope);

  for (const { traitHash, entry } of cohorts) {
    if (entry.members.length >= rule.min_members) continue;

    const derivedTargetId = crystallizedEntityTarget(rule.scope, traitHash);
    let derived: DerivedEntity | null = null;
    try {
      const buf = await db.get(`derived:${derivedTargetId}`);
      derived = decode(buf) as DerivedEntity;
    } catch (e: any) {
      if (e.code === 'LEVEL_NOT_FOUND') continue;
      throw e;
    }

    if (derived && !derived.inert) {
      derived.inert = true;
      await db.put(`derived:${derivedTargetId}`, encode(derived));

      // Mark the state as inert too so Horizon can reflect it
      const existing = await getState(db, derivedTargetId);
      if (existing) {
        await setState(db, {
          ...existing,
          value: { ...existing.value, _inert: true },
        });
      }
    }
  }
}

// ─── Crystallize a Cohort ────────────────────────────────────────────

async function crystallizeCohort(
  db: EoDb,
  rule: CrystallizationRule,
  traitHash: string,
  entry: CohortEntry,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  const derivedTargetId = crystallizedEntityTarget(rule.scope, traitHash);

  const derivedOperand = {
    constituents: entry.members,
    traits: entry.traits,
    scope: rule.scope,
    topology: 'cohort',
  };

  const existing = await getState(db, derivedTargetId);
  const now = new Date().toISOString();

  if (existing) {
    // Already crystallized — update if members changed, revive if inert
    const existingConstituents: string[] = existing.value?.constituents ?? [];
    const wasInert = existing.value?._inert === true;
    const membersMatch =
      existingConstituents.length === entry.members.length &&
      existingConstituents.every((c: string, i: number) => c === entry.members[i]);

    if (membersMatch && !wasInert) return;

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

    // Diff reverse deps
    for (const old of existingConstituents) {
      if (!entry.members.includes(old)) {
        await removeReverseDep(db, old, derivedTargetId);
      }
    }
    for (const member of entry.members) {
      if (!existingConstituents.includes(member)) {
        await addReverseDep(db, member, derivedTargetId);
      }
    }

    // Revive if was inert
    const derived: DerivedEntity = {
      target: derivedTargetId,
      level: existing.level,
      constituents: entry.members,
      topology: 'cohort',
      inert: false,
    };
    await db.put(`derived:${derivedTargetId}`, encode(derived));

    if (feed) feed.notify(updateEvent);
  } else {
    // New crystallization — INS at the next level
    let maxLevel = 1;
    for (const member of entry.members) {
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
      constituents: entry.members,
      topology: 'cohort',
      inert: false,
    };
    await db.put(`derived:${derivedTargetId}`, encode(derived));

    for (const member of entry.members) {
      await addReverseDep(db, member, derivedTargetId);
    }

    if (feed) feed.notify(insEvent);
  }
}
