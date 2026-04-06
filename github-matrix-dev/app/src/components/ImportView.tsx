import { useState, useRef, useCallback } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme } from '../theme';
import type { ExternalOperator } from '../db/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedRow {
  op: string;
  target: string | null;
  operand?: any;
  ts?: string;
  client_event_id?: string;
  meta?: Record<string, any>;
  /** Row came from a generic (no-op/target) import and needs a random target. */
  _generic?: boolean;
  /** Row came from a keyed-collection import; `target` is a relative path ("collection.id"). */
  _keyed?: boolean;
}

type ImportMode = 'event' | 'generic' | 'keyed';

interface EdgeDetail {
  /** Field on the source collection that references the target. */
  field: string;
  /** Source collection name. */
  sourceCollection: string;
  /** Target collection name. */
  targetCollection: string;
  /** Number of individual CON events generated for this relationship. */
  count: number;
}

interface KeyedSummary {
  /** Collections discovered: name → entity count. */
  collections: Array<{ name: string; count: number; idField: string }>;
  /** Number of CON edge events generated from auto-detected references. */
  edgeCount: number;
  /** Per-relationship breakdown of detected edges. */
  edges: EdgeDetail[];
}

type ImportStatus = 'idle' | 'parsed' | 'importing' | 'done' | 'error';

const VALID_OPS = new Set(['INS', 'DEF', 'CON', 'SEG', 'SYN', 'EVA']);

// ---------------------------------------------------------------------------
// CSV Parser — handles quoted fields, newlines inside quotes, etc.
// ---------------------------------------------------------------------------

function parseCsvLines(text: string, delimiter: string): string[][] {
  const results: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += ch; i++; }
    } else {
      if (ch === '"') { inQuotes = true; i++; }
      else if (ch === delimiter) { current.push(field); field = ''; i++; }
      else if (ch === '\n' || (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n')) {
        current.push(field); field = ''; results.push(current); current = [];
        i += ch === '\r' ? 2 : 1;
      } else if (ch === '\r') {
        current.push(field); field = ''; results.push(current); current = []; i++;
      } else { field += ch; i++; }
    }
  }
  if (field || current.length > 0) { current.push(field); results.push(current); }
  return results;
}

// ---------------------------------------------------------------------------
// Keyed-collection detection (mirrors server-side parseKeyedCollections)
// ---------------------------------------------------------------------------

const ID_PATTERNS: RegExp[] = [
  /^[A-Z]+-\d+$/,
  /^[A-Z]+_\d+$/,
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  /^\d+$/,
];

function jsonToCollections(parsed: Record<string, any>): Record<string, Record<string, any>[]> {
  const collections: Record<string, Record<string, any>[]> = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
      collections[key] = val as Record<string, any>[];
    } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      collections[key] = [val];
    }
  }
  return collections;
}

function findIdField(records: Record<string, any>[]): { idField: string } {
  if (records.length === 0) return { idField: 'id' };

  const fieldValues = new Map<string, string[]>();
  for (const record of records) {
    for (const [key, val] of Object.entries(record)) {
      if (val == null) continue;
      const strVal = typeof val === 'string' ? val : typeof val === 'number' ? String(val) : null;
      if (strVal === null) continue;
      if (!fieldValues.has(key)) fieldValues.set(key, []);
      fieldValues.get(key)!.push(strVal);
    }
  }

  const candidates: string[] = [];
  for (const [field, values] of fieldValues) {
    if (values.length === records.length && new Set(values).size === records.length) {
      candidates.push(field);
    }
  }
  if (candidates.length === 0) {
    const firstField = fieldValues.keys().next().value;
    return { idField: firstField ?? 'id' };
  }
  let chosen = candidates[0];
  for (const c of candidates) {
    if (c === 'id') { chosen = c; break; }
    if (c.endsWith('_id') && chosen !== 'id') chosen = c;
  }
  // Prefer ID-like patterns (ATT-001, UUID) when multiple candidates exist
  for (const c of candidates) {
    const values = fieldValues.get(c)!;
    if (values.length > 0 && ID_PATTERNS.some(p => values.every(v => p.test(v)))) {
      if (chosen !== 'id' && !chosen.endsWith('_id')) chosen = c;
      break;
    }
  }
  return { idField: chosen };
}

function extractCandidateIds(value: any): string[] {
  if (value == null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    const ids: string[] = [];
    for (const item of value) if (typeof item === 'string') ids.push(item);
    return ids;
  }
  return [];
}

