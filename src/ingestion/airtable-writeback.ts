/**
 * Airtable writeback — local edits as EO transformations.
 *
 * A local edit emits a DEF on `at.{base}.{table}.{record}` exactly like the
 * pull-path sync does, but with `source='airtable-edit'` and a distinct
 * `client_event_id` prefix (`at-edit:...`) so the log records provenance.
 * The same call mirrors the edit into a small "pending writebacks" queue in
 * LevelDB. A drain loop reads the queue, PATCHes Airtable, and removes
 * entries on success.
 *
 * Echo dedup: when the pull picks the change back up from Airtable, the
 * stored field values now match local state, so `hasActualChanges()` returns
 * false and the diff is empty — no new event is folded. No special-case code
 * is needed for echoes.
 *
 * Conflict shield: while a writeback is pending for (base, table, record),
 * the pull-path drops any incoming change whose key is in the pending field
 * set (local-wins-while-pending). When the writeback completes and is
 * dequeued, the next pull is authoritative again.
 */

import type { EoDb } from '../db/level.js';
import { encode, decode, getCurrentSeq } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import type { EoEventInput } from '../db/types.js';
import { processEvent } from '../db/fold.js';
import { getState } from '../db/state.js';
import { stableStringify } from './value-extract.js';
import { COMPUTED_TYPES } from './field-rules.js';
import {
  tickLocalReplica,
  readFieldClocksFromState,
  mergeFieldClocks,
  type FieldClock,
} from './airtable-clocks.js';
import type { AirtableClient } from './airtable-client.js';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Marks events emitted by the writeback path (vs the pull-path sync). */
export const EDIT_SOURCE = 'airtable-edit';

const WRITEBACK_PREFIX = 'ingestion:airtable:writeback:';

