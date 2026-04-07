/**
 * Population-relative entity classification — on-demand, not per-event.
 *
 * Entities are classified as emanon / protogon / holon based on z-scores
 * within their collection (object type), not hardcoded thresholds. A contact
 * is an emanon because it resists convergence *relative to what convergence
 * looks like for contacts*, not because it crosses a universal number.
 *
 * Computed lazily when the UI requests it (horizonGet with classification: true).
 * Population statistics are built from existing fold caches via a single
 * prefix scan, then cached in memory for the session. Zero write-path cost.
 */

import type { EoStore } from './encrypted-store';
import { getStateByPrefix } from './state';
import type {
  EntitySignals, PopulationStats, SpaceStatistics,
  EntityClassification, EntityType, EoStateFold,
} from './types';
import type { Card, Prototype } from './card-encoder';
import { getChunkWriter, extractCard } from './card-encoder';

// ─── Signal Extraction ──────────────────────────────────────────────────

/**
 * Extract the 5 raw signals from an entity's fold cache.
 * These values are meaningless as absolutes — they only gain meaning
 * through z-scores within the entity's population.
 */
function extractEntitySignals(
  fold: EoStateFold,
  card: Card | null,
  proto: Prototype | null,
): EntitySignals {
  // 1. Periodicity: 1 - coefficient_of_variation(intervals).
  let periodicity = 0;
  if (fold.intervalsSorted.length >= 2) {
    const intervals = fold.intervalsSorted;
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const std = Math.sqrt(
      intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length,
    );
    const cv = mean > 0 ? std / mean : 1;
    periodicity = Math.max(0, Math.min(1, 1 - cv));
  }

  // 2. Momentum: recent activity rate relative to total.
  let momentum = 0;
  if (fold.eventCount > 1 && fold.recentTimestamps.length > 0) {
    momentum = fold.recentTimestamps.length / fold.eventCount;
  }

  // 3. Conflict rate: ratio of overwrite ops (DEF+SYN) to total.
  const opCounts = fold.trajectoryFingerprint.opCounts;
  const overwrites = (opCounts['DEF'] ?? 0) + (opCounts['SYN'] ?? 0);
  const conflictRate = fold.eventCount > 0 ? overwrites / fold.eventCount : 0;

  // 4. Convergence: time since last event vs median interval.
  let convergence = 0;
  if (fold.intervalsSorted.length >= 1 && fold.lastEventTs) {
    const median = fold.intervalsSorted[Math.floor(fold.intervalsSorted.length / 2)];
    const timeSinceLast = Date.now() - new Date(fold.lastEventTs).getTime();
    convergence = median > 0 ? Math.min(1, timeSinceLast / (median * 3)) : 0;
  }

  // 5. Diff size: distance from card prototype.
  let diffSize = 0;
  if (card && proto) {
    diffSize = estimateDiffSizeLocal(card, proto);
  }

  return { periodicity, momentum, conflictRate, convergence, diffSize };
}

function estimateDiffSizeLocal(card: Card, proto: Prototype): number {
  let size = 8;
  if (card.dominantCell !== proto.card.dominantCell) size += 1;
  if (card.recentCell   !== proto.card.recentCell)   size += 1;
  if (card.helixReach   !== proto.card.helixReach)   size += 1;
  if (card.cellSpread   !== proto.card.cellSpread)   size += 1;
  if (card.eventCount   !== proto.card.eventCount)   size += 2;
  if (card.graphDegree  !== proto.card.graphDegree)  size += 2;
  return size;
}

// ─── Population Statistics (computed lazily, cached per-session) ─────────

function emptyStats(): PopulationStats {
  return { mean: 0, std: 0, n: 0, m2: 0 };
}

function emptySpaceStats(): SpaceStatistics {
  return {
    periodicity:  emptyStats(),
    momentum:     emptyStats(),
    conflictRate: emptyStats(),
    convergence:  emptyStats(),
    diffSize:     emptyStats(),
  };
}

function welfordUpdate(stats: PopulationStats, value: number): PopulationStats {
  const n = stats.n + 1;
  const delta = value - stats.mean;
  const mean = stats.mean + delta / n;
  const delta2 = value - mean;
  const m2 = stats.m2 + delta * delta2;
  const std = n > 1 ? Math.sqrt(m2 / (n - 1)) : 0;
  return { mean, std, n, m2 };
}

function addSignalsToStats(stats: SpaceStatistics, signals: EntitySignals): SpaceStatistics {
  return {
    periodicity:  welfordUpdate(stats.periodicity,  signals.periodicity),
    momentum:     welfordUpdate(stats.momentum,     signals.momentum),
    conflictRate: welfordUpdate(stats.conflictRate, signals.conflictRate),
    convergence:  welfordUpdate(stats.convergence,  signals.convergence),
    diffSize:     welfordUpdate(stats.diffSize,     signals.diffSize),
  };
}

/** Session cache: collectionPrefix → SpaceStatistics. */
const _localCache = new Map<string, SpaceStatistics>();
let _globalCache: SpaceStatistics | null = null;

/**
 * Build population statistics for a collection by scanning fold caches.
 * O(N) for the collection, but runs at most once per collection per session.
 * Subsequent calls return the cached result.
 */
