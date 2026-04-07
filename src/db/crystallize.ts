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
 * Storage keys:
 *   cryst-rule:{scope}           — the crystallization rule
 *   cryst-snap:{scope}           — last-seen structural snapshot hash
 *   cryst-counter:{scope}        — stability counter (how many events the snapshot held)
 *   derived:{target}             — DerivedEntity registration (shared with REC)
 *   rdep:{constituent}:{derived} — reverse dep index (shared with REC)
 */

import { createHash } from 'crypto';
import { EoDb, encode, decode, nextSeq } from './level.js';
import { getState, setState, getStateByPrefix } from './state.js';
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
    await db.del(`cryst-counter:${scope}`);
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
}

/**
 * Find all crystallization rules whose scope is a prefix of the changed target.
 * A target "firm.cases.rec001" matches rules at "firm.cases", "firm", etc.
 */
async function getRulesForTarget(db: EoDb, target: string): Promise<CrystallizationRule[]> {
  const parts = target.split('.');
  const rules: CrystallizationRule[] = [];

  for (let depth = parts.length; depth >= 1; depth--) {
    const scope = parts.slice(0, depth).join('.');
    const rule = await getCrystallizationRule(db, scope);
    if (rule) rules.push(rule);
  }

  return rules;
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

// ─── Cohort Detection ────────────────────────────────────────────────

interface Cohort {
  traitKey: string;                   // e.g. "attorney:sarah|task:research"
  traits: Record<string, any>;        // e.g. { attorney: "sarah", task: "research" }
  members: string[];                  // sorted target paths
}

/**
 * Scan targets under a scope and group them by shared trait values.
 * Returns cohorts with >= min_members.
 */
async function detectCohorts(
  db: EoDb,
  rule: CrystallizationRule,
): Promise<Cohort[]> {
  const allStates = await getStateByPrefix(db, rule.scope + '.');

  // Only consider record-level targets (direct children of the scope)
  const scopeDepth = rule.scope.split('.').length;
  const records = allStates.filter(s => {
    const parts = s.target.split('.');
    return parts.length === scopeDepth + 1 && !s.value?._alias && !s.value?._deleted;
  });

  // Group by trait signature
  const groups = new Map<string, { traits: Record<string, any>; members: string[] }>();

  for (const record of records) {
    const traits = extractRuleTraits(record, rule.traits);
    if (!traits) continue; // record doesn't have all trait fields

    const traitKey = buildTraitKey(traits);

    const existing = groups.get(traitKey);
    if (existing) {
      existing.members.push(record.target);
    } else {
      groups.set(traitKey, { traits, members: [record.target] });
    }
  }

  // Filter by min_members and sort members for deterministic identity
  const cohorts: Cohort[] = [];
  for (const [traitKey, { traits, members }] of groups) {
    if (members.length >= rule.min_members) {
      cohorts.push({ traitKey, traits, members: members.sort() });
    }
  }

  return cohorts;
}

/**
 * Extract the trait values from a record state for the specified trait keys.
 * Returns null if any trait key is missing from the record.
 */
function extractRuleTraits(
  state: EoState,
  traitKeys: string[],
): Record<string, any> | null {
  if (!state.value || typeof state.value !== 'object') return null;

  const traits: Record<string, any> = {};
  for (const key of traitKeys) {
    const val = state.value[key];
    if (val === undefined || val === null) return null;
    traits[key] = val;
  }
  return traits;
}

function buildTraitKey(traits: Record<string, any>): string {
  return Object.keys(traits)
    .sort()
    .map(k => `${k}:${JSON.stringify(traits[k])}`)
    .join('|');
}

// ─── Hash-Stable Detection ──────────────────────────────────────────

/**
 * Snapshot the {target → hash} map for all record-level targets under a scope.
 */
async function snapshotHashes(db: EoDb, scope: string): Promise<string> {
  const allStates = await getStateByPrefix(db, scope + '.');
  const scopeDepth = scope.split('.').length;

  const pairs = allStates
    .filter(s => {
      const parts = s.target.split('.');
      return parts.length === scopeDepth + 1 && !s.value?._alias && !s.value?._deleted;
    })
    .map(s => `${s.target}:${s.hash}`)
    .sort();

  return createHash('sha256').update(pairs.join('|')).digest('hex');
}

// ─── Snapshot Hashing ────────────────────────────────────────────────

/**
 * Hash the cohort structure for comparison.
 * Two identical cohort configurations produce the same hash.
 */
function hashCohortStructure(cohorts: Cohort[]): string {
  const serialized = cohorts
    .map(c => `${c.traitKey}=[${c.members.join(',')}]`)
    .sort()
    .join('||');
  return createHash('sha256').update(serialized || 'empty').digest('hex');
}

// ─── Crystallized Entity Target ──────────────────────────────────────

/**
 * Deterministic target for a crystallized entity.
 * Identity is the cohort's trait key + sorted members.
 * Same cohort reforming → same target (updates, not duplicates).
 */
function crystallizedEntityTarget(scope: string, traitKey: string, members: string[]): string {
  const identity = `${scope}|${traitKey}|${members.join(',')}`;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  return `system.cryst.${hash}`;
}

/**
 * Deterministic target for a hash-stable crystallized entity.
 */
function hashStableEntityTarget(scope: string, targets: string[]): string {
  const identity = `stable|${scope}|${targets.join(',')}`;
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
 * This is not analytics. This is what the fold does when it folds.
 */
export async function detectAndEmitCrystallization(
  db: EoDb,
  changedTarget: string,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  const rules = await getRulesForTarget(db, changedTarget);
  if (rules.length === 0) return;

  for (const rule of rules) {
    if (rule.predicate === 'cohort_forms') {
      await processCohortRule(db, rule, triggeringEvent, feed);
    } else if (rule.predicate === 'hash_stable') {
      await processHashStableRule(db, rule, triggeringEvent, feed);
    }
  }
}

// ─── Cohort Forms ────────────────────────────────────────────────────

async function processCohortRule(
  db: EoDb,
  rule: CrystallizationRule,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  // 1. Detect current cohorts
  const cohorts = await detectCohorts(db, rule);
  const currentHash = hashCohortStructure(cohorts);

  // 2. Compare to stability snapshot
  const stability = await getStabilityState(db, rule.scope);

  if (stability && stability.snapshot_hash === currentHash) {
    // Structure unchanged — increment counter
    const newCounter = stability.counter + 1;
    await setStabilityState(db, {
      scope: rule.scope,
      snapshot_hash: currentHash,
      counter: newCounter,
      last_seq: triggeringEvent.seq,
    });

    // 3. If counter hits window, crystallize
    if (newCounter >= rule.window) {
      for (const cohort of cohorts) {
        await crystallizeCohort(db, rule, cohort, triggeringEvent, feed);
      }
      // Reset counter — the birth of new entities changes the landscape
      await setStabilityState(db, {
        scope: rule.scope,
        snapshot_hash: currentHash,
        counter: 0,
        last_seq: triggeringEvent.seq,
      });
    }
  } else {
    // Structure changed — reset counter, store new snapshot
    await setStabilityState(db, {
      scope: rule.scope,
      snapshot_hash: currentHash,
      counter: 1,
      last_seq: triggeringEvent.seq,
    });
  }
}

async function crystallizeCohort(
  db: EoDb,
  rule: CrystallizationRule,
  cohort: Cohort,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  const derivedTargetId = crystallizedEntityTarget(rule.scope, cohort.traitKey, cohort.members);

  // Determine level: one above the highest constituent
  let maxLevel = 1;
  for (const member of cohort.members) {
    const state = await getState(db, member);
    if (state && state.level > maxLevel) maxLevel = state.level;
  }
  const derivedLevel = maxLevel + 1;

  const derivedOperand = {
    constituents: cohort.members,
    traits: cohort.traits,
    scope: rule.scope,
    topology: 'cohort',
    predicate: rule.predicate,
  };

  const existing = await getState(db, derivedTargetId);
  const now = new Date().toISOString();

  if (existing) {
    // Cohort already crystallized — update with current data
    // Only update if constituent list actually changed
    const existingConstituents = existing.value?.constituents;
    if (Array.isArray(existingConstituents) &&
        existingConstituents.length === cohort.members.length &&
        existingConstituents.every((c: string, i: number) => c === cohort.members[i])) {
      return; // Same cohort, same members — nothing new
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

    // Register as a derived entity — same index as REC-derived
    const derived: DerivedEntity = {
      target: derivedTargetId,
      level: derivedLevel,
      constituents: cohort.members,
      topology: 'cohort',
      inert: false,
    };
    await db.put(`derived:${derivedTargetId}`, encode(derived));

    // Reverse deps: constituent → crystallized entity
    for (const member of cohort.members) {
      await addReverseDep(db, member, derivedTargetId);
    }

    if (feed) feed.notify(insEvent);
  }
}

// ─── Hash Stable ─────────────────────────────────────────────────────

async function processHashStableRule(
  db: EoDb,
  rule: CrystallizationRule,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  // 1. Snapshot current hash map
  const currentHash = await snapshotHashes(db, rule.scope);

  // 2. Compare to stability snapshot
  const stability = await getStabilityState(db, rule.scope);

  if (stability && stability.snapshot_hash === currentHash) {
    const newCounter = stability.counter + 1;
    await setStabilityState(db, {
      scope: rule.scope,
      snapshot_hash: currentHash,
      counter: newCounter,
      last_seq: triggeringEvent.seq,
    });

    if (newCounter >= rule.window) {
      await crystallizeStableSet(db, rule, triggeringEvent, feed);
      await setStabilityState(db, {
        scope: rule.scope,
        snapshot_hash: currentHash,
        counter: 0,
        last_seq: triggeringEvent.seq,
      });
    }
  } else {
    await setStabilityState(db, {
      scope: rule.scope,
      snapshot_hash: currentHash,
      counter: 1,
      last_seq: triggeringEvent.seq,
    });
  }
}

async function crystallizeStableSet(
  db: EoDb,
  rule: CrystallizationRule,
  triggeringEvent: EoEvent,
  feed?: Feed,
): Promise<void> {
  const allStates = await getStateByPrefix(db, rule.scope + '.');
  const scopeDepth = rule.scope.split('.').length;

  const records = allStates.filter(s => {
    const parts = s.target.split('.');
    return parts.length === scopeDepth + 1 && !s.value?._alias && !s.value?._deleted;
  });

  if (records.length < rule.min_members) return;

  const members = records.map(r => r.target).sort();
  const derivedTargetId = hashStableEntityTarget(rule.scope, members);

  let maxLevel = 1;
  for (const r of records) {
    if (r.level > maxLevel) maxLevel = r.level;
  }
  const derivedLevel = maxLevel + 1;

  const derivedOperand = {
    constituents: members,
    scope: rule.scope,
    topology: 'stable',
    predicate: rule.predicate,
  };

  const existing = await getState(db, derivedTargetId);
  const now = new Date().toISOString();

  if (existing) return; // Already crystallized with same members

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
