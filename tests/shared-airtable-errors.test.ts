import { describe, it, expect } from 'vitest';
import {
  AirtableApiError,
  NonJsonResponseError,
  RateLimitedError,
  ScopeMissingError,
  UnknownFieldTypeError,
  WebhookGoneError,
} from '../src/shared/airtable/errors.js';
import {
  mapAirtableType,
  mapAirtableTypeOrNull,
  mapAirtableTypeStrict,
} from '../src/shared/airtable/type-map.js';

describe('AirtableApiError', () => {
  it('preserves status and airtableErrorType on the base class', () => {
    const err = new AirtableApiError('boom', 500, 'INTERNAL');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AirtableApiError);
    expect(err.status).toBe(500);
    expect(err.airtableErrorType).toBe('INTERNAL');
  });
});

describe('WebhookGoneError', () => {
  it('is an AirtableApiError carrying the passed status + type', () => {
    const err = new WebhookGoneError('gone', 404, 'MODEL_NOT_FOUND');
    expect(err).toBeInstanceOf(AirtableApiError);
    expect(err).toBeInstanceOf(WebhookGoneError);
    expect(err.status).toBe(404);
    expect(err.airtableErrorType).toBe('MODEL_NOT_FOUND');
  });
});

describe('ScopeMissingError', () => {
  it('is an AirtableApiError preserving 403 + scope type', () => {
    const err = new ScopeMissingError('forbidden', 403, 'INVALID_PERMISSIONS');
    expect(err).toBeInstanceOf(AirtableApiError);
    expect(err).toBeInstanceOf(ScopeMissingError);
    expect(err.status).toBe(403);
    expect(err.airtableErrorType).toBe('INVALID_PERMISSIONS');
  });
});

describe('RateLimitedError', () => {
  it('fixes status to 429 with the documented error type', () => {
    const err = new RateLimitedError('max retries');
    expect(err).toBeInstanceOf(AirtableApiError);
    expect(err.status).toBe(429);
    expect(err.airtableErrorType).toBe('RATE_LIMITED');
  });
});

describe('NonJsonResponseError', () => {
  it('carries the body preview so the UI can show what came back', () => {
    const err = new NonJsonResponseError('HTML body', 200, '<html>...</html>');
    expect(err).toBeInstanceOf(AirtableApiError);
    expect(err.status).toBe(200);
    expect(err.bodyPreview).toBe('<html>...</html>');
  });
});

describe('UnknownFieldTypeError', () => {
  it('carries the raw Airtable type string', () => {
    const err = new UnknownFieldTypeError('newExperimentalType');
    expect(err).toBeInstanceOf(Error);
    expect(err.airtableType).toBe('newExperimentalType');
    expect(err.message).toContain('newExperimentalType');
  });
});

describe('type-map accessors', () => {
  it('mapAirtableType defaults unknown types to "text"', () => {
    expect(mapAirtableType('singleLineText')).toBe('text');
    expect(mapAirtableType('multipleRecordLinks')).toBe('linkedRecord');
    expect(mapAirtableType('someBrandNewType')).toBe('text');
  });

  it('mapAirtableTypeOrNull returns null for unknown types', () => {
    expect(mapAirtableTypeOrNull('singleLineText')).toBe('text');
    expect(mapAirtableTypeOrNull('someBrandNewType')).toBeNull();
  });

  it('mapAirtableTypeStrict throws UnknownFieldTypeError for unknown types', () => {
    expect(mapAirtableTypeStrict('singleLineText')).toBe('text');
    expect(() => mapAirtableTypeStrict('someBrandNewType'))
      .toThrow(UnknownFieldTypeError);
  });
});
