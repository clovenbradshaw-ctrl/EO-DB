import { describe, it, expect } from 'vitest';
import {
  AirtableApiError,
  RateLimitedError,
  ScopeMissingError,
  UnknownFieldTypeError,
  WebhookGoneError,
  buildAirtableApiError,
} from '../src/shared/airtable/errors.js';
import { mapAirtableType } from '../src/shared/airtable/type-map.js';

describe('AirtableApiError', () => {
  it('preserves status and airtableErrorType on the base class', () => {
    const err = new AirtableApiError('boom', { status: 500, airtableErrorType: 'INTERNAL' });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AirtableApiError);
    expect(err.status).toBe(500);
    expect(err.airtableErrorType).toBe('INTERNAL');
  });
});

describe('buildAirtableApiError', () => {
  it('returns RateLimitedError for 429', () => {
    const err = buildAirtableApiError({ status: 429, message: 'rate' });
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toBeInstanceOf(AirtableApiError);
    expect(err.status).toBe(429);
  });

  it('returns WebhookGoneError for 404 on a webhook call', () => {
    const err = buildAirtableApiError({
      status: 404,
      message: 'Webhook not found',
      isWebhookCall: true,
    });
    expect(err).toBeInstanceOf(WebhookGoneError);
    expect(err.status).toBe(404);
  });

  it('returns plain AirtableApiError for 404 on non-webhook calls', () => {
    const err = buildAirtableApiError({ status: 404, message: 'Record not found' });
    expect(err).not.toBeInstanceOf(WebhookGoneError);
    expect(err).toBeInstanceOf(AirtableApiError);
    expect(err.status).toBe(404);
  });

  it('returns ScopeMissingError for 403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND', () => {
    const err = buildAirtableApiError({
      status: 403,
      message: 'forbidden',
      airtableErrorType: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND',
    });
    expect(err).toBeInstanceOf(ScopeMissingError);
    expect(err.status).toBe(403);
    expect(err.airtableErrorType).toBe('INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND');
  });

  it('returns plain AirtableApiError for other 403 types', () => {
    const err = buildAirtableApiError({
      status: 403,
      message: 'forbidden',
      airtableErrorType: 'OTHER',
    });
    expect(err).not.toBeInstanceOf(ScopeMissingError);
    expect(err).toBeInstanceOf(AirtableApiError);
  });
});

describe('UnknownFieldTypeError', () => {
  it('carries the raw Airtable type string', () => {
    const err = new UnknownFieldTypeError('newExperimentalType');
    expect(err).toBeInstanceOf(Error);
    expect(err.rawType).toBe('newExperimentalType');
    expect(err.message).toContain('newExperimentalType');
  });
});

describe('mapAirtableType', () => {
  it('returns the mapped type for known Airtable types', () => {
    expect(mapAirtableType('singleLineText')).toEqual({ type: 'text' });
    expect(mapAirtableType('multipleRecordLinks')).toEqual({ type: 'linkedRecord' });
  });

  it('returns { type: "text", unknown: rawType } for unmapped types', () => {
    const result = mapAirtableType('someBrandNewType');
    expect(result.type).toBe('text');
    expect(result.unknown).toBe('someBrandNewType');
  });
});
