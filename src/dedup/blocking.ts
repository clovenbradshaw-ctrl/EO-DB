// ─── Blocking Strategy Implementations ───────────────────────────────────────
// Partition records so only likely matches are compared, reducing O(n²) to tractable.

import type { EoState } from '../db/types.js';
import type { BlockingRule } from './types.js';
import { fingerprint } from './similarity.js';

/**
 * Extract a field value from a record's value object using a dot-path.
 * Returns empty string if the field doesn't exist.
 */
export function extractField(state: EoState, fieldPath: string): string {
  let val: any = state.value;
  for (const key of fieldPath.split('.')) {
    if (val == null || typeof val !== 'object') return '';
    val = val[key];
  }
  return val == null ? '' : String(val);
}

/**
 * Build a blocking key from multiple fields by concatenating their fingerprints.
 */
function buildBlockingKey(state: EoState, fields: string[]): string {
  return fields.map(f => fingerprint(extractField(state, f))).join('|');
}

// ─── Key Blocking ────────────────────────────────────────────────────────────
// Group records by exact blocking key. Only records in the same group are compared.

export function keyBlock(records: EoState[], fields: string[]): Map<string, EoState[]> {
  const blocks = new Map<string, EoState[]>();
  for (const rec of records) {
    const key = buildBlockingKey(rec, fields);
    if (!key) continue; // skip records with empty blocking keys
    const existing = blocks.get(key);
    if (existing) existing.push(rec);
    else blocks.set(key, [rec]);
  }
  return blocks;
}

// ─── Sorted Neighborhood ─────────────────────────────────────────────────────
// Sort by blocking key, slide a window, compare records within the window.

export function sortedNeighborhood(
  records: EoState[],
  fields: string[],
  windowSize: number = 10,
): [EoState, EoState][] {
  const keyed = records
    .map(r => ({ key: buildBlockingKey(r, fields), record: r }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const pairs: [EoState, EoState][] = [];
  const seen = new Set<string>();

  for (let i = 0; i < keyed.length; i++) {
    const end = Math.min(i + windowSize, keyed.length);
    for (let j = i + 1; j < end; j++) {
      const pairKey = keyed[i].record.target < keyed[j].record.target
        ? `${keyed[i].record.target}\0${keyed[j].record.target}`
        : `${keyed[j].record.target}\0${keyed[i].record.target}`;
      if (!seen.has(pairKey)) {
        seen.add(pairKey);
        pairs.push([keyed[i].record, keyed[j].record]);
      }
    }
  }

  return pairs;
}

// ─── Canopy Clustering ───────────────────────────────────────────────────────
// Two thresholds: loose (include in canopy) and tight (don't seed new canopy).
// Uses fingerprint distance as a cheap proximity measure.

export function canopyClustering(
  records: EoState[],
  fields: string[],
  looseThreshold: number = 0.4,
  tightThreshold: number = 0.8,
): [EoState, EoState][] {
  // Build token sets for cheap distance computation
  const keyed = records.map(r => ({
    record: r,
    tokens: new Set(buildBlockingKey(r, fields).split(/\s+/).filter(Boolean)),
  }));

  const canopies: number[][] = [];
  const tightAssigned = new Set<number>();

  for (let i = 0; i < keyed.length; i++) {
    if (tightAssigned.has(i)) continue;

    const canopy: number[] = [i];
    for (let j = i + 1; j < keyed.length; j++) {
      if (tightAssigned.has(j)) continue;
      const sim = jaccardTokens(keyed[i].tokens, keyed[j].tokens);
      if (sim >= looseThreshold) {
        canopy.push(j);
        if (sim >= tightThreshold) tightAssigned.add(j);
      }
    }
    canopies.push(canopy);
  }

  // Generate pairs from canopies
  const pairs: [EoState, EoState][] = [];
  const seen = new Set<string>();
  for (const canopy of canopies) {
    for (let i = 0; i < canopy.length; i++) {
      for (let j = i + 1; j < canopy.length; j++) {
        const a = keyed[canopy[i]].record;
        const b = keyed[canopy[j]].record;
        const pairKey = a.target < b.target ? `${a.target}\0${b.target}` : `${b.target}\0${a.target}`;
        if (!seen.has(pairKey)) {
          seen.add(pairKey);
          pairs.push([a, b]);
        }
      }
    }
  }

  return pairs;
}

function jaccardTokens(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

// ─── LSH (Locality-Sensitive Hashing) ────────────────────────────────────────
// MinHash signatures + banding for approximate nearest neighbors.

export function lshBlocking(
  records: EoState[],
  fields: string[],
  numHashes: number = 128,
  bands: number = 16,
): [EoState, EoState][] {
  const rowsPerBand = Math.floor(numHashes / bands);

  // Build shingle sets (character 3-grams from blocking key)
  const shingleSets = records.map(r => {
    const key = buildBlockingKey(r, fields);
    const shingles = new Set<string>();
    for (let i = 0; i <= key.length - 3; i++) {
      shingles.add(key.slice(i, i + 3));
    }
    return shingles;
  });

  // Generate MinHash signatures using random hash functions
  // We use a simple hash: (a * x + b) mod p for random a, b
  const p = 2147483647; // large prime
  const hashParams: [number, number][] = [];
  let seed = 42;
  for (let h = 0; h < numHashes; h++) {
    seed = (seed * 6364136223846793005 + 1) & 0x7fffffff;
    const a = seed;
    seed = (seed * 6364136223846793005 + 1) & 0x7fffffff;
    const b = seed;
    hashParams.push([a, b]);
  }

  function hashShingle(shingle: string, a: number, b: number): number {
    let h = 0;
    for (let i = 0; i < shingle.length; i++) {
      h = (h * 31 + shingle.charCodeAt(i)) & 0x7fffffff;
    }
    return ((a * h + b) & 0x7fffffff) % p;
  }

  // Compute signatures
  const signatures: number[][] = shingleSets.map(shingles => {
    const sig = new Array(numHashes).fill(Infinity);
    for (const shingle of shingles) {
      for (let h = 0; h < numHashes; h++) {
        const hv = hashShingle(shingle, hashParams[h][0], hashParams[h][1]);
        if (hv < sig[h]) sig[h] = hv;
      }
    }
    return sig;
  });

  // Band and bucket
  const pairs: [EoState, EoState][] = [];
  const seen = new Set<string>();

  for (let band = 0; band < bands; band++) {
    const buckets = new Map<string, number[]>();
    const start = band * rowsPerBand;
    const end = start + rowsPerBand;

    for (let i = 0; i < signatures.length; i++) {
      const bandSig = signatures[i].slice(start, end).join(',');
      const existing = buckets.get(bandSig);
      if (existing) existing.push(i);
      else buckets.set(bandSig, [i]);
    }

    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const a = records[bucket[i]];
          const b = records[bucket[j]];
          const pairKey = a.target < b.target ? `${a.target}\0${b.target}` : `${b.target}\0${a.target}`;
          if (!seen.has(pairKey)) {
            seen.add(pairKey);
            pairs.push([a, b]);
          }
        }
      }
    }
  }

  return pairs;
}

