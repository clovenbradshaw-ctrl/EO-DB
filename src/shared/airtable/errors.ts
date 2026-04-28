/**
 * Typed errors for the Airtable API client.
 *
 * Callers branch on `instanceof` instead of pattern-matching error strings.
 * Every subclass keeps `.status` and `.airtableErrorType` as instance
 * properties so existing duck-typed handlers (e.g. `e.status === 404`)
 * continue to work during migration.
 */

export class AirtableApiError extends Error {
  readonly status: number;
  readonly airtableErrorType?: string;

  constructor(message: string, status: number, airtableErrorType?: string) {
    super(message);
    this.name = 'AirtableApiError';
    this.status = status;
    this.airtableErrorType = airtableErrorType;
  }
}

/**
 * Webhook id is gone from Airtable's side. Seen as:
 *   - 403 with type=INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND on a /webhooks/* path
 *   - 404 on a /webhooks/* path (cursor too old; Airtable GC'd the payloads)
 *
 * The operator-native recovery is to emit REC recognized="webhook_expired" on
 * the webhook site and let the scheduler re-register; callers should NOT
 * retry the same webhook id.
 */
export class WebhookGoneError extends AirtableApiError {
  constructor(message: string, status: number, airtableErrorType?: string) {
    super(message, status, airtableErrorType);
    this.name = 'WebhookGoneError';
  }
}

/**
 * The PAT lacks a scope the request needs (webhook:manage, schema:read, etc.).
 * Distinct from WebhookGoneError because re-registering will also fail — the
 * only fix is a human granting the scope.
 */
export class ScopeMissingError extends AirtableApiError {
  constructor(message: string, status: number, airtableErrorType?: string) {
    super(message, status, airtableErrorType);
    this.name = 'ScopeMissingError';
  }
}

/** 429 retries exhausted. */
export class RateLimitedError extends AirtableApiError {
  constructor(message: string) {
    super(message, 429, 'RATE_LIMITED');
    this.name = 'RateLimitedError';
  }
}

/**
 * 2xx response whose body wasn't JSON. Almost always a proxy / captive portal
 * returning HTML. Kept distinct so the UI can say "we got HTML back" instead
 * of surfacing a cryptic SyntaxError.
 */
export class NonJsonResponseError extends AirtableApiError {
  readonly bodyPreview: string;

  constructor(message: string, status: number, bodyPreview: string) {
    super(message, status);
    this.name = 'NonJsonResponseError';
    this.bodyPreview = bodyPreview;
  }
}

/**
 * The Amino n8n gateway has no op for the requested operation (list bases,
 * fetch a single record by id, webhook lifecycle, create/delete record).
 * Surfaced as 501 in the response observer so the UI can hide affordances
 * for capabilities the gateway intentionally doesn't expose.
 */
export class AminoProxyUnsupportedError extends AirtableApiError {
  constructor(message: string) {
    super(message, 501, 'AMINO_PROXY_UNSUPPORTED');
    this.name = 'AminoProxyUnsupportedError';
  }
}

/**
 * Gateway-level signal that a table can't be incrementally synced because it
 * has no `lastModifiedTime` field. Distinct from a generic AirtableApiError
 * so callers can demote it to a quiet skip rather than treating each tick
 * as a sync failure.
 */
export class NoLastModifiedFieldError extends AirtableApiError {
  readonly tableId?: string;
  readonly tableName?: string;

  constructor(message: string, opts?: { tableId?: string; tableName?: string }) {
    super(message, 422, 'NO_LM_FIELD');
    this.name = 'NoLastModifiedFieldError';
    this.tableId = opts?.tableId;
    this.tableName = opts?.tableName;
  }
}

/**
 * Airtable reported a field type the type-map doesn't know. Thrown only by
 * the strict variant of `mapAirtableType`; the loose variant returns 'text'
 * for back-compat.
 */
export class UnknownFieldTypeError extends Error {
  readonly airtableType: string;

  constructor(airtableType: string) {
    super(`Unknown Airtable field type: ${airtableType}`);
    this.name = 'UnknownFieldTypeError';
    this.airtableType = airtableType;
  }
}
