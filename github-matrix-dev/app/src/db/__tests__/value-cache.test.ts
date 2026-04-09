/**
 * Tests for db/value-cache.ts
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createValueCache,
  hasField,
  getFieldValue,
  populateField,
  invalidate,
  evictStale,
} from '../value-cache';

describe('value-cache', () => {
  describe('createValueCache', () => {
    it('returns an empty cache', () => {
      const cache = createValueCache();
      expect(cache.fields.size).toBe(0);
    });
  });

  describe('hasField', () => {
    it('returns false before population', () => {
      const cache = createValueCache();
      expect(hasField(cache, 'age')).toBe(false);
    });

    it('returns true after populateField even with no entries', () => {
      const cache = createValueCache();
      populateField(cache, 'age', []);
      expect(hasField(cache, 'age')).toBe(true);
    });
  });

  describe('getFieldValue', () => {
    it('returns undefined on cache miss', () => {
      const cache = createValueCache();
      expect(getFieldValue(cache, 'alice', 'age')).toBeUndefined();
    });

    it('returns undefined when field is populated but target is absent', () => {
      const cache = createValueCache();
      populateField(cache, 'age', [{ target: 'alice', value: 30 }]);
      expect(getFieldValue(cache, 'bob', 'age')).toBeUndefined();
    });

    it('returns cached value on hit', () => {
      const cache = createValueCache();
      populateField(cache, 'name', [{ target: 'alice', value: 'Alice' }]);
      expect(getFieldValue(cache, 'alice', 'name')).toBe('Alice');
    });

    it('records a lastAccess timestamp on populate', () => {
      const cache = createValueCache();
      const t0 = Date.now();
      populateField(cache, 'score', [{ target: 'x', value: 99 }]);
      expect(cache.fields.get('score')!.lastAccess).toBeGreaterThanOrEqual(t0);
    });
  });

  describe('populateField', () => {
    it('stores multiple entries', () => {
      const cache = createValueCache();
      populateField(cache, 'age', [
        { target: 'alice', value: 30 },
        { target: 'bob', value: 25 },
      ]);
      expect(getFieldValue(cache, 'alice', 'age')).toBe(30);
      expect(getFieldValue(cache, 'bob', 'age')).toBe(25);
    });

    it('subsequent populate extends existing entries', () => {
      const cache = createValueCache();
      populateField(cache, 'age', [{ target: 'alice', value: 30 }]);
      populateField(cache, 'age', [{ target: 'bob', value: 40 }]);
      expect(getFieldValue(cache, 'alice', 'age')).toBe(30);
      expect(getFieldValue(cache, 'bob', 'age')).toBe(40);
    });
  });

  describe('invalidate', () => {
    it('updates an existing cache entry', () => {
      const cache = createValueCache();
      populateField(cache, 'score', [{ target: 'alice', value: 10 }]);
      invalidate(cache, 'alice', 'score', 99);
      expect(getFieldValue(cache, 'alice', 'score')).toBe(99);
    });

    it('is a no-op when field has not been populated', () => {
      const cache = createValueCache();
      invalidate(cache, 'alice', 'age', 30); // field not populated
      expect(hasField(cache, 'age')).toBe(false); // still not populated
    });

    it('adds a new target to an existing field cache', () => {
      const cache = createValueCache();
      populateField(cache, 'score', [{ target: 'alice', value: 10 }]);
      invalidate(cache, 'bob', 'score', 55);
      expect(getFieldValue(cache, 'bob', 'score')).toBe(55);
    });
  });

  describe('evictStale', () => {
    it('removes fields not accessed within maxAgeMs', () => {
      const cache = createValueCache();
      // Populate with a past timestamp
      populateField(cache, 'old-field', [{ target: 'x', value: 1 }]);
      // Manually set lastAccess to the distant past
      cache.fields.get('old-field')!.lastAccess = Date.now() - 60 * 60 * 1000 - 1;

      populateField(cache, 'new-field', [{ target: 'y', value: 2 }]);

      evictStale(cache, 30 * 60 * 1000); // 30 min

      expect(hasField(cache, 'old-field')).toBe(false);
      expect(hasField(cache, 'new-field')).toBe(true);
    });

    it('keeps recently accessed fields', () => {
      const cache = createValueCache();
      populateField(cache, 'recent', [{ target: 'a', value: 1 }]);
      evictStale(cache, 30 * 60 * 1000);
      expect(hasField(cache, 'recent')).toBe(true);
    });

    it('is a no-op on empty cache', () => {
      const cache = createValueCache();
      expect(() => evictStale(cache)).not.toThrow();
    });
  });
});
