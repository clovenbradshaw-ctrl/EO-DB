// ─── Pairwise Comparison Engine ──────────────────────────────────────────────
// Compares two records using FieldComparison[] config, supports ranked and
// co-equal weighting modes, returns scored DedupCandidate.

import { createHash } from 'crypto';
import type { EoState } from '../db/types.js';
import type { DedupToolConfig, DedupCandidate, FieldComparison, FieldWeightMode } from './types.js';
import { computeSimilarity } from './similarity.js';

/**
 * Extract a field value from a record's value object using a dot-path.
 * Returns undefined if the field doesn't exist.
 */
export function extractFieldValue(state: EoState, fieldPath: string): any {
  let val: any = state.value;
  for (const key of fieldPath.split('.')) {
    if (val == null || typeof val !== 'object') return undefined;
    val = val[key];
  }
  return val;
}

/**
 * Compute a deterministic candidate ID from the pair of targets + tool ID.
 */
function candidateId(targetA: string, targetB: string, toolId: string): string {
  const ordered = targetA < targetB ? `${targetA}\0${targetB}` : `${targetB}\0${targetA}`;
  return 'dedup:' + createHash('sha256').update(`${toolId}\0${ordered}`).digest('hex').slice(0, 16);
}

/**
 * Score fields using co-equal mode: simple average of all field scores.
 * Every field has an equal vote — score = sum(scores) / N.
 */
function scoreCoEqual(fieldScores: Record<string, number>, activeFields: string[]): number {
  if (activeFields.length === 0) return 0;
  let sum = 0;
  for (const field of activeFields) {
    sum += fieldScores[field] ?? 0;
  }
  return sum / activeFields.length;
}

/**
 * Score fields using ranked mode: weighted sum normalized by total weight.
 * score = sum(score_i * weight_i) / sum(weight_i)
 */
function scoreRanked(
  fieldScores: Record<string, number>,
  comparisons: FieldComparison[],
  activeFields: string[],
): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const comp of comparisons) {
    const scoreKey = `${comp.field}:${comp.metric}`;
    if (!activeFields.includes(scoreKey)) continue;
    const w = comp.weight ?? 1;
    weightedSum += (fieldScores[scoreKey] ?? 0) * w;
    totalWeight += w;
  }
  return totalWeight === 0 ? 0 : weightedSum / totalWeight;
}

/**
 * Combine per-field similarity scores into an overall score.
 * Dispatches to co-equal or ranked based on the field weight mode.
 */
export function scoreFields(
  fieldScores: Record<string, number>,
  comparisons: FieldComparison[],
  mode: FieldWeightMode,
  activeFields: string[],
): number {
  if (mode === 'co-equal') {
    return scoreCoEqual(fieldScores, activeFields);
  }
  return scoreRanked(fieldScores, comparisons, activeFields);
}

/**
 * Fellegi-Sunter match weight calculation.
 * Uses m-probability (agreement rate among matches) and u-probability
 * (chance agreement among non-matches) to compute a log-likelihood ratio.
 * Returns a normalized 0-1 score.
 */
export function scoreFellegiSunter(
  fieldScores: Record<string, number>,
  comparisons: FieldComparison[],
  mProbs: Record<string, number>,
  uProbs: Record<string, number>,
  activeFields: string[],
): number {
  let logWeight = 0;
  let maxLogWeight = 0;
  let minLogWeight = 0;

  for (const comp of comparisons) {
    const scoreKey = `${comp.field}:${comp.metric}`;
    if (!activeFields.includes(scoreKey)) continue;
    const m = mProbs[scoreKey] ?? mProbs[comp.field] ?? 0.9;
    const u = uProbs[scoreKey] ?? uProbs[comp.field] ?? 0.1;
    const fieldScore = fieldScores[scoreKey] ?? 0;
    const threshold = comp.threshold ?? 0.5;

    // Agree or disagree based on threshold
    if (fieldScore >= threshold) {
      // Agreement weight: log(m/u)
      const w = Math.log2(Math.max(m, 1e-10) / Math.max(u, 1e-10));
      logWeight += w;
    } else {
      // Disagreement weight: log((1-m)/(1-u))
      const w = Math.log2(Math.max(1 - m, 1e-10) / Math.max(1 - u, 1e-10));
      logWeight += w;
    }

    // Track bounds for normalization
    maxLogWeight += Math.log2(Math.max(m, 1e-10) / Math.max(u, 1e-10));
    minLogWeight += Math.log2(Math.max(1 - m, 1e-10) / Math.max(1 - u, 1e-10));
  }

  // Normalize to 0-1
  if (maxLogWeight === minLogWeight) return logWeight >= 0 ? 1 : 0;
  return (logWeight - minLogWeight) / (maxLogWeight - minLogWeight);
}

/**
 * Compare two records and produce a DedupCandidate.
 */
export function compareRecords(
  a: EoState,
  b: EoState,
  config: DedupToolConfig,
  mProbs?: Record<string, number>,
  uProbs?: Record<string, number>,
): DedupCandidate {
  const fieldScores: Record<string, number> = {};
  const activeFields: string[] = [];

  for (const comp of config.comparisons) {
    // Use field:metric as key to support multiple metrics on the same field
    const scoreKey = `${comp.field}:${comp.metric}`;
    const valA = extractFieldValue(a, comp.field);
    const valB = extractFieldValue(b, comp.field);

    // Handle missing values
    if (valA == null || valB == null) {
      const handling = comp.missing_value_handling ?? 'skip';
      if (handling === 'skip') continue;
      if (handling === 'disagree') { fieldScores[scoreKey] = 0; activeFields.push(scoreKey); continue; }
      if (handling === 'agree') { fieldScores[scoreKey] = 1; activeFields.push(scoreKey); continue; }
    }

    const strA = String(valA);
    const strB = String(valB);

    fieldScores[scoreKey] = computeSimilarity(strA, strB, comp.metric, comp.params);
    activeFields.push(scoreKey);
  }

  // Compute overall score
  let score: number;
  if (config.scoring.method === 'fellegi-sunter' && mProbs && uProbs) {
    score = scoreFellegiSunter(fieldScores, config.comparisons, mProbs, uProbs, activeFields);
  } else {
    score = scoreFields(fieldScores, config.comparisons, config.field_weight_mode, activeFields);
  }

  return {
    id: candidateId(a.target, b.target, config.id),
    target_a: a.target < b.target ? a.target : b.target,
    target_b: a.target < b.target ? b.target : a.target,
    score,
    field_scores: fieldScores,
    tool_id: config.id,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
}
