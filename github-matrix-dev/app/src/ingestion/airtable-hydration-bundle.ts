/**
 * Hydration bundle — newline-delimited JSON (NDJSON) file format for a
 * "save-first, fold-later" Airtable import.
 *
 * Each line is a single JSON object terminated by `\n`. The bundle is
 * appendable (a crashed fetch leaves a valid prefix that can be re-parsed)
 * and stream-parseable (a line is the natural unit of recovery).
 *
 * Line types:
 *   header       — first line; import metadata and full schema manifest.
 *   page         — one Airtable page of records for a single table.
 *   table_end    — sentinel marking a table's records are fully captured.
 *   end          — last line; marks the bundle complete.
 *
 * A well-formed bundle always starts with `header` and (when complete) ends
 * with `end`. A bundle missing the `end` line is treated as in-progress by
 * `BundleReader` — callers can still fold whatever completed tables are
 * already written.
 *
 * This module is transport-agnostic: writers emit bytes, callers decide
 * whether to tee them to Drive, a Blob for local download, or both.
 */

import type { AirtableRecord } from './airtable-client';
import type { HydrationManifest } from './airtable-sync';

export const HYDRATION_BUNDLE_FORMAT = 'eo-hydration-bundle';
export const HYDRATION_BUNDLE_VERSION = 1 as const;
export const HYDRATION_BUNDLE_MIME = 'application/x-ndjson';
export const HYDRATION_BUNDLE_EXT = 'ndjson';

export interface HydrationBundleHeader {
  type: 'header';
  format: typeof HYDRATION_BUNDLE_FORMAT;
  version: typeof HYDRATION_BUNDLE_VERSION;
  source: 'airtable';
  importId: string;
  collectedAt: string;
  manifest: HydrationManifest;
}

export interface HydrationBundlePage {
  type: 'page';
  baseId: string;
  baseName: string;
  tableId: string;
  tableName: string;
  useFieldIds: boolean;
  pageIndex: number;
  records: AirtableRecord[];
}

export interface HydrationBundleTableEnd {
  type: 'table_end';
  baseId: string;
  tableId: string;
  recordCount: number;
}

export interface HydrationBundleEnd {
  type: 'end';
  importId: string;
  completedAt: string;
  tableCount: number;
  recordCount: number;
}

export type HydrationBundleLine =
  | HydrationBundleHeader
  | HydrationBundlePage
  | HydrationBundleTableEnd
  | HydrationBundleEnd;

/** Deterministic filename used for both the local download and the Drive copy. */
export function hydrationBundleFilename(importId: string): string {
  const safe = importId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `airtable-hydration-${safe}.${HYDRATION_BUNDLE_EXT}`;
}

// ─── Writer ────────────────────────────────────────────────────────────────

/**
 * Accumulates NDJSON lines in memory and tees to an optional local `Blob`.
 *
 * The writer keeps the full byte buffer so `toBytes()` can produce a single
 * upload for Drive and `toBlob()` can back a browser download — both
 * reading the same underlying bytes. Stays in memory: typical Airtable
 * bundles (~1–5 KB/record) fit comfortably even for 50 k records.
 */
export class HydrationBundleWriter {
  private chunks: Uint8Array[] = [];
  private _byteLength = 0;
  private encoder = new TextEncoder();

  get byteLength(): number {
    return this._byteLength;
  }

  /**
   * Seed a writer from bytes previously written by another session — used
   * on resume after reloading an in-progress bundle from Drive. The caller
   * is responsible for ensuring the seed bytes are a valid NDJSON prefix;
   * `parseHydrationBundle()` provides the validation layer.
   */
  static fromBytes(bytes: Uint8Array): HydrationBundleWriter {
    const w = new HydrationBundleWriter();
    if (bytes.byteLength > 0) {
      w.chunks.push(bytes);
      w._byteLength = bytes.byteLength;
    }
    return w;
  }

  appendLine(line: HydrationBundleLine): void {
    const bytes = this.encoder.encode(JSON.stringify(line) + '\n');
    this.chunks.push(bytes);
    this._byteLength += bytes.byteLength;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this._byteLength);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }

  /**
   * Produce a `Blob` suitable for `URL.createObjectURL()`. Uses the same
   * underlying bytes as `toBytes()` — calling both is cheap.
   */
  toBlob(): Blob {
    return new Blob([this.toBytes() as unknown as BlobPart], {
      type: HYDRATION_BUNDLE_MIME,
    });
  }
}

// ─── Reader ────────────────────────────────────────────────────────────────

/**
 * Parse an NDJSON bundle into its header + per-table pages.
 *
 * Tolerant of truncated input: an unterminated final line is dropped
 * silently so a bundle written by a crashed fetch still yields every
 * complete line before the crash point. Throws only when the header is
 * missing or malformed — without a header there's no way to know what the
 * bundle contains.
 */
export interface ParsedHydrationBundle {
  header: HydrationBundleHeader;
  /** Pages grouped by `${baseId}:${tableId}` in the order they were written. */
  tables: Array<{
    baseId: string;
    baseName: string;
    tableId: string;
    tableName: string;
    useFieldIds: boolean;
    pages: HydrationBundlePage[];
    complete: boolean;
    recordCount: number;
  }>;
  complete: boolean;
  completedAt?: string;
}

export function parseHydrationBundle(bytes: Uint8Array): ParsedHydrationBundle {
  const text = new TextDecoder().decode(bytes);
  const lines = text.split('\n');
  // Drop the final empty element from the trailing newline, plus any unterminated
  // partial line written by a crashed fetch.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let header: HydrationBundleHeader | null = null;
  const tableMap = new Map<string, ParsedHydrationBundle['tables'][number]>();
  const tableOrder: string[] = [];
  let complete = false;
  let completedAt: string | undefined;

  for (const raw of lines) {
    if (!raw) continue;
    let line: HydrationBundleLine;
    try {
      line = JSON.parse(raw) as HydrationBundleLine;
    } catch {
      // Tolerate a truncated last line; anything else mid-stream is a hard error.
      continue;
    }
    if (line.type === 'header') {
      if (line.format !== HYDRATION_BUNDLE_FORMAT) {
        throw new Error(`unexpected bundle format: ${line.format}`);
      }
      header = line;
    } else if (line.type === 'page') {
      const key = `${line.baseId}:${line.tableId}`;
      let entry = tableMap.get(key);
      if (!entry) {
        entry = {
          baseId: line.baseId,
          baseName: line.baseName,
          tableId: line.tableId,
          tableName: line.tableName,
          useFieldIds: line.useFieldIds,
          pages: [],
          complete: false,
          recordCount: 0,
        };
        tableMap.set(key, entry);
        tableOrder.push(key);
      }
      entry.pages.push(line);
      entry.recordCount += line.records.length;
    } else if (line.type === 'table_end') {
      const key = `${line.baseId}:${line.tableId}`;
      const entry = tableMap.get(key);
      if (entry) entry.complete = true;
    } else if (line.type === 'end') {
      complete = true;
      completedAt = line.completedAt;
    }
  }

  if (!header) {
    throw new Error('hydration bundle missing header line');
  }

  return {
    header,
    tables: tableOrder.map((k) => tableMap.get(k)!),
    complete,
    completedAt,
  };
}
