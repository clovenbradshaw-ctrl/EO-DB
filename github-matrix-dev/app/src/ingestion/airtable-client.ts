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
        throw new Error(`Airtable API ${res.status}: ${body}`);
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
