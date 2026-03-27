/**
 * Rate-limited Airtable API client.
 *
 * Airtable enforces 5 requests/second per base. This client uses a token-bucket
 * rate limiter to stay well under that ceiling, with configurable concurrency
 * and automatic pagination handling.
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

// ─── Rate limiter ───────────────────────────────────────────────────────────

/**
 * Token-bucket rate limiter. Refills at `rate` tokens per second up to `burst`.
 * Each API call consumes one token; callers await acquire() before firing.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly rate: number = 4,   // tokens/sec (stay under Airtable's 5/sec)
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
    // Wait until at least one token is available
    const waitMs = Math.ceil((1 - this.tokens) / this.rate * 1000);
    await sleep(waitMs);
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

  // ── Low-level fetch with rate limiting & retry ──────────────────────────

  private async request<T>(url: string, retries = 3): Promise<T> {
    await this.bucket.acquire();

    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (res.status === 429) {
        // Rate limited — back off exponentially
        const backoff = Math.pow(2, attempt + 1) * 1000;
        await sleep(backoff);
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

  // ── Meta API ────────────────────────────────────────────────────────────

  /** List all bases the API key has access to. */
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

  /** Get the schema (tables + fields) for a base. */
  async getBaseSchema(baseId: string): Promise<AirtableTable[]> {
    const res = await this.request<AirtableBaseSchema>(
      `${AIRTABLE_META_API}/bases/${baseId}/tables`,
    );
    return res.tables;
  }

  // ── Records API ─────────────────────────────────────────────────────────

  /**
   * Fetch all records from a table, automatically paginating.
   * Yields pages so callers can process incrementally without holding
   * the entire dataset in memory.
   */
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
