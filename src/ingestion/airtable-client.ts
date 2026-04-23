/**
 * Re-export shim. The real implementation lives in `src/shared/airtable/`
 * and is consumed by both the server (here) and the browser app. Typed
 * error classes (WebhookGoneError, ScopeMissingError, RateLimitedError,
 * NonJsonResponseError, AirtableApiError) are re-exported so callers can
 * `instanceof`-check them instead of pattern-matching error strings.
 */

export * from '../shared/airtable/client.js';
export * from '../shared/airtable/errors.js';
