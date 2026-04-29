/**
 * Rate-limited Airtable API client — shared between the Fastify server
 * (src/ingestion) and the browser app (github-matrix-dev/app/src/ingestion).
 *
 * Before this module existed there were two drifting copies; webhook support
 * and error parsing only landed on the browser copy. This file is the single
 * superset. See docs in src/shared/airtable/errors.ts for the typed-error
 * contract that replaces the old `Error & { status?, airtableErrorType? }`
 * duck type.
 *
 * Runtime dependencies: global `fetch` only — works in Node 18+ and browsers.
 */

import {
  AirtableApiError,
  AminoProxyUnsupportedError,
  NoLastModifiedFieldError,
  NonJsonResponseError,
  RateLimitedError,
  ScopeMissingError,
  WebhookGoneError,
} from './errors.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AirtableBase {
  id: string;
  name: string;
  permissionLevel: string;
}

export interface AirtableTable {
  id: string;
  name: string;
  description?: string;
  primaryFieldId: string;
  fields: AirtableField[];
}

export interface AirtableField {
  id: string;
  name: string;
  type: string;
  description?: string;
  options?: Record<string, any>;
}

export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, any>;
}

export interface AirtableListResponse {
  records: AirtableRecord[];
  offset?: string;
}

export interface AirtableBaseSchema {
  tables: AirtableTable[];
}

export interface AirtableBasesResponse {
  bases: AirtableBase[];
  offset?: string;
}

// ─── Webhook types ─────────────────────────────────────────────────────────
//
// The Airtable Webhooks API is the authoritative "what changed" endpoint for
// a base. We register a webhook (no notificationUrl — we poll), then read
// `listWebhookPayloads` with a monotonically-increasing cursor to get every
// change event since the last poll. This replaces the scan-the-whole-table
// `filterByFormula=IS_AFTER(LAST_MODIFIED_TIME(), ...)` approach, which has
// no server-side index and misses changes to computed/linked fields.

/** A single webhook as returned by GET /v0/bases/{baseId}/webhooks. */
export interface AirtableWebhook {
  id: string;
  specification?: AirtableWebhookSpecification;
  notificationUrl?: string | null;
  cursorForNextPayload?: number;
  lastNotificationResult?: unknown;
  areNotificationsEnabled?: boolean;
  expirationTime?: string;
  isHookEnabled?: boolean;
}

export interface AirtableWebhookSpecification {
  options?: {
    filters?: {
      dataTypes?: Array<'tableData' | 'tableFields' | 'tableMetadata'>;
      recordChangeScope?: string;
      watchDataInFieldIds?: string[];
      fromSources?: string[];
    };
    includes?: {
      includeCellValuesInFieldIds?: string[] | 'all';
      includePreviousCellValues?: boolean;
      includePreviousFieldDefinitions?: boolean;
    };
  };
}

export interface AirtableCreateWebhookResponse {
  id: string;
  /** Server-assigned cursor we should poll FROM on the next listPayloads call. */
  cursorForNextPayload?: number;
  expirationTime?: string;
  macSecretBase64?: string;
}

/**
 * A single change payload from the list-payloads endpoint. Payloads are
 * delivered in ascending baseTransactionNumber order; the list response's
 * top-level `cursor` is the value the *next* poll should use.
 */
export interface AirtableWebhookPayload {
  timestamp: string;
  baseTransactionNumber?: number;
  actionMetadata?: { source?: string; sourceMetadata?: Record<string, unknown> };
  payloadFormat?: string;
  changedTablesById?: Record<string, AirtableWebhookTableChange>;
  createdTablesById?: Record<string, unknown>;
  destroyedTableIds?: string[];
  error?: boolean;
  code?: string;
}

export interface AirtableWebhookTableChange {
  /** Newly-inserted records keyed by record id. Contains every cell value. */
  createdRecordsById?: Record<string, {
    createdTime?: string;
    cellValuesByFieldId?: Record<string, unknown>;
  }>;
  /**
   * Edited records keyed by record id. Only the CHANGED fields are present
   * in `current.cellValuesByFieldId`; we refetch the full record so folds
   * see a complete snapshot rather than a sparse diff.
   */
  changedRecordsById?: Record<string, {
    current?: { cellValuesByFieldId?: Record<string, unknown> };
    previous?: { cellValuesByFieldId?: Record<string, unknown> };
    unchanged?: { cellValuesByFieldId?: Record<string, unknown> };
  }>;
  destroyedRecordIds?: string[];
  createdFieldsById?: Record<string, unknown>;
  changedFieldsById?: Record<string, unknown>;
  destroyedFieldIds?: string[];
  changedMetadata?: unknown;
}

