/**
 * Airtable sync engine.
 *
 * Two modes:
 *   1. **Hydration sync** — full pull of all bases/tables. Discovers schema,
 *      returns a manifest of everything available, then ingests all records
 *      as EO events using rate-limited pagination.
 *
 *   2. **Update sync** — incremental pull. Client-side devices call this to
 *      fetch only records modified since the last sync cursor. Filters out
 *      non-transformations (records that haven't actually changed in EO-DB)
 *      and deduplicates against concurrent syncs from other devices.
 *
 * Design:
 *   - Sync cursors stored per table: `ingestion:airtable:cursor:{baseId}:{tableId}`
 *   - Sync locks prevent concurrent syncs on the same table: `ingestion:airtable:lock:{baseId}:{tableId}`
 *   - Records map to EO targets: `at.{baseId}.{tableId}.{recordId}`
 *   - Explicit INS before first DEF — every entity has a real birth event in the log.
 *   - Persistent HydrationJob records track per-table progress for crash recovery.
 */

import type { EoDb } from '../db/level.js';
import { encode, decode } from '../db/level.js';
import { processEvent } from '../db/fold.js';
import { getState } from '../db/state.js';
import type { Feed } from '../db/feed.js';
import type { HydrationJob, TableProgress } from '../db/types.js';
import type { EventSink } from './event-sink.js';
import { randomUUID } from 'crypto';
import {
  AirtableClient,
  type AirtableBase,
  type AirtableTable,
  type AirtableRecord,
} from './airtable-client.js';
import { classifyFieldType, type FieldClassification } from './field-rules.js';
import { mapAirtableTypeOrNull } from './airtable-type-map.js';
import { extractValue, valuesEqual, stableStringify } from './value-extract.js';
import { isExcluded, EMPTY_EXCLUSIONS, type SyncExclusions } from './exclusions.js';
import { supersedePendingFields } from './airtable-writeback.js';
import {
  airtableClock,
  readFieldClocksFromState,
  pickIncomingWinners,
  mergeFieldClocks,
} from './airtable-clocks.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HydrationManifest {
  bases: Array<{
    id: string;
    name: string;
    tables: Array<{
      id: string;
      name: string;
      primaryFieldId?: string;
      fieldCount: number;
      fields: Array<{ id: string; name: string; type: string; options?: Record<string, any> }>;
    }>;
  }>;
  discovered_at: string;
}

export interface SyncResult {
  base_id: string;
  table_id: string;
  table_name: string;
  records_fetched: number;
  records_ingested: number;
  records_skipped_no_change: number;
  records_skipped_duplicate: number;
  cursor_before: string | null;
  cursor_after: string;
}

export interface HydrationResult {
  manifest: HydrationManifest;
  sync_results: SyncResult[];
  total_records_ingested: number;
  total_records_skipped: number;
  duration_ms: number;
}

export interface UpdateSyncResult {
  sync_results: SyncResult[];
  total_records_ingested: number;
  total_records_skipped: number;
  duration_ms: number;
}

/**
 * Options for customizing what gets synced and how.
 */
export interface SyncCustomization {
  /**
   * Which tables to sync, keyed by base ID.
   * If undefined or empty, all tables are synced.
   * Example: { 'appXYZ': ['tblA', 'tblB'] }
   */
  selectedTables?: Record<string, string[]>;

  /**
   * Field exclusions per table (by field ID or name pattern).
   * Example: { 'tblA': { fields: ['fldXYZ'], patterns: ['^internal_'] } }
   */
  fieldExclusions?: Record<string, SyncExclusions>;

  /**
   * When true, never overwrite field values that already exist in EO-DB.
   * New records are always added. For existing records, only fields that
   * don't yet have a value in EO-DB are written.
   * Default: false — Airtable values overwrite EO-DB values on every sync.
   * Field-level provenance history is always preserved in the event log.
   */
  preserveExisting?: boolean;

  /**
   * Override the display name field per table (by table ID → field ID).
   * When set, this field's value is used as the record's `name`.
   * If not set, falls back to the table's primaryFieldId.
   * Example: { 'tblClients': 'fldFullName' }
   */
  displayFields?: Record<string, string>;
}

// ─── Cursor management ──────────────────────────────────────────────────────

const CURSOR_PREFIX = 'ingestion:airtable:cursor:';
const LOCK_PREFIX = 'ingestion:airtable:lock:';
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minute lock timeout

function cursorKey(baseId: string, tableId: string): string {
  return `${CURSOR_PREFIX}${baseId}:${tableId}`;
}

function lockKey(baseId: string, tableId: string): string {
  return `${LOCK_PREFIX}${baseId}:${tableId}`;
}

