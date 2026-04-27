/**
 * Airtable writeback — pushes local edits back to Airtable.
 *
 * When a user edits a field on a record that originated from Airtable
 * (target starts with `at.`), this module sends the update back via
 * the Airtable API so the two systems stay in sync.
 *
 * The PAT comes from `useAirtableStore` — the same in-memory source
 * used by discovery, manual sync, and continuous sync. Reading it via
 * `createAirtableClient()` ensures we always pick up the freshly-entered
 * key (and the `viaAminoProxy` flag) instead of a stale persisted copy.
 */

import { createAirtableClient } from './airtable-store';

// ─── Target parsing ────────────────────────────────────────────────────────

export interface AirtableParts {
  baseId: string;
  tableId: string;
  recordId: string;
}

export function parseAirtableTarget(target: string): AirtableParts | null {
  const parts = target.split('.');
  if (parts.length < 4 || parts[0] !== 'at') return null;
  return { baseId: parts[1], tableId: parts[2], recordId: parts[3] };
}

// ─── Writeback ─────────────────────────────────────────────────────────────

export interface WritebackOpts {
  target: string;
  fieldKey: string;
  value: any;
}

/**
 * Push a single field edit back to Airtable.
 * Fire-and-forget — callers should `.catch(console.warn)`.
 */
export async function syncEditToAirtable(opts: WritebackOpts): Promise<void> {
  const parsed = parseAirtableTarget(opts.target);
  if (!parsed) return;

  let client;
  try {
    client = createAirtableClient();
  } catch {
    console.warn('[airtable-writeback] Airtable store not connected — skipping sync');
    return;
  }

  await client.updateRecord(
    parsed.baseId,
    parsed.tableId,
    parsed.recordId,
    { [opts.fieldKey]: opts.value },
  );
}
