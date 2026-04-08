import { AirtableClient } from '../../ingestion/airtable-client';
import type { ApiAdapter, RemoteField, RemoteRecord } from './types';
import { normalizeTimestamp } from './types';

/**
 * Adapter for Airtable — wraps the existing rate-limited AirtableClient.
 * Does not duplicate any API logic.
 *
 * Sync cursor strategy: an ISO datetime string used as the argument to
 *   IS_AFTER(LAST_MODIFIED_TIME(), "{cursor}")
 * This mirrors the pattern in airtable-sync.ts exactly.
 *
 * lastModifiedAt per record: uses a mapped lastModifiedTime field if the
 * user configured one, otherwise falls back to record.createdTime.
 */
export class AirtableAdapter implements ApiAdapter {
  private client: AirtableClient;

  constructor(
    private readonly baseId: string,
    private readonly tableId: string,
    apiKey: string,
    /** remoteFieldId of the lastModifiedTime field, if the user mapped one. */
    private readonly lastModifiedFieldId: string | null = null,
  ) {
    this.client = new AirtableClient(apiKey);
  }

  async testConnection(): Promise<void> {
    // Verify the API key is valid and the specific base/table is reachable.
    const tables = await this.client.getBaseSchema(this.baseId);
    const found = tables.find(
      (t) => t.id === this.tableId || t.name === this.tableId,
    );
    if (!found) {
      throw new Error(
        `Table "${this.tableId}" not found in base "${this.baseId}". ` +
        `Available: ${tables.map((t) => t.name).join(', ')}`,
      );
    }
  }

  async discoverFields(): Promise<RemoteField[]> {
    const tables = await this.client.getBaseSchema(this.baseId);
    const table = tables.find(
      (t) => t.id === this.tableId || t.name === this.tableId,
    );
    if (!table) {
      throw new Error(`Table "${this.tableId}" not found in base "${this.baseId}"`);
    }
    return table.fields.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
    }));
  }

  async fetchRecords(opts: {
    cursor: string | null;
    limit?: number;
  }): Promise<{ records: RemoteRecord[]; nextCursor: string | null }> {
    const filterByFormula = opts.cursor
      ? `IS_AFTER(LAST_MODIFIED_TIME(), "${opts.cursor}")`
      : undefined;

    const records: RemoteRecord[] = [];

    for await (const page of this.client.paginateRecords(
      this.baseId,
      this.tableId,
      {
        filterByFormula,
        pageSize: opts.limit ?? 100,
        returnFieldsByFieldId: true,
      },
    )) {
      for (const rec of page) {
        // Resolve lastModifiedAt:
        // 1. Prefer a user-mapped lastModifiedTime field
        // 2. Fall back to record.createdTime (always present, imprecise)
        let rawTs: unknown = rec.createdTime;
        if (this.lastModifiedFieldId) {
          const mapped = rec.fields[this.lastModifiedFieldId];
          if (mapped != null) rawTs = mapped;
        }

        records.push({
          id: rec.id,
          fields: rec.fields,
          lastModifiedAt: normalizeTimestamp(rawTs),
        });
      }
    }

    // Next cursor = current UTC time so the next incremental sync only
    // fetches records modified after this moment.
    const nextCursor = new Date().toISOString();
    return { records, nextCursor };
  }

  async updateRecord(
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    await this.client.updateRecord(
      this.baseId,
      this.tableId,
      recordId,
      fields,
      { returnFieldsByFieldId: true },
    );
  }

  async deleteRecord(_recordId: string): Promise<void> {
    // AirtableClient doesn't expose DELETE yet.
    throw new Error('NOT_SUPPORTED');
  }
}
