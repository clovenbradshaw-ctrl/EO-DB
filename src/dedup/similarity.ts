// ─── String Similarity Functions ─────────────────────────────────────────────
// Pure functions implementing all SimilarityMetric values. No DB dependency.

import type { SimilarityMetric, FieldComparison } from './types.js';

// ─── Basic Tier: Key Collision & Phonetic ────────────────────────────────────

/**
 * Fingerprint: normalize a string into a canonical key.
 * Lowercase → strip punctuation → tokenize on whitespace → sort → join.
 * "Cruise, Tom" and "Tom Cruise" both become "cruise tom".
 */
export function fingerprint(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')  // strip punctuation (Unicode-aware)
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * N-gram fingerprint: extract character n-grams, deduplicate, sort, join.
 * Catches spelling variants like "Krzysztof"/"Krzystof".
 */
export function ngramFingerprint(s: string, n: number = 2): string {
  const normalized = s.toLowerCase().replace(/\s+/g, '');
  if (normalized.length < n) return normalized;
  const ngrams = new Set<string>();
  for (let i = 0; i <= normalized.length - n; i++) {
    ngrams.add(normalized.slice(i, i + n));
  }
  return [...ngrams].sort().join('');
}

/**
 * Soundex: classic phonetic algorithm (1918).
 * Returns 4-character code (letter + 3 digits).
 */
export function soundex(s: string): string {
  const clean = s.toUpperCase().replace(/[^A-Z]/g, '');
  if (!clean) return '0000';

  const map: Record<string, string> = {
    B: '1', F: '1', P: '1', V: '1',
    C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
    D: '3', T: '3',
    L: '4',
    M: '5', N: '5',
    R: '6',
  };

  let code = clean[0];
  let prev = map[clean[0]] || '0';

  for (let i = 1; i < clean.length && code.length < 4; i++) {
    const digit = map[clean[i]];
    if (digit && digit !== prev) {
      code += digit;
    }
    prev = digit || '0';
  }

  return code.padEnd(4, '0');
}

/**
 * Metaphone: improved phonetic algorithm.
 * Simplified implementation covering common English transformations.
 */
export function metaphone(s: string): string {
  let word = s.toUpperCase().replace(/[^A-Z]/g, '');
  if (!word) return '';

  // Drop initial silent letters
  if (/^(KN|GN|PN|AE|WR)/.test(word)) word = word.slice(1);

  let result = '';
  let i = 0;

  while (i < word.length && result.length < 6) {
    const c = word[i];
    const next = word[i + 1] || '';
    const prev = i > 0 ? word[i - 1] : '';

    // Skip duplicate adjacent letters (except C)
    if (c === prev && c !== 'C') { i++; continue; }

    switch (c) {
      case 'A': case 'E': case 'I': case 'O': case 'U':
        if (i === 0) result += c;
        break;
      case 'B':
        if (prev !== 'M') result += 'B';
        break;
      case 'C':
        if ('EIY'.includes(next)) result += 'S';
        else result += 'K';
        break;
      case 'D':
        if (next === 'G' && 'EIY'.includes(word[i + 2] || '')) result += 'J';
        else result += 'T';
        break;
      case 'F': result += 'F'; break;
      case 'G':
        if (next === 'H' && !'AEIOU'.includes(word[i + 2] || '')) { i++; break; }
        if (i > 0 && (next === '' || (next === 'N' && (word[i + 2] === '' || !word[i + 2])))) break;
        if ('EIY'.includes(next)) result += 'J';
        else result += 'K';
        break;
      case 'H':
        if ('AEIOU'.includes(next) && !'AEIOU'.includes(prev)) result += 'H';
        break;
      case 'J': result += 'J'; break;
      case 'K':
        if (prev !== 'C') result += 'K';
        break;
      case 'L': result += 'L'; break;
      case 'M': result += 'M'; break;
      case 'N': result += 'N'; break;
      case 'P':
        if (next === 'H') { result += 'F'; i++; }
        else result += 'P';
        break;
      case 'Q': result += 'K'; break;
      case 'R': result += 'R'; break;
      case 'S':
        if (next === 'H' || (next === 'I' && 'AO'.includes(word[i + 2] || ''))) result += 'X';
        else result += 'S';
        break;
      case 'T':
        if (next === 'H') { result += '0'; i++; }
        else if (next === 'I' && 'AO'.includes(word[i + 2] || '')) result += 'X';
        else result += 'T';
        break;
      case 'V': result += 'F'; break;
      case 'W': case 'Y':
        if ('AEIOU'.includes(next)) result += c;
        break;
      case 'X': result += 'KS'; break;
      case 'Z': result += 'S'; break;
    }
    i++;
  }

  return result;
}

// ─── Intermediate Tier: Edit Distance & Token Overlap ────────────────────────

/**
 * Levenshtein edit distance between two strings.
 * Returns the number of single-character edits (insert, delete, substitute).
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  // Use two rows instead of full matrix for O(min(m,n)) space
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,     // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}

/**
 * Normalized Levenshtein similarity (0-1).
 * 1 = identical, 0 = completely different.
 */
export function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * Damerau-Levenshtein distance: Levenshtein + transpositions.
 * "ab" → "ba" costs 1 (transposition), not 2 (substitute+substitute).
 */
export function damerauLevenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (!la) return lb;
  if (!lb) return la;

  // Use 3 rolling rows instead of full (la+1)×(lb+1) matrix — O(lb) space.
  // Row indices: pprev = i-2, prev = i-1, curr = i
  let pprev = new Array(lb + 1).fill(0);
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  let curr = new Array(lb + 1).fill(0);

  // pprev is row 0 (only used when i >= 2, initialised to row -1 sentinel)
  // prev is row 0
  // We swap into prev = row 0 first, then start from i = 1
  // Re-init: prev = row 0
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        curr[j] = Math.min(curr[j], pprev[j - 2] + cost);
      }
    }
    // Rotate rows: pprev ← prev, prev ← curr, curr ← pprev (reused buffer)
    const tmp = pprev;
    pprev = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[lb];
}

