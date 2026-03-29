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
import { randomUUID } from 'crypto';
import {
  AirtableClient,
  type AirtableBase,
  type AirtableTable,
  type AirtableRecord,
} from './airtable-client.js';
import { classifyFieldType, type FieldClassification } from './field-rules.js';
import { extractValue, valuesEqual, stableStringify } from './value-extract.js';
import { isExcluded, EMPTY_EXCLUSIONS, type SyncExclusions } from './exclusions.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HydrationManifest {
  bases: Array<{
    id: string;
    name: string;
    tables: Array<{
      id: string;
      name: string;
      fieldCount: number;
      fields: Array<{ id: string; name: string; type: string }>;
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
   * Default: true (safe mode — EO-DB is source of truth once populated).
   */
  preserveExisting?: boolean;
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
    const keyStr = typeof key === 'string' ? key : key.toString();
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

/** Map of field ID → { name, type, classification } built from table schema. */
export interface FieldMeta {
  id: string;
  name: string;
  type: string;
  classification: FieldClassification;
}

/**
 * Build a field metadata map from the table's stored schema.
 * Falls back to empty map if schema isn't available (all fields pass through).
 */
function buildFieldMetaMap(
  fields: Array<{ id: string; name: string; type: string }> | undefined,
): Map<string, FieldMeta> {
  const map = new Map<string, FieldMeta>();
  if (!fields) return map;
  for (const f of fields) {
    map.set(f.id, {
      id: f.id,
      name: f.name,
      type: f.type,
      classification: classifyFieldType(f.type),
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

// ─── Non-transformation detection ───────────────────────────────────────────

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

    // Skip computed/metadata fields — they're Horizon outputs
    if (meta.classification === 'skip') continue;

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
  preserveExisting: boolean = true,
): Promise<'ingested' | 'skipped_no_change' | 'skipped_duplicate'> {
  const target = recordTarget(baseId, tableId, record.id);

  // 1. Extract only storable fields (skip computed/metadata, normalize values)
  let storableFields = extractStorableFields(record.fields, fieldMeta, exclusions);

  if (preserveExisting) {
    // Only write fields that don't already exist in EO-DB.
    // Existing field values are never overwritten — EO-DB is source of truth.
    const existing = await getState(db, target);
    const existingFields = existing?.value?.fields;
    if (existingFields) {
      const newFields: Record<string, any> = {};
      for (const [key, val] of Object.entries(storableFields)) {
        if (!(key in existingFields) || existingFields[key] === undefined || existingFields[key] === null) {
          newFields[key] = val;
        }
      }
      if (Object.keys(newFields).length === 0) {
        return 'skipped_no_change';
      }
      storableFields = newFields;
    }
  } else {
    // 2. Check for non-transformation against normalized fields
    if (!await hasActualChanges(db, target, storableFields)) {
      return 'skipped_no_change';
    }
  }

  // 3. Build idempotent event ID using normalized content hash for dedup
  const contentKey = stableStringify(storableFields);
  const clientEventId = recordEventId(baseId, tableId, record.id, contentKey);

  // 4. Explicit INS for new records — the log should truthfully show entity birth
  //    INS idempotency key uses record ID only (stable across re-syncs).
  //    Idempotency check in processEvent prevents duplicate INS on re-sync.
  const existing = await getState(db, target);
  if (!existing) {
    try {
      await processEvent(db, {
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
      }, feed);
    } catch (e: any) {
      // Idempotency or concurrent INS — safe to continue to DEF
      if (!e.message?.includes('already') && !e.message?.includes('already instantiated')) throw e;
    }
  }

  // 5. Ingest via DEF with only storable fields (no computed/Horizon noise)
  try {
    await processEvent(db, {
      op: 'DEF',
      target,
      operand: {
        fields: storableFields,
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
      client_event_id: clientEventId,
    }, feed);
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
        fieldCount: t.fields.length,
        fields: t.fields.map(f => ({ id: f.id, name: f.name, type: f.type })),
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
  },
): Promise<HydrationResult> {
  const start = Date.now();
  const preserveExisting = opts?.customization?.preserveExisting ?? true;
  const selectedTables = opts?.customization?.selectedTables;
  const fieldExclusions = opts?.customization?.fieldExclusions;
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
          await processEvent(db, {
            op: 'INS',
            target: baseT,
            operand: { _airtable: { type: 'base', base_id: base.id } },
            agent,
            ts: new Date().toISOString(),
            acquired_ts: new Date().toISOString(),
            client_event_id: `at-ins-base:${base.id}`,
          }, feed);
        } catch { /* idempotency or concurrent INS */ }
      }
      try {
        await processEvent(db, {
          op: 'DEF',
          target: baseT,
          operand: { name: base.name, _airtable: { type: 'base', base_id: base.id } },
          agent,
          ts: new Date().toISOString(),
          acquired_ts: new Date().toISOString(),
          client_event_id: `at-base:${base.id}`,
        }, feed);
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
            await processEvent(db, {
              op: 'INS',
              target: tblT,
              operand: { _airtable: { type: 'table', base_id: base.id, table_id: table.id } },
              agent,
              ts: new Date().toISOString(),
              acquired_ts: new Date().toISOString(),
              client_event_id: `at-ins-table:${base.id}:${table.id}`,
            }, feed);
          } catch { /* idempotency or concurrent INS */ }
        }
        try {
          await processEvent(db, {
            op: 'DEF',
            target: tblT,
            operand: {
              name: table.name,
              field_count: table.fieldCount,
              fields: table.fields,
              _airtable: { type: 'table', base_id: base.id, table_id: table.id },
            },
            agent,
            ts: new Date().toISOString(),
            acquired_ts: new Date().toISOString(),
            client_event_id: `at-table:${base.id}:${table.id}`,
          }, feed);
        } catch { /* idempotency */ }

        // Mark table in-progress in job
        if (tableProgress) {
          tableProgress.status = 'in_progress';
          tableProgress.started_at = new Date().toISOString();
          await persistJob(db, job);
        }

        const exclusions = fieldExclusions?.[table.id] ?? EMPTY_EXCLUSIONS;

        // Sync all records in this table
        try {
          const result = await syncTable(db, feed, client, base.id, table.id, table.name, agent, null, exclusions, preserveExisting);
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
  },
): Promise<UpdateSyncResult> {
  const start = Date.now();
  const preserveExisting = opts?.customization?.preserveExisting ?? true;
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
        const result = await syncTable(db, feed, client, base.id, table.id, table.name, agent, cursor, exclusions, preserveExisting);
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
  preserveExisting: boolean = true,
): Promise<SyncResult> {
  let fetched = 0;
  let ingested = 0;
  let skippedNoChange = 0;
  let skippedDuplicate = 0;

  // Retrieve field metadata from the table's stored schema (set during hydration).
  const fieldMeta = await getTableFieldMeta(db, baseId, tableId);

  // Build filter: if we have a cursor, subtract a 60-second overlap window
  // to catch records modified during clock skew or during the previous sync.
  // Idempotency handles any re-fetched duplicates from the overlap.
  const filterCursor = cursorSince
    ? new Date(new Date(cursorSince).getTime() - 60_000).toISOString()
    : undefined;
  const filterByFormula = filterCursor
    ? `LAST_MODIFIED_TIME()>='${filterCursor}'`
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
      const result = await ingestRecord(db, feed, baseId, tableId, record, agent, fieldMeta, exclusions, preserveExisting);
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
  recordEventId,
  recordTarget,
  tableTarget,
  baseTarget,
  extractStorableFields,
  buildFieldMetaMap,
};

export type { SyncCustomization };
