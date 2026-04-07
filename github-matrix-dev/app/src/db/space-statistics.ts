/**
 * Population-relative entity classification.
 *
 * Entities are classified as emanon / protogon / holon based on z-scores
 * within their collection (object type), not hardcoded thresholds. A contact
 * is an emanon because it resists convergence *relative to what convergence
 * looks like for contacts*, not because it crosses a universal number.
 *
 * Population statistics are maintained incrementally via Welford's online
 * algorithm — no full rescan on each event.
 */

import type { EoStore } from './encrypted-store';
import type {
  EntitySignals, PopulationStats, SpaceStatistics,
  EntityClassification, EntityType, EoStateFold,
} from './types';
import type { Card, Prototype } from './card-encoder';
import { getChunkWriter, extractCard } from './card-encoder';

// ─── Signal Extraction ──────────────────────────────────────────────────

/**
 * Extract the 5 raw signals from an entity's fold cache + card state.
 * These values are meaningless as absolutes — they only gain meaning
 * through z-scores within the entity's population.
 */
export function extractEntitySignals(
  fold: EoStateFold,
  card: Card | null,
  proto: Prototype | null,
): EntitySignals {
  // 1. Periodicity: 1 - coefficient_of_variation(intervals).
  //    High = regular/periodic, Low = chaotic/irregular.
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

  // 2. Momentum: recent activity rate.
  //    High = lots of events recently relative to total.
  let momentum = 0;
  if (fold.eventCount > 1 && fold.recentTimestamps.length > 0) {
    momentum = fold.recentTimestamps.length / fold.eventCount;
  }

  // 3. Conflict rate: ratio of overwrite ops (DEF+SYN) to total.
  //    High = entity's state gets frequently rewritten.
  const opCounts = fold.trajectoryFingerprint.opCounts;
  const overwrites = (opCounts['DEF'] ?? 0) + (opCounts['SYN'] ?? 0);
  const conflictRate = fold.eventCount > 0 ? overwrites / fold.eventCount : 0;

  // 4. Convergence: has the entity settled?
  //    Measured as time-since-last-event relative to median interval.
  //    High = entity hasn't been touched in a while relative to its rhythm.
  let convergence = 0;
  if (fold.intervalsSorted.length >= 1 && fold.lastEventTs) {
    const median = fold.intervalsSorted[Math.floor(fold.intervalsSorted.length / 2)];
    const timeSinceLast = Date.now() - new Date(fold.lastEventTs).getTime();
    convergence = median > 0 ? Math.min(1, timeSinceLast / (median * 3)) : 0;
  }

  // 5. Diff size: distance from card prototype.
  //    High = entity is structurally unusual for its population.
  let diffSize = 0;
  if (card && proto) {
    diffSize = estimateDiffSizeLocal(card, proto);
  }

  return { periodicity, momentum, conflictRate, convergence, diffSize };
}

/** Local estimateDiffSize — avoids circular import from card-encoder. */
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

// ─── Welford's Online Algorithm ─────────────────────────────────────────

function emptyStats(): PopulationStats {
  return { mean: 0, std: 0, n: 0, m2: 0 };
}

export function emptySpaceStats(): SpaceStatistics {
  return {
    periodicity:  emptyStats(),
    momentum:     emptyStats(),
    conflictRate: emptyStats(),
    convergence:  emptyStats(),
    diffSize:     emptyStats(),
  };
}

/** Welford online update — adds one observation to running mean/std. */
function welfordUpdate(stats: PopulationStats, value: number): PopulationStats {
  const n = stats.n + 1;
  const delta = value - stats.mean;
  const mean = stats.mean + delta / n;
  const delta2 = value - mean;
  const m2 = stats.m2 + delta * delta2;
  const std = n > 1 ? Math.sqrt(m2 / (n - 1)) : 0;
  return { mean, std, n, m2 };
}

/** Update all 5 signal stats with a new entity's signals. */
export function updateSpaceStats(
  stats: SpaceStatistics,
  signals: EntitySignals,
): SpaceStatistics {
  return {
    periodicity:  welfordUpdate(stats.periodicity,  signals.periodicity),
    momentum:     welfordUpdate(stats.momentum,     signals.momentum),
    conflictRate: welfordUpdate(stats.conflictRate, signals.conflictRate),
    convergence:  welfordUpdate(stats.convergence,  signals.convergence),
    diffSize:     welfordUpdate(stats.diffSize,     signals.diffSize),
  };
}

// ─── Z-Scores ───────────────────────────────────────────────────────────

function zScore(value: number, stats: PopulationStats): number {
  if (stats.std === 0 || stats.n < 2) return 0;
  return (value - stats.mean) / stats.std;
}

/**
 * Blended z-score for small populations.
 * With <10 entities in a collection, blend local + global z-scores.
 * Full local weight at N=10+.
 */
function blendedZScore(
  value: number,
  localStats: PopulationStats,
  globalStats: PopulationStats,
): number {
  const localWeight = Math.min(1, localStats.n / 10);
  const globalWeight = 1 - localWeight;
  const localZ  = zScore(value, localStats);
  const globalZ = zScore(value, globalStats);
  return localZ * localWeight + globalZ * globalWeight;
}

// ─── Classification ─────────────────────────────────────────────────────

const SIGNAL_KEYS: Array<keyof EntitySignals> = [
  'periodicity', 'momentum', 'conflictRate', 'convergence', 'diffSize',
];