function writebackKey(baseId: string, tableId: string, recordId: string): string {
  return `${WRITEBACK_PREFIX}${baseId}:${tableId}:${recordId}`;
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface WritebackEntry {
  base_id: string;
  table_id: string;
  record_id: string;
  /** Field-id → value. Merged on subsequent edits to the same record. */
  fields: Record<string, unknown>;
  /** Agent who initiated the edit (Matrix user id, or "system"). */
  agent: string;
  /** When the entry was first queued. */
  queued_at: string;
  /** Seq of the most recent local DEF that produced this pending writeback. */
  last_seq: number;
  /** Attempt count (incremented before each PATCH). */
  attempts: number;
  /** Last error message, if any. */
  last_error?: string;
  /** ISO timestamp of last attempt, if any. */
  last_attempt_at?: string;
}

export interface ApplyEditResult {
  /** Seq of the emitted DEF. */
  seq: number;
  /** Total fields now pending for this record (after merge). */
  pending_field_count: number;
}

export interface DrainOptions {
  /** Max entries to drain in one pass. Default: 50. */
  limit?: number;
  /** Max attempts before leaving an entry stuck. Default: Infinity. */
  maxAttempts?: number;
  /** Called after each entry attempt (success or failure). */
  onAttempt?: (entry: WritebackEntry, outcome: 'sent' | 'failed') => void;
}

export interface DrainResult {
  sent: number;
  failed: number;
  remaining: number;
}

// ─── Field writability ─────────────────────────────────────────────────────

/**
 * Whether a field type is writable from EO-DB back to Airtable.
 * Excludes computed types (formula, rollup, lookup, count) — Airtable rejects
 * PATCHes against them — and metadata fields.
 */
export function isWritableFieldType(type: string): boolean {
  if (COMPUTED_TYPES.has(type)) return false;
  if (type === 'createdTime' || type === 'createdBy' || type === 'autoNumber') return false;
  if (type === 'lastModifiedTime' || type === 'lastModifiedBy') return false;
  return true;
}

// ─── Queue I/O ─────────────────────────────────────────────────────────────

async function readEntry(
  db: EoDb,
  baseId: string,
  tableId: string,
  recordId: string,
): Promise<WritebackEntry | null> {
  try {
    const buf = await db.get(writebackKey(baseId, tableId, recordId));
    return decode(buf) as WritebackEntry;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

async function persistEntry(db: EoDb, entry: WritebackEntry): Promise<void> {
  await db.put(writebackKey(entry.base_id, entry.table_id, entry.record_id), encode(entry));
}

async function removeEntry(
  db: EoDb,
  baseId: string,
  tableId: string,
  recordId: string,
): Promise<void> {
  try {
    await db.del(writebackKey(baseId, tableId, recordId));
  } catch {
    // already gone — safe
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Field IDs with pending writebacks for a record. Empty set if none.
 * Used by the pull path as a conflict shield: incoming Airtable values for
 * these fields are dropped until the writeback drains successfully.
 */
export async function getPendingFieldsFor(
  db: EoDb,
  baseId: string,
  tableId: string,
  recordId: string,
): Promise<Set<string>> {
  const entry = await readEntry(db, baseId, tableId, recordId);
  if (!entry) return new Set();
  return new Set(Object.keys(entry.fields));
}

/** Read a single pending writeback. Returns null if none. */
export async function getPendingWriteback(
  db: EoDb,
  baseId: string,
  tableId: string,
  recordId: string,
): Promise<WritebackEntry | null> {
  return readEntry(db, baseId, tableId, recordId);
}

/** Iterate all pending writebacks, optionally scoped to a base or table. */
export async function listPendingWritebacks(
  db: EoDb,
  scope?: { baseId?: string; tableId?: string },
): Promise<WritebackEntry[]> {
  const prefix = scope?.baseId
    ? scope.tableId
      ? `${WRITEBACK_PREFIX}${scope.baseId}:${scope.tableId}:`
      : `${WRITEBACK_PREFIX}${scope.baseId}:`
    : WRITEBACK_PREFIX;
  const out: WritebackEntry[] = [];
  for await (const [, value] of db.iterator({ gte: prefix, lte: `${prefix}\xff` })) {
    out.push(decode(value) as WritebackEntry);
  }
  return out;
}

/**
 * Apply a local edit: emit the DEF, then enqueue the writeback.
 *
 * `fields` is keyed by Airtable field ID (not name) — the same form the pull
 * path stores. If a writeback is already pending for this record, the new
 * fields are merged in (last write wins per field within the queue).
 */
export async function applyLocalEdit(
  db: EoDb,
  feed: Feed,
  opts: {
    baseId: string;
    tableId: string;
    recordId: string;
    fields: Record<string, unknown>;
    agent: string;
  },
): Promise<ApplyEditResult> {
  const { baseId, tableId, recordId, fields, agent } = opts;
  if (Object.keys(fields).length === 0) {
    throw new Error('applyLocalEdit called with empty fields');
  }

  const target = `at.${baseId}.${tableId}.${recordId}`;
  const existing = await getState(db, target);
  if (!existing) {
    // Without an INS, the DEF would create a phantom record local-only.
    // Refuse — local edits operate on records that already exist.
    throw new Error(`Cannot edit unknown record ${target} — sync the base first`);
  }

  const now = new Date().toISOString();
  const contentKey = stableStringify(fields);
  const clientEventId = `at-edit:${baseId}:${tableId}:${recordId}:${contentKey}`;

  // Stamp each edited field with a freshly-ticked local HLC and merge into
  // the record's current per-field clock map. Future pulls compare against
  // these clocks to decide if Airtable's value should overwrite ours.
  const editClock = tickLocalReplica();
  const incomingClocks: Record<string, FieldClock> = {};
  for (const key of Object.keys(fields)) incomingClocks[key] = editClock;
  const mergedClocks = mergeFieldClocks(
    readFieldClocksFromState(existing),
    incomingClocks,
  );

  const event: EoEventInput = {
    op: 'DEF',
    target,
    operand: {
      fields,
      _airtable: {
        record_id: recordId,
        base_id: baseId,
        table_id: tableId,
        fieldClocks: mergedClocks,
      },
    },
    agent,
    ts: now,
    acquired_ts: now,
    client_event_id: clientEventId,
    source: EDIT_SOURCE,
    hlc: editClock.hlc,
    replica_id: editClock.replica,
  };

  let seq: number;
  try {
    seq = await processEvent(db, event, feed);
  } catch (e: any) {
    // Idempotent re-submission of the exact same edit — fold rejects, but
    // we still want the writeback queue to reflect the intent.
    if (!e.message?.includes('already')) throw e;
    seq = await getCurrentSeq(db);
  }

  const prior = await readEntry(db, baseId, tableId, recordId);
  const merged: WritebackEntry = prior
    ? {
        ...prior,
        fields: { ...prior.fields, ...fields },
        last_seq: seq,
        // attempts/last_error preserved; a new edit doesn't reset the retry counter
      }
    : {
        base_id: baseId,
        table_id: tableId,
        record_id: recordId,
        fields: { ...fields },
        agent,
        queued_at: now,
        last_seq: seq,
        attempts: 0,
      };
  await persistEntry(db, merged);

  return { seq, pending_field_count: Object.keys(merged.fields).length };
}

/**
 * Drop `fields` from a pending writeback because they were superseded by a
 * remote write (incoming pull beat the local clock). If no fields remain
 * after removal, the queue entry is deleted entirely.
 *
 * Called by the pull path when clock comparison says the incoming record
 * wins for some field the user had locally edited.
 */
export async function supersedePendingFields(
  db: EoDb,
  baseId: string,
  tableId: string,
  recordId: string,
  fields: string[],
): Promise<{ removed: number; remaining: number } | null> {
  if (fields.length === 0) return null;
  const entry = await readEntry(db, baseId, tableId, recordId);
  if (!entry) return null;
  const remaining: Record<string, unknown> = {};
  let removed = 0;
  for (const [field, val] of Object.entries(entry.fields)) {
    if (fields.includes(field)) {
      removed++;
    } else {
      remaining[field] = val;
    }
  }
  if (removed === 0) return { removed: 0, remaining: Object.keys(entry.fields).length };
  if (Object.keys(remaining).length === 0) {
    await removeEntry(db, baseId, tableId, recordId);
    return { removed, remaining: 0 };
  }
  await persistEntry(db, { ...entry, fields: remaining });
  return { removed, remaining: Object.keys(remaining).length };
}

/**
 * Drain the writeback queue: for each pending entry, PATCH Airtable and
 * remove the entry on success. Failures bump `attempts` and persist
 * `last_error`; the entry remains queued for the next drain.
 */
export async function drainWritebacks(
  db: EoDb,
  client: AirtableClient,
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const limit = opts.limit ?? 50;
  const maxAttempts = opts.maxAttempts ?? Infinity;

  const entries = await listPendingWritebacks(db);
  let sent = 0;
  let failed = 0;

  for (const entry of entries.slice(0, limit)) {
    if (entry.attempts >= maxAttempts) {
      failed++;
      continue;
    }

    const attempted: WritebackEntry = {
      ...entry,
      attempts: entry.attempts + 1,
      last_attempt_at: new Date().toISOString(),
    };

    try {
      await client.updateRecord(
        entry.base_id,
        entry.table_id,
        entry.record_id,
        entry.fields as Record<string, any>,
        { returnFieldsByFieldId: true },
      );
      await removeEntry(db, entry.base_id, entry.table_id, entry.record_id);
      sent++;
      opts.onAttempt?.(attempted, 'sent');
    } catch (e: any) {
      attempted.last_error = e?.message ?? String(e);
      await persistEntry(db, attempted);
      failed++;
      opts.onAttempt?.(attempted, 'failed');
    }
  }

  const remaining = (await listPendingWritebacks(db)).length;
  return { sent, failed, remaining };
}
