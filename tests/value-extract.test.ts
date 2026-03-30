import { describe, it, expect } from 'vitest';
import { extractValue, stableStringify, valuesEqual } from '../src/ingestion/value-extract.js';

describe('extractValue', () => {
  it('returns null for null input', () => {
    expect(extractValue(null, 'singleLineText')).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(extractValue(undefined, 'singleLineText')).toBeNull();
  });

  it('passes through singleSelect as-is', () => {
    const val = { id: 'sel1', name: 'Active', color: 'green' };
    expect(extractValue(val, 'singleSelect')).toEqual(val);
  });

  it('passes through multipleSelects as-is', () => {
    const val = [{ id: 'sel1', name: 'A' }, { id: 'sel2', name: 'B' }];
    expect(extractValue(val, 'multipleSelects')).toEqual(val);
  });

  it('strips display names from multipleRecordLinks, keeps IDs', () => {
    const raw = [
      { id: 'rec001', name: 'Maria Garcia' },
      { id: 'rec002', name: 'John Doe' },
    ];
    expect(extractValue(raw, 'multipleRecordLinks')).toEqual(['rec001', 'rec002']);
  });

  it('handles plain string IDs in multipleRecordLinks', () => {
    const raw = ['rec001', 'rec002'];
    expect(extractValue(raw, 'multipleRecordLinks')).toEqual(['rec001', 'rec002']);
  });

  it('handles non-array multipleRecordLinks gracefully', () => {
    expect(extractValue('single-value', 'multipleRecordLinks')).toBe('single-value');
  });

  it('strips URLs from attachments, keeps identity fields', () => {
    const raw = [
      {
        id: 'att1',
        url: 'https://rotating-url.example.com/file.jpg',
        filename: 'photo.jpg',
        size: 12345,
        type: 'image/jpeg',
        thumbnails: { small: { url: '...' } },
      },
    ];
    const result = extractValue(raw, 'attachment') as any[];
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'att1',
      filename: 'photo.jpg',
      size: 12345,
      type: 'image/jpeg',
    });
    expect(result[0].url).toBeUndefined();
    expect(result[0].thumbnails).toBeUndefined();
  });

  it('handles non-array attachment gracefully', () => {
    expect(extractValue('not-array', 'attachment')).toBe('not-array');
  });

  it('passes through unknown field types as-is', () => {
    const val = { complex: [1, 2, 3] };
    expect(extractValue(val, 'singleLineText')).toEqual(val);
  });
});

describe('stableStringify', () => {
  it('handles null', () => {
    expect(stableStringify(null)).toBe('null');
  });

  it('handles undefined', () => {
    expect(stableStringify(undefined)).toBe('null');
  });

  it('handles primitives', () => {
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(true)).toBe('true');
  });

  it('sorts object keys deterministically', () => {
    const a = stableStringify({ z: 1, a: 2, m: 3 });
    const b = stableStringify({ a: 2, m: 3, z: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"m":3,"z":1}');
  });

  it('handles arrays', () => {
    expect(stableStringify([1, 'two', null])).toBe('[1,"two",null]');
  });

  it('handles nested objects', () => {
    const result = stableStringify({ b: { z: 1, a: 2 }, a: [] });
    expect(result).toBe('{"a":[],"b":{"a":2,"z":1}}');
  });

  it('is deterministic across multiple calls', () => {
    const obj = { name: 'test', values: [3, 1, 2], meta: { x: true } };
    expect(stableStringify(obj)).toBe(stableStringify(obj));
  });
});

describe('valuesEqual', () => {
  it('returns true for identical primitives', () => {
    expect(valuesEqual(42, 42)).toBe(true);
    expect(valuesEqual('hello', 'hello')).toBe(true);
  });

  it('returns true for null == undefined', () => {
    expect(valuesEqual(null, undefined)).toBe(true);
    expect(valuesEqual(undefined, null)).toBe(true);
  });

  it('returns true for null == null', () => {
    expect(valuesEqual(null, null)).toBe(true);
  });

  it('returns true for deep equal objects', () => {
    expect(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('returns false for different values', () => {
    expect(valuesEqual(1, 2)).toBe(false);
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('returns false for different structures', () => {
    expect(valuesEqual({ a: 1 }, [1])).toBe(false);
    expect(valuesEqual('1', 1)).toBe(false);
  });
});
