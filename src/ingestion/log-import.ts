/**
 * Log Import — JSON and CSV parsing for bulk event ingestion.
 *
 * Accepts arrays of events in JSON format or CSV text, validates them,
 * and processes each through the fold in sequence.
 */

import type { EoDb } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import { processEvent } from '../db/fold.js';
import type { ExternalOperator, EoEventInput } from '../db/types.js';

const EXTERNAL_OPS: Set<string> = new Set(['INS', 'DEF', 'CON', 'SEG', 'SYN', 'EVA']);

export interface ImportResult {
  total: number;
  processed: number;
  skipped: number;
  errors: Array<{ index: number; error: string }>;
  sequences: number[];
}

export interface ImportEventRow {
  op: string;
  target: string;
  operand?: any;
  ts?: string;
  client_event_id?: string;
  meta?: Record<string, any>;
}

/**
 * Validate a single import row. Returns null if valid, error string if not.
 */
function validateRow(row: ImportEventRow, index: number): string | null {
  if (!row.op) return `Row ${index}: missing required field "op"`;
  if (!EXTERNAL_OPS.has(row.op.toUpperCase())) {
    return `Row ${index}: invalid op "${row.op}" — must be one of: ${[...EXTERNAL_OPS].join(', ')}`;
  }
  if (!row.target) return `Row ${index}: missing required field "target"`;
  if (typeof row.target !== 'string') return `Row ${index}: "target" must be a string`;
  return null;
}

/**
 * Parse a JSON import payload. Accepts an array of event objects.
 */
export function parseJsonImport(payload: unknown): ImportEventRow[] {
  if (!Array.isArray(payload)) {
    throw new Error('JSON import payload must be an array of event objects');
  }
  return payload.map((item, i) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`JSON import: item at index ${i} is not an object`);
    }
    return item as ImportEventRow;
  });
}

/**
 * Parse a CSV string into import rows.
 *
 * Expected columns: op, target, operand, ts, client_event_id, meta
 * The operand and meta columns are parsed as JSON if present.
 * Supports quoted fields with commas and newlines inside quotes.
 */
export function parseCsvImport(csvText: string): ImportEventRow[] {
  const lines = parseCsvLines(csvText);
  if (lines.length < 2) {
    throw new Error('CSV import: must contain a header row and at least one data row');
  }

  const headers = lines[0].map(h => h.trim().toLowerCase());
  const opIdx = headers.indexOf('op');
  const targetIdx = headers.indexOf('target');

  if (opIdx === -1) throw new Error('CSV import: missing required column "op"');
  if (targetIdx === -1) throw new Error('CSV import: missing required column "target"');

  const operandIdx = headers.indexOf('operand');
  const tsIdx = headers.indexOf('ts');
  const clientEventIdIdx = headers.indexOf('client_event_id');
  const metaIdx = headers.indexOf('meta');

  const rows: ImportEventRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i];
    if (cols.length === 1 && cols[0].trim() === '') continue; // skip empty lines

    const row: ImportEventRow = {
      op: cols[opIdx]?.trim() || '',
      target: cols[targetIdx]?.trim() || '',
    };

    if (operandIdx !== -1 && cols[operandIdx]?.trim()) {
      try {
        row.operand = JSON.parse(cols[operandIdx].trim());
      } catch {
        throw new Error(`CSV import: invalid JSON in "operand" column at row ${i + 1}`);
      }
    }

    if (tsIdx !== -1 && cols[tsIdx]?.trim()) {
      row.ts = cols[tsIdx].trim();
    }

    if (clientEventIdIdx !== -1 && cols[clientEventIdIdx]?.trim()) {
      row.client_event_id = cols[clientEventIdIdx].trim();
    }

    if (metaIdx !== -1 && cols[metaIdx]?.trim()) {
      try {
        row.meta = JSON.parse(cols[metaIdx].trim());
      } catch {
        throw new Error(`CSV import: invalid JSON in "meta" column at row ${i + 1}`);
      }
    }

    rows.push(row);
  }

  return rows;
}

/**
 * Parse CSV text into an array of string arrays, handling quoted fields.
 */
function parseCsvLines(text: string): string[][] {
  const results: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        current.push(field);
        field = '';
        i++;
      } else if (ch === '\n' || (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n')) {
        current.push(field);
        field = '';
        results.push(current);
        current = [];
        i += ch === '\r' ? 2 : 1;
      } else if (ch === '\r') {
        current.push(field);
        field = '';
        results.push(current);
        current = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }

  // Flush last field/row
  if (field || current.length > 0) {
    current.push(field);
    results.push(current);
  }

  return results;
}

/**
 * Process an array of validated import rows through the fold.
 * Events are processed sequentially in order. Errors on individual
 * rows are captured but do not halt the import (unless halt_on_error is set).
 */
export async function processImport(
  db: EoDb,
  feed: Feed,
  rows: ImportEventRow[],
  agent: string,
  options?: { halt_on_error?: boolean },
): Promise<ImportResult> {
  const result: ImportResult = {
    total: rows.length,
    processed: 0,
    skipped: 0,
    errors: [],
    sequences: [],
  };

  const now = new Date().toISOString();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Validate
    const validationError = validateRow(row, i);
    if (validationError) {
      result.errors.push({ index: i, error: validationError });
      result.skipped++;
      if (options?.halt_on_error) break;
      continue;
    }

    // Build event input
    const eventInput: EoEventInput = {
      op: row.op.toUpperCase() as ExternalOperator,
      target: row.target,
      operand: row.operand ?? {},
      agent,
      ts: row.ts || now,
      acquired_ts: now,
      client_event_id: row.client_event_id,
      meta: row.meta,
    };

    try {
      const seq = await processEvent(db, eventInput, feed);
      result.sequences.push(seq);
      result.processed++;
    } catch (e: any) {
      result.errors.push({ index: i, error: e.message });
      result.skipped++;
      if (options?.halt_on_error) break;
    }
  }

  return result;
}
