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
  _generic?: boolean;
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
// Parse helpers
// ---------------------------------------------------------------------------

function parseJson(text: string): { rows: ParsedRow[]; isGeneric: boolean } {
  let data: any;
  try { data = JSON.parse(text); }
  catch { throw new Error('Invalid JSON — could not parse file'); }

  let arr: any[] | null = Array.isArray(data) ? data
    : Array.isArray(data?.events) ? data.events
    : Array.isArray(data?._flat_events_for_import) ? data._flat_events_for_import
    : null;

  if (!arr && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const hasArrayProp = Object.values(data).some(v => Array.isArray(v));
    if (hasArrayProp && !data.op) {
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
    return { rows: arr as ParsedRow[], isGeneric: false };
  }

  const rows: ParsedRow[] = arr.map((item, i) => {
    if (typeof item !== 'object' || item === null) throw new Error(`Item ${i}: not an object`);
    return { op: 'INS', target: null, operand: item, _generic: true };
  });
  return { rows, isGeneric: true };
}

function parseCsv(text: string, forceTsv: boolean): { rows: ParsedRow[]; isGeneric: boolean } {
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
    return { rows, isGeneric: false };
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
  return { rows, isGeneric: true };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ImportView() {
  const { theme: t } = useTheme();
  const dispatch = useEoStore((s) => s.dispatch);

  const [status, setStatus] = useState<ImportStatus>('idle');
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [isGeneric, setIsGeneric] = useState(false);
  const [fileName, setFileName] = useState('');
  const [fileStats, setFileStats] = useState('');
  const [targetPrefix, setTargetPrefix] = useState('');
  const [haltOnError, setHaltOnError] = useState(true);
  const [message, setMessage] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, errors: 0 });
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
        setIsGeneric(result.isGeneric);
        setFileName(file.name);
        const label = result.isGeneric ? 'row' : 'event';
        const sizeKb = (file.size / 1024).toFixed(1);
        setFileStats(`${result.rows.length} ${label}${result.rows.length !== 1 ? 's' : ''} · ${sizeKb} KB · ${ext!.toUpperCase()}${result.isGeneric ? ' (generic → INS)' : ''}`);
        if (result.isGeneric) {
          const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
          setTargetPrefix('import.' + baseName);
        }
        setStatus('parsed');
        setMessage({ type: 'info', text: `Parsed ${result.rows.length} ${label}s. Review and click "Import Events" to proceed.` });
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
    setIsGeneric(false);
    setFileName('');
    setFileStats('');
    setTargetPrefix('');
    setMessage(null);
    setProgress({ current: 0, total: 0, errors: 0 });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const runImport = async () => {
    if (rows.length === 0) return;
    setStatus('importing');
    setProgress({ current: 0, total: rows.length, errors: 0 });

    let errors = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const target = row._generic
          ? `${targetPrefix}.rec_${crypto.randomUUID().slice(0, 8)}`
          : row.target!;
        await dispatch({
          op: row.op as ExternalOperator,
          target,
          operand: row.operand ?? {},
          agent: 'import',
          ts: row.ts || new Date().toISOString(),
          acquired_ts: new Date().toISOString(),
          client_event_id: row.client_event_id,
          meta: row.meta,
        });
      } catch (e: any) {
        errors++;
        if (haltOnError) {
          setStatus('error');
          setMessage({ type: 'error', text: `Error at row ${i + 1}: ${e.message}` });
          setProgress(p => ({ ...p, current: i + 1, errors }));
          return;
        }
      }
      setProgress({ current: i + 1, total: rows.length, errors });
    }

    setStatus('done');
    setMessage({
      type: errors > 0 ? 'error' : 'success',
      text: errors > 0
        ? `Imported ${rows.length - errors} of ${rows.length} events (${errors} errors)`
        : `Successfully imported ${rows.length} event${rows.length !== 1 ? 's' : ''}`,
    });
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

      {/* Target prefix for generic imports */}
      {isGeneric && status === 'parsed' && (
        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Target Prefix
          </label>
          <input
            value={targetPrefix}
            onChange={(e) => setTargetPrefix(e.target.value)}
            placeholder="e.g. import.my_data"
            style={{
              display: 'block', width: '100%', marginTop: 4, padding: '8px 10px',
              border: `1px solid ${t.border}`, borderRadius: 4, background: t.bg,
              color: t.text, fontSize: 13, fontFamily: "'JetBrains Mono', monospace",
              boxSizing: 'border-box',
            }}
          />
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 4 }}>
            Each row becomes an INS event at {targetPrefix || '...'}.rec_*
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
            disabled={isGeneric && !targetPrefix.trim()}
            style={{
              padding: '6px 16px', fontSize: 12, border: 'none', borderRadius: 4,
              background: t.accent, color: '#fff', cursor: 'pointer', fontWeight: 600,
              opacity: isGeneric && !targetPrefix.trim() ? 0.5 : 1,
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
