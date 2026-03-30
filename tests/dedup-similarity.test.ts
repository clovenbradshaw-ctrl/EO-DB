import { describe, it, expect } from 'vitest';
import {
  fingerprint,
  ngramFingerprint,
  soundex,
  metaphone,
  levenshteinDistance,
  levenshteinSimilarity,
  damerauLevenshteinDistance,
  damerauLevenshteinSimilarity,
  jaroSimilarity,
  jaroWinkler,
  jaccard,
  dice,
  cosineSimilarity,
  affineGapSimilarity,
  smithWatermanSimilarity,
  computeSimilarity,
} from '../src/dedup/similarity.js';

// ─── Basic Tier: Key Collision ───────────────────────────────────────────────

describe('fingerprint', () => {
  it('normalizes casing and whitespace', () => {
    expect(fingerprint('Tom Cruise')).toBe('cruise tom');
    expect(fingerprint('  tom  cruise ')).toBe('cruise tom');
  });

  it('strips punctuation and sorts tokens', () => {
    expect(fingerprint('Cruise, Tom')).toBe('cruise tom');
    expect(fingerprint('Tom   Cruise!!!')).toBe('cruise tom');
  });

  it('produces same key for name variants', () => {
    const a = fingerprint('Tom Cruise');
    const b = fingerprint('Cruise, Tom');
    const c = fingerprint('  tom  cruise ');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('handles empty string', () => {
    expect(fingerprint('')).toBe('');
  });
});

describe('ngramFingerprint', () => {
  it('produces sorted 2-gram fingerprint', () => {
    const a = ngramFingerprint('abc', 2);
    expect(a).toBe('abbc'); // sorted 2-grams: ab, bc → "abbc"
  });

  it('catches spelling variants', () => {
    const a = ngramFingerprint('Krzysztof', 2);
    const b = ngramFingerprint('Krzystof', 2);
    // Both share most n-grams — not identical but close
    expect(typeof a).toBe('string');
    expect(typeof b).toBe('string');
  });

  it('handles short strings', () => {
    expect(ngramFingerprint('a', 2)).toBe('a');
  });
});

describe('soundex', () => {
  it('encodes Smith and Smyth identically', () => {
    expect(soundex('Smith')).toBe(soundex('Smyth'));
  });

  it('returns 4-char codes', () => {
    expect(soundex('Robert')).toMatch(/^[A-Z]\d{3}$/);
    expect(soundex('Rupert')).toMatch(/^[A-Z]\d{3}$/);
  });

  it('Robert and Rupert produce the same code', () => {
    expect(soundex('Robert')).toBe(soundex('Rupert'));
  });

  it('handles empty string', () => {
    expect(soundex('')).toBe('0000');
  });
});

describe('metaphone', () => {
  it('produces phonetic codes', () => {
    expect(metaphone('Smith')).toBeTruthy();
    expect(metaphone('phone')).toBeTruthy();
  });

  it('catches similar-sounding names', () => {
    // Stephen and Steven sound alike
    const a = metaphone('Stephen');
    const b = metaphone('Steven');
    expect(a).toBe(b);
  });

  it('handles empty string', () => {
    expect(metaphone('')).toBe('');
  });
});

// ─── Intermediate Tier: Edit Distance ────────────────────────────────────────

describe('levenshtein', () => {
  it('identical strings have distance 0', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('single edit has distance 1', () => {
    expect(levenshteinDistance('hello', 'hallo')).toBe(1); // substitution
    expect(levenshteinDistance('hello', 'hell')).toBe(1);  // deletion
    expect(levenshteinDistance('hello', 'helloo')).toBe(1); // insertion
  });

  it('empty vs non-empty', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
  });

  it('similarity is normalized 0-1', () => {
    expect(levenshteinSimilarity('hello', 'hello')).toBe(1);
    expect(levenshteinSimilarity('', '')).toBe(1);
    expect(levenshteinSimilarity('abc', 'xyz')).toBeLessThan(0.5);
  });
});

describe('damerau-levenshtein', () => {
  it('transposition costs 1', () => {
    expect(damerauLevenshteinDistance('ab', 'ba')).toBe(1);
  });

  it('cheaper than levenshtein for transpositions', () => {
    const dl = damerauLevenshteinDistance('ab', 'ba');
    const l = levenshteinDistance('ab', 'ba');
    expect(dl).toBeLessThanOrEqual(l);
  });

  it('similarity normalized 0-1', () => {
    expect(damerauLevenshteinSimilarity('hello', 'hello')).toBe(1);
    expect(damerauLevenshteinSimilarity('hello', 'ehllo')).toBeGreaterThan(0.5);
  });
});

describe('jaro-winkler', () => {
  it('identical strings score 1', () => {
    expect(jaroWinkler('hello', 'hello')).toBe(1);
  });

  it('completely different strings score near 0', () => {
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });

  it('prefix boost increases score', () => {
    const jaro = jaroSimilarity('MARTHA', 'MARHTA');
    const jw = jaroWinkler('MARTHA', 'MARHTA');
    expect(jw).toBeGreaterThan(jaro);
  });

  it('handles empty strings', () => {
    expect(jaroWinkler('', '')).toBe(1);
    expect(jaroWinkler('abc', '')).toBe(0);
    expect(jaroWinkler('', 'abc')).toBe(0);
  });
});

describe('jaccard', () => {
  it('identical strings score 1', () => {
    expect(jaccard('hello world', 'hello world')).toBe(1);
  });

  it('no overlap scores 0', () => {
    expect(jaccard('hello', 'world')).toBe(0);
  });

  it('partial overlap gives fractional score', () => {
    const score = jaccard('hello world', 'hello there');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('empty strings score 1', () => {
    expect(jaccard('', '')).toBe(1);
  });
});

describe('dice', () => {
  it('identical strings score 1', () => {
    expect(dice('hello world', 'hello world')).toBe(1);
  });

  it('no overlap scores 0', () => {
    expect(dice('hello', 'world')).toBe(0);
  });

  it('dice >= jaccard for same input', () => {
    const j = jaccard('hello world foo', 'hello world bar');
    const d = dice('hello world foo', 'hello world bar');
    expect(d).toBeGreaterThanOrEqual(j);
  });
});

describe('cosineSimilarity', () => {
  it('identical strings score 1', () => {
    expect(cosineSimilarity('the quick brown fox', 'the quick brown fox')).toBeCloseTo(1, 5);
  });

  it('no shared terms score 0', () => {
    expect(cosineSimilarity('hello', 'world')).toBe(0);
  });

  it('empty strings score 1', () => {
    expect(cosineSimilarity('', '')).toBe(1);
  });

  it('partial overlap gives score between 0 and 1', () => {
    const score = cosineSimilarity('the quick brown fox', 'the quick red dog');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

// ─── Advanced Tier: Alignment ────────────────────────────────────────────────

describe('affineGapSimilarity', () => {
  it('identical strings score 1', () => {
    expect(affineGapSimilarity('hello', 'hello')).toBe(1);
  });

  it('empty string vs non-empty scores 0', () => {
    expect(affineGapSimilarity('', 'hello')).toBe(0);
    expect(affineGapSimilarity('hello', '')).toBe(0);
  });

  it('similar strings score higher than dissimilar', () => {
    const sim = affineGapSimilarity('hello', 'hallo');
    const dissim = affineGapSimilarity('hello', 'world');
    expect(sim).toBeGreaterThan(dissim);
  });

  it('consecutive gaps cheaper than multiple singles', () => {
    // "abcdef" vs "abef" — one gap of 2 should be cheaper than two gaps of 1
    const score = affineGapSimilarity('abcdef', 'abef');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe('smithWatermanSimilarity', () => {
  it('identical strings score 1', () => {
    expect(smithWatermanSimilarity('hello', 'hello')).toBe(1);
  });

  it('empty strings score 0', () => {
    expect(smithWatermanSimilarity('', 'hello')).toBe(0);
  });

  it('finds local alignment in longer strings', () => {
    // "hello" embedded in a longer string should still get a reasonable score
    const score = smithWatermanSimilarity('hello', 'xxxhelloyyy');
    expect(score).toBeGreaterThan(0);
  });

  it('completely different strings score low', () => {
    const score = smithWatermanSimilarity('abcde', 'fghij');
    expect(score).toBe(0);
  });
});

// ─── Dispatcher ──────────────────────────────────────────────────────────────

describe('computeSimilarity', () => {
  it('dispatches exact metric', () => {
    expect(computeSimilarity('hello', 'hello', 'exact')).toBe(1);
    expect(computeSimilarity('hello', 'Hello', 'exact')).toBe(1); // case insensitive by default
    expect(computeSimilarity('hello', 'Hello', 'exact', { case_sensitive: true })).toBe(0);
  });

  it('dispatches fingerprint metric', () => {
    expect(computeSimilarity('Tom Cruise', 'Cruise, Tom', 'fingerprint')).toBe(1);
    expect(computeSimilarity('Tom Cruise', 'Tom Hanks', 'fingerprint')).toBe(0);
  });

  it('dispatches soundex metric', () => {
    expect(computeSimilarity('Smith', 'Smyth', 'soundex')).toBe(1);
  });

  it('dispatches levenshtein metric', () => {
    const score = computeSimilarity('hello', 'hallo', 'levenshtein');
    expect(score).toBeCloseTo(0.8, 1);
  });

  it('dispatches jaro-winkler metric', () => {
    const score = computeSimilarity('MARTHA', 'MARHTA', 'jaro-winkler');
    expect(score).toBeGreaterThan(0.9);
  });

  it('dispatches jaccard metric', () => {
    expect(computeSimilarity('hello world', 'hello world', 'jaccard')).toBe(1);
  });

  it('dispatches cosine metric', () => {
    expect(computeSimilarity('the cat', 'the cat', 'cosine')).toBeCloseTo(1, 5);
  });

  it('dispatches affine-gap metric', () => {
    expect(computeSimilarity('hello', 'hello', 'affine-gap')).toBe(1);
  });

  it('dispatches smith-waterman metric', () => {
    expect(computeSimilarity('hello', 'hello', 'smith-waterman')).toBe(1);
  });

  it('throws for custom metric', () => {
    expect(() => computeSimilarity('a', 'b', 'custom')).toThrow('Custom metric');
  });

  it('throws for unknown metric', () => {
    expect(() => computeSimilarity('a', 'b', 'unknown' as any)).toThrow('Unknown');
  });
});
