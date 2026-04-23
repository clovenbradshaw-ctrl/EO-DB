/**
 * Unit tests for the shared Airtable client's error classifier.
 *
 * Locks in the boundary between WebhookGoneError (specific id dead) vs
 * WebhookAccessError (token can't manage webhooks at all) so future
 * refactors don't silently reroute the two — they have different recovery
 * semantics (re-register vs. cache-and-give-up).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AirtableClient } from '../src/shared/airtable/client.js';
import {
  AirtableApiError,
  NonJsonResponseError,
  RateLimitedError,
  ScopeMissingError,
  WebhookAccessError,
  WebhookGoneError,
} from '../src/shared/airtable/errors.js';

function mockFetchOnce(response: {
  status: number;
  body: string | object;
  ok?: boolean;
}) {
  const bodyText = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
  const status = response.status;
  const ok = response.ok ?? (status >= 200 && status < 300);
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok,
    status,
    statusText: '',
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
  }) as any);
}

// 429 retries chew through the 4-token burst + an exponential backoff; run
// with `ratePerSec: 1000` so the retry loop doesn't slow the test suite.
function client() {
  return new AirtableClient('pat-fake', 1000);
}

describe('AirtableClient error classification', () => {
  afterEach(() => vi.restoreAllMocks());

  it('404 on a specific webhook id path → WebhookGoneError', async () => {
    mockFetchOnce({
      status: 404,
      body: { error: { type: 'NOT_FOUND', message: 'webhook not found' } },
    });
    const err = await client()
      .listWebhookPayloads('appX', 'achABC123', { cursor: 1 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(WebhookGoneError);
    expect(err).toBeInstanceOf(AirtableApiError);
    expect(err.status).toBe(404);
  });

  it('403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND on a specific webhook id path → WebhookGoneError', async () => {
    mockFetchOnce({
      status: 403,
      body: { error: { type: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND', message: 'gone' } },
    });
    const err = await client()
      .refreshWebhook('appX', 'achABC123')
      .catch((e) => e);
    expect(err).toBeInstanceOf(WebhookGoneError);
    expect(err.airtableErrorType).toBe('INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND');
  });

  it('403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND on the list/create path → WebhookAccessError', async () => {
    mockFetchOnce({
      status: 403,
      body: { error: { type: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND', message: 'scope missing' } },
    });
    const err = await client()
      .createWebhook('appX', { options: { filters: { dataTypes: ['tableData'] } } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(WebhookAccessError);
    // WebhookAccessError must NOT also be a WebhookGoneError — they have
    // different recovery semantics (cache-permanent vs. re-register).
    expect(err).not.toBeInstanceOf(WebhookGoneError);
  });

  it('403 INVALID_PERMISSIONS (bare, no _OR_MODEL_NOT_FOUND) → ScopeMissingError', async () => {
    mockFetchOnce({
      status: 403,
      body: { error: { type: 'INVALID_PERMISSIONS', message: 'missing scope' } },
    });
    const err = await client().listBases().catch((e) => e);
    expect(err).toBeInstanceOf(ScopeMissingError);
    expect(err).not.toBeInstanceOf(WebhookAccessError);
  });

  it('unknown 4xx → plain AirtableApiError (not any webhook/scope subclass)', async () => {
    mockFetchOnce({
      status: 400,
      body: { error: { type: 'INVALID_REQUEST', message: 'bad filter formula' } },
    });
    const err = await client().listBases().catch((e) => e);
    expect(err).toBeInstanceOf(AirtableApiError);
    expect(err).not.toBeInstanceOf(WebhookGoneError);
    expect(err).not.toBeInstanceOf(WebhookAccessError);
    expect(err).not.toBeInstanceOf(ScopeMissingError);
    expect(err.status).toBe(400);
  });

  it('2xx with HTML body → NonJsonResponseError', async () => {
    mockFetchOnce({
      status: 200,
      ok: true,
      body: '<!doctype html><html><body>captive portal</body></html>',
    });
    const err = await client().listBases().catch((e) => e);
    expect(err).toBeInstanceOf(NonJsonResponseError);
    expect(err.bodyPreview).toContain('captive portal');
  });

  it('429 exhausts retries → RateLimitedError', async () => {
    // The 429 retry path uses real setTimeout for exponential backoff
    // (2s + 4s + 8s + 16s by default). Fake timers let the test advance
    // through all four waits synchronously rather than blocking 30s.
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: false,
      status: 429,
      statusText: '',
      text: async () => '{}',
      json: async () => ({}),
    }) as any);
    const promise = client().listBases().catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    vi.useRealTimers();
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.status).toBe(429);
  });
});
