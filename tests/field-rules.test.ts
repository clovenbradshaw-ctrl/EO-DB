import { describe, it, expect } from 'vitest';
import {
  classifyFieldType,
  COMPUTED_TYPES,
  INGESTABLE_METADATA,
  FOLD_METADATA,
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

describe('INGESTABLE_METADATA', () => {
  it('contains factual metadata field types (set once)', () => {
    expect(INGESTABLE_METADATA.has('createdTime')).toBe(true);
    expect(INGESTABLE_METADATA.has('createdBy')).toBe(true);
    expect(INGESTABLE_METADATA.has('autoNumber')).toBe(true);
    expect(INGESTABLE_METADATA.size).toBe(3);
  });
});

describe('FOLD_METADATA', () => {
  it('contains fold-computed metadata field types', () => {
    expect(FOLD_METADATA.has('lastModifiedTime')).toBe(true);
    expect(FOLD_METADATA.has('lastModifiedBy')).toBe(true);
    expect(FOLD_METADATA.size).toBe(2);
  });
});

describe('LINK_TYPES', () => {
  it('contains multipleRecordLinks', () => {
    expect(LINK_TYPES.has('multipleRecordLinks')).toBe(true);
    expect(LINK_TYPES.size).toBe(1);
  });
});

describe('SKIP_VALUE_TYPES', () => {
  it('contains only computed types (not metadata)', () => {
    for (const t of COMPUTED_TYPES) expect(SKIP_VALUE_TYPES.has(t)).toBe(true);
    expect(SKIP_VALUE_TYPES.size).toBe(COMPUTED_TYPES.size);
  });
});

describe('classifyFieldType', () => {
  it('classifies computed fields as skip', () => {
    expect(classifyFieldType('formula')).toBe('skip');
    expect(classifyFieldType('rollup')).toBe('skip');
    expect(classifyFieldType('lookup')).toBe('skip');
    expect(classifyFieldType('count')).toBe('skip');
  });

  it('classifies fold-computed metadata as eva', () => {
    expect(classifyFieldType('lastModifiedTime')).toBe('eva');
    expect(classifyFieldType('lastModifiedBy')).toBe('eva');
  });

  it('classifies ingestable metadata as def', () => {
    expect(classifyFieldType('createdTime')).toBe('def');
    expect(classifyFieldType('createdBy')).toBe('def');
    expect(classifyFieldType('autoNumber')).toBe('def');
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
