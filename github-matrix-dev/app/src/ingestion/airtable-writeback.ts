/**
 * Airtable writeback — disabled.
 *
 * Local field edits are NOT pushed back to Airtable. `syncEditToAirtable`
 * is a no-op so the existing call sites in TableView/FigureFields can stay
 * unchanged when writeback is re-enabled.
 */

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
  // Writeback to Airtable is disabled — local edits stay local until the
  // policy on round-tripping into the source-of-truth base is settled.
  void opts;
  return;
}