export interface AirtableWebhookPayloadsResponse {
  payloads: AirtableWebhookPayload[];
  /** Cursor to use on the *next* call — always advance to this. */
  cursor: number;
  mightHaveMore?: boolean;
  payloadFormat?: string;
}

// ─── Rate limiter ───────────────────────────────────────────────────────────

/**
 * Token-bucket rate limiter. Refills at `rate` tokens per second up to `burst`.
 * Each API call consumes one token; callers await acquire() before firing.
 * Default stays under Airtable's documented 5/sec per-base ceiling.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly rate: number = 4,
    private readonly burst: number = 4,
  ) {
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.rate * 1000);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    this.refill();
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }
}

// ─── Client ─────────────────────────────────────────────────────────────────

const AIRTABLE_API = 'https://api.airtable.com/v0';
const AIRTABLE_META_API = 'https://api.airtable.com/v0/meta';

/**
 * EO/// DB Airtable Gateway — the n8n workflow that brokers every Airtable
 * call for users on the `app.aminoimmigration.com` Matrix homeserver.
 *
 * Auth: the client sends `Authorization: Bearer <matrix_access_token>`. n8n
 * calls `/account/whoami` against the Amino homeserver to validate before
 * forwarding to Airtable with its own OAuth credential — the browser never
 * sees an Airtable PAT.
 *
 * Protocol: not a transparent URL forwarder. Requests are op-routed
 * (`schema | sync | search | update`) and responses are wrapped in a
 * `{ ok, data } | { ok: false, error, detail }` envelope. The `request()`
 * method below translates the AirtableClient's existing URL+method shape
 * into the matching op so callers (paginateRecords, getBaseSchema, etc.)
 * keep working unchanged.
 */
const AIRTABLE_PROXY_WEBHOOK = 'https://n8n.intelechia.com/webhook/eodb/airtable';

/**
 * Marker prefix for the synthetic `offset` we return from Amino-gateway
 * `paginateRecords` so the existing pagination loop keeps calling us. The
 * real value carried is the gateway's `highWaterMark`, which we feed back
 * as `since` on the next op:sync call.
 */
const AMINO_OFFSET_PREFIX = '__amino:';

function safeJsonParse(input: string): unknown {
  try { return JSON.parse(input); } catch { return input; }
}

/**
 * The four URL families the AirtableClient generates against `api.airtable.com`.
 * `parseAirtableUrl` classifies each one so the Amino branch can dispatch to
 * the right gateway op.
 */
type AirtableUrlKind =
  | { kind: 'listBases' }
  | { kind: 'schema'; baseId: string }
  | { kind: 'records'; baseId: string; tableId: string; query: URLSearchParams }
  | { kind: 'record'; baseId: string; tableId: string; recordId: string }
  | { kind: 'webhook'; baseId: string }
  | { kind: 'unknown' };

function parseAirtableUrl(url: string): AirtableUrlKind {
  let u: URL;
  try { u = new URL(url); } catch { return { kind: 'unknown' }; }
  const segs = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  // `meta/bases` and `meta/bases/{baseId}/tables` come from AIRTABLE_META_API,
  // which already includes `/v0/meta` — segs[0] is `v0`.
  if (segs[0] === 'v0' && segs[1] === 'meta' && segs[2] === 'bases') {
    if (segs.length === 3) return { kind: 'listBases' };
    if (segs[4] === 'tables') return { kind: 'schema', baseId: segs[3] };
  }
  if (segs[0] === 'v0' && segs[1] === 'bases' && segs[3] === 'webhooks') {
    return { kind: 'webhook', baseId: segs[2] };
  }
  if (segs[0] === 'v0' && segs.length >= 3) {
    const baseId = segs[1];
    const tableId = decodeURIComponent(segs[2]);
    if (segs.length === 3) return { kind: 'records', baseId, tableId, query: u.searchParams };
    return { kind: 'record', baseId, tableId, recordId: segs[3] };
  }
  return { kind: 'unknown' };
}

