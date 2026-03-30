// ─── Dedup Tool Presets ──────────────────────────────────────────────────────
// Ready-to-use configurations for each tier. Each tier includes both ranked
// and co-equal variants to demonstrate both field weighting modes.

import type { DedupToolConfig } from './types.js';

/**
 * Create a preset with common defaults filled in.
 */
function preset(overrides: Omit<DedupToolConfig, 'created_by' | 'created_at'>): DedupToolConfig {
  return {
    ...overrides,
    created_by: 'system',
    created_at: new Date().toISOString(),
  };
}

// ─── Basic Tier ──────────────────────────────────────────────────────────────

/**
 * Basic — Ranked: Name field weighted higher than email and phonetic.
 * Use when name is the primary discriminator.
 */
export const BASIC_FINGERPRINT_RANKED: DedupToolConfig = preset({
  id: 'basic-fingerprint-ranked',
  name: 'Basic Fingerprint (Ranked)',
  tier: 'basic',
  description: 'Exact and fingerprint matching across name, email, and phonetic code. Name weighted highest.',
  scope: { collection: 'app.tbl' },
  blocking: [{ method: 'key', fields: ['name'] }],
  comparisons: [
    { field: 'name',  metric: 'fingerprint', weight: 0.50 },
    { field: 'email', metric: 'exact',       weight: 0.35 },
    { field: 'name',  metric: 'soundex',     weight: 0.15 },
  ],
  field_weight_mode: 'ranked',
  scoring: {
    method: 'weighted-sum',
    auto_merge_threshold: 0.99,
    review_threshold: 0.80,
  },
});

/**
 * Basic — Co-equal: Every field has the same vote.
 * Use when all fields are equally trustworthy.
 */
export const BASIC_FINGERPRINT_COEQUAL: DedupToolConfig = preset({
  id: 'basic-fingerprint-coequal',
  name: 'Basic Fingerprint (Co-Equal)',
  tier: 'basic',
  description: 'Exact matching on name, email, and phone — all fields vote equally.',
  scope: { collection: 'app.tbl' },
  blocking: [{ method: 'key', fields: ['name'] }],
  comparisons: [
    { field: 'name',  metric: 'fingerprint' },
    { field: 'email', metric: 'exact' },
    { field: 'phone', metric: 'exact' },
  ],
  field_weight_mode: 'co-equal',
  scoring: {
    method: 'weighted-sum',
    auto_merge_threshold: 0.99,
    review_threshold: 0.80,
  },
});

// ─── Intermediate Tier ───────────────────────────────────────────────────────

/**
 * Intermediate — Probabilistic multi-field fuzzy matching with ranked weights.
 * Sorted neighborhood blocking; Fellegi-Sunter scoring with EM.
 */
export const INTERMEDIATE_PROBABILISTIC: DedupToolConfig = preset({
  id: 'intermediate-probabilistic',
  name: 'Intermediate Probabilistic',
  tier: 'intermediate',
  description: 'Fuzzy matching across name, email, address, phone with Fellegi-Sunter scoring and sorted-neighborhood blocking.',
  scope: { collection: 'app.tbl' },
  blocking: [{
    method: 'sorted-neighborhood',
    fields: ['name'],
    params: { window_size: 10 },
  }],
  comparisons: [
    { field: 'name',    metric: 'jaro-winkler', weight: 0.40, threshold: 0.7 },
    { field: 'email',   metric: 'levenshtein',  weight: 0.30, threshold: 0.8 },
    { field: 'address', metric: 'jaccard',       weight: 0.20, threshold: 0.5 },
    { field: 'phone',   metric: 'exact',         weight: 0.10, threshold: 1.0 },
  ],
  field_weight_mode: 'ranked',
  scoring: {
    method: 'fellegi-sunter',
    auto_merge_threshold: 0.92,
    review_threshold: 0.70,
  },
  advanced: {
    use_em: true,
  },
});

/**
 * Intermediate — Co-equal variant for when field importance is unknown.
 */
export const INTERMEDIATE_COEQUAL: DedupToolConfig = preset({
  id: 'intermediate-coequal',
  name: 'Intermediate Fuzzy (Co-Equal)',
  tier: 'intermediate',
  description: 'Fuzzy matching on name, email, address with equal field weights.',
  scope: { collection: 'app.tbl' },
  blocking: [{
    method: 'sorted-neighborhood',
    fields: ['name'],
    params: { window_size: 10 },
  }],
  comparisons: [
    { field: 'name',    metric: 'jaro-winkler', threshold: 0.7 },
    { field: 'email',   metric: 'levenshtein',  threshold: 0.8 },
    { field: 'address', metric: 'jaccard',       threshold: 0.5 },
  ],
  field_weight_mode: 'co-equal',
  scoring: {
    method: 'weighted-sum',
    auto_merge_threshold: 0.92,
    review_threshold: 0.70,
  },
});

// ─── Advanced Tier ───────────────────────────────────────────────────────────

/**
 * Advanced — ML entity resolution with LSH blocking, alignment algorithms,
 * term frequency adjustment, transitive closure, and active learning.
 */
export const ADVANCED_ML_RESOLUTION: DedupToolConfig = preset({
  id: 'advanced-ml-resolution',
  name: 'Advanced ML Entity Resolution',
  tier: 'advanced',
  description: 'Large-scale entity resolution with LSH blocking, affine-gap/cosine comparisons, term frequency weighting, and active learning.',
  scope: { collection: 'app.tbl' },
  blocking: [{
    method: 'lsh',
    fields: ['name', 'email'],
    params: { num_hashes: 128, bands: 16 },
  }],
  comparisons: [
    { field: 'name',        metric: 'affine-gap',   weight: 0.35, params: { gap_open: 5, gap_extend: 1 } },
    { field: 'description', metric: 'cosine',        weight: 0.30 },
    { field: 'email',       metric: 'jaro-winkler',  weight: 0.20 },
    { field: 'address',     metric: 'jaccard',        weight: 0.15 },
  ],
  field_weight_mode: 'ranked',
  scoring: {
    method: 'classifier',
    auto_merge_threshold: 0.95,
    review_threshold: 0.70,
  },
  advanced: {
    use_em: true,
    term_frequency_adjust: true,
    active_learning: true,
    transitive_closure: true,
  },
});

// ─── All Presets ─────────────────────────────────────────────────────────────

export const ALL_PRESETS: DedupToolConfig[] = [
  BASIC_FINGERPRINT_RANKED,
  BASIC_FINGERPRINT_COEQUAL,
  INTERMEDIATE_PROBABILISTIC,
  INTERMEDIATE_COEQUAL,
  ADVANCED_ML_RESOLUTION,
];

/**
 * Get a preset by ID.
 */
export function getPreset(id: string): DedupToolConfig | undefined {
  return ALL_PRESETS.find(p => p.id === id);
}

/**
 * Get all presets for a given tier.
 */
export function getPresetsForTier(tier: DedupToolConfig['tier']): DedupToolConfig[] {
  return ALL_PRESETS.filter(p => p.tier === tier);
}
