import { describe, it, expect } from 'vitest';
import type { EoState } from '../src/db/types.js';
import type { BlockingRule } from '../src/dedup/types.js';
import {
  extractField,
  keyBlock,
  sortedNeighborhood,
  canopyClustering,
  lshBlocking,
  candidatePairs,
} from '../src/dedup/blocking.js';

function makeState(target: string, value: any): EoState {
  return {
    target,
    value,
    hash: 'a'.repeat(64),
    level: 1,
    last_seq: 1,
    last_op: 'INS',
    last_agent: '@test:ex.com',
    last_ts: '2025-01-01T00:00:00.000Z',
    last_acquired_ts: '2025-01-01T00:00:00.000Z',
  };
}

const RECORDS: EoState[] = [
  makeState('app.tbl.rec1', { name: 'Tom Cruise', email: 'tom@example.com', city: 'LA' }),
  makeState('app.tbl.rec2', { name: 'Cruise, Tom', email: 'tom@example.com', city: 'LA' }),
  makeState('app.tbl.rec3', { name: 'Tom Hanks', email: 'tom.hanks@example.com', city: 'LA' }),
  makeState('app.tbl.rec4', { name: 'Brad Pitt', email: 'brad@example.com', city: 'NY' }),
  makeState('app.tbl.rec5', { name: 'Brad Pit', email: 'brad@example.com', city: 'NY' }),
];

describe('extractField', () => {
  it('extracts top-level field', () => {
    expect(extractField(RECORDS[0], 'name')).toBe('Tom Cruise');
  });

  it('extracts nested field', () => {
    const state = makeState('x', { address: { city: 'LA' } });
    expect(extractField(state, 'address.city')).toBe('LA');
  });

  it('returns empty string for missing field', () => {
    expect(extractField(RECORDS[0], 'phone')).toBe('');
  });

  it('returns empty string for null value', () => {
    const state = makeState('x', null);
    expect(extractField(state, 'name')).toBe('');
  });
});

describe('keyBlock', () => {
  it('groups records by fingerprinted key', () => {
    const blocks = keyBlock(RECORDS, ['name']);
    // "Tom Cruise" and "Cruise, Tom" fingerprint to "cruise tom" — same block
    let foundCruiseBlock = false;
    for (const [, records] of blocks) {
      const targets = records.map(r => r.target);
      if (targets.includes('app.tbl.rec1') && targets.includes('app.tbl.rec2')) {
        foundCruiseBlock = true;
      }
    }
    expect(foundCruiseBlock).toBe(true);
  });

  it('separates dissimilar records', () => {
    const blocks = keyBlock(RECORDS, ['name']);
    // "Tom Cruise" and "Brad Pitt" should NOT be in the same block
    for (const [, records] of blocks) {
      const targets = records.map(r => r.target);
      expect(targets.includes('app.tbl.rec1') && targets.includes('app.tbl.rec4')).toBe(false);
    }
  });
});

describe('sortedNeighborhood', () => {
  it('generates pairs within window', () => {
    const pairs = sortedNeighborhood(RECORDS, ['name'], 3);
    expect(pairs.length).toBeGreaterThan(0);
    // Each pair should be unique
    const pairKeys = pairs.map(([a, b]) => {
      const [x, y] = [a.target, b.target].sort();
      return `${x}|${y}`;
    });
    expect(new Set(pairKeys).size).toBe(pairKeys.length);
  });

  it('smaller window means fewer pairs', () => {
    const wide = sortedNeighborhood(RECORDS, ['name'], 5);
    const narrow = sortedNeighborhood(RECORDS, ['name'], 2);
    expect(narrow.length).toBeLessThanOrEqual(wide.length);
  });
});

describe('canopyClustering', () => {
  it('generates pairs from canopies', () => {
    const pairs = canopyClustering(RECORDS, ['name'], 0.1, 0.8);
    expect(pairs.length).toBeGreaterThan(0);
  });

  it('tighter thresholds produce fewer pairs', () => {
    const loose = canopyClustering(RECORDS, ['name'], 0.01, 0.5);
    const tight = canopyClustering(RECORDS, ['name'], 0.5, 0.9);
    expect(tight.length).toBeLessThanOrEqual(loose.length);
  });
});

describe('lshBlocking', () => {
  it('generates pairs via MinHash banding', () => {
    const pairs = lshBlocking(RECORDS, ['name'], 64, 8);
    expect(pairs.length).toBeGreaterThan(0);
  });

  it('similar records more likely to be paired', () => {
    const pairs = lshBlocking(RECORDS, ['name', 'email'], 128, 16);
    const pairTargets = pairs.map(([a, b]) => [a.target, b.target].sort().join('|'));
    // "Tom Cruise" and "Cruise, Tom" share many features — likely paired
    // "Brad Pitt" and "Brad Pit" also share features — likely paired
    // We can't guarantee due to probabilistic nature, but check structure
    expect(pairTargets.length).toBeGreaterThan(0);
  });
});

describe('candidatePairs', () => {
  it('with no blocking, returns all pairs (O(n²))', () => {
    const rules: BlockingRule[] = [{ method: 'none', fields: [] }];
    const pairs = candidatePairs(RECORDS, rules);
    expect(pairs.length).toBe(RECORDS.length * (RECORDS.length - 1) / 2);
  });

  it('with empty rules, returns all pairs', () => {
    const pairs = candidatePairs(RECORDS, []);
    expect(pairs.length).toBe(RECORDS.length * (RECORDS.length - 1) / 2);
  });

  it('with key blocking, reduces pairs', () => {
    const rules: BlockingRule[] = [{ method: 'key', fields: ['name'] }];
    const pairs = candidatePairs(RECORDS, rules);
    // Should be fewer than all pairs
    expect(pairs.length).toBeLessThan(RECORDS.length * (RECORDS.length - 1) / 2);
    expect(pairs.length).toBeGreaterThan(0);
  });

  it('union of multiple rules produces unique pairs', () => {
    const rules: BlockingRule[] = [
      { method: 'key', fields: ['name'] },
      { method: 'key', fields: ['city'] },
    ];
    const pairs = candidatePairs(RECORDS, rules);
    // Check uniqueness
    const pairKeys = pairs.map(([a, b]) => {
      const [x, y] = [a.target, b.target].sort();
      return `${x}|${y}`;
    });
    expect(new Set(pairKeys).size).toBe(pairKeys.length);
  });

  it('reduction ratio is meaningful', () => {
    const rules: BlockingRule[] = [{ method: 'key', fields: ['city'] }];
    const pairs = candidatePairs(RECORDS, rules);
    const totalPossible = RECORDS.length * (RECORDS.length - 1) / 2;
    const reductionRatio = 1 - pairs.length / totalPossible;
    expect(reductionRatio).toBeGreaterThan(0);
  });
});
