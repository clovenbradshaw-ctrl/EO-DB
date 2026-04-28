/**
 * Absorber loop — per-table cursor, folded into the Given-Log.
 *
 * This is the EO-native shape. The cursor is per-table, persisted as
 * `highWaterMark`. Each sync pull becomes a batch of `REC` events appended
 * to the log, then the fold derives current state.
 *
 * Subtleties this module enforces:
 *   - Persist the cursor only after the fold succeeds. If folding throws,
 *     we want to retry the same window, not skip it.
 *   - Page using `highWaterMark`, not `offset`. Restarting from the last
 *     persisted highWaterMark mid-stream is correct; resuming an offset is
 *     fragile.
 *   - One absorber per table — slow tables shouldn't block fast ones.
 *   - The loop is bounded (50 pages = 5000 records max per sync run) so a
 *     server-side bug can't spin us forever.
 */
import { gateway } from './gateway';
import { idb } from './idb';
import { AMINO_AIRTABLE_BASE_ID } from '../amino-config';

const MAX_PAGES = 50;

export interface SyncRecord {
  id: string;
  fields: Record<string, unknown>;
  /** Airtable's `createdTime`, when the gateway includes it. */
  createdTime?: string;
}

export interface SyncResponse {
  records: SyncRecord[];
  count: number;
  highWaterMark: string | null;
  hasMore: boolean;
  table: string;
  /** Field name the gateway used as the canonical event time for this batch. */
  lastModifiedField: string;
}

/**
 * One REC event derived from an Airtable row. `ts` is the canonical event
 * time (the value of `lastModifiedField`); `_src` records provenance so
 * the fold can tell sync-derived events apart from local edits.
 */
export interface RecEvent {
  op: 'REC';
  site: { base: string; table: string; id: string };
  resolution: Record<string, unknown>;
  /** ISO timestamp the gateway reported as `lastModifiedField` for this row. */
  ts: string | null;
  _src: 'airtable.sync';
}

/**
 * The pluggable side-effect contracts. The caller wires their Given-Log
 * append and their derived-store fold; this module never touches them
 * directly. Keeps the absorber single-purpose and testable.
 */
export interface SyncSinks {
  append(events: RecEvent[]): Promise<void>;
  fold(events: RecEvent[]): Promise<void>;
}

export interface SyncTableOptions {
  sinks: SyncSinks;
  /** Page size for each gateway hop. Server clamps to [1, 100]. */
  limit?: number;
  /** Override the base id (defaults to the configured Amino base). */
  baseId?: string;
}

export interface SyncTableResult {
  /** Total records folded across all pages this run. */
  recordCount: number;
  /** Number of gateway round-trips this run made. */
  pages: number;
  /** Cursor written to IndexedDB at the end (null if there was nothing new). */
  cursor: string | null;
  /** True if the loop hit the page cap before draining `hasMore`. */
  truncated: boolean;
}

const cursorKey = (tableId: string): string => `eodb:cursor:${tableId}`;

/** Read the persisted cursor for a table (null on first run). */
export async function getCursor(tableId: string): Promise<string | null> {
  return (await idb.get<string>(cursorKey(tableId))) ?? null;
}

/** Wipe the cursor — the next sync will pull every record again. */
export async function resetCursor(tableId: string): Promise<void> {
  await idb.del(cursorKey(tableId));
}

/**
 * Pull every record modified since the table's persisted cursor, fold each
 * page into the caller's store, then advance the cursor to the latest
 * `highWaterMark`. Bounded at MAX_PAGES iterations.
 */
export async function syncTable(
  tableId: string,
  opts: SyncTableOptions,
): Promise<SyncTableResult> {
  const baseId = opts.baseId ?? AMINO_AIRTABLE_BASE_ID;
  const limit = opts.limit ?? 100;

  let since = await getCursor(tableId);
  let recordCount = 0;
  let pages = 0;
  let lastHighWaterMark: string | null = null;
  let truncated = false;

  for (let i = 0; i < MAX_PAGES; i++) {
    const data = await gateway<SyncResponse>({
      op: 'sync',
      site: { base: baseId, table: tableId },
      ...(since ? { since } : {}),
      limit,
    });
    pages++;

    const events: RecEvent[] = data.records.map((rec) => {
      const tsRaw = data.lastModifiedField ? rec.fields[data.lastModifiedField] : undefined;
      return {
        op: 'REC',
        site: { base: baseId, table: tableId, id: rec.id },
        resolution: rec.fields,
        ts: typeof tsRaw === 'string' ? tsRaw : null,
        _src: 'airtable.sync',
      };
    });

    if (events.length > 0) {
      await opts.sinks.append(events);
      // Fold can throw — if it does, the cursor is NOT advanced and the
      // next call will retry the same window. This is the contract.
      await opts.sinks.fold(events);
      recordCount += events.length;
    }

    if (data.highWaterMark) lastHighWaterMark = data.highWaterMark;

    if (!data.hasMore) {
      if (lastHighWaterMark) {
        await idb.set(cursorKey(tableId), lastHighWaterMark);
      }
      return { recordCount, pages, cursor: lastHighWaterMark, truncated: false };
    }

    if (!data.highWaterMark) {
      // Server says hasMore but didn't give us a cursor — break to avoid
      // an infinite identical query.
      truncated = true;
      break;
    }

    since = data.highWaterMark;
  }

  // Hit the page cap. Persist what we have so the next run resumes from
  // here instead of replaying the same prefix.
  if (lastHighWaterMark) {
    await idb.set(cursorKey(tableId), lastHighWaterMark);
  }
  return { recordCount, pages, cursor: lastHighWaterMark, truncated: truncated || pages >= MAX_PAGES };
}

/**
 * Convenience: sync many tables in parallel. Failures in one table don't
 * block the others — each table's outcome is reported independently so
 * the caller can decide whether to surface, retry, or ignore.
 */
export async function syncTables(
  tableIds: string[],
  opts: SyncTableOptions,
): Promise<Array<{ tableId: string; ok: true; result: SyncTableResult } | { tableId: string; ok: false; error: Error }>> {
  return Promise.all(
    tableIds.map(async (tableId) => {
      try {
        const result = await syncTable(tableId, opts);
        return { tableId, ok: true as const, result };
      } catch (e) {
        return { tableId, ok: false as const, error: e instanceof Error ? e : new Error(String(e)) };
      }
    }),
  );
}
