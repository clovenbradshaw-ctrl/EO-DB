/**
 * Search — ad-hoc queries against Airtable's *current* state.
 *
 * Search is for queries the user (or the UI) initiates. It does NOT go in
 * the Given-Log — results are a snapshot, not an event stream. The formula
 * is constructed by the caller, which means anything the Airtable formula
 * language allows works here without the server needing to understand the
 * semantics.
 *
 * If you find yourself reaching for search to do what sync does, your local
 * store is incomplete and you should sync that table instead.
 */
import { gateway } from './gateway';
import { AMINO_AIRTABLE_BASE_ID } from '../amino-config';

export interface SearchRecord {
  id: string;
  fields: Record<string, unknown>;
  createdTime?: string;
}

export interface SearchResponse {
  records: SearchRecord[];
  count: number;
}

export interface SearchOptions {
  /** Override the base id (defaults to the configured Amino base). */
  baseId?: string;
  /** Page size cap. Server clamps to [1, 100]. */
  limit?: number;
}

/**
 * Run an Airtable formula against `tableId` and return the raw record list.
 * No cursor, no fold — just current-state rows for display.
 *
 * Example:
 *   searchTable('tblMatters',
 *     "AND({Status}='Active', IS_AFTER({Modified}, DATEADD(NOW(), -7, 'days')))")
 */
export async function searchTable(
  tableId: string,
  filterByFormula: string,
  opts: SearchOptions = {},
): Promise<SearchRecord[]> {
  const data = await gateway<SearchResponse>({
    op: 'search',
    site: { base: opts.baseId ?? AMINO_AIRTABLE_BASE_ID, table: tableId },
    filterByFormula,
    limit: opts.limit ?? 100,
  });
  return data.records;
}
