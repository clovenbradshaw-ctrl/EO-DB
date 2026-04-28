/**
 * Bootstrap: load Airtable schema once at startup, persist `_eoHints`.
 *
 * Schema is what makes the rest of the app possible — without
 * `_eoHints[tableId].lastModifiedField.name` the absorber can't build its
 * filter formula. We call `op:schema` on app boot, cache the response in
 * IndexedDB, and refresh on a long interval (hour-ish) or on demand.
 *
 * Two-layer cache: the gateway already caches schema for ~5 min server-side,
 * but caching client-side too saves a network round-trip on every page load.
 */
import { gateway } from './gateway';
import { idb } from './idb';
import { AMINO_AIRTABLE_BASE_ID } from '../amino-config';

const CACHE_KEY = 'eodb:schema';
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface FieldRef { id: string; name: string }
export interface FieldDef { id: string; name: string; type: string; options?: unknown }
export interface TableDef {
  id: string;
  name: string;
  primaryFieldId?: string;
  fields: FieldDef[];
  views?: Array<{ id: string; name: string; type: string }>;
}

export interface EoHints {
  /** The table's `lastModifiedTime` field, or null if none exists. */
  lastModifiedField: FieldRef | null;
  /** The table's `createdTime` field, or null if none exists. */
  createdField: FieldRef | null;
  /** The table's primary field. */
  primaryField: FieldRef | null;
}

export interface SchemaResponse {
  baseId: string;
  tables: TableDef[];
  /** Per-table EO hints, keyed by tableId. */
  _eoHints?: Record<string, EoHints>;
  _eoMeta?: { fetchedAt: string; cacheTtlSec: number; fromCache: boolean; ageSec?: number };
}

interface CachedSchema {
  fetchedAt: number;
  payload: SchemaResponse;
}

/**
 * Return the gateway-provided schema for the configured Amino base, hitting
 * the network only when the local cache is stale (or missing).
 *
 * Pass `{ force: true }` to bypass the cache entirely — useful when the user
 * just edited their Airtable schema and wants the change to show up
 * immediately.
 */
export async function bootstrapSchema(opts?: { force?: boolean }): Promise<SchemaResponse> {
  if (!opts?.force) {
    const cached = await idb.get<CachedSchema>(CACHE_KEY);
    const fresh = cached && (Date.now() - cached.fetchedAt < CACHE_TTL_MS);
    if (fresh) return cached.payload;
  }

  const data = await gateway<SchemaResponse>({
    op: 'schema',
    site: { base: AMINO_AIRTABLE_BASE_ID },
  });

  await idb.set(CACHE_KEY, { fetchedAt: Date.now(), payload: data } satisfies CachedSchema);
  return data;
}

/**
 * Look up the lastModifiedTime field for a given table from the schema's
 * `_eoHints`. Returns null when the table has no such field — callers
 * should surface that as a UX message ("This table can't be synced — add a
 * Last Modified field in Airtable first.") rather than working around it.
 */
export function getLastModifiedField(
  schema: SchemaResponse,
  tableId: string,
): FieldRef | null {
  return schema._eoHints?.[tableId]?.lastModifiedField ?? null;
}

/** Drop the cached schema. Next call to `bootstrapSchema()` will refetch. */
export async function clearSchemaCache(): Promise<void> {
  await idb.del(CACHE_KEY);
}
