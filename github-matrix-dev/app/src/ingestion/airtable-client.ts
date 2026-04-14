/**
 * Browser-side rate-limited Airtable API client.
 *
 * Uses browser fetch() directly against the Airtable API.
 * Token-bucket rate limiter keeps requests under 5/sec ceiling.
 */

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

interface AirtableListResponse {
  records: AirtableRecord[];
  offset?: string;
}

interface AirtableBaseSchema {
  tables: AirtableTable[];
}

interface AirtableBasesResponse {
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

export class AirtableClient {
  private bucket: TokenBucket;

  constructor(
    private readonly apiKey: string,
    ratePerSec: number = 4,
  ) {
    this.bucket = new TokenBucket(ratePerSec, ratePerSec);
  }

  private async request<T>(url: string, init?: RequestInit, retries = 3): Promise<T> {
    await this.bucket.acquire();

    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(url, {
        ...init,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...init?.headers,
        },
      });

      if (res.status === 429) {
        const backoff = Math.pow(2, attempt + 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        // Preserve the HTTP status so callers can branch on 404 (webhook
        // expired / cursor too stale) without parsing the error message.
        const err = new Error(`Airtable API ${res.status}: ${body}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }

      return await res.json() as T;
    }

    throw new Error('Airtable API: max retries exceeded (429)');
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

  /**
   * Update a single record's fields via PATCH.
   * Returns the updated Airtable record.
   */
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
}