export function damerauLevenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - damerauLevenshteinDistance(a, b) / maxLen;
}

/**
 * Jaro similarity.
 * Measures character-level agreement with positional tolerance.
 */
export function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matchWindow = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aMatched = new Array(a.length).fill(false);
  const bMatched = new Array(b.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  return (
    matches / a.length +
    matches / b.length +
    (matches - transpositions / 2) / matches
  ) / 3;
}

/**
 * Jaro-Winkler similarity.
 * Boosts Jaro score when strings share a common prefix (good for names).
 */
export function jaroWinkler(a: string, b: string, prefixWeight: number = 0.1): number {
  const jaro = jaroSimilarity(a, b);

  // Common prefix length (max 4)
  let prefix = 0;
  const maxPrefix = Math.min(4, Math.min(a.length, b.length));
  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }

  return jaro + prefix * prefixWeight * (1 - jaro);
}

/**
 * Tokenize a string into lowercase words.
 */
function tokenize(s: string): string[] {
  return s.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Jaccard coefficient: |intersection| / |union| of token sets.
 */
export function jaccard(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Dice coefficient: 2 * |intersection| / (|A| + |B|) of token sets.
 */
export function dice(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const total = setA.size + setB.size;
  return total === 0 ? 1 : (2 * intersection) / total;
}

/**
 * TF-IDF cosine similarity between two strings (treated as documents).
 * Computes term frequencies, applies IDF weighting from the pair corpus,
 * then returns cosine of the resulting vectors.
 */
export function cosineSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.length === 0 && tokensB.length === 0) return 1;
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  // Term frequency
  const tfA = new Map<string, number>();
  const tfB = new Map<string, number>();
  for (const t of tokensA) tfA.set(t, (tfA.get(t) || 0) + 1);
  for (const t of tokensB) tfB.set(t, (tfB.get(t) || 0) + 1);

  // IDF from this pair (2 documents)
  const allTerms = new Set([...tfA.keys(), ...tfB.keys()]);
  const idf = new Map<string, number>();
  for (const term of allTerms) {
    const df = (tfA.has(term) ? 1 : 0) + (tfB.has(term) ? 1 : 0);
    idf.set(term, Math.log(2 / df) + 1); // smoothed IDF
  }

  // TF-IDF vectors and cosine
  let dot = 0, magA = 0, magB = 0;
  for (const term of allTerms) {
    const wa = (tfA.get(term) || 0) * idf.get(term)!;
    const wb = (tfB.get(term) || 0) * idf.get(term)!;
    dot += wa * wb;
    magA += wa * wa;
    magB += wb * wb;
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Advanced Tier: Alignment Algorithms ─────────────────────────────────────

/**
 * Affine gap distance (normalized to 0-1 similarity).
 * Models consecutive insertions/deletions as cheaper than multiple single ones.
 * gap_open = cost to start a gap, gap_extend = cost to extend an existing gap.
 */
export function affineGapSimilarity(
  a: string, b: string,
  gapOpen: number = 5,
  gapExtend: number = 1,
): number {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;

  // Use 2 rolling rows instead of 3 full (la+1)×(lb+1) matrices — O(lb) space.
  let prevD = new Array(lb + 1).fill(-Infinity);
  let prevP = new Array(lb + 1).fill(-Infinity);
  let prevQ = new Array(lb + 1).fill(-Infinity);
  let currD = new Array(lb + 1).fill(-Infinity);
  let currP = new Array(lb + 1).fill(-Infinity);
  let currQ = new Array(lb + 1).fill(-Infinity);

  prevD[0] = 0;
  for (let j = 1; j <= lb; j++) {
    prevD[j] = -(gapOpen + (j - 1) * gapExtend);
    prevQ[j] = prevD[j];
  }

  for (let i = 1; i <= la; i++) {
    currD[0] = -(gapOpen + (i - 1) * gapExtend);
    currP[0] = currD[0];
    currQ[0] = -Infinity;

    for (let j = 1; j <= lb; j++) {
      const matchScore = a[i - 1] === b[j - 1] ? 1 : -1;
      currP[j] = Math.max(
        prevD[j] - gapOpen,
        prevP[j] - gapExtend,
      );
      currQ[j] = Math.max(
        currD[j - 1] - gapOpen,
        currQ[j - 1] - gapExtend,
      );
      currD[j] = Math.max(
        prevD[j - 1] + matchScore,
        currP[j],
        currQ[j],
      );
    }

    // Swap rows
    [prevD, currD] = [currD, prevD];
    [prevP, currP] = [currP, prevP];
    [prevQ, currQ] = [currQ, prevQ];
  }

  const rawScore = prevD[lb];
  const maxPossible = Math.min(la, lb); // best case: all matches
  const minPossible = -Math.max(la, lb); // worst case
  if (maxPossible === minPossible) return rawScore >= 0 ? 1 : 0;
  return (rawScore - minPossible) / (maxPossible - minPossible);
}

/**
 * Smith-Waterman local alignment (normalized to 0-1 similarity).
 * Finds the best matching subsequence — useful for partial matches in longer text.
 */
export function smithWatermanSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;

  const matchScore = 2;
  const mismatchPenalty = -1;
  const gapPenalty = -1;

  // Use 2 rolling rows instead of full (la+1)×(lb+1) matrix — O(lb) space.
  let prev = new Array(lb + 1).fill(0);
  let curr = new Array(lb + 1).fill(0);
  let maxScore = 0;

  for (let i = 1; i <= la; i++) {
    curr[0] = 0;
    for (let j = 1; j <= lb; j++) {
      const match = prev[j - 1] + (a[i - 1] === b[j - 1] ? matchScore : mismatchPenalty);
      const del = prev[j] + gapPenalty;
      const ins = curr[j - 1] + gapPenalty;
      curr[j] = Math.max(0, match, del, ins);
      if (curr[j] > maxScore) maxScore = curr[j];
    }
    [prev, curr] = [curr, prev];
  }

  const maxPossible = Math.min(la, lb) * matchScore;
  return maxPossible === 0 ? 0 : maxScore / maxPossible;
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Compute similarity between two strings using the specified metric.
 * Returns a value between 0 (no similarity) and 1 (identical).
 *
 * For key-collision metrics (fingerprint, soundex, metaphone), returns 1 if
 * the canonical forms match, 0 otherwise.
 */
export function computeSimilarity(
  a: string,
  b: string,
  metric: SimilarityMetric,
  params?: FieldComparison['params'],
): number {
  const caseSensitive = params?.case_sensitive ?? false;
  const sa = caseSensitive ? a : a.toLowerCase();
  const sb = caseSensitive ? b : b.toLowerCase();

  switch (metric) {
    case 'exact':
      return sa === sb ? 1 : 0;

    case 'fingerprint':
      return fingerprint(a) === fingerprint(b) ? 1 : 0;

    case 'ngram-fingerprint':
      return ngramFingerprint(a, params?.ngram_size ?? 2) === ngramFingerprint(b, params?.ngram_size ?? 2) ? 1 : 0;

    case 'soundex':
      return soundex(a) === soundex(b) ? 1 : 0;

    case 'metaphone':
      return metaphone(a) === metaphone(b) ? 1 : 0;

    case 'levenshtein':
      return levenshteinSimilarity(sa, sb);

    case 'jaro-winkler':
      return jaroWinkler(sa, sb, params?.prefix_weight ?? 0.1);

    case 'damerau-levenshtein':
      return damerauLevenshteinSimilarity(sa, sb);

    case 'jaccard':
      return jaccard(a, b);

    case 'dice':
      return dice(a, b);

    case 'cosine':
      return cosineSimilarity(a, b);

    case 'affine-gap':
      return affineGapSimilarity(sa, sb, params?.gap_open ?? 5, params?.gap_extend ?? 1);

    case 'smith-waterman':
      return smithWatermanSimilarity(sa, sb);

    case 'custom':
      throw new Error('Custom metric requires a user-provided comparison function');

    default:
      throw new Error(`Unknown similarity metric: ${metric}`);
  }
}
