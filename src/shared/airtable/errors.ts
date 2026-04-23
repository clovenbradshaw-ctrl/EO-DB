/**
 * Typed Airtable API error classes.
 *
 * Replaces string-matching on `e.message?.includes('…')` and probing for an
 * ad-hoc `airtableErrorType` property. Callers should `instanceof` check
 * these subclasses to branch on known failure modes.
 *
 * The HTTP status and Airtable machine-readable error type are always
 * preserved on the base class so the Webhook Health panel (and equivalent
 * server-side telemetry) can render them without re-parsing the message.
 */

/** Base class for every error thrown by the shared Airtable client. */
export class AirtableApiError extends Error {
  readonly status: number;
  readonly airtableErrorType?: string;

  constructor(message: string, opts: { status: number; airtableErrorType?: string }) {
    super(message);
    this.name = 'AirtableApiError';
    this.status = opts.status;
    this.airtableErrorType = opts.airtableErrorType;
  }
}

/**
 * HTTP 404 on a webhooks/payloads call — the webhook was garbage-collected
 * (7-day inactivity window) or the polling cursor has aged out of retention.
 * Callers must wipe local webhook state and trigger a full re-hydration.
 */
export class WebhookGoneError extends AirtableApiError {
  constructor(message: string, opts: { airtableErrorType?: string } = {}) {
    super(message, { status: 404, airtableErrorType: opts.airtableErrorType });
    this.name = 'WebhookGoneError';
  }
}

/**
 * HTTP 429 — hit Airtable's 5 req/sec ceiling. The client's retry loop
 * handles these internally; this class is thrown only when retries are
 * exhausted.
 */
export class RateLimitedError extends AirtableApiError {
  constructor(message: string) {
    super(message, { status: 429 });
    this.name = 'RateLimitedError';
  }
}

/**
 * HTTP 403 with `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` — the PAT is
 * missing the required scope (e.g. `webhook:manage`) or the base isn't in
 * its allowlist. Permanent for the life of the token; callers cache a
 * dismissal so we don't hammer the endpoint every tick.
 */
export class ScopeMissingError extends AirtableApiError {
  constructor(message: string) {
    super(message, { status: 403, airtableErrorType: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND' });
    this.name = 'ScopeMissingError';
  }
}

/**
 * Thrown (or constructed and reported out-of-band) when an Airtable field
 * type has no mapping in `AIRTABLE_TYPE_MAP`. The caller can decide whether
 * to fall back to `'text'` or propagate the error up.
 */
export class UnknownFieldTypeError extends Error {
  readonly rawType: string;

  constructor(rawType: string) {
    super(`Unknown Airtable field type: ${rawType}`);
    this.name = 'UnknownFieldTypeError';
    this.rawType = rawType;
  }
}

/**
 * Build the right subclass for a parsed Airtable error response. Keeps the
 * classification rules in one place so the client and any future writer
 * paths agree on what counts as a `ScopeMissingError` vs a plain 403.
 */
export function buildAirtableApiError(opts: {
  status: number;
  message: string;
  airtableErrorType?: string;
  /** True if this call was a webhooks/payloads request (404 → WebhookGone). */
  isWebhookCall?: boolean;
}): AirtableApiError {
  const { status, message, airtableErrorType, isWebhookCall } = opts;
  if (status === 429) return new RateLimitedError(message);
  if (status === 404 && isWebhookCall) {
    return new WebhookGoneError(message, { airtableErrorType });
  }
  if (status === 403 && airtableErrorType === 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND') {
    return new ScopeMissingError(message);
  }
  return new AirtableApiError(message, { status, airtableErrorType });
}
