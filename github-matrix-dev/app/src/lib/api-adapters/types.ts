// ─── Credential shapes (discriminated union) ─────────────────────────────────

export interface AirtableCredentials {
  sourceType: 'airtable';
  apiKey: string;   // Personal Access Token — stored encrypted, never rendered
  baseId: string;   // e.g. "appXYZ123"
  tableId: string;  // e.g. "tblABC456" or a table name string
}

export interface GenericRestCredentials {
  sourceType: 'generic_rest';
  baseUrl: string;
  authType: 'bearer' | 'apikey' | 'none';
  authValue: string;
  recordsPath: string;  // dot-path to array in response, e.g. "data.items"
}

export type ApiCredentials = AirtableCredentials | GenericRestCredentials;

// ─── Field discovery ──────────────────────────────────────────────────────────

export interface RemoteField {
  id: string;    // stable source field ID (Airtable: "fldXYZ")
  name: string;  // human display name from source
  type: string;  // source-native type string (e.g. "singleLineText", "lastModifiedTime")
}

// ─── Records ──────────────────────────────────────────────────────────────────

export interface RemoteRecord {
  id: string;
  fields: Record<string, unknown>;  // keyed by remoteFieldId
  /** ISO 8601 string; null if the source doesn't expose a modification time. */
  lastModifiedAt: string | null;
}

// ─── Timestamp normalizer ─────────────────────────────────────────────────────

/**
 * Normalize any timestamp value a source might return to an ISO 8601 string.
 * Handles: ISO string, Unix seconds (number < 1e12), Unix ms (number >= 1e12),
 * Date objects, and unknown/null → null.
 *
 * Must never throw — returns null on unrecognized input.
 */
export function normalizeTimestamp(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'number') {
    // Heuristic: numbers < 1e12 are Unix seconds; >= 1e12 are milliseconds
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value.toISOString();
  }
  return null;
}

// ─── Field mapping ────────────────────────────────────────────────────────────

/** remoteFieldId → internalName stored in DEF event */
export type FieldMapping = Record<string, string>;

// ─── Connection config (persisted as DEF event operand) ──────────────────────

export interface ApiConnectionConfig {
  connectionId: string;         // UUID — used as the DEF target suffix
  label: string;                // user-chosen display name
  credentials: ApiCredentials;
  fieldMappings: FieldMapping;
  createdAt: string;            // ISO timestamp
  lastSyncAt: string | null;
  syncCursor: string | null;    // opaque; each adapter interprets it
  /** Minimum milliseconds between syncs. Default: 60_000 (1 minute). */
  minSyncIntervalMs: number;
}

// ─── Adapter interface ────────────────────────────────────────────────────────

export interface ApiAdapter {
  /** Verify credentials — throws with a user-readable message on failure. */
  testConnection(): Promise<void>;

  /** Return all fields available on the configured source table/endpoint. */
  discoverFields(): Promise<RemoteField[]>;

  /**
   * Fetch records from the source.
   * Pass cursor=null for a full refresh; pass the stored syncCursor for
   * an incremental fetch (only records modified after the cursor).
   */
  fetchRecords(opts: {
    cursor: string | null;
    limit?: number;
  }): Promise<{ records: RemoteRecord[]; nextCursor: string | null }>;

  /**
   * Write field updates back to the source.
   * Throws the string 'NOT_SUPPORTED' if the adapter is read-only.
   */
  updateRecord(recordId: string, fields: Record<string, unknown>): Promise<void>;

  /**
   * Delete a record on the source side.
   * Throws the string 'NOT_SUPPORTED' if the adapter is read-only.
   */
  deleteRecord(recordId: string): Promise<void>;
}
