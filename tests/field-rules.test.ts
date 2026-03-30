import { describe, it, expect } from 'vitest';
import {
  classifyFieldType,
  COMPUTED_TYPES,
  METADATA_TYPES,
  LINK_TYPES,
  SKIP_VALUE_TYPES,
} from '../src/ingestion/field-rules.js';

describe('COMPUTED_TYPES', () => {
  it('contains formula, rollup, lookup, count', () => {
    expect(COMPUTED_TYPES.has('formula')).toBe(true);
    expect(COMPUTED_TYPES.has('rollup')).toBe(true);
    expect(COMPUTED_TYPES.has('lookup')).toBe(true);
    expect(COMPUTED_TYPES.has('count')).toBe(true);
    expect(COMPUTED_TYPES.size).toBe(4);
  });
});

describe('METADATA_TYPES', () => {
  it('contains auto-populated field types', () => {
    expect(METADATA_TYPES.has('createdTime')).toBe(true);
    expect(METADATA_TYPES.has('lastModifiedTime')).toBe(true);
    expect(METADATA_TYPES.has('createdBy')).toBe(true);
    expect(METADATA_TYPES.has('lastModifiedBy')).toBe(true);
    expect(METADATA_TYPES.has('autoNumber')).toBe(true);
    expect(METADATA_TYPES.size).toBe(5);
  });
});

describe('LINK_TYPES', () => {
  it('contains multipleRecordLinks', () => {
    expect(LINK_TYPES.has('multipleRecordLinks')).toBe(true);
    expect(LINK_TYPES.size).toBe(1);
  });
});

describe('SKIP_VALUE_TYPES', () => {
  it('is the union of computed and metadata types', () => {
    for (const t of COMPUTED_TYPES) expect(SKIP_VALUE_TYPES.has(t)).toBe(true);
    for (const t of METADATA_TYPES) expect(SKIP_VALUE_TYPES.has(t)).toBe(true);
    expect(SKIP_VALUE_TYPES.size).toBe(COMPUTED_TYPES.size + METADATA_TYPES.size);
  });
});

describe('classifyFieldType', () => {
  it('classifies computed fields as skip', () => {
    expect(classifyFieldType('formula')).toBe('skip');
    expect(classifyFieldType('rollup')).toBe('skip');
    expect(classifyFieldType('lookup')).toBe('skip');
    expect(classifyFieldType('count')).toBe('skip');
  });

  it('classifies metadata fields as skip', () => {
    expect(classifyFieldType('createdTime')).toBe('skip');
    expect(classifyFieldType('lastModifiedTime')).toBe('skip');
    expect(classifyFieldType('autoNumber')).toBe('skip');
  });

  it('classifies link fields as con', () => {
    expect(classifyFieldType('multipleRecordLinks')).toBe('con');
  });

  it('classifies value fields as def', () => {
    expect(classifyFieldType('singleLineText')).toBe('def');
    expect(classifyFieldType('multilineText')).toBe('def');
    expect(classifyFieldType('number')).toBe('def');
    expect(classifyFieldType('checkbox')).toBe('def');
    expect(classifyFieldType('singleSelect')).toBe('def');
    expect(classifyFieldType('multipleSelects')).toBe('def');
    expect(classifyFieldType('date')).toBe('def');
    expect(classifyFieldType('attachment')).toBe('def');
  });

  it('defaults unknown field types to def', () => {
    expect(classifyFieldType('unknownType')).toBe('def');
    expect(classifyFieldType('')).toBe('def');
  });
});