/**
 * Pull the ISO timestamp out of the LAST_MODIFIED_TIME filter the sync code
 * builds (`IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE('...'))`). The
 * gateway expects `since` as a top-level body field; the formula text itself
 * is ignored server-side. Returns `undefined` when no usable timestamp is
 * found, which makes op:sync pull every record (initial hydration).
 */
function extractSinceFromFilter(filter: string): string | undefined {
  const m = filter.match(/DATETIME_PARSE\('([^']+)'\)/);
  return m ? m[1] : undefined;
}

/**
 * n8n's Airtable node returns records in the standard `{id, createdTime, fields}`
 * shape. The gateway's `Sync: shape response` code defensively reads both
 * `rec.fields[name]` and `rec[name]`, so to be safe we re-wrap any record
 * whose `fields` is missing into the canonical shape.
 */
function normalizeAminoRecord(rec: any): AirtableRecord {
  if (rec && typeof rec === 'object' && rec.id && rec.fields && typeof rec.fields === 'object') {
    return {
      id: String(rec.id),
      createdTime: typeof rec.createdTime === 'string' ? rec.createdTime : '',
      fields: rec.fields as Record<string, any>,
    };
  }
  const { id, createdTime, ...rest } = rec ?? {};
  return {
    id: String(id ?? ''),
    createdTime: typeof createdTime === 'string' ? createdTime : '',
    fields: rest as Record<string, any>,
  };
}

interface AminoEnvelopeOk<T> { ok: true; data: T }
interface AminoEnvelopeErr { ok: false; error: string; detail?: string }
type AminoEnvelope<T> = AminoEnvelopeOk<T> | AminoEnvelopeErr;

interface AminoSchemaResponse {
  baseId: string;
  tables: AirtableTable[];
  _eoHints?: Record<string, {
    lastModifiedField: { id: string; name: string } | null;
    createdField: { id: string; name: string } | null;
    primaryField: { id: string; name: string } | null;
  }>;
  _eoMeta?: { fetchedAt: string; cacheTtlSec: number; fromCache: boolean; ageSec?: number };
}

interface AminoSyncResponse {
  records: any[];
  count: number;
  highWaterMark: string | null;
  hasMore: boolean;
  /**
   * Airtable's native opaque pagination token, forwarded by the gateway.
   * Present iff there's another page in the SAME (filter+sort) query the
   * gateway issued — that is, iff `hasMore` is true. The client uses this
   * for within-run pagination instead of `highWaterMark`, because Airtable's
   * `IS_AFTER` filter is strict and silently drops records whose
   * `lastModifiedTime` exactly equals the previous page's tail.
   */
  offset: string | null;
  table: string;
  lastModifiedField: string;
}

interface AminoSearchResponse {
  records: any[];
  count: number;
}

/**
 * `/bases/{baseId}/webhooks/{webhookId}` or any deeper path under it.
 * Used to narrow error classification: a 403/404 on a specific webhook id
 * means that id is gone (WebhookGoneError), whereas the same status on the
 * list/create endpoint is about scopes or the base itself.
 */
