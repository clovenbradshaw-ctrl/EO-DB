// ─── Deduplication Tools: Three-Tier Model ───────────────────────────────────
// Basic → Intermediate → Advanced dedup configurations that feed candidate
// pairs into the existing SYN operator for merging.

// ─── Tier Classification ───

export type DedupTier = 'basic' | 'intermediate' | 'advanced';

// ─── String Similarity Metrics ───

export type SimilarityMetric =
  // Basic tier — key collision & phonetic
  | 'exact'               // exact string equality
  | 'fingerprint'         // normalized: lowercase, trim, sort tokens, strip punctuation
  | 'ngram-fingerprint'   // n-gram sorted fingerprint
  | 'soundex'             // phonetic encoding (English)
  | 'metaphone'           // phonetic encoding (improved)
  // Intermediate tier — edit distance & token overlap
  | 'levenshtein'         // edit distance (insertions, deletions, substitutions)
  | 'jaro-winkler'        // prefix-weighted similarity (0-1)
  | 'damerau-levenshtein' // edit distance with transpositions
  | 'jaccard'             // token set overlap (Jaccard coefficient)
  | 'dice'                // token set overlap (Dice coefficient)
  | 'cosine'              // TF-IDF cosine similarity
  // Advanced tier — alignment & custom
  | 'affine-gap'          // consecutive gap penalty (Dedupe-style)
  | 'smith-waterman'      // local sequence alignment
  | 'custom';             // user-provided comparison function

// ─── Blocking Strategy ───

export type BlockingMethod =
  | 'none'                // O(n²) — small datasets only
  | 'key'                 // exact key blocking (group by field value)
  | 'sorted-neighborhood' // sliding window over sorted keys
  | 'canopy'              // TF-IDF loose/tight threshold clustering
  | 'lsh';                // locality-sensitive hashing (MinHash signatures)

export interface BlockingRule {
  method: BlockingMethod;
  fields: string[];           // target field paths to block on
  params?: {
    window_size?: number;     // sorted-neighborhood window (default: 10)
    loose_threshold?: number; // canopy loose threshold (default: 0.4)
    tight_threshold?: number; // canopy tight threshold (default: 0.8)
    num_hashes?: number;      // LSH hash count (default: 128)
    bands?: number;           // LSH band count (default: 16)
  };
}

// ─── Field Weighting Mode ───
// Controls how multiple field comparisons combine into an overall score.
//
//   'ranked'   — fields have explicit weights (0-1); weighted sum determines score.
//                Higher-weight fields dominate. A name match matters more than phone.
//
//   'co-equal' — all fields contribute equally; score = simple average of similarities.
//                Every field has the same vote. Good default when you don't know what matters.

export type FieldWeightMode = 'ranked' | 'co-equal';

// ─── Field Comparison Rule ───

export interface FieldComparison {
  field: string;              // dot-path relative to record value (e.g., "name", "address.city")
  metric: SimilarityMetric;
  weight?: number;            // 0-1. Required when mode='ranked'; ignored when mode='co-equal'
  threshold?: number;         // minimum field-level similarity to count as agreement
  params?: {
    ngram_size?: number;      // for ngram-fingerprint (default: 2)
    max_distance?: number;    // for levenshtein: max edit distance for normalization
    prefix_weight?: number;   // for jaro-winkler (default: 0.1)
    gap_open?: number;        // for affine-gap (default: 5)
    gap_extend?: number;      // for affine-gap (default: 1)
    case_sensitive?: boolean; // default: false
  };
  missing_value_handling?: 'skip' | 'disagree' | 'agree'; // when field absent (default: skip)
}

// ─── Dedup Tool Configuration ───

export interface DedupToolConfig {
  id: string;                  // unique identifier
  name: string;                // human-readable name
  tier: DedupTier;
  description?: string;

  // Scope: which records to deduplicate
  scope: {
    collection: string;        // target prefix (e.g., "app.tblClients")
    filter?: Record<string, any>; // optional field-level filter
  };

  // Blocking (candidate generation)
  blocking: BlockingRule[];    // multiple rules = union of candidate pairs

  // Comparison — multiple fields at every tier (basic included)
  comparisons: FieldComparison[];
  field_weight_mode: FieldWeightMode; // 'ranked' = explicit weights, 'co-equal' = uniform 1/N

  // Scoring & thresholds
  scoring: {
    method: 'weighted-sum' | 'fellegi-sunter' | 'classifier';
    auto_merge_threshold: number;    // above this → auto SYN (default: 0.95)
    review_threshold: number;        // above this → queue for review (default: 0.70)
    // below review_threshold → discard as non-match
  };

  // Advanced tier options
  advanced?: {
    use_em?: boolean;                // Expectation-Maximization for parameter estimation
    term_frequency_adjust?: boolean; // weight rare values higher
    active_learning?: boolean;       // present uncertain pairs for labeling
    transitive_closure?: boolean;    // if A=B and B=C then A=C
  };

  // Metadata
  created_by: string;                // agent (Matrix user ID)
  created_at: string;                // ISO 8601
}

// ─── Dedup Candidate (output of comparison) ───

export interface DedupCandidate {
  id: string;                        // deterministic hash of the pair
  target_a: string;                  // first record target
  target_b: string;                  // second record target
  score: number;                     // overall match probability (0-1)
  field_scores: Record<string, number>; // per-field similarity scores
  tool_id: string;                   // which DedupToolConfig produced this
  status: 'pending' | 'approved' | 'rejected' | 'auto_merged';
  reviewed_by?: string;              // agent who reviewed (if manual)
  reviewed_at?: string;
  created_at: string;
}

// ─── Dedup Job (execution of a tool config) ───

export interface DedupJob {
  job_id: string;
  tool_id: string;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  completed_at?: string;
  stats: {
    records_scanned: number;
    pairs_compared: number;          // after blocking reduction
    pairs_total_possible: number;    // n*(n-1)/2 before blocking
    reduction_ratio: number;         // 1 - (compared/total_possible)
    auto_merged: number;
    pending_review: number;
    rejected: number;
  };
  error?: string;
}
