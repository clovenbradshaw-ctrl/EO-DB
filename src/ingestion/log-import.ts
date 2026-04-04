/**
 * Log Import — JSON, CSV, and TSV parsing for bulk event ingestion.
 *
 * Accepts arrays of events in JSON format or CSV/TSV text, validates them,
 * and processes each through the fold in sequence.
 *
 * Supports two modes:
 * - Event format: rows with op + target columns are imported as-is
 * - Generic format: rows without op + target are auto-wrapped as INS events
 */

import type { EoDb } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import { processEvent } from '../db/fold.js';
import type { ExternalOperator, EoEventInput } from '../db/types.js';
import type { EventSink } from './event-sink.js';
import {
  jsonToCollections,
  discoverStructure,
  populateEntities,
  autoDetectDefs,
  resolveEdges,
  inferCooccurrence,
} from './edge-detection.js';

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
  _generic?: boolean;
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
 * Parse a JSON import payload.
 * Accepts: array of event objects, array of generic objects,
 * or a keyed object with array values.
 */
export function parseJsonImport(payload: unknown, targetPrefix?: string): ImportEventRow[] {
  let arr: any[];

  if (Array.isArray(payload)) {
    arr = payload;
  } else if (typeof payload === 'object' && payload !== null) {
    // Check if it's a wrapper like { events: [...] }
    const obj = payload as Record<string, any>;
    if (Array.isArray(obj.events)) {
      arr = obj.events;
    } else if (Array.isArray(obj._flat_events_for_import)) {
      arr = obj._flat_events_for_import;
    } else {
      // Keyed collection: discover structure, use entity IDs, and detect edges
      return parseKeyedCollections(obj, targetPrefix);
    }
  } else {
    throw new Error('JSON import payload must be an array or object');
  }

  if (arr.length === 0) throw new Error('JSON import: empty payload');

  // Check if first item looks like event format
  const looksLikeEvents = arr[0]?.op && arr[0]?.target;

  return arr.map((item, i) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`JSON import: item at index ${i} is not an object`);
    }
    if (looksLikeEvents) {
      return item as ImportEventRow;
    }
    // Generic: wrap as INS
    const prefix = targetPrefix || 'import.data';
    return {
      op: 'INS',
      target: `${prefix}.rec${String(i + 1).padStart(String(arr.length).length, '0')}`,
      operand: item,
      _generic: true,
    } as ImportEventRow;
  });
}

/**
 * Parse a keyed-collection JSON object into import rows.
 * Discovers collections, uses entity IDs as targets,
 * and auto-detects foreign key relationships to create CON events.
 */
function parseKeyedCollections(obj: Record<string, any>, targetPrefix?: string): ImportEventRow[] {
  const prefix = targetPrefix || 'import';
  const rows: ImportEventRow[] = [];

  // Discover collections (arrays of objects + singleton objects)
  const collections = jsonToCollections(obj);
  if (Object.keys(collections).length === 0) {
    // Fallback: wrap entire object as single INS event
    return [{
      op: 'INS',
      target: `${prefix}.data.rec1`,
      operand: obj,
      _generic: true,
    }];
  }

  // Discover structure and populate entities
  const typeRegistry = discoverStructure(collections);
  const entityRegistry = populateEntities(collections, typeRegistry);

  // INS events for all entities — use real entity IDs
  for (const [collectionName, records] of Object.entries(collections)) {
    const meta = typeRegistry.get(collectionName);
    if (!meta) continue;

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const id = record[meta.idField] != null
        ? String(record[meta.idField])
        : `rec${String(i + 1).padStart(String(records.length).length, '0')}`;
      rows.push({
        op: 'INS',
        target: `${prefix}.${collectionName}.${id}`,
        operand: record,
      });
    }
  }

  // Auto-detect foreign key relationships and create CON events
  const defs = autoDetectDefs(collections, typeRegistry, entityRegistry);
  if (defs.length > 0) {
    const { explicitEdges } = resolveEdges(defs, collections, typeRegistry, entityRegistry);
    for (const edge of explicitEdges) {
      rows.push({
        op: 'CON',
        target: `${prefix}.${edge.sourceCollection}.${edge.source}`,
        operand: {
          added: [`${prefix}.${edge.targetCollection}.${edge.target}`],
          edge_type: edge.field,
        },
      });
    }
  }

  return rows;
}

