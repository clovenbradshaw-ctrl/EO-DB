import { describe, it, expect } from 'vitest';
import {
  isExcluded,
  mergeExclusions,
  EMPTY_EXCLUSIONS,
  type SyncExclusions,
} from '../src/ingestion/exclusions.js';

describe('EMPTY_EXCLUSIONS', () => {
  it('has empty fields and patterns', () => {
    expect(EMPTY_EXCLUSIONS.fields).toEqual([]);
    expect(EMPTY_EXCLUSIONS.patterns).toEqual([]);
  });
});

describe('isExcluded', () => {
  it('returns false with empty exclusions', () => {
    expect(isExcluded('fld123', 'Name', EMPTY_EXCLUSIONS)).toBe(false);
  });

  it('matches exact field ID', () => {
    const excl: SyncExclusions = { fields: ['fld123', 'fld456'], patterns: [] };
    expect(isExcluded('fld123', 'Name', excl)).toBe(true);
    expect(isExcluded('fld999', 'Name', excl)).toBe(false);
  });

  it('matches regex pattern on field ID', () => {
    const excl: SyncExclusions = { fields: [], patterns: ['^fld_temp'] };
    expect(isExcluded('fld_temp_001', 'Name', excl)).toBe(true);
    expect(isExcluded('fld_perm_001', 'Name', excl)).toBe(false);
  });

  it('matches regex pattern on field name', () => {
    const excl: SyncExclusions = { fields: [], patterns: ['Internal'] };
    expect(isExcluded('fld001', 'Internal Notes', excl)).toBe(true);
    expect(isExcluded('fld001', 'Public Notes', excl)).toBe(false);
  });

  it('handles missing patterns array', () => {
    const excl: SyncExclusions = { fields: ['fld1'] };
    expect(isExcluded('fld1', 'Name', excl)).toBe(true);
    expect(isExcluded('fld2', 'Name', excl)).toBe(false);
  });

  it('field ID match takes priority over pattern', () => {
    const excl: SyncExclusions = { fields: ['fld1'], patterns: ['never-matches'] };
    expect(isExcluded('fld1', 'Name', excl)).toBe(true);
  });
});

describe('mergeExclusions', () => {
  it('merges fields from multiple levels', () => {
    const a: SyncExclusions = { fields: ['fld1', 'fld2'], patterns: [] };
    const b: SyncExclusions = { fields: ['fld2', 'fld3'], patterns: [] };
    const merged = mergeExclusions(a, b);
    expect(merged.fields.sort()).toEqual(['fld1', 'fld2', 'fld3']);
  });

  it('merges patterns from multiple levels', () => {
    const a: SyncExclusions = { fields: [], patterns: ['^temp'] };
    const b: SyncExclusions = { fields: [], patterns: ['^internal', '^temp'] };
    const merged = mergeExclusions(a, b);
    expect(merged.patterns!.sort()).toEqual(['^internal', '^temp']);
  });

  it('handles empty exclusions in merge', () => {
    const a: SyncExclusions = { fields: ['fld1'], patterns: ['pat1'] };
    const merged = mergeExclusions(a, EMPTY_EXCLUSIONS);
    expect(merged.fields).toEqual(['fld1']);
    expect(merged.patterns).toEqual(['pat1']);
  });

  it('merges three levels', () => {
    const system: SyncExclusions = { fields: ['sys1'] };
    const base: SyncExclusions = { fields: ['base1'], patterns: ['^skip'] };
    const table: SyncExclusions = { fields: ['tbl1'], patterns: ['^ignore'] };
    const merged = mergeExclusions(system, base, table);
    expect(merged.fields.sort()).toEqual(['base1', 'sys1', 'tbl1']);
    expect(merged.patterns!.sort()).toEqual(['^ignore', '^skip']);
  });
});
