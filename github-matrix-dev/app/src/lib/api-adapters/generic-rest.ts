import type { ApiAdapter, RemoteField, RemoteRecord, GenericRestCredentials } from './types';
import { normalizeTimestamp } from './types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve a dot-path like "data.items" against an unknown value. */
function resolvePath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce<unknown>((cur, key) => {
    if (cur != null && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      return (cur as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function buildHeaders(
  authType: GenericRestCredentials['authType'],
  authValue: string,
): Record<string, string> {
  if (authType === 'bearer') return { Authorization: `Bearer ${authValue}` };
  if (authType === 'apikey') return { 'X-API-Key': authValue };
  return {};
}

/** Extract a stable string ID from a raw record object, falling back to the array index. */
function extractId(record: Record<string, unknown>, index: number): string {
  const raw = record['id'] ?? record['_id'] ?? record['ID'];
  if (raw != null) return String(raw);
  return String(index);
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

/**
 * Adapter for any JSON REST endpoint.
 *
 * Limitations (by design for v1):
 * - Read-only: updateRecord / deleteRecord throw NOT_SUPPORTED.
 * - Always full-refresh: incremental sync is not possible without a
 *   source-specific cursor convention, so nextCursor is always null.
 * - Field discovery is based on the shape of the first record in the array.
 */
export class GenericRestAdapter implements ApiAdapter {
  constructor(private readonly creds: GenericRestCredentials) {}

  private async _fetchArray(): Promise<unknown[]> {
    const headers = buildHeaders(this.creds.authType, this.creds.authValue);
    let response: Response;
    try {
      response = await fetch(this.creds.baseUrl, { headers });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Network error: ${msg}`);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error('Response is not valid JSON.');
    }

    const resolved = resolvePath(json, this.creds.recordsPath);
    if (!Array.isArray(resolved)) {
      const pathDesc = this.creds.recordsPath
        ? `recordsPath "${this.creds.recordsPath}"`
        : 'root response';
      throw new Error(
        `${pathDesc} did not resolve to an array (got ${resolved === null ? 'null' : typeof resolved}).`,
      );
    }
    return resolved;
  }

  async testConnection(): Promise<void> {
    await this._fetchArray(); // throws on any error
  }

  async discoverFields(): Promise<RemoteField[]> {
    const arr = await this._fetchArray();
    if (arr.length === 0) return [];
    const first = arr[0];
    if (typeof first !== 'object' || first === null) {
      throw new Error('Records are not objects — cannot discover fields.');
    }
    return Object.keys(first as object).map((key) => ({
      id: key,
      name: key,
      type: 'string',
    }));
  }

  async fetchRecords(opts: {
    cursor: string | null;
    limit?: number;
  }): Promise<{ records: RemoteRecord[]; nextCursor: string | null }> {
    void opts; // full refresh always — cursor not used
    const arr = await this._fetchArray();
    const records: RemoteRecord[] = arr.map((item, index) => {
      const record =
        typeof item === 'object' && item !== null
          ? (item as Record<string, unknown>)
          : { value: item };
      const id = extractId(record, index);
      const lastModifiedAt = normalizeTimestamp(
        record['updatedAt'] ?? record['updated_at'] ?? record['lastModifiedAt'] ?? null,
      );
      return { id, fields: record, lastModifiedAt };
    });
    return { records, nextCursor: null };
  }

  async updateRecord(_recordId: string, _fields: Record<string, unknown>): Promise<void> {
    throw new Error('NOT_SUPPORTED');
  }

  async deleteRecord(_recordId: string): Promise<void> {
    throw new Error('NOT_SUPPORTED');
  }
}