function isSpecificWebhookPath(url: string): boolean {
  return /\/bases\/[^/?#]+\/webhooks\/[^/?#]+/.test(url);
}

/**
 * Optional callback invoked for every HTTP request the client makes.
 * Wired by `AirtableSyncService` to populate the Webhook Health panel —
 * specifically the "200 OK / 401 Unauthorized" indicator the user sees
 * for the most recent /payloads call.
 *
 * Fires for both success and failure paths. `status` is null when the
 * fetch threw (network error, CORS) before producing a response.
 */
export interface AirtableResponseInfo {
  url: string;
  method: string;
  status: number | null;
  statusText: string | null;
  ok: boolean;
  /** Wall-clock duration in ms from request to response/error. */
  durationMs: number;
  /** Set when the call threw before a response landed. */
  error?: string;
  /**
   * Machine-readable Airtable error type parsed from the `{error: {type}}`
   * body, e.g. `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND`. Lets the UI branch
   * on known failure modes (scope hints) without string-matching.
   */
  errorType?: string;
  /**
   * Set when the response body was non-JSON despite a 2xx status. The first
   * 200 chars of the body are captured so the UI can show the user "we got
   * HTML back" instead of the cryptic SyntaxError.
   */
  nonJsonBodyPreview?: string;
}

/**
 * Extract `{error: {type, message}}` from an Airtable error body. Falls back
 * to the first 200 chars of the raw text when the body isn't the documented
 * shape — callers then get a readable string instead of a JSON dump.
 */
function parseAirtableError(body: string): { message: string; type?: string } {
  try {
    const parsed = JSON.parse(body);
    const err = parsed?.error;
    if (typeof err === 'string') return { message: err };
    if (err && typeof err === 'object') {
      const message = typeof err.message === 'string' && err.message
        ? err.message
        : body.slice(0, 200);
      const type = typeof err.type === 'string' ? err.type : undefined;
      return { message, type };
    }
  } catch { /* non-JSON body */ }
  return { message: body.slice(0, 200) };
}

/**
 * Classify a non-2xx Airtable response into the most specific typed error
 * we can recognize. Callers `instanceof`-check the result. Generic 4xx/5xx
 * falls through to the base `AirtableApiError`.
 */
function classifyError(
  url: string,
  status: number,
  parsed: { message: string; type?: string },
): AirtableApiError {
  const msg = `Airtable API ${status}: ${parsed.message}`;
  // A dead webhook id returns 403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND or
  // 404; the authoritative signal is that the status fires on the id-scoped
  // webhook subpath. PR #624 tried to recognize this via string matching;
  // this check replaces that.
  if (isSpecificWebhookPath(url)) {
    if (status === 404) return new WebhookGoneError(msg, status, parsed.type);
    if (status === 403 && parsed.type === 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND') {
      return new WebhookGoneError(msg, status, parsed.type);
    }
  }
  // PAT is missing a scope (webhook:manage, schema:read, data.records:read, …).
  // Airtable reports this as bare `INVALID_PERMISSIONS`; re-registering a
  // webhook won't help — a human has to grant the scope.
  if (status === 403 && parsed.type === 'INVALID_PERMISSIONS') {
    return new ScopeMissingError(msg, status, parsed.type);
  }
  return new AirtableApiError(msg, status, parsed.type);
}

export type AirtableResponseHook = (info: AirtableResponseInfo) => void;

export class AirtableClient {
  private bucket: TokenBucket;
  private onResponse?: AirtableResponseHook;
  private readonly viaAminoProxy: boolean;
  private readonly aminoBaseId: string | null;

  /**
   * @param apiKey  When `viaAminoProxy` is false (default), an Airtable PAT
   *                sent as a Bearer token to `api.airtable.com`. When
   *                `viaAminoProxy` is true, a Matrix access token for
   *                `app.aminoimmigration.com` that the gateway validates
   *                before forwarding the request with its own Airtable
   *                OAuth credential.
   * @param opts.aminoBaseId  Required when `viaAminoProxy` is true. The
   *                          single Airtable base id the Amino tenant has
   *                          access to (the gateway has no `list bases`
   *                          op, so we synthesize it client-side).
   */
  constructor(
    private readonly apiKey: string,
    ratePerSec: number = 4,
    opts?: { onResponse?: AirtableResponseHook; viaAminoProxy?: boolean; aminoBaseId?: string },
  ) {
    this.bucket = new TokenBucket(ratePerSec, ratePerSec);
    this.onResponse = opts?.onResponse;
    this.viaAminoProxy = opts?.viaAminoProxy === true;
    this.aminoBaseId = opts?.aminoBaseId ?? null;
  }

  /**
   * Replace the response observer after construction. Useful when the
   * client is created before the sync service that wants to listen.
   */
  setResponseHook(hook: AirtableResponseHook | undefined): void {
    this.onResponse = hook;
  }

  /**
   * True when this client routes through the EO/// DB Airtable Gateway
   * instead of `api.airtable.com` directly. Sync code uses this to skip
   * code paths the gateway doesn't expose (webhook lifecycle, snapshot
   * bundle export, etc.) without first eating an AminoProxyUnsupportedError.
   */
  isAminoProxy(): boolean {
    return this.viaAminoProxy;
  }

  private async request<T>(url: string, init?: RequestInit, retries = 3): Promise<T> {
    if (this.viaAminoProxy) {
      return this.requestViaAminoGateway<T>(url, init);
    }
    await this.bucket.acquire();

    for (let attempt = 0; attempt <= retries; attempt++) {
      const startedAt = Date.now();
      const method = (init?.method ?? 'GET').toUpperCase();
      let res: Response;
      try {
        res = await fetch(url, {
          ...init,
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            ...init?.headers,
          },
        });
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        try {
          this.onResponse?.({
            url, method, status: null, statusText: null, ok: false,
            durationMs: Date.now() - startedAt, error: msg,
          });
        } catch { /* observer must never break the request */ }
        throw e;
      }

      if (res.status === 429) {
        try {
          this.onResponse?.({
            url, method, status: 429, statusText: res.statusText, ok: false,
            durationMs: Date.now() - startedAt,
          });
        } catch { /* ignore */ }
        const backoff = Math.pow(2, attempt + 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        const parsed = parseAirtableError(body);
        try {
          this.onResponse?.({
            url, method, status: res.status, statusText: res.statusText, ok: false,
            durationMs: Date.now() - startedAt,
            error: parsed.message,
            errorType: parsed.type,
          });
        } catch { /* ignore */ }
        throw classifyError(url, res.status, parsed);
      }

      // Read body as text first so we can detect HTML-where-JSON-was-expected
      // and surface a typed error rather than the cryptic SyntaxError. This
      // handles the common case where a captive portal / proxy / CDN returns
      // an HTML error page with a 200 status.
      const text = await res.text();
      try {
        const parsed = JSON.parse(text) as T;
        try {
          this.onResponse?.({
            url, method, status: res.status, statusText: res.statusText, ok: true,
            durationMs: Date.now() - startedAt,
          });
        } catch { /* ignore */ }
        return parsed;
      } catch (_jsonErr) {
        const preview = text.slice(0, 200);
        try {
          this.onResponse?.({
            url, method, status: res.status, statusText: res.statusText, ok: false,
            durationMs: Date.now() - startedAt,
            error: 'non-JSON response',
            nonJsonBodyPreview: preview,
          });
        } catch { /* ignore */ }
        const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);
        const hint = looksLikeHtml
          ? 'Airtable returned HTML instead of JSON — likely a network proxy, captive portal, or expired credentials redirect.'
          : 'Airtable returned a non-JSON body.';
        throw new NonJsonResponseError(
          `${hint} (${res.status} ${res.statusText}; body: ${preview})`,
          res.status,
          preview,
        );
      }
    }

    throw new RateLimitedError('Airtable API: max retries exceeded (429)');
  }

  /**
   * Translate the AirtableClient's URL+method shape into an op call against
   * the EO/// DB Airtable Gateway. Keeps the public method signatures
   * (`paginateRecords`, `getBaseSchema`, `updateRecord`, …) unchanged so the
   * sync code doesn't need to know whether it's talking to the gateway or
   * to api.airtable.com directly.
   *
   * Operations the gateway intentionally doesn't expose — list bases, get
   * record by id, webhook lifecycle, create/delete record — throw
   * AminoProxyUnsupportedError. Callers that can degrade gracefully (the
   * polling-only update sync, for instance) catch it; callers that can't
   * surface the error to the user.
   */
  private async requestViaAminoGateway<T>(url: string, init?: RequestInit): Promise<T> {
    await this.bucket.acquire();
    const startedAt = Date.now();
    const method = (init?.method ?? 'GET').toUpperCase();
    const observe = (status: number, ok: boolean, error?: string): void => {
      try {
        this.onResponse?.({
          url, method, status, statusText: ok ? 'OK' : 'Gateway',
          ok, durationMs: Date.now() - startedAt,
          ...(error ? { error } : {}),
        });
      } catch { /* observer must never break the request */ }
    };

    const parsed = parseAirtableUrl(url);

    if (parsed.kind === 'listBases') {
      if (!this.aminoBaseId) {
        observe(501, false, 'aminoBaseId not configured');
        throw new AminoProxyUnsupportedError(
          'listBases via Amino gateway requires aminoBaseId — set it on the AirtableClient.',
        );
      }
      observe(200, true);
      return ({
        bases: [{ id: this.aminoBaseId, name: 'Amino', permissionLevel: 'create' }],
      } as AirtableBasesResponse) as unknown as T;
    }

    if (parsed.kind === 'webhook') {
      observe(501, false, 'webhook ops not supported');
      throw new AminoProxyUnsupportedError(
        'Airtable webhook lifecycle is not exposed by the Amino gateway. Use polling-based sync.',
      );
    }

    if (parsed.kind === 'record' && method === 'GET') {
      observe(501, false, 'getRecord not supported');
      throw new AminoProxyUnsupportedError(
        `Single-record GET is not exposed by the Amino gateway (${parsed.baseId}/${parsed.tableId}/${parsed.recordId}).`,
      );
    }

    if (parsed.kind === 'record' && (method === 'DELETE' || method === 'POST')) {
      observe(501, false, `${method} not supported`);
      throw new AminoProxyUnsupportedError(
        `Record ${method} is not exposed by the Amino gateway (only PATCH via op:update is supported).`,
      );
    }

    if (parsed.kind === 'unknown') {
      observe(501, false, `unrecognized URL: ${url}`);
      throw new AminoProxyUnsupportedError(`Unrecognized Airtable URL for Amino gateway: ${url}`);
    }

    if (parsed.kind === 'schema') {
      const data = await this.callGateway<AminoSchemaResponse>('schema', {
        site: { base: parsed.baseId },
      }, observe);
      return ({ tables: data.tables ?? [] } as AirtableBaseSchema) as unknown as T;
    }

    if (parsed.kind === 'records') {
      // `since` is pinned across the whole pagination loop. Airtable's
      // opaque `offset` is only valid within the (filterByFormula + sort)
      // it was issued under — advancing `since` per-page would invalidate
      // the offset and silently drop rows that share a lastModifiedTime
      // with the previous page's tail (the strict `IS_AFTER` boundary).
      const filter = parsed.query.get('filterByFormula') ?? '';
      const since = extractSinceFromFilter(filter);
      const offsetParam = parsed.query.get('offset') ?? '';
      let airtableOffset: string | undefined;
      if (offsetParam.startsWith(AMINO_OFFSET_PREFIX)) {
        const fromOffset = offsetParam.slice(AMINO_OFFSET_PREFIX.length);
        if (fromOffset) airtableOffset = fromOffset;
      }
      const pageSizeParam = parsed.query.get('pageSize');
      const limit = Math.min(Math.max(Number(pageSizeParam) || 100, 1), 100);

      const data = await this.callGateway<AminoSyncResponse>('sync', {
        site: { base: parsed.baseId, table: parsed.tableId },
        ...(since ? { since } : {}),
        ...(airtableOffset ? { offset: airtableOffset } : {}),
        limit,
      }, observe);

      const records = (data.records ?? []).map(normalizeAminoRecord);
      // Use Airtable's native offset for within-run continuation. The
      // gateway forwards it from the upstream response; when it's null the
      // run is exhausted and pagination stops cleanly.
      const nextOffset = data.offset
        ? `${AMINO_OFFSET_PREFIX}${data.offset}`
        : undefined;
      return ({ records, offset: nextOffset } as AirtableListResponse) as unknown as T;
    }

    // PATCH single record → op:update
    const bodyParsed = init?.body
      ? safeJsonParse(typeof init.body === 'string' ? init.body : '') as { fields?: Record<string, any> } | string
      : { fields: {} };
    const fields = (typeof bodyParsed === 'object' && bodyParsed && 'fields' in bodyParsed && bodyParsed.fields)
      ? bodyParsed.fields
      : {};
    const updated = await this.callGateway<unknown>('update', {
      site: { base: parsed.baseId, table: parsed.tableId, recordId: parsed.recordId },
      payload: fields,
    }, observe);
    return updated as T;
  }

  /**
   * POST one op to the gateway and unwrap the `{ ok, data }` envelope. Maps
   * `{ ok: false }` and non-2xx responses onto the same AirtableApiError
   * subclasses the direct-API path uses, so callers don't need a separate
   * catch for the gateway.
   */
  private async callGateway<T>(
    op: 'schema' | 'sync' | 'search' | 'update',
    body: Record<string, unknown>,
    observe: (status: number, ok: boolean, error?: string) => void,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(AIRTABLE_PROXY_WEBHOOK, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ op, ...body }),
      });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      observe(0, false, msg);
      throw e;
    }

    const text = await res.text();
    let parsed: AminoEnvelope<T> | null = null;
    try { parsed = JSON.parse(text) as AminoEnvelope<T>; } catch { parsed = null; }

    if (!parsed) {
      observe(res.status, false, 'non-JSON response');
      throw new NonJsonResponseError(
        `Amino gateway returned a non-JSON body (${res.status} ${res.statusText}; body: ${text.slice(0, 200)})`,
        res.status,
        text.slice(0, 200),
      );
    }

    if (!res.ok || parsed.ok === false) {
      const err = parsed.ok === false ? parsed : null;
      const message = err
        ? `Amino gateway: ${err.error}${err.detail ? ` — ${err.detail}` : ''}`
        : `Amino gateway HTTP ${res.status}`;
      observe(res.status, false, message);
      if (res.status === 401 || err?.error === 'unauthorized') {
        throw new AirtableApiError(message, 401, 'AUTHENTICATION_REQUIRED');
      }
      // Tables without a `lastModifiedTime` field can't be incrementally
      // synced — the gateway tells us up front. Throw a typed error so the
      // sync loop can demote it to a quiet skip instead of a sync_error.
      if (err?.error === 'no_lm_field') {
        const detailMatch = err.detail?.match(/Table\s+"([^"]+)"\s+\(([^)]+)\)/);
        throw new NoLastModifiedFieldError(message, {
          tableName: detailMatch?.[1],
          tableId: detailMatch?.[2],
        });
      }
      throw new AirtableApiError(message, res.status || 502);
    }

    observe(res.status, true);
    return parsed.data;
  }

  async listBases(): Promise<AirtableBase[]> {
    const bases: AirtableBase[] = [];
    let offset: string | undefined;

    do {
      const url = offset
        ? `${AIRTABLE_META_API}/bases?offset=${encodeURIComponent(offset)}`
        : `${AIRTABLE_META_API}/bases`;
      const res = await this.request<AirtableBasesResponse>(url);
      bases.push(...res.bases);
      offset = res.offset;
    } while (offset);

    return bases;
  }

  async getBaseSchema(baseId: string): Promise<AirtableTable[]> {
    const res = await this.request<AirtableBaseSchema>(
      `${AIRTABLE_META_API}/bases/${baseId}/tables`,
    );
    return res.tables;
  }

  /** Update a single record's fields via PATCH. Returns the updated record. */
  async updateRecord(
    baseId: string,
    tableIdOrName: string,
    recordId: string,
    fields: Record<string, any>,
    opts?: { returnFieldsByFieldId?: boolean },
  ): Promise<AirtableRecord> {
    const params = new URLSearchParams();
    if (opts?.returnFieldsByFieldId) params.set('returnFieldsByFieldId', 'true');
    const qs = params.toString();
    const url = `${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableIdOrName)}/${recordId}${qs ? `?${qs}` : ''}`;
    return this.request<AirtableRecord>(url, {
      method: 'PATCH',
      body: JSON.stringify({ fields }),
    });
  }

  /**
   * Fetch a single record by id. Used after a webhook payload tells us a
   * record changed — the payload only carries the diff, so we refetch to
   * get the full current field set before folding.
   */
  async getRecord(
    baseId: string,
    tableIdOrName: string,
    recordId: string,
    opts?: { returnFieldsByFieldId?: boolean },
  ): Promise<AirtableRecord> {
    const params = new URLSearchParams();
    if (opts?.returnFieldsByFieldId) params.set('returnFieldsByFieldId', 'true');
    const qs = params.toString();
    const url = `${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableIdOrName)}/${recordId}${qs ? `?${qs}` : ''}`;
    return this.request<AirtableRecord>(url);
  }

  // ─── Webhooks API ────────────────────────────────────────────────────────

  /** GET /v0/bases/{baseId}/webhooks — list all webhooks on a base. */
  async listWebhooks(baseId: string): Promise<AirtableWebhook[]> {
    const url = `${AIRTABLE_API}/bases/${baseId}/webhooks`;
    const res = await this.request<{ webhooks: AirtableWebhook[] }>(url);
    return res.webhooks ?? [];
  }

  /**
   * POST /v0/bases/{baseId}/webhooks — register a new webhook.
   * We omit `notificationUrl` so Airtable queues payloads for us to poll
   * (browser-only app; no server to receive pushes).
   */
  async createWebhook(
    baseId: string,
    specification: AirtableWebhookSpecification,
  ): Promise<AirtableCreateWebhookResponse> {
    const url = `${AIRTABLE_API}/bases/${baseId}/webhooks`;
    return this.request<AirtableCreateWebhookResponse>(url, {
      method: 'POST',
      body: JSON.stringify({ specification }),
    });
  }

  /** DELETE /v0/bases/{baseId}/webhooks/{id} — deregister a webhook. */
  async deleteWebhook(baseId: string, webhookId: string): Promise<void> {
    const url = `${AIRTABLE_API}/bases/${baseId}/webhooks/${webhookId}`;
    await this.request<unknown>(url, { method: 'DELETE' });
  }

  /**
   * POST /v0/bases/{baseId}/webhooks/{id}/refresh — reset the 7-day
   * expiration clock. Call periodically or the webhook (and its queued
   * payloads) will be garbage-collected.
   */
  async refreshWebhook(baseId: string, webhookId: string): Promise<{ expirationTime?: string }> {
    const url = `${AIRTABLE_API}/bases/${baseId}/webhooks/${webhookId}/refresh`;
    return this.request<{ expirationTime?: string }>(url, { method: 'POST' });
  }

  /**
   * GET /v0/bases/{baseId}/webhooks/{id}/payloads — stream change events
   * since `cursor`. The response's top-level `cursor` is what the next call
   * should use; `mightHaveMore=true` means keep polling in a loop to drain.
   */
  async listWebhookPayloads(
    baseId: string,
    webhookId: string,
    opts?: { cursor?: number; limit?: number },
  ): Promise<AirtableWebhookPayloadsResponse> {
    const params = new URLSearchParams();
    if (opts?.cursor != null) params.set('cursor', String(opts.cursor));
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    const qs = params.toString();
    const url = `${AIRTABLE_API}/bases/${baseId}/webhooks/${webhookId}/payloads${qs ? `?${qs}` : ''}`;
    return this.request<AirtableWebhookPayloadsResponse>(url);
  }

  // ─── Records API ────────────────────────────────────────────────────────

  async *paginateRecords(
    baseId: string,
    tableIdOrName: string,
    opts?: {
      filterByFormula?: string;
      fields?: string[];
      pageSize?: number;
      returnFieldsByFieldId?: boolean;
    },
  ): AsyncGenerator<AirtableRecord[], void, unknown> {
    let offset: string | undefined;
    const pageSize = opts?.pageSize ?? 100;

    do {
      const params = new URLSearchParams();
      params.set('pageSize', String(pageSize));
      if (opts?.filterByFormula) params.set('filterByFormula', opts.filterByFormula);
      if (opts?.returnFieldsByFieldId) params.set('returnFieldsByFieldId', 'true');
      if (opts?.fields) {
        for (const f of opts.fields) params.append('fields[]', f);
      }
      if (offset) params.set('offset', offset);

      const url = `${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableIdOrName)}?${params}`;
      const res = await this.request<AirtableListResponse>(url);
      yield res.records;
      offset = res.offset;
    } while (offset);
  }

  /** Fetch all records from a table into a single array. */
  async listAllRecords(
    baseId: string,
    tableIdOrName: string,
    opts?: {
      filterByFormula?: string;
      fields?: string[];
      returnFieldsByFieldId?: boolean;
    },
  ): Promise<AirtableRecord[]> {
    const all: AirtableRecord[] = [];
    for await (const page of this.paginateRecords(baseId, tableIdOrName, opts)) {
      all.push(...page);
    }
    return all;
  }
}