interface KeyedParse {
  rows: ParsedRow[];
  summary: KeyedSummary;
}

function parseKeyedCollections(obj: Record<string, any>): KeyedParse | null {
  const collections = jsonToCollections(obj);
  const names = Object.keys(collections);
  if (names.length === 0) return null;

  // Discover ID fields per collection.
  const meta = new Map<string, { idField: string }>();
  for (const [name, records] of Object.entries(collections)) {
    meta.set(name, findIdField(records));
  }

  // Build entity registry: id → collection
  const entityRegistry = new Map<string, { collection: string }>();
  for (const [name, records] of Object.entries(collections)) {
    const idField = meta.get(name)!.idField;
    for (let i = 0; i < records.length; i++) {
      const raw = records[i][idField];
      const id = raw != null
        ? String(raw)
        : `rec${String(i + 1).padStart(String(records.length).length, '0')}`;
      // Don't collide across collections — first writer wins for lookup
      if (!entityRegistry.has(id)) entityRegistry.set(id, { collection: name });
    }
  }

  const rows: ParsedRow[] = [];

  // INS events
  for (const [name, records] of Object.entries(collections)) {
    const idField = meta.get(name)!.idField;
    for (let i = 0; i < records.length; i++) {
      const raw = records[i][idField];
      const id = raw != null
        ? String(raw)
        : `rec${String(i + 1).padStart(String(records.length).length, '0')}`;
      rows.push({
        op: 'INS',
        target: `${name}.${id}`,
        operand: records[i],
        _keyed: true,
      });
    }
  }

  // Auto-detect foreign key refs → CON events.
  let edgeCount = 0;
  // Track per-relationship edge counts: "sourceCollection|field|targetCollection" → count
  const edgeCountMap = new Map<string, { field: string; sourceCollection: string; targetCollection: string; count: number }>();
  for (const [name, records] of Object.entries(collections)) {
    const idField = meta.get(name)!.idField;
    for (const record of records) {
      const sourceId = String(record[idField]);
      for (const [field, value] of Object.entries(record)) {
        if (field === idField) continue;
        const candidates = extractCandidateIds(value);
        for (const candidateId of candidates) {
          if (candidateId === sourceId) continue;
          const entry = entityRegistry.get(candidateId);
          if (!entry) continue;
          rows.push({
            op: 'CON',
            target: `${name}.${sourceId}`,
            operand: {
              added: [`${entry.collection}.${candidateId}`],
              edge_type: field,
            },
            _keyed: true,
          });
          edgeCount++;
          const edgeKey = `${name}|${field}|${entry.collection}`;
          const existing = edgeCountMap.get(edgeKey);
          if (existing) {
            existing.count++;
          } else {
            edgeCountMap.set(edgeKey, { field, sourceCollection: name, targetCollection: entry.collection, count: 1 });
          }
        }
      }
    }
  }

  const edges: EdgeDetail[] = Array.from(edgeCountMap.values())
    .sort((a, b) => b.count - a.count);

  const summary: KeyedSummary = {
    collections: names.map(n => ({
      name: n,
      count: collections[n].length,
      idField: meta.get(n)!.idField,
    })),
    edgeCount,
    edges,
  };

  return { rows, summary };
}

// ---------------------------------------------------------------------------
// JSON parse
// ---------------------------------------------------------------------------

