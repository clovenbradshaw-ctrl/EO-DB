/**
 * Tiny file parsers for the "upload current state into a target table"
 * importer. Limited to JSON arrays and RFC-4180-style CSV — enough to
 * handle Airtable's CSV / JSON exports and most hand-rolled API dumps.
 *
 * No external dependency to keep the bundle slim; the CSV parser is the
 * standard scanner (DFA over `,` / `"` / `\n`) with BOM stripping and
 * doubled-quote escaping. Not RFC-perfect at the edges (rare quoting
 * sequences), but correct for everything we ship from Airtable.
 */

export interface ParsedRows {
  /** Column / key names in source order. */
  columns: string[];
  /** One object per row; keys are exactly the `columns` entries. */
  rows: Array<Record<string, unknown>>;
}

// ─── CSV ────────────────────────────────────────────────────────────────────

/**
 * Parse a CSV string into `{ columns, rows }`. The first row is treated
 * as the header. Unquoted fields are returned as raw strings — caller is
 * responsible for any further type coercion (matching against the field
 * `type` on the persisted schema).
 *
 * Handles:
 *   - UTF-8 BOM stripping (Excel-exported CSVs often start with `﻿`)
 *   - CRLF, LF, and CR line endings
 *   - Quoted fields containing commas, newlines, and doubled `""` quotes
 *   - Trailing newline (ignored)
 */
export function parseCsv(text: string): ParsedRows {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // Doubled quote → literal quote
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      // Skip a paired CRLF in one go
      if (ch === '\r' && text[i + 1] === '\n') i += 2;
      else i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Flush the trailing field / row (if no terminating newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return { columns: [], rows: [] };

  const columns = rows[0].map((c) => c.trim());
  const dataRows = rows.slice(1).filter((r) => r.some((c) => c.length > 0));
  const objects: Array<Record<string, unknown>> = dataRows.map((cells) => {
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < columns.length; c++) {
      obj[columns[c]] = cells[c] ?? '';
    }
    return obj;
  });

  return { columns, rows: objects };
}

// ─── JSON ───────────────────────────────────────────────────────────────────

/**
 * Parse a JSON string that's either:
 *   - A top-level array of objects, OR
 *   - An object with a `records` / `data` / `items` array
 *
 * Returns `{ columns, rows }` with columns derived from the union of
 * keys across all rows (so a sparsely-populated source still surfaces
 * every column).
 */
export function parseJson(text: string): ParsedRows {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON: ${msg}`);
  }

  // Find the array of records
  let arr: unknown;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    arr = obj.records ?? obj.data ?? obj.items ?? obj.rows;
    if (!Array.isArray(arr)) {
      throw new Error(
        'JSON is not an array and does not contain a top-level records / data / items / rows array.',
      );
    }
  } else {
    throw new Error('JSON top-level must be an array or an object containing one.');
  }

  const rows: Array<Record<string, unknown>> = [];
  const columnSet = new Set<string>();
  for (const item of arr as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    rows.push(obj);
    for (const key of Object.keys(obj)) columnSet.add(key);
  }

  return { columns: [...columnSet], rows };
}

// ─── Dispatch by extension ──────────────────────────────────────────────────

/** Choose the right parser based on a file name / mime type. */
export function parseByName(text: string, fileName: string): ParsedRows {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return parseCsv(text);
  if (lower.endsWith('.json') || lower.endsWith('.ndjson')) return parseJson(text);
  // Fall back: sniff the first non-whitespace character.
  const trimmed = text.trimStart();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return parseJson(text);
  return parseCsv(text);
}