/**
 * Classify an entity relative to its population.
 *
 * - emanon:   resists convergence — high conflict, low periodicity, low convergence
 * - holon:    settled prototype — periodic, converged, small diff from prototype
 * - protogon: in transition — directional momentum, medium on other axes
 */
export function classifyEntity(
  signals: EntitySignals,
  localStats: SpaceStatistics,
  globalStats: SpaceStatistics,
  population: string,
): EntityClassification {
  const populationSize = localStats.periodicity.n;

  // Defer classification until population is large enough
  if (populationSize < 2) {
    return {
      type: 'protogon',
      confidence: 0,
      zScores: {},
      signals,
      population,
      populationSize,
    };
  }

  const z: Record<string, number> = {};
  for (const key of SIGNAL_KEYS) {
    z[key] = blendedZScore(signals[key], localStats[key], globalStats[key]);
  }

  // Emanon: outlier on the hard-to-settle end
  const emanonScore = (
    Math.max(0,  z.conflictRate) +
    Math.max(0, -z.periodicity) +
    Math.max(0, -z.convergence) +
    Math.max(0,  z.diffSize)
  ) / 4;

  // Holon: close to prototype, periodic, converged
  const holonScore = (
    Math.max(0,  z.periodicity) +
    Math.max(0,  z.convergence) +
    Math.max(0, -z.diffSize) +
    Math.max(0, -z.conflictRate)
  ) / 4;

  // Protogon: directional but unsettled
  const protogonScore = (
    Math.max(0, z.momentum) +
    Math.max(0, -Math.abs(z.periodicity)) +
    Math.max(0, -Math.abs(z.convergence))
  ) / 3;

  const scores = { emanon: emanonScore, holon: holonScore, protogon: protogonScore };
  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const type = sorted[0][0] as EntityType;

  // Confidence: how clearly does one type dominate?
  const confidence = sorted[0][1] > 0
    ? (sorted[0][1] - sorted[1][1]) / sorted[0][1]
    : 0;

  return { type, confidence, zScores: z, signals, population, populationSize };
}

// ─── Store Integration ──────────────────────────────────────────────────

/** Global stats across all collections (fallback for small populations). */
let _globalStats: SpaceStatistics = emptySpaceStats();

/** Per-collection stats keyed by collection prefix. */
const _spaceStatsCache = new Map<string, SpaceStatistics>();

/**
 * Load space statistics from the store for a collection prefix.
 * Caches in memory for the session.
 */
export async function getSpaceStats(
  store: EoStore,
  collectionPrefix: string,
): Promise<SpaceStatistics> {
  const cached = _spaceStatsCache.get(collectionPrefix);
  if (cached) return cached;

  const stored = await store.get(`spacestats:${collectionPrefix}`);
  const stats = stored ? (stored as SpaceStatistics) : emptySpaceStats();
  _spaceStatsCache.set(collectionPrefix, stats);
  return stats;
}

export async function getGlobalStats(store: EoStore): Promise<SpaceStatistics> {
  if (_globalStats.periodicity.n > 0) return _globalStats;
  const stored = await store.get('spacestats:_global');
  if (stored) _globalStats = stored as SpaceStatistics;
  return _globalStats;
}

/**
 * Persist updated space statistics after classification.
 * Called from fold-cache after every event on a record-level target.
 */
export async function persistSpaceStats(
  store: EoStore,
  collectionPrefix: string,
  local: SpaceStatistics,
  global: SpaceStatistics,
): Promise<void> {
  _spaceStatsCache.set(collectionPrefix, local);
  _globalStats = global;
  await store.put(`spacestats:${collectionPrefix}`, local);
  await store.put('spacestats:_global', global);
}

/**
 * Full classification pipeline for a single entity.
 * Extracts signals, updates population stats, classifies, persists.
 *
 * Returns the classification result (also stored on the state row
 * by the caller in fold-cache.ts).
 */
export async function classifyAndUpdateStats(
  store: EoStore,
  target: string,
  fold: EoStateFold,
): Promise<EntityClassification | undefined> {
  const parts = target.split('.');
  // Only classify record-level targets (depth 3: "scope.collection.id")
  if (parts.length < 3) return undefined;

  const collectionPrefix = parts.slice(0, 2).join('.');

  // Get card + prototype for diffSize signal
  let card: Card | null = null;
  let proto: Prototype | null = null;
  const writer = getChunkWriter();
  if (writer) {
    const registry = writer.getRegistry();
    // Build a temporary card to get diffSize
    const tmpCard = extractCard(target, {
      seq: 0, op: fold.trajectory[fold.trajectory.length - 1]?.op ?? 'NUL',
      target, operand: null, agent: '', ts: fold.lastEventTs,
      acquired_ts: fold.lastEventTs,
    }, fold, 0);
    card = tmpCard;

    // Find best matching prototype
    for (const p of registry.prototypes.values()) {
      if (!proto || estimateDiffSizeLocal(tmpCard, p) < estimateDiffSizeLocal(tmpCard, proto)) {
        proto = p;
      }
    }
  }

  const signals = extractEntitySignals(fold, card, proto);

  // Update population stats (Welford)
  const localStats = updateSpaceStats(await getSpaceStats(store, collectionPrefix), signals);
  const globalStats = updateSpaceStats(await getGlobalStats(store), signals);

  // Classify
  const classification = classifyEntity(signals, localStats, globalStats, collectionPrefix);

  // Persist stats
  await persistSpaceStats(store, collectionPrefix, localStats, globalStats);

  return classification;
}