function parseJson(text: string): { rows: ParsedRow[]; mode: ImportMode; keyed?: KeyedSummary } {
  let data: any;
  try { data = JSON.parse(text); }
  catch { throw new Error('Invalid JSON — could not parse file'); }

  // Event-format wrappers
  let arr: any[] | null = Array.isArray(data) ? data
    : Array.isArray(data?.events) ? data.events
    : Array.isArray(data?._flat_events_for_import) ? data._flat_events_for_import
    : null;

  // Keyed-collections object (multiple entity types at top level)
  if (!arr && typeof data === 'object' && data !== null && !Array.isArray(data) && !data.op) {
    const keyed = parseKeyedCollections(data);
    if (keyed) {
      return { rows: keyed.rows, mode: 'keyed', keyed: keyed.summary };
    }
    // Single collection fallback → generic flatten
    const hasArrayProp = Object.values(data).some(v => Array.isArray(v));
    if (hasArrayProp) {
      const flattened: any[] = [];
      for (const [key, val] of Object.entries(data)) {
        if (Array.isArray(val)) {
          val.forEach((item: any) => {
            if (typeof item === 'object' && item !== null) flattened.push({ _source_key: key, ...item });
          });
        }
      }
      if (flattened.length > 0) arr = flattened;
    }
    if (!arr) arr = [data];
  }

  if (!arr) throw new Error('JSON must be an array, an object, or contain an "events" key');
  if (arr.length === 0) throw new Error('JSON is empty — nothing to import');

  const looksLikeEvents = arr.length > 0 && arr[0].op && arr[0].target;

  if (looksLikeEvents) {
    for (let i = 0; i < arr.length; i++) {
      const row = arr[i];
      if (typeof row !== 'object' || row === null) throw new Error(`Item ${i}: not an object`);
      if (!row.op) throw new Error(`Item ${i}: missing "op"`);
      if (!VALID_OPS.has(row.op.toUpperCase())) throw new Error(`Item ${i}: invalid op "${row.op}"`);
      if (!row.target) throw new Error(`Item ${i}: missing "target"`);
      row.op = row.op.toUpperCase();
    }
    return { rows: arr as ParsedRow[], mode: 'event' };
  }

  const rows: ParsedRow[] = arr.map((item, i) => {
    if (typeof item !== 'object' || item === null) throw new Error(`Item ${i}: not an object`);
    return { op: 'INS', target: null, operand: item, _generic: true };
  });
  return { rows, mode: 'generic' };
}

function parseCsv(text: string, forceTsv: boolean): { rows: ParsedRow[]; mode: ImportMode } {
  let delimiter: string;
  if (forceTsv) {
    delimiter = '\t';
  } else {
    const firstLine = text.split(/\r?\n/)[0];
    const tabCount = (firstLine.match(/\t/g) || []).length;
    const commaCount = (firstLine.match(/,/g) || []).length;
    delimiter = tabCount > commaCount ? '\t' : ',';
  }

  const lines = parseCsvLines(text, delimiter);
  if (lines.length < 2) throw new Error('File must have a header row and at least one data row');

  const headers = lines[0].map(h => h.trim());
  const headersLower = headers.map(h => h.toLowerCase());
  const opIdx = headersLower.indexOf('op');
  const targetIdx = headersLower.indexOf('target');
  const hasEventFormat = opIdx !== -1 && targetIdx !== -1;

  if (hasEventFormat) {
    const operandIdx = headersLower.indexOf('operand');
    const tsIdx = headersLower.indexOf('ts');
    const cidIdx = headersLower.indexOf('client_event_id');
    const metaIdx = headersLower.indexOf('meta');
    const rows: ParsedRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i];
      if (cols.length === 1 && cols[0].trim() === '') continue;
      const op = (cols[opIdx] || '').trim().toUpperCase();
      const target = (cols[targetIdx] || '').trim();
      if (!op && !target) continue;
      if (!op) throw new Error(`Row ${i + 1}: missing "op"`);
      if (!VALID_OPS.has(op)) throw new Error(`Row ${i + 1}: invalid op "${op}"`);
      if (!target) throw new Error(`Row ${i + 1}: missing "target"`);
      const row: ParsedRow = { op, target };
      if (operandIdx !== -1 && cols[operandIdx]?.trim()) {
        try { row.operand = JSON.parse(cols[operandIdx].trim()); }
        catch { throw new Error(`Row ${i + 1}: invalid JSON in "operand" column`); }
      }
      if (tsIdx !== -1 && cols[tsIdx]?.trim()) row.ts = cols[tsIdx].trim();
      if (cidIdx !== -1 && cols[cidIdx]?.trim()) row.client_event_id = cols[cidIdx].trim();
      if (metaIdx !== -1 && cols[metaIdx]?.trim()) {
        try { row.meta = JSON.parse(cols[metaIdx].trim()); }
        catch { throw new Error(`Row ${i + 1}: invalid JSON in "meta" column`); }
      }
      rows.push(row);
    }
    if (rows.length === 0) throw new Error('File has no data rows');
    return { rows, mode: 'event' };
  }

  // Generic CSV: each row → INS
  const rows: ParsedRow[] = [];
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
    rows.push({ op: 'INS', target: null, operand, _generic: true });
  }
  if (rows.length === 0) throw new Error('File has no data rows');
  return { rows, mode: 'generic' };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ImportViewProps {
  onImportComplete?: (scope: string) => void;
}