/**
 * Parse a CSV or TSV string into import rows.
 *
 * If the file has op + target columns, imports as event format.
 * Otherwise, treats each row as generic data → INS events.
 *
 * Delimiter is auto-detected (tab vs comma) if not specified.
 */
export function parseCsvImport(csvText: string, options?: { delimiter?: string; targetPrefix?: string }): ImportEventRow[] {
  // Auto-detect delimiter
  let delimiter = options?.delimiter;
  if (!delimiter) {
    const firstLine = csvText.split(/\r?\n/)[0];
    const tabCount = (firstLine.match(/\t/g) || []).length;
    const commaCount = (firstLine.match(/,/g) || []).length;
    delimiter = tabCount > commaCount ? '\t' : ',';
  }

  const lines = parseCsvLines(csvText, delimiter);
  if (lines.length < 2) {
    throw new Error('Import: must contain a header row and at least one data row');
  }

  const headers = lines[0].map(h => h.trim());
  const headersLower = headers.map(h => h.toLowerCase());
  const opIdx = headersLower.indexOf('op');
  const targetIdx = headersLower.indexOf('target');
  const hasEventFormat = opIdx !== -1 && targetIdx !== -1;

  if (hasEventFormat) {
    // Event-format: require op + target
    const operandIdx = headersLower.indexOf('operand');
    const tsIdx = headersLower.indexOf('ts');
    const clientEventIdIdx = headersLower.indexOf('client_event_id');
    const metaIdx = headersLower.indexOf('meta');

    const rows: ImportEventRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i];
      if (cols.length === 1 && cols[0].trim() === '') continue;

      const row: ImportEventRow = {
        op: cols[opIdx]?.trim() || '',
        target: cols[targetIdx]?.trim() || '',
      };

      if (operandIdx !== -1 && cols[operandIdx]?.trim()) {
        try {
          row.operand = JSON.parse(cols[operandIdx].trim());
        } catch {
          throw new Error(`Import: invalid JSON in "operand" column at row ${i + 1}`);
        }
      }
      if (tsIdx !== -1 && cols[tsIdx]?.trim()) row.ts = cols[tsIdx].trim();
      if (clientEventIdIdx !== -1 && cols[clientEventIdIdx]?.trim()) row.client_event_id = cols[clientEventIdIdx].trim();
      if (metaIdx !== -1 && cols[metaIdx]?.trim()) {
        try {
          row.meta = JSON.parse(cols[metaIdx].trim());
        } catch {
          throw new Error(`Import: invalid JSON in "meta" column at row ${i + 1}`);
        }
      }
      rows.push(row);
    }
    return rows;
  } else {
    // Generic: each row → INS event with all columns as operand
    const prefix = options?.targetPrefix || 'import.data';
    const total = lines.length - 1;
    const rows: ImportEventRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i];
      if (cols.length === 1 && cols[0].trim() === '') continue;
      if (cols.every(c => c.trim() === '')) continue;

      const operand: Record<string, any> = {};
      for (let j = 0; j < headers.length; j++) {
        const val = (cols[j] || '').trim();
        if (val === '') continue;
        if (val === 'true') operand[headers[j]] = true;
        else if (val === 'false') operand[headers[j]] = false;
        else if (val === 'null') operand[headers[j]] = null;
        else if (!isNaN(Number(val)) && val !== '') operand[headers[j]] = Number(val);
        else operand[headers[j]] = val;
      }

      rows.push({
        op: 'INS',
        target: `${prefix}.rec${String(rows.length + 1).padStart(String(total).length, '0')}`,
        operand,
        _generic: true,
      });
    }
    return rows;
  }
}

/**
 * Parse delimited text into an array of string arrays, handling quoted fields.
 */
export function parseCsvLines(text: string, delimiter: string = ','): string[][] {
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
      } else if (ch === delimiter) {
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
  options?: { halt_on_error?: boolean; sink?: EventSink },
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
      const seq = options?.sink
        ? await options.sink.emit(eventInput)
        : await processEvent(db, eventInput, feed);
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
