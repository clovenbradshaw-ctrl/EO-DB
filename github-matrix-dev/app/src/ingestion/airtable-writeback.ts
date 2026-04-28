/**
 * Airtable writeback — pushes local edits back to Airtable.
 *
 * When a user edits a field on a record that originated from Airtable
 * (target starts with `at.`), this module sends the update back via
 * the Airtable API so the two systems stay in sync.
 */

import { AirtableClient } from './airtable-client';
import { useAirtableStore } from './airtable-store';
import { AMINO_AIRTABLE_BASE_ID } from '../lib/amino-config';
import type { EoState } from '../db/types';

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

// ─── API key discovery ─────────────────────────────────────────────────────

const KEY_PREFIX = 'system.ingestion.airtable.keys.';

export async function findAirtableApiKey(
  getStateByPrefix: (prefix: string) => Promise<EoState[]>,
): Promise<string | null> {
  const states = await getStateByPrefix(KEY_PREFIX);
  for (const state of states) {
    const key = state.value?.api_key;
    if (typeof key === 'string' && key) return key;
  }
  return null;
}

// ─── Writeback ─────────────────────────────────────────────────────────────

export interface WritebackOpts {
  target: string;
  fieldKey: string;
  value: any;
  getStateByPrefix: (prefix: string) => Promise<EoState[]>;
}

/**
 * Push a single field edit back to Airtable.
 * Fire-and-forget — callers should `.catch(console.warn)`.
 */
export async function syncEditToAirtable(opts: WritebackOpts): Promise<void> {
  const parsed = parseAirtableTarget(opts.target);
  if (!parsed) return;

  // Amino users hold the matrix token in the in-memory store, not in EO
  // state — route their writebacks through the gateway via op:update.
  const storeState = useAirtableStore.getState();
  if (storeState.viaAminoProxy && storeState.apiKey) {
    const client = new AirtableClient(storeState.apiKey, undefined, {
      viaAminoProxy: true,
      aminoBaseId: AMINO_AIRTABLE_BASE_ID,
    });
    await client.updateRecord(
      parsed.baseId,
      parsed.tableId,
      parsed.recordId,
      { [opts.fieldKey]: opts.value },
    );
    return;
  }

  const apiKey = await findAirtableApiKey(opts.getStateByPrefix);
  if (!apiKey) {
    console.warn('[airtable-writeback] No API key found — skipping sync');
    return;
  }

  const client = new AirtableClient(apiKey);
  await client.updateRecord(
    parsed.baseId,
    parsed.tableId,
    parsed.recordId,
    { [opts.fieldKey]: opts.value },
  );
}
