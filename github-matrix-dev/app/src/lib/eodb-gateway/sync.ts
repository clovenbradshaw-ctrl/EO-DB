/**
 * Absorber loop — per-table cursor, folded into the Given-Log.
 *
 * This is the EO-native shape. The cursor is per-table, persisted as the
 * highest `lastModifiedTime` we've absorbed for this table. Each sync pull
 * becomes a batch of `REC` events appended to the log, then the fold
 * derives current state.
 *
 * Subtleties this module enforces:
 *   - Pin `since` across the loop. Airtable's `offset` is bound to the
 *     (filterByFormula + sort) it was issued under; advancing `since`
 *     per-page invalidates it and at best re-fetches rows, at worst errors.
 *   - Paginate within a run via Airtable's opaque `offset`, NOT by stepping
 *     the timestamp cursor. The gateway's `IS_AFTER` filter is strict —
 *     stepping by `highWaterMark` silently drops every record that ties on
 *     the previous page's tail timestamp (the bug that was capping pulls
 *     at ~2.5k for bulk-imported tables).
 *   - Accumulate `highWaterMark` in memory; commit it ONCE at the end,
 *     after `hasMore: false`. If the loop crashes mid-stream the next run
 *     replays from the old cursor and re-absorbs the pages it already had —
 *     fine because absorb is idempotent on record id. Writing partial
 *     cursors would skip the unread tail forever.
 *   - Persist the cursor only after the fold succeeds. If folding throws,
 *     we want to retry the same window, not skip it.
 *   - One absorber per table — slow tables shouldn't block fast ones.
 *   - The loop is bounded at MAX_PAGES as a runaway safety net (~20k rows
 *     at limit=100); hitting it is a bug, not a normal terminator.
 */
import { gateway } from './gateway';
import { idb } from './idb';
import { AMINO_AIRTABLE_BASE_ID } from '../amino-config';

/** Runaway safety net — at limit=100 this caps a single run at ~20k rows. */
const MAX_PAGES = 200;
/** Per-page sleep, sized to keep us under Airtable's 5 req/sec per-base ceiling. */
const PAGE_THROTTLE_MS = 220;

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
  /**
   * Airtable's opaque pagination token, forwarded by the gateway. Pass it
   * back as `offset` on the next call to continue the same query. Null
   * when the run is exhausted.
   */
  offset: string | null;
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
 * page into the caller's store, then advance the cursor — committed once,
 * after the run drains. Within a run, pagination uses Airtable's opaque
 * `offset`; `since` stays pinned at the loaded cursor.
 *
 * Recovery contract: if the loop crashes the cursor is NOT touched, so the
 * next run replays from the same `since` and re-absorbs the pages it had.
 * Absorb must be idempotent on record id for that to be a no-op.
 */
export async function syncTable(
  tableId: string,
  opts: SyncTableOptions,
): Promise<SyncTableResult> {
  const baseId = opts.baseId ?? AMINO_AIRTABLE_BASE_ID;
  const limit = opts.limit ?? 100;

  // Pin `since` for the whole run. Mutating it per-page would invalidate
  // Airtable's `offset`, which is bound to the (filter+sort) it was issued
  // under — see the module docstring for why this matters.
  const since = await getCursor(tableId);

  let offset: string | null = null;
  let highWaterMark: string | null = since;
  let recordCount = 0;
  let pages = 0;

  do {
    const data: SyncResponse = await gateway<SyncResponse>({
      op: 'sync',
      site: { base: baseId, table: tableId },
      ...(since ? { since } : {}),
      ...(offset ? { offset } : {}),
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

    if (data.highWaterMark && (!highWaterMark || data.highWaterMark > highWaterMark)) {
      highWaterMark = data.highWaterMark;
    }
    offset = data.offset;

    if (pages >= MAX_PAGES) {
      // Runaway safety net. We don't persist a partial cursor here: a
      // mid-run cursor write would skip the unread tail forever on the
      // next run. Surface the condition so the caller can investigate.
      throw new Error(
        `[eodb-gateway] syncTable(${tableId}): pagination runaway — stopped after ${pages} pages`,
      );
    }

    if (offset) await sleep(PAGE_THROTTLE_MS);
  } while (offset);

  // Drained cleanly. Commit the high-water mark once, atomically — this
  // is the sole place the cursor advances.
  if (highWaterMark && highWaterMark !== since) {
    await idb.set(cursorKey(tableId), highWaterMark);
  }
  return { recordCount, pages, cursor: highWaterMark, truncated: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