export function ImportView({ onImportComplete }: ImportViewProps) {
  const { theme: t } = useTheme();
  const dispatch = useEoStore((s) => s.dispatch);
  const batchImport = useEoStore((s) => s.batchImport);

  const [status, setStatus] = useState<ImportStatus>('idle');
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [mode, setMode] = useState<ImportMode>('event');
  const [keyedSummary, setKeyedSummary] = useState<KeyedSummary | null>(null);
  const [fileName, setFileName] = useState('');
  const [fileStats, setFileStats] = useState('');
  const [targetPrefix, setTargetPrefix] = useState('');
  const [haltOnError, setHaltOnError] = useState(true);
  const [message, setMessage] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, errors: 0 });
  const [creationDate, setCreationDate] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'json' && ext !== 'csv' && ext !== 'tsv') {
      setMessage({ type: 'error', text: 'Unsupported file type. Use .json, .csv, or .tsv' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        const result = ext === 'json' ? parseJson(text) : parseCsv(text, ext === 'tsv');
        setRows(result.rows);
        setMode(result.mode);
        const keyed = result.mode === 'keyed' && 'keyed' in result ? (result as { keyed: KeyedSummary }).keyed : null;
        setKeyedSummary(keyed);
        setFileName(file.name);
        const sizeKb = (file.size / 1024).toFixed(1);
        let label: string;
        let suffix = '';
        if (result.mode === 'keyed' && keyed) {
          const entityCount = keyed.collections.reduce((s, c) => s + c.count, 0);
          label = 'event';
          suffix = ` · ${keyed.collections.length} tables · ${entityCount} entities${keyed.edgeCount ? ` · ${keyed.edgeCount} edges` : ''}`;
        } else if (result.mode === 'generic') {
          label = 'row';
          suffix = ' (generic → INS)';
        } else {
          label = 'event';
        }
        setFileStats(`${result.rows.length} ${label}${result.rows.length !== 1 ? 's' : ''} · ${sizeKb} KB · ${ext!.toUpperCase()}${suffix}`);
        if (result.mode === 'generic' || result.mode === 'keyed') {
          const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
          setTargetPrefix(result.mode === 'keyed' ? 'import' : 'import.' + baseName);
        }
        setStatus('parsed');
        let msg = `Parsed ${result.rows.length} ${label}s.`;
        if (result.mode === 'keyed' && keyed) {
          msg = `Detected ${keyed.collections.length} entity types (${keyed.collections.map(c => c.name).join(', ')}) with ${keyed.edgeCount} auto-detected relationships.`;
        }
        setMessage({ type: 'info', text: `${msg} Review and click "Import Events" to proceed.` });
      } catch (e: any) {
        setStatus('error');
        setMessage({ type: 'error', text: e.message });
      }
    };
    reader.readAsText(file);
  }, []);

  const handleClear = () => {
    setStatus('idle');
    setRows([]);
    setMode('event');
    setKeyedSummary(null);
    setFileName('');
    setFileStats('');
    setTargetPrefix('');
    setCreationDate('');
    setMessage(null);
    setProgress({ current: 0, total: 0, errors: 0 });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const runImport = async () => {
    if (rows.length === 0) return;
    setStatus('importing');
    setProgress({ current: 0, total: rows.length, errors: 0 });

    // Prepare all events upfront
    const prefix = targetPrefix.trim().replace(/\.+$/, '');
    const events = rows.map((row) => ({
      op: row.op as ExternalOperator,
      target: row._keyed
        ? `${prefix}.${row.target}`
        : row._generic
        ? `${prefix}.rec_${crypto.randomUUID().slice(0, 8)}`
        : row.target!,
      operand: row._keyed && row.op === 'CON' && row.operand?.added
        ? { ...row.operand, added: row.operand.added.map((t: string) => `${prefix}.${t}`) }
        : row.operand ?? {},
      agent: 'import',
      ts: creationDate
        ? new Date(creationDate + 'T00:00:00Z').toISOString()
        : (row.ts || new Date().toISOString()),
      acquired_ts: new Date().toISOString(),
      client_event_id: row.client_event_id,
      meta: row.meta,
    }));

    try {
      // Batch import: fold locally for progress, send as single Matrix message
      await batchImport(events, (current, total) => {
        setProgress({ current, total, errors: 0 });
      });

      setStatus('done');
      setMessage({
        type: 'success',
        text: `Successfully imported ${rows.length} event${rows.length !== 1 ? 's' : ''}`,
      });
    } catch (e: any) {
      setStatus('error');
      setMessage({ type: 'error', text: `Import failed: ${e.message}` });
      return;
    }

    // Auto-navigate to the imported scope so the user sees their records immediately
    if (onImportComplete) {
      if ((mode === 'generic' || mode === 'keyed') && targetPrefix.trim()) {
        // Generic/keyed imports: navigate to the target prefix scope (e.g. "import.my_data")
        onImportComplete(targetPrefix.trim());
      } else if (mode === 'event' && rows.length > 0 && rows[0].target) {
        // Event-format imports: derive the common parent scope from event targets
        const firstTarget = rows[0].target!;
        const parts = firstTarget.split('.');
        if (parts.length >= 2) {
          onImportComplete(parts.slice(0, -1).join('.'));
        }
      }
    }
  };

  const preview = rows.slice(0, 5);

  return (
    <div style={{ flex: 1, overflowY: 'auto', maxWidth: 640, margin: '0 auto', padding: '0 28px 48px' }}>
      <div style={{ padding: '32px 0 12px', borderBottom: `1px solid ${t.border}`, marginBottom: 24 }}>
        <div style={{ fontFamily: "'Source Serif 4', Georgia, serif", fontSize: 22, fontWeight: 600, color: t.textHeading }}>
          Import Data
        </div>
        <div style={{ fontSize: 13, color: t.textSecondary, marginTop: 4 }}>
          Upload JSON, CSV, or TSV files to import records into your space
        </div>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
        }}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? t.accent : t.border}`,
          borderRadius: 8,
          padding: '32px 24px',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragging ? t.accentBg : t.bgMuted,
          transition: 'all 0.15s',
        }}
      >
        <div style={{ fontSize: 24, marginBottom: 8 }}>+</div>
        <div style={{ fontSize: 13, color: t.textSecondary }}>
          Drop a file here, or click to browse
        </div>
        <div style={{ fontSize: 11, color: t.textMuted, marginTop: 4 }}>
          JSON: array or object &nbsp;|&nbsp; CSV/TSV: header row + data rows
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.csv,.tsv"
        style={{ display: 'none' }}
        onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }}
      />

      {/* File info */}
      {fileName && (
        <div style={{ marginTop: 16, padding: '10px 14px', background: t.bgMuted, borderRadius: 6, fontSize: 13 }}>
          <div style={{ fontWeight: 600, color: t.text }}>{fileName}</div>
          <div style={{ color: t.textSecondary, fontSize: 12, marginTop: 2 }}>{fileStats}</div>
        </div>
      )}

      {/* Target prefix for generic/keyed imports */}
      {(mode === 'generic' || mode === 'keyed') && status === 'parsed' && (
        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Target Prefix
          </label>
          <input
            value={targetPrefix}
            onChange={(e) => setTargetPrefix(e.target.value)}
            placeholder={mode === 'keyed' ? 'e.g. import' : 'e.g. import.my_data'}
            style={{
              display: 'block', width: '100%', marginTop: 4, padding: '8px 10px',
              border: `1px solid ${t.border}`, borderRadius: 4, background: t.bg,
              color: t.text, fontSize: 13, fontFamily: "'JetBrains Mono', monospace",
              boxSizing: 'border-box',
            }}
          />
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 4 }}>
            {mode === 'keyed'
              ? `Entities land at ${targetPrefix || '...'}.{table}.{id}`
              : `Each row becomes an INS event at ${targetPrefix || '...'}.rec_*`}
          </div>
        </div>
      )}

      {/* Detected nodes & edges summary (keyed mode) */}
      {mode === 'keyed' && keyedSummary && status === 'parsed' && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Nodes section */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
              Nodes &mdash; {keyedSummary.collections.length} {keyedSummary.collections.length === 1 ? 'type' : 'types'}, {keyedSummary.collections.reduce((s, c) => s + c.count, 0)} entities
            </div>
            <div style={{ border: `1px solid ${t.border}`, borderRadius: 6, background: t.bgMuted, padding: '8px 0' }}>
              {keyedSummary.collections.map((c) => (
                <div key={c.name} style={{
                  display: 'flex', justifyContent: 'space-between',
                  padding: '4px 12px', fontSize: 12, color: t.text,
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  <span>{c.name}</span>
                  <span style={{ color: t.textMuted }}>
                    {c.count} {c.count === 1 ? 'entity' : 'entities'} · id: {c.idField}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Edges section */}
          {keyedSummary.edges.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
                Edges &mdash; {keyedSummary.edgeCount} connections from {keyedSummary.edges.length} {keyedSummary.edges.length === 1 ? 'relationship' : 'relationships'}
              </div>
              <div style={{ border: `1px solid ${t.border}`, borderRadius: 6, background: t.bgMuted, padding: '8px 0' }}>
                {keyedSummary.edges.map((e, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '4px 12px', fontSize: 12, color: t.text,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}>
                    <span>
                      <span>{e.sourceCollection}</span>
                      <span style={{ color: t.textMuted }}>.{e.field}</span>
                      <span style={{ color: t.textSecondary, margin: '0 6px' }}>&rarr;</span>
                      <span>{e.targetCollection}</span>
                    </span>
                    <span style={{ color: t.textMuted, fontSize: 11 }}>
                      {e.count} {e.count === 1 ? 'edge' : 'edges'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Creation date override */}
      {status === 'parsed' && (
        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Creation Date Override
          </label>
          <input
            type="date"
            value={creationDate}
            onChange={(e) => setCreationDate(e.target.value)}
            style={{
              display: 'block', width: '100%', marginTop: 4, padding: '8px 10px',
              border: `1px solid ${t.border}`, borderRadius: 4, background: t.bg,
              color: creationDate ? t.text : t.textMuted,
              fontSize: 13, fontFamily: "'JetBrains Mono', monospace",
              boxSizing: 'border-box',
            }}
          />
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 4 }}>
            Sets the creation date (ts) for all imported records. Leave blank to use each row's
            own timestamp or current time. The ingestion timestamp is always tracked separately.
          </div>
        </div>
      )}

      {/* Preview */}
      {preview.length > 0 && status === 'parsed' && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
            Preview ({Math.min(5, rows.length)} of {rows.length})
          </div>
          <pre style={{
            background: t.bgMuted, border: `1px solid ${t.border}`, borderRadius: 6,
            padding: 12, fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
            color: t.text, overflow: 'auto', maxHeight: 200, margin: 0,
          }}>
            {JSON.stringify(preview, null, 2)}
            {rows.length > 5 ? `\n... and ${rows.length - 5} more` : ''}
          </pre>
        </div>
      )}

      {/* Options + Actions */}
      {status === 'parsed' && (
        <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.textSecondary, cursor: 'pointer' }}>
            <input type="checkbox" checked={haltOnError} onChange={(e) => setHaltOnError(e.target.checked)} />
            Halt on error
          </label>
          <div style={{ flex: 1 }} />
          <button onClick={handleClear} style={{
            padding: '6px 14px', fontSize: 12, border: `1px solid ${t.border}`,
            borderRadius: 4, background: t.bg, color: t.textSecondary, cursor: 'pointer',
          }}>
            Clear
          </button>
          <button
            onClick={runImport}
            disabled={(mode === 'generic' || mode === 'keyed') && !targetPrefix.trim()}
            style={{
              padding: '6px 16px', fontSize: 12, border: 'none', borderRadius: 4,
              background: t.accent, color: '#fff', cursor: 'pointer', fontWeight: 600,
              opacity: (mode === 'generic' || mode === 'keyed') && !targetPrefix.trim() ? 0.5 : 1,
            }}
          >
            Import Events
          </button>
        </div>
      )}

      {/* Progress bar */}
      {(status === 'importing' || status === 'done') && progress.total > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{
            height: 6, background: t.bgMuted, borderRadius: 3, overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', borderRadius: 3, transition: 'width 0.2s',
              width: `${(progress.current / progress.total) * 100}%`,
              background: progress.errors > 0 ? t.danger : t.accent,
            }} />
          </div>
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 4 }}>
            {progress.current} / {progress.total}
            {progress.errors > 0 && ` (${progress.errors} errors)`}
          </div>
        </div>
      )}

      {/* Status message */}
      {message && (
        <div style={{
          marginTop: 16, padding: '10px 14px', borderRadius: 6, fontSize: 12,
          background: message.type === 'error' ? `${t.danger}18` : message.type === 'success' ? `${t.teal}18` : t.bgMuted,
          color: message.type === 'error' ? t.danger : message.type === 'success' ? t.teal : t.textSecondary,
          border: `1px solid ${message.type === 'error' ? `${t.danger}40` : message.type === 'success' ? `${t.teal}40` : t.border}`,
        }}>
          {message.text}
        </div>
      )}
    </div>
  );
}