async function getPopulationStats(
  store: EoStore,
  collectionPrefix: string,
): Promise<{ local: SpaceStatistics; global: SpaceStatistics }> {
  // Return cached if we've already scanned this collection
  if (_localCache.has(collectionPrefix) && _globalCache) {
    return { local: _localCache.get(collectionPrefix)!, global: _globalCache };
  }

  // Scan all sibling records in the collection
  const siblings = await getStateByPrefix(store, collectionPrefix + '.');
  const targetDepth = collectionPrefix.split('.').length + 1;

  let local = emptySpaceStats();
  let global = _globalCache ?? emptySpaceStats();

  for (const sib of siblings) {
    if (sib.target.split('.').length !== targetDepth) continue;
    if (sib.value?._alias) continue;
    if (!sib._fold) continue;

    const signals = extractEntitySignals(sib._fold, null, null);
    local = addSignalsToStats(local, signals);
    global = addSignalsToStats(global, signals);
  }

  _localCache.set(collectionPrefix, local);
  _globalCache = global;
  return { local, global };
}

/** Invalidate cached stats (call after bulk import or data change). */
export function invalidateStatsCache(collectionPrefix?: string): void {
  if (collectionPrefix) {
    _localCache.delete(collectionPrefix);
  } else {
    _localCache.clear();
    _globalCache = null;
  }
}

// ─── Z-Scores ───────────────────────────────────────────────────────────

function zScore(value: number, stats: PopulationStats): number {
  if (stats.std === 0 || stats.n < 2) return 0;
  return (value - stats.mean) / stats.std;
}

function blendedZScore(
  value: number,
  localStats: PopulationStats,
  globalStats: PopulationStats,
): number {
  const localWeight = Math.min(1, localStats.n / 10);
  const globalWeight = 1 - localWeight;
  return zScore(value, localStats) * localWeight + zScore(value, globalStats) * globalWeight;
}

// ─── Classification ─────────────────────────────────────────────────────

const SIGNAL_KEYS: Array<keyof EntitySignals> = [
  'periodicity', 'momentum', 'conflictRate', 'convergence', 'diffSize',
];

function classifyEntity(
  signals: EntitySignals,
  localStats: SpaceStatistics,
  globalStats: SpaceStatistics,
  population: string,
): EntityClassification {
  const populationSize = localStats.periodicity.n;

  if (populationSize < 2) {
    return {
      type: 'protogon', confidence: 0, zScores: {}, signals, population, populationSize,
    };
  }

  const z: Record<string, number> = {};
  for (const key of SIGNAL_KEYS) {
    z[key] = blendedZScore(signals[key], localStats[key], globalStats[key]);
  }

  // Emanon: resists convergence
  const emanonScore = (
    Math.max(0,  z.conflictRate) +
    Math.max(0, -z.periodicity) +
    Math.max(0, -z.convergence) +
    Math.max(0,  z.diffSize)
  ) / 4;

  // Holon: settled, periodic, close to prototype
  const holonScore = (
    Math.max(0,  z.periodicity) +
    Math.max(0,  z.convergence) +
    Math.max(0, -z.diffSize) +
    Math.max(0, -z.conflictRate)
  ) / 4;

  // Protogon: in transition, directional
  const protogonScore = (
    Math.max(0, z.momentum) +
    Math.max(0, -Math.abs(z.periodicity)) +
    Math.max(0, -Math.abs(z.convergence))
  ) / 3;

  const scores = { emanon: emanonScore, holon: holonScore, protogon: protogonScore };
  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const type = sorted[0][0] as EntityType;

  const confidence = sorted[0][1] > 0
    ? (sorted[0][1] - sorted[1][1]) / sorted[0][1]
    : 0;

  return { type, confidence, zScores: z, signals, population, populationSize };
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * On-demand classification for a single entity.
 * Scans the collection once (cached), then classifies this entity
 * against the population. Called from horizonGet when classification: true.
 */
export async function classifyOnDemand(
  store: EoStore,
  target: string,
  fold: EoStateFold,
): Promise<EntityClassification | undefined> {
  const parts = target.split('.');
  if (parts.length < 3) return undefined;

  const collectionPrefix = parts.slice(0, 2).join('.');
  const { local, global } = await getPopulationStats(store, collectionPrefix);

  // Build card + find best prototype for diffSize signal
  let card: Card | null = null;
  let proto: Prototype | null = null;
  const writer = getChunkWriter();
  if (writer) {
    const registry = writer.getRegistry();
    const tmpCard = extractCard(target, {
      seq: 0, op: fold.trajectory[fold.trajectory.length - 1]?.op ?? 'NUL',
      target, operand: null, agent: '', ts: fold.lastEventTs,
      acquired_ts: fold.lastEventTs,
    }, fold, 0);
    card = tmpCard;

    for (const p of registry.prototypes.values()) {
      if (!proto || estimateDiffSizeLocal(tmpCard, p) < estimateDiffSizeLocal(tmpCard, proto)) {
        proto = p;
      }
    }
  }

  const signals = extractEntitySignals(fold, card, proto);
  return classifyEntity(signals, local, global, collectionPrefix);
}