async function getCursor(db: EoDb, baseId: string, tableId: string): Promise<string | null> {
  try {
    const buf = await db.get(cursorKey(baseId, tableId));
    return decode(buf) as string;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

async function setCursor(db: EoDb, baseId: string, tableId: string, cursor: string): Promise<void> {
  await db.put(cursorKey(baseId, tableId), encode(cursor));
}

// ─── Sync lock (prevents concurrent syncs on the same table) ────────────────

interface SyncLock {
  acquired_by: string;
  acquired_at: number;
}

async function acquireLock(
  db: EoDb,
  baseId: string,
  tableId: string,
  agent: string,
): Promise<boolean> {
  const key = lockKey(baseId, tableId);
  try {
    const buf = await db.get(key);
    const existing = decode(buf) as SyncLock;
    // If lock is stale, steal it
    if (Date.now() - existing.acquired_at > LOCK_TTL_MS) {
      await db.put(key, encode({ acquired_by: agent, acquired_at: Date.now() }));
      return true;
    }
    return false; // Lock held by another sync
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') {
      await db.put(key, encode({ acquired_by: agent, acquired_at: Date.now() }));
      return true;
    }
    throw e;
  }
}

async function releaseLock(db: EoDb, baseId: string, tableId: string): Promise<void> {
  try {
    await db.del(lockKey(baseId, tableId));
  } catch {
    // Ignore if already released
  }
}

/** Renew a lock's timestamp to prevent TTL expiry during long-running syncs. */
async function renewLock(db: EoDb, baseId: string, tableId: string, agent: string): Promise<void> {
  const key = lockKey(baseId, tableId);
  try {
    await db.put(key, encode({ acquired_by: agent, acquired_at: Date.now() }));
  } catch {
    // Best-effort renewal
  }
}

const LOCK_RENEW_INTERVAL_MS = 2 * 60 * 1000; // Renew lock every 2 minutes

// ─── Job tracking (persistent hydration/sync progress) ────────────────────

const JOB_PREFIX = 'ingestion:airtable:job:';
const JOB_LATEST_PREFIX = 'ingestion:airtable:job:latest:';

async function createJob(
  db: EoDb,
  type: HydrationJob['type'],
  label: string,
  agent: string,
  tableEntries: Array<{ baseId: string; tableId: string; tableName: string }>,
): Promise<HydrationJob> {
  const job: HydrationJob = {
    job_id: randomUUID(),
    type,
    api_key_label: label,
    status: 'running',
    agent,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    table_progress: {},
    totals: { tables_total: tableEntries.length, tables_completed: 0, records_ingested: 0, records_skipped: 0 },
  };
  for (const t of tableEntries) {
    const key = `${t.baseId}:${t.tableId}`;
    job.table_progress[key] = {
      base_id: t.baseId,
      table_id: t.tableId,
      table_name: t.tableName,
      status: 'pending',
      records_fetched: 0,
      records_ingested: 0,
    };
  }
  await persistJob(db, job);
  await db.put(`${JOB_LATEST_PREFIX}${label}`, encode(job.job_id));
  return job;
}

async function persistJob(db: EoDb, job: HydrationJob): Promise<void> {
  job.updated_at = new Date().toISOString();
  await db.put(`${JOB_PREFIX}${job.job_id}`, encode(job));
}

export async function getJob(db: EoDb, jobId: string): Promise<HydrationJob | null> {
  try {
    const buf = await db.get(`${JOB_PREFIX}${jobId}`);
    return decode(buf) as HydrationJob;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

export async function getLatestJob(db: EoDb, label: string): Promise<HydrationJob | null> {
  try {
    const buf = await db.get(`${JOB_LATEST_PREFIX}${label}`);
    const jobId = decode(buf) as string;
    return getJob(db, jobId);
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

/** Find jobs left in 'running' state (crashed). Mark them as 'interrupted'. */
export async function recoverInterruptedJobs(db: EoDb): Promise<HydrationJob[]> {
  const interrupted: HydrationJob[] = [];
  for await (const [key, value] of db.iterator({
    gte: JOB_PREFIX,
    lte: `${JOB_PREFIX}\xff`,
  })) {
    // Skip 'latest:' pointers
    const keyStr = String(key);
    if (keyStr.startsWith(JOB_LATEST_PREFIX)) continue;
    const job = decode(value) as HydrationJob;
    if (job.status === 'running') {
      job.status = 'interrupted';
      job.updated_at = new Date().toISOString();
      await persistJob(db, job);
      interrupted.push(job);
    }
  }
  return interrupted;
}

// ─── Event emit helper ─────────────────────────────────────────────────────

/** Emit an event through the sink if available, otherwise fold directly. */
async function emitEvent(
  db: EoDb,
  feed: Feed,
  event: import('../db/types.js').EoEventInput,
  sink?: EventSink,
): Promise<number> {
  if (sink) return sink.emit(event);
  return processEvent(db, event, feed);
}

// ─── Target naming ──────────────────────────────────────────────────────────

/** Map an Airtable record to an EO target path. */
function recordTarget(baseId: string, tableId: string, recordId: string): string {
  return `at.${baseId}.${tableId}.${recordId}`;
}

/** Map an Airtable table to an EO target (the collection/parent). */
function tableTarget(baseId: string, tableId: string): string {
  return `at.${baseId}.${tableId}`;
}

/** Map an Airtable base to an EO target. */
function baseTarget(baseId: string): string {
  return `at.${baseId}`;
}

// ─── Field metadata helpers ────────────────────────────────────────────────

/** Map of field ID → { name, type, classification, options } built from table schema. */
export interface FieldMeta {
  id: string;
  name: string;
  type: string;
  classification: FieldClassification;
  options?: Record<string, any>;
}

/**
 * Build a field metadata map from the table's stored schema.
 * Falls back to empty map if schema isn't available (all fields pass through).
 */
function buildFieldMetaMap(
  fields: Array<{ id: string; name: string; type: string; options?: Record<string, any> }> | undefined,
): Map<string, FieldMeta> {
  const map = new Map<string, FieldMeta>();
  if (!fields) return map;
  for (const f of fields) {
    map.set(f.id, {
      id: f.id,
      name: f.name,
      type: f.type,
      classification: classifyFieldType(f.type),
      options: f.options,
    });
  }
  return map;
}

/**
 * Retrieve the field metadata map for a table from its stored EO-DB state.
 * The schema is stored during hydration as DEF on the table target.
 */
async function getTableFieldMeta(
  db: EoDb,
  baseId: string,
  tableId: string,
): Promise<Map<string, FieldMeta>> {
  const state = await getState(db, tableTarget(baseId, tableId));
  return buildFieldMetaMap(state?.value?.fields);
}

// ─── Last-modified-time extraction (for HLC derivation) ───────────────────

/**
 * Find the ISO timestamp of the most recent change on a record. Looks for
 * any field whose schema type is `lastModifiedTime`; returns undefined if no
 * such field exists on the table (caller falls back to `record.createdTime`).
 */
function findLastModifiedTime(
  rawFields: Record<string, any>,
  fieldMeta: Map<string, FieldMeta>,
): string | undefined {
  for (const meta of fieldMeta.values()) {
    if (meta.type === 'lastModifiedTime') {
      const raw = rawFields[meta.id] ?? rawFields[meta.name];
      if (typeof raw === 'string' && raw.length > 0) return raw;
    }
  }
  return undefined;
}

// ─── Non-transformation detection ───────────────────────────────────────────

// ─── Constraint emission from Airtable field options ──────────────────────

/** Constraint mapping: Airtable field type → option keys to emit as constraints. */
const CONSTRAINT_MAP: Record<string, Array<{ optionKey: string; constraintName: string }>> = {
  singleSelect:        [{ optionKey: 'choices', constraintName: 'enum' }],
  multipleSelects:     [{ optionKey: 'choices', constraintName: 'enum' }],
  number:              [{ optionKey: 'precision', constraintName: 'precision' }],
  currency:            [{ optionKey: 'precision', constraintName: 'precision' }, { optionKey: 'symbol', constraintName: 'symbol' }],
  percent:             [{ optionKey: 'precision', constraintName: 'precision' }],
  rating:              [{ optionKey: 'max', constraintName: 'max' }, { optionKey: 'icon', constraintName: 'icon' }, { optionKey: 'color', constraintName: 'color' }],
  duration:            [{ optionKey: 'durationFormat', constraintName: 'format' }],
  date:                [{ optionKey: 'dateFormat', constraintName: 'dateFormat' }, { optionKey: 'timeFormat', constraintName: 'timeFormat' }],
  dateTime:            [{ optionKey: 'dateFormat', constraintName: 'dateFormat' }, { optionKey: 'timeFormat', constraintName: 'timeFormat' }],
  formula:             [{ optionKey: 'formula', constraintName: 'formula' }, { optionKey: 'referencedFieldIds', constraintName: 'referencedFieldIds' }],
  rollup:              [{ optionKey: 'fieldIdInLinkedTable', constraintName: 'sourceField' }, { optionKey: 'recordLinkFieldId', constraintName: 'linkField' }, { optionKey: 'referencedFieldIds', constraintName: 'referencedFieldIds' }],
  lookup:              [{ optionKey: 'fieldIdInLinkedTable', constraintName: 'sourceField' }, { optionKey: 'recordLinkFieldId', constraintName: 'linkField' }],
  count:               [{ optionKey: 'recordLinkFieldId', constraintName: 'linkField' }],
};

async function emitFieldConstraints(
  db: EoDb,
  feed: Feed,
  fieldTarget: string,
  field: { id: string; type: string; options?: Record<string, any> },
  agent: string,
  baseId: string,
  tableId: string,
  sink?: EventSink,
): Promise<void> {
  const mappings = CONSTRAINT_MAP[field.type];
  if (!mappings || !field.options) return;

  for (const { optionKey, constraintName } of mappings) {
    const value = field.options[optionKey];
    if (value == null) continue;

    try {
      await emitEvent(db, feed, {
        op: 'DEF',
        target: `${fieldTarget}.constraint.${constraintName}`,
        operand: constraintName === 'enum' ? { choices: value } : { value },
        agent,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
        client_event_id: `at-constraint:${baseId}:${tableId}:${field.id}:${constraintName}`,
      }, sink);
    } catch { /* idempotent */ }
  }
}

/**
 * Extract only the storable fields from an Airtable record, skipping
 * computed/metadata fields, applying exclusions, and normalizing values.
 *
 * Returns null if field metadata isn't available (fall back to raw fields).
 */
function extractStorableFields(
  rawFields: Record<string, any>,
  fieldMeta: Map<string, FieldMeta>,
  exclusions: SyncExclusions,
): Record<string, any> {
  // No schema available — pass through all fields as-is (backward compat)
  if (fieldMeta.size === 0) return rawFields;

  const result: Record<string, any> = {};
  for (const [fieldId, rawValue] of Object.entries(rawFields)) {
    const meta = fieldMeta.get(fieldId);

    // No metadata for this field — pass through (safe default)
    if (!meta) {
      result[fieldId] = rawValue;
      continue;
    }

    // Skip computed fields and fold-computed metadata — values come from fold
    if (meta.classification === 'skip' || meta.classification === 'eva') continue;

    // Skip excluded fields
    if (isExcluded(fieldId, meta.name, exclusions)) continue;

    // Normalize the value (strip Horizon data like stale URLs, display names)
    result[fieldId] = extractValue(rawValue, meta.type);
  }
  return result;
}

/**
 * Compare an incoming Airtable record's fields against the current EO-DB state.
 * Returns true if the record actually changed — false if it's a non-transformation
 * (Airtable says "modified" but the storable field values are identical).
 *
 * Field-type-aware: skips computed/metadata fields, normalizes values before
 * comparison, and respects exclusion policies.
 */
async function hasActualChanges(
  db: EoDb,
  target: string,
  storableFields: Record<string, any>,
): Promise<boolean> {
  const existing = await getState(db, target);
  if (!existing) return true; // New record — always a change

  const existingFields = existing.value?.fields;
  if (!existingFields) return true;

  // Compare each storable field against stored value
  for (const [key, val] of Object.entries(storableFields)) {
    const existingVal = existingFields[key];
    if (!valuesEqual(val, existingVal)) return true;
  }

  // Check if any stored fields were removed (cleared in Airtable)
  for (const key of Object.keys(existingFields)) {
    if (!(key in storableFields)) return true;
  }

  return false;
}

/**
 * Compute field-level diff between incoming fields and existing state.
 * Returns only the fields that actually changed.
 * For new records (no existing), returns only fields with non-null values.
 */
function computeFieldDiff(
  incomingFields: Record<string, any>,
  existingFields: Record<string, any> | undefined,
): Record<string, any> {
  const diff: Record<string, any> = {};
  if (!existingFields) {
    // New record — only DEF fields that have actual values
    for (const [key, val] of Object.entries(incomingFields)) {
      if (val !== null && val !== undefined) diff[key] = val;
    }
    return diff;
  }
  // Existing record — only include fields that actually changed
  for (const [key, val] of Object.entries(incomingFields)) {
    if (!valuesEqual(val, existingFields[key])) diff[key] = val;
  }
  return diff;
}

/** @deprecated Use valuesEqual from value-extract.ts instead. Kept for test backward compat. */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

// ─── Deduplication ──────────────────────────────────────────────────────────

/**
 * Generate a deterministic client_event_id for an Airtable record ingestion.
 * This ensures that if two devices sync the same record update concurrently,
 * only one event is created in the EO log (idempotency via client_event_id).
 */
function recordEventId(baseId: string, tableId: string, recordId: string, modifiedTime: string): string {
  return `at-sync:${baseId}:${tableId}:${recordId}:${modifiedTime}`;
}

// ─── Ingest a single record ─────────────────────────────────────────────────

async function ingestRecord(
  db: EoDb,
  feed: Feed,
  baseId: string,
  tableId: string,
  record: AirtableRecord,
  agent: string,
  fieldMeta: Map<string, FieldMeta>,
  exclusions: SyncExclusions = EMPTY_EXCLUSIONS,
  preserveExisting: boolean = false,
  displayField?: string,
  sink?: EventSink,
): Promise<'ingested' | 'skipped_no_change' | 'skipped_duplicate'> {
  const target = recordTarget(baseId, tableId, record.id);

  // 1. Extract only storable fields (skip computed/metadata, normalize values)
  const storableFields = extractStorableFields(record.fields, fieldMeta, exclusions);

  // 2. Get existing state once — used for INS check, diff, and preserveExisting
  const existing = await getState(db, target);
  const existingFields = existing?.value?.fields;

  // 3. Compute field-level diff — only fields that actually changed
  let diffFields = computeFieldDiff(storableFields, existingFields);

  // 3a. Conflict shield via per-field HLCs (LWW-Register semantics).
  // Each field on the record carries an HLC at _airtable.fieldClocks; we
  // derive the incoming clock from Airtable's lastModifiedTime and drop
  // any field whose current local clock beats it. Surviving incoming
  // fields supersede any pending writeback for the same field, so the
  // drain doesn't PATCH a now-stale value.
  const existingClocks = readFieldClocksFromState(existing);
  const incomingLastModified = findLastModifiedTime(record.fields, fieldMeta);
  const incomingClock = airtableClock(baseId, incomingLastModified, record.createdTime);
  const { winners, newClocks } = pickIncomingWinners(existingClocks, diffFields, incomingClock);
  const supersededByIncoming = Object.keys(winners);
  if (supersededByIncoming.length > 0) {
    await supersedePendingFields(db, baseId, tableId, record.id, supersededByIncoming);
  }
  diffFields = winners;
  const mergedClocks = mergeFieldClocks(existingClocks, newClocks);

  // 4. If preserveExisting, further filter to only fields where existing is null/undefined
  if (preserveExisting && existingFields) {
    const filtered: Record<string, any> = {};
    for (const [key, val] of Object.entries(diffFields)) {
      if (!(key in existingFields) || existingFields[key] === undefined || existingFields[key] === null) {
        filtered[key] = val;
      }
    }
    diffFields = filtered;
  }

  // 5. If no actual diffs, skip
  if (Object.keys(diffFields).length === 0) {
    return 'skipped_no_change';
  }

  // 6. Build idempotent event ID using diff content hash for dedup
  const contentKey = stableStringify(diffFields);
  const clientEventId = recordEventId(baseId, tableId, record.id, contentKey);

  // 7. Explicit INS for new records — the log should truthfully show entity birth
  //    INS idempotency key uses record ID only (stable across re-syncs).
  if (!existing) {
    try {
      await emitEvent(db, feed, {
        op: 'INS',
        target,
        operand: {
          _airtable: {
            record_id: record.id,
            base_id: baseId,
            table_id: tableId,
            created_time: record.createdTime,
          },
        },
        agent,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
        client_event_id: `at-ins:${baseId}:${tableId}:${record.id}`,
      }, sink);
    } catch (e: any) {
      // Idempotency or concurrent INS — safe to continue to DEF
      if (!e.message?.includes('already') && !e.message?.includes('already instantiated')) throw e;
    }
  }

  // 8. DEF with only the changed fields (not all storable fields)
  try {
    await emitEvent(db, feed, {
      op: 'DEF',
      target,
      operand: {
        fields: diffFields,
        _airtable: {
          record_id: record.id,
          base_id: baseId,
          table_id: tableId,
          created_time: record.createdTime,
          fieldClocks: mergedClocks,
        },
      },
      agent,
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
      client_event_id: clientEventId,
    }, sink);

    // 9. Set display name as a separate DEF — ontologically distinct from the data import.
    if (displayField) {
      const nameVal = diffFields[displayField] ?? record.fields[displayField];
      if (nameVal != null) {
        await emitEvent(db, feed, {
          op: 'DEF',
          target,
          operand: { name: String(nameVal) },
          agent: `${agent}:display`,
          ts: new Date().toISOString(),
          acquired_ts: new Date().toISOString(),
          client_event_id: `${clientEventId}:name`,
        }, sink);
      }
    }

    return 'ingested';
  } catch (e: any) {
    // If idempotency caught it, it's a duplicate from another device
    if (e.message?.includes('already')) return 'skipped_duplicate';
    throw e;
  }
}

// ─── Discovery (schema manifest) ───────────────────────────────────────────

/**
 * Discover all bases and tables accessible with the given API key.
 * Returns a manifest without ingesting any data.
 */
export async function discoverSchema(client: AirtableClient): Promise<HydrationManifest> {
  const bases = await client.listBases();
  const manifest: HydrationManifest = {
    bases: [],
    discovered_at: new Date().toISOString(),
  };

  for (const base of bases) {
    const tables = await client.getBaseSchema(base.id);
    manifest.bases.push({
      id: base.id,
      name: base.name,
      tables: tables.map(t => ({
        id: t.id,
        name: t.name,
        primaryFieldId: t.primaryFieldId,
        fieldCount: t.fields.length,
        fields: t.fields.map(f => ({ id: f.id, name: f.name, type: f.type, ...(f.options ? { options: f.options } : {}) })),
      })),
    });
  }

  return manifest;
}

// ─── Hydration sync ─────────────────────────────────────────────────────────

/**
 * Full hydration: discover schema, then pull every record from every table
 * (or a specified subset of bases/tables).
 *
 * This is the initial "drink from the firehose" sync. Records are ingested
 * via DEF with idempotency so re-running is safe.
 */
export async function hydrationSync(
  db: EoDb,
  feed: Feed,
  client: AirtableClient,
  agent: string,
  opts?: {
    /** Only sync these base IDs (empty/undefined = all). */
    baseIds?: string[];
    /** Only sync these table IDs within each base (empty/undefined = all). */
    tableIds?: string[];
    /** Progress callback — called after each table. */
    onTableComplete?: (result: SyncResult) => void;
    /** Customization options for table/field selection and preserve mode. */
    customization?: SyncCustomization;
    /** API key label for job tracking. */
    apiKeyLabel?: string;
    /** Resume an interrupted job instead of starting fresh. */
    resumeJobId?: string;
    /** Event sink for grounded imports. When provided, events are batched into
     *  a single Matrix upload instead of individual room messages. */
    sink?: EventSink;
  },
): Promise<HydrationResult> {
  const start = Date.now();
  const preserveExisting = opts?.customization?.preserveExisting ?? false;
  const selectedTables = opts?.customization?.selectedTables;
  const fieldExclusions = opts?.customization?.fieldExclusions;
  const displayFields = opts?.customization?.displayFields;
  const manifest = await discoverSchema(client);
  const syncResults: SyncResult[] = [];

  // Collect all tables that will be synced (for job tracking)
  const tableEntries: Array<{ baseId: string; tableId: string; tableName: string }> = [];
  for (const base of manifest.bases) {
    if (opts?.baseIds?.length && !opts.baseIds.includes(base.id)) continue;
    const baseTables = selectedTables?.[base.id];
    if (selectedTables && !baseTables?.length) continue;
    for (const table of base.tables) {
      if (opts?.tableIds?.length && !opts.tableIds.includes(table.id)) continue;
      if (baseTables && !baseTables.includes(table.id)) continue;
      tableEntries.push({ baseId: base.id, tableId: table.id, tableName: table.name });
    }
  }

  // Create or resume a persistent job record
  let job: HydrationJob | null = null;
  if (opts?.resumeJobId) {
    job = await getJob(db, opts.resumeJobId);
  }
  if (!job) {
    job = await createJob(db, 'hydration', opts?.apiKeyLabel ?? 'unknown', agent, tableEntries);
  }

  try {
    // Register base-level targets
    for (const base of manifest.bases) {
      if (opts?.baseIds?.length && !opts.baseIds.includes(base.id)) continue;
      const baseTables = selectedTables?.[base.id];
      if (selectedTables && !baseTables?.length) continue;

      // INS the base as a container, then DEF its metadata
      const baseT = baseTarget(base.id);
      const baseExists = await getState(db, baseT);
      if (!baseExists) {
        try {
          await emitEvent(db, feed, {
            op: 'INS',
            target: baseT,
            operand: { _airtable: { type: 'base', base_id: base.id } },
            agent,
            ts: new Date().toISOString(),
            acquired_ts: new Date().toISOString(),
            client_event_id: `at-ins-base:${base.id}`,
          }, opts?.sink);
        } catch { /* idempotency or concurrent INS */ }
      }
      try {
        await emitEvent(db, feed, {
          op: 'DEF',
          target: baseT,
          operand: { name: base.name, _airtable: { type: 'base', base_id: base.id } },
          agent,
          ts: new Date().toISOString(),
          acquired_ts: new Date().toISOString(),
          client_event_id: `at-base:${base.id}`,
        }, opts?.sink);
      } catch { /* idempotency */ }

      for (const table of base.tables) {
        if (opts?.tableIds?.length && !opts.tableIds.includes(table.id)) continue;
        if (baseTables && !baseTables.includes(table.id)) continue;

        const progressKey = `${base.id}:${table.id}`;
        const tableProgress = job.table_progress[progressKey];

        // Skip tables already completed in a previous run (resume support)
        if (tableProgress?.status === 'completed') continue;

        // INS the table as a container, then DEF its metadata
        const tblT = tableTarget(base.id, table.id);
        const tblExists = await getState(db, tblT);
        if (!tblExists) {
          try {
            await emitEvent(db, feed, {
              op: 'INS',
              target: tblT,
              operand: { _airtable: { type: 'table', base_id: base.id, table_id: table.id } },
              agent,
              ts: new Date().toISOString(),
              acquired_ts: new Date().toISOString(),
              client_event_id: `at-ins-table:${base.id}:${table.id}`,
            }, opts?.sink);
          } catch { /* idempotency or concurrent INS */ }
        }
        try {
          await emitEvent(db, feed, {
            op: 'DEF',
            target: tblT,
            operand: {
              name: table.name,
              field_count: table.fieldCount,
              fields: table.fields,
              _displayField: displayFields?.[table.id] || table.primaryFieldId || undefined,
              _airtable: { type: 'table', base_id: base.id, table_id: table.id },
            },
            agent,
            ts: new Date().toISOString(),
            acquired_ts: new Date().toISOString(),
            client_event_id: `at-table:${base.id}:${table.id}`,
          }, opts?.sink);
        } catch { /* idempotency */ }

        // Create per-field schema entities under _schema container
        const schemaTarget = `${tblT}._schema`;
        try {
          await emitEvent(db, feed, {
            op: 'INS',
            target: schemaTarget,
            operand: { _airtable: { type: 'schema', base_id: base.id, table_id: table.id } },
            agent,
            ts: new Date().toISOString(),
            acquired_ts: new Date().toISOString(),
            client_event_id: `at-ins-schema:${base.id}:${table.id}`,
          }, opts?.sink);
        } catch { /* idempotency */ }

        for (const field of table.fields) {
          const fieldTarget = `${schemaTarget}.${field.id}`;
          try {
            await emitEvent(db, feed, {
              op: 'INS',
              target: fieldTarget,
              operand: { _airtable: { type: 'field', field_id: field.id, table_id: table.id } },
              agent,
              ts: new Date().toISOString(),
              acquired_ts: new Date().toISOString(),
              client_event_id: `at-ins-field:${base.id}:${table.id}:${field.id}`,
            }, opts?.sink);
          } catch { /* idempotency */ }
          try {
            await emitEvent(db, feed, {
              op: 'DEF',
              target: fieldTarget,
              operand: {
                name: field.name,
                type: field.type,
                _airtable: { field_id: field.id, table_id: table.id, base_id: base.id },
              },
              agent,
              ts: new Date().toISOString(),
              acquired_ts: new Date().toISOString(),
              client_event_id: `at-field:${base.id}:${table.id}:${field.id}`,
            }, opts?.sink);
          } catch { /* idempotency */ }

          // Emit .type DEF with mapped EO-DB column type.
          // For multipleRecordLinks, also store the linked table's EO target so
          // consumers can resolve the relationship without Airtable API access.
          const mapped = mapAirtableTypeOrNull(field.type);
          const eoType = mapped ?? 'text';
          const typeOperand: Record<string, unknown> = { type: eoType };
          if (mapped === null) typeOperand.unknownAirtableType = field.type;
          if (field.type === 'multipleRecordLinks' && field.options?.linkedTableId) {
            typeOperand.linkedTable = tableTarget(base.id, field.options.linkedTableId as string);
          }
          try {
            await emitEvent(db, feed, {
              op: 'DEF',
              target: `${fieldTarget}.type`,
              operand: typeOperand,
              agent,
              ts: new Date().toISOString(),
              acquired_ts: new Date().toISOString(),
              client_event_id: `at-field-type:${base.id}:${table.id}:${field.id}`,
            }, opts?.sink);
          } catch { /* idempotency */ }

          // Emit constraint DEFs from Airtable field options
          await emitFieldConstraints(db, feed, fieldTarget, field, agent, base.id, table.id, opts?.sink);
        }

        // Mark table in-progress in job
        if (tableProgress) {
          tableProgress.status = 'in_progress';
          tableProgress.started_at = new Date().toISOString();
          await persistJob(db, job);
        }

        const exclusions = fieldExclusions?.[table.id] ?? EMPTY_EXCLUSIONS;

        // Sync all records in this table
        try {
          const result = await syncTable(db, feed, client, base.id, table.id, table.name, agent, null, exclusions, preserveExisting, opts?.sink);
          syncResults.push(result);

          // Update job progress
          if (tableProgress) {
            tableProgress.status = 'completed';
            tableProgress.completed_at = new Date().toISOString();
            tableProgress.records_fetched = result.records_fetched;
            tableProgress.records_ingested = result.records_ingested;
            job.totals.tables_completed++;
            job.totals.records_ingested += result.records_ingested;
            job.totals.records_skipped += result.records_skipped_no_change + result.records_skipped_duplicate;
            await persistJob(db, job);
          }

          opts?.onTableComplete?.(result);
        } catch (e: any) {
          if (tableProgress) {
            tableProgress.status = 'failed';
            tableProgress.error = e.message;
            await persistJob(db, job);
          }
          throw e;
        }
      }
    }

    // Mark job completed
    job.status = 'completed';
    job.completed_at = new Date().toISOString();
    await persistJob(db, job);
  } catch (e: any) {
    // Mark job failed (tables already completed are preserved for resume)
    job.status = 'failed';
    job.error = e.message;
    await persistJob(db, job);
    throw e;
  }

  const totalIngested = syncResults.reduce((s, r) => s + r.records_ingested, 0);
  const totalSkipped = syncResults.reduce(
    (s, r) => s + r.records_skipped_no_change + r.records_skipped_duplicate, 0,
  );

  return {
    manifest,
    sync_results: syncResults,
    total_records_ingested: totalIngested,
    total_records_skipped: totalSkipped,
    duration_ms: Date.now() - start,
  };
}

// ─── Update sync ────────────────────────────────────────────────────────────

/**
 * Incremental update sync. Client devices call this to pull only changes
 * since the last sync cursor.
 *
 * Uses Airtable's `filterByFormula` with LAST_MODIFIED_TIME() to only
 * fetch recently changed records. Then filters out non-transformations
 * and deduplicates against concurrent syncs.
 */
export async function updateSync(
  db: EoDb,
  feed: Feed,
  client: AirtableClient,
  agent: string,
  opts?: {
    baseIds?: string[];
    tableIds?: string[];
    onTableComplete?: (result: SyncResult) => void;
    customization?: SyncCustomization;
    /** Event sink for grounded imports. */
    sink?: EventSink;
  },
): Promise<UpdateSyncResult> {
  const start = Date.now();
  const preserveExisting = opts?.customization?.preserveExisting ?? false;
  const selectedTables = opts?.customization?.selectedTables;
  const fieldExclusions = opts?.customization?.fieldExclusions;
  const syncResults: SyncResult[] = [];

  // Discover what's available (or use cached schema from hydration)
  const bases = await client.listBases();

  for (const base of bases) {
    if (opts?.baseIds?.length && !opts.baseIds.includes(base.id)) continue;

    // If table selection exists but this base has no selected tables, skip
    const baseTables = selectedTables?.[base.id];
    if (selectedTables && !baseTables?.length) continue;

    const tables = await client.getBaseSchema(base.id);

    for (const table of tables) {
      if (opts?.tableIds?.length && !opts.tableIds.includes(table.id)) continue;
      // Skip tables not in the selection
      if (baseTables && !baseTables.includes(table.id)) continue;

      const cursor = await getCursor(db, base.id, table.id);

      // If no cursor exists, this table hasn't been hydrated yet — skip
      if (!cursor) continue;

      // Acquire lock to prevent concurrent syncs on this table
      const locked = await acquireLock(db, base.id, table.id, agent);
      if (!locked) continue;

      try {
        const exclusions = fieldExclusions?.[table.id] ?? EMPTY_EXCLUSIONS;
        const result = await syncTable(db, feed, client, base.id, table.id, table.name, agent, cursor, exclusions, preserveExisting, opts?.sink);
        syncResults.push(result);
        opts?.onTableComplete?.(result);
      } finally {
        await releaseLock(db, base.id, table.id);
      }
    }
  }

  const totalIngested = syncResults.reduce((s, r) => s + r.records_ingested, 0);
  const totalSkipped = syncResults.reduce(
    (s, r) => s + r.records_skipped_no_change + r.records_skipped_duplicate, 0,
  );

  return {
    sync_results: syncResults,
    total_records_ingested: totalIngested,
    total_records_skipped: totalSkipped,
    duration_ms: Date.now() - start,
  };
}

// ─── Core table sync logic ──────────────────────────────────────────────────

async function syncTable(
  db: EoDb,
  feed: Feed,
  client: AirtableClient,
  baseId: string,
  tableId: string,
  tableName: string,
  agent: string,
  cursorSince: string | null,
  exclusions: SyncExclusions = EMPTY_EXCLUSIONS,
  preserveExisting: boolean = false,
  sink?: EventSink,
): Promise<SyncResult> {
  let fetched = 0;
  let ingested = 0;
  let skippedNoChange = 0;
  let skippedDuplicate = 0;

  // Retrieve field metadata from the table's stored schema (set during hydration).
  const fieldMeta = await getTableFieldMeta(db, baseId, tableId);

  // Retrieve the display field (primaryFieldId) so records get a `name` property.
  const tableState = await getState(db, tableTarget(baseId, tableId));
  const displayField: string | undefined = tableState?.value?._displayField;

  // Build filter: if we have a cursor, subtract a 60-second overlap window
  // to catch records modified during clock skew or during the previous sync.
  // Idempotency handles any re-fetched duplicates from the overlap.
  const filterCursor = cursorSince
    ? new Date(new Date(cursorSince).getTime() - 60_000).toISOString()
    : undefined;
  const filterByFormula = filterCursor
    ? `IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE('${filterCursor}'))`
    : undefined;

  // Request records keyed by field ID (not name) so they align with schema metadata.
  const useFieldIds = fieldMeta.size > 0;

  // Track last lock renewal to prevent TTL expiry during long-running syncs
  let lastLockRenew = Date.now();

  for await (const page of client.paginateRecords(baseId, tableId, {
    filterByFormula,
    returnFieldsByFieldId: useFieldIds,
  })) {
    // Renew lock heartbeat every 2 minutes to prevent TTL expiry
    if (Date.now() - lastLockRenew > LOCK_RENEW_INTERVAL_MS) {
      await renewLock(db, baseId, tableId, agent);
      lastLockRenew = Date.now();
    }

    for (const record of page) {
      fetched++;
      const result = await ingestRecord(db, feed, baseId, tableId, record, agent, fieldMeta, exclusions, preserveExisting, displayField, sink);
      switch (result) {
        case 'ingested': ingested++; break;
        case 'skipped_no_change': skippedNoChange++; break;
        case 'skipped_duplicate': skippedDuplicate++; break;
      }
    }
  }

  // Set cursor AFTER all records are fetched and ingested — not before.
  // This ensures records modified during the sync window are caught on next sync.
  const cursorAfter = new Date().toISOString();
  await setCursor(db, baseId, tableId, cursorAfter);

  return {
    base_id: baseId,
    table_id: tableId,
    table_name: tableName,
    records_fetched: fetched,
    records_ingested: ingested,
    records_skipped_no_change: skippedNoChange,
    records_skipped_duplicate: skippedDuplicate,
    cursor_before: cursorSince,
    cursor_after: cursorAfter,
  };
}

// ─── Exports for testing ────────────────────────────────────────────────────

export {
  hasActualChanges,
  deepEqual,
  computeFieldDiff,
  recordEventId,
  recordTarget,
  tableTarget,
  baseTarget,
  extractStorableFields,
  buildFieldMetaMap,
};