// ─── Candidate Pair Generator ────────────────────────────────────────────────
// Applies blocking rules (union of all rules) and returns unique candidate pairs.

export function candidatePairs(
  records: EoState[],
  rules: BlockingRule[],
): [EoState, EoState][] {
  if (rules.length === 0 || rules.every(r => r.method === 'none')) {
    // No blocking — all pairs (O(n²))
    const pairs: [EoState, EoState][] = [];
    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        pairs.push([records[i], records[j]]);
      }
    }
    return pairs;
  }

  const allPairs: [EoState, EoState][] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    let rulePairs: [EoState, EoState][];

    switch (rule.method) {
      case 'none':
        continue; // skip — handled above if all rules are 'none'

      case 'key': {
        const blocks = keyBlock(records, rule.fields);
        rulePairs = [];
        for (const block of blocks.values()) {
          for (let i = 0; i < block.length; i++) {
            for (let j = i + 1; j < block.length; j++) {
              rulePairs.push([block[i], block[j]]);
            }
          }
        }
        break;
      }

      case 'sorted-neighborhood':
        rulePairs = sortedNeighborhood(records, rule.fields, rule.params?.window_size ?? 10);
        break;

      case 'canopy':
        rulePairs = canopyClustering(
          records, rule.fields,
          rule.params?.loose_threshold ?? 0.4,
          rule.params?.tight_threshold ?? 0.8,
        );
        break;

      case 'lsh':
        rulePairs = lshBlocking(
          records, rule.fields,
          rule.params?.num_hashes ?? 128,
          rule.params?.bands ?? 16,
        );
        break;

      default:
        throw new Error(`Unknown blocking method: ${rule.method}`);
    }

    // Deduplicate pairs across rules
    for (const [a, b] of rulePairs) {
      const pairKey = a.target < b.target ? `${a.target}\0${b.target}` : `${b.target}\0${a.target}`;
      if (!seen.has(pairKey)) {
        seen.add(pairKey);
        allPairs.push([a, b]);
      }
    }
  }

  return allPairs;
}
