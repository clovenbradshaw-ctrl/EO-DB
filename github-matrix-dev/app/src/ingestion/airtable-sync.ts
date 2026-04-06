/**
 * Browser-side Airtable sync engine.
 *
 * Adapted from the server-side engine to use EoStore (IndexedDB + AES-GCM)
 * instead of LevelDB. Records fold locally via processEvent, and sync to
 * Matrix via the SyncManager if available.
 *
 * Two modes:
 *   1. Hydration sync — full pull of all bases/tables
 *   2. Update sync — incremental pull using LAST_MODIFIED_TIME() filter
 *
 * Cursors stored in IndexedDB meta store: `meta:at_cursor:{baseId}:{tableId}`
 */

import type { EoStore } from '../db/encrypted-store';
import { processEvent } from '../db/fold';
import { getState } from '../db/state';
import {
  AirtableClient,
  type AirtableBase,
  type AirtableTable,
  type AirtableRecord,
} from './airtable-client';
import { classifyFieldType, type FieldClassification } from './field-rules';
import { extractValue, valuesEqual, stableStringify } from './value-extract';
import { isExcluded, EMPTY_EXCLUSIONS, type SyncExclusions } from './exclusions';

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

export interface SyncProgress {
  phase: 'discovering' | 'syncing';
  base?: string;
  table?: string;
  records_so_far?: number;
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

  /**
   * Maximum number of records to import per table.
   * When set, sync stops after importing this many records from each table.
   * Useful for testing or partial imports. 0 or undefined means no limit.
   */
  recordLimit?: number;

  /**
   * Override the display name field per table (by table ID → field ID).
   * When set, this field's value is used as the record's `name`.
   * If not set, falls back to the table's primaryFieldId.
   * Example: { 'tblClients': 'fldFullName' }
   */
  displayFields?: Record<string, string>;
}

// ─── Cursor management (IndexedDB meta store) ─────────────────────────────

function cursorKey(baseId: string, tableId: string): string {
  return `meta:at_cursor:${baseId}:${tableId}`;
}

async function getCursor(store: EoStore, baseId: string, tableId: string): Promise<string | null> {
  return store.get(cursorKey(baseId, tableId));
}

async function setCursor(store: EoStore, baseId: string, tableId: string, cursor: string): Promise<void> {
  await store.put(cursorKey(baseId, tableId), cursor);
}

// ─── Target naming ──────────────────────────────────────────────────────────

function recordTarget(baseId: string, tableId: string, recordId: string): string {
  return `at.${baseId}.${tableId}.${recordId}`;
}

function tableTarget(baseId: string, tableId: string): string {
  return `at.${baseId}.${tableId}`;
}

function baseTarget(baseId: string): string {
  return `at.${baseId}`;
}

// ─── Field metadata ─────────────────────────────────────────────────────────

interface FieldMeta {
  id: string;
  name: string;
  type: string;
  classification: FieldClassification;
}

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

async function getTableFieldMeta(
  store: EoStore,
  baseId: string,
  tableId: string,
): Promise<Map<string, FieldMeta>> {
  const state = await getState(store, tableTarget(baseId, tableId));
  return buildFieldMetaMap(state?.value?.fields);
}

// ─── Non-transformation detection ──────────────────────────────────────────

function extractStorableFields(
  rawFields: Record<string, any>,
  fieldMeta: Map<string, FieldMeta>,
  exclusions: SyncExclusions,
): Record<string, any> {
  if (fieldMeta.size === 0) return rawFields;

  const result: Record<string, any> = {};
  for (const [fieldId, rawValue] of Object.entries(rawFields)) {
    const meta = fieldMeta.get(fieldId);
    if (!meta) { result[fieldId] = rawValue; continue; }
    if (meta.classification === 'skip') continue;
    if (isExcluded(fieldId, meta.name, exclusions)) continue;
    result[fieldId] = extractValue(rawValue, meta.type);
  }
  return result;
}

async function hasActualChanges(
  store: EoStore,
  target: string,
  storableFields: Record<string, any>,
): Promise<boolean> {
  const existing = await getState(store, target);
  if (!existing) return true;

  const existingFields = existing.value?.fields;
  if (!existingFields) return true;

  for (const [key, val] of Object.entries(storableFields)) {
    if (!valuesEqual(val, existingFields[key])) return true;
  }
  for (const key of Object.keys(existingFields)) {
    if (!(key in storableFields)) return true;
  }
  return false;
}

// ─── Deduplication ─────────────────────────────────────────────────────────

function recordEventId(baseId: string, tableId: string, recordId: string, contentKey: string): string {
  return `at-sync:${baseId}:${tableId}:${recordId}:${contentKey}`;
}

// ─── Ingest a single record ────────────────────────────────────────────────

async function ingestRecord(
  store: EoStore,
  baseId: string,
  tableId: string,
  record: AirtableRecord,
  agent: string,
  fieldMeta: Map<string, FieldMeta>,
  exclusions: SyncExclusions = EMPTY_EXCLUSIONS,
  preserveExisting: boolean = true,
  onEvent?: (event: any) => void,
  displayField?: string,
): Promise<'ingested' | 'skipped_no_change' | 'skipped_duplicate'> {
  const target = recordTarget(baseId, tableId, record.id);
  let storableFields = extractStorableFields(record.fields, fieldMeta, exclusions);

  if (preserveExisting) {
    // Only write fields that don't already exist in EO-DB.
    // Existing field values are never overwritten — EO-DB is source of truth.
    const existing = await getState(store, target);
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
    if (!await hasActualChanges(store, target, storableFields)) {
      return 'skipped_no_change';
    }
  }

  const contentKey = stableStringify(storableFields);
  const clientEventId = recordEventId(baseId, tableId, record.id, contentKey);

  try {
    await processEvent(store, {
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
    }, onEvent);

    // Set display name as a separate DEF — ontologically distinct from the data import.
    // The name assignment is a user/system choice about how to present this record,
    // not part of the source data itself.
    if (displayField) {
      const nameVal = storableFields[displayField] ?? record.fields[displayField];
      if (nameVal != null) {
        await processEvent(store, {
          op: 'DEF',
          target,
          operand: { name: String(nameVal) },
          agent: `${agent}:display`,
          ts: new Date().toISOString(),
          acquired_ts: new Date().toISOString(),
          client_event_id: `${clientEventId}:name`,
        }, onEvent);
      }
    }
    return 'ingested';
  } catch (e: any) {
    if (e.message?.includes('already')) return 'skipped_duplicate';
    throw e;
  }
}

// ─── Discovery ─────────────────────────────────────────────────────────────

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
        fields: t.fields.map(f => ({ id: f.id, name: f.name, type: f.type })),
      })),
    });
  }

  return manifest;
}

// ─── Core table sync ───────────────────────────────────────────────────────

async function syncTable(
  store: EoStore,
  client: AirtableClient,
  baseId: string,
  tableId: string,
  tableName: string,
  agent: string,
  cursorSince: string | null,
  exclusions: SyncExclusions = EMPTY_EXCLUSIONS,
  preserveExisting: boolean = true,
  onEvent?: (event: any) => void,
  onProgress?: (progress: SyncProgress) => void,
  recordLimit?: number,
): Promise<SyncResult> {
  let fetched = 0;
  let ingested = 0;
  let skippedNoChange = 0;
  let skippedDuplicate = 0;
  const now = new Date().toISOString();
  const limit = recordLimit && recordLimit > 0 ? recordLimit : Infinity;

  const fieldMeta = await getTableFieldMeta(store, baseId, tableId);

  // Retrieve display field so records get a `name` property
  const tableState = await getState(store, tableTarget(baseId, tableId));
  const displayField: string | undefined = tableState?.value?._displayField;

  const filterByFormula = cursorSince
    ? `LAST_MODIFIED_TIME()>='${cursorSince}'`
    : undefined;

  const useFieldIds = fieldMeta.size > 0;

  let limitReached = false;
  for await (const page of client.paginateRecords(baseId, tableId, {
    filterByFormula,
    returnFieldsByFieldId: useFieldIds,
  })) {
    for (const record of page) {
      if (fetched >= limit) { limitReached = true; break; }
      fetched++;
      const result = await ingestRecord(store, baseId, tableId, record, agent, fieldMeta, exclusions, preserveExisting, onEvent, displayField);
      switch (result) {
        case 'ingested': ingested++; break;
        case 'skipped_no_change': skippedNoChange++; break;
        case 'skipped_duplicate': skippedDuplicate++; break;
      }
    }
    if (limitReached) break;
    onProgress?.({ phase: 'syncing', table: tableName, records_so_far: fetched });
  }

  await setCursor(store, baseId, tableId, now);

  return {
    base_id: baseId,
    table_id: tableId,
    table_name: tableName,
    records_fetched: fetched,
    records_ingested: ingested,
    records_skipped_no_change: skippedNoChange,
    records_skipped_duplicate: skippedDuplicate,
    cursor_before: cursorSince,
    cursor_after: now,
  };
}

// ─── Hydration sync ────────────────────────────────────────────────────────

export async function hydrationSync(
  store: EoStore,
  client: AirtableClient,
  agent: string,
  opts?: {
    onProgress?: (progress: SyncProgress) => void;
    onEvent?: (event: any) => void;
    onTableComplete?: (result: SyncResult) => void;
    customization?: SyncCustomization;
  },
): Promise<HydrationResult> {
  const start = Date.now();
  const preserveExisting = opts?.customization?.preserveExisting ?? true;
  const selectedTables = opts?.customization?.selectedTables;
  const fieldExclusions = opts?.customization?.fieldExclusions;
  const recordLimit = opts?.customization?.recordLimit;
  const displayFields = opts?.customization?.displayFields;

  opts?.onProgress?.({ phase: 'discovering' });
  const manifest = await discoverSchema(client);
  const syncResults: SyncResult[] = [];

  for (const base of manifest.bases) {
    // If table selection exists but this base has no selected tables, skip
    const baseTables = selectedTables?.[base.id];
    if (selectedTables && !baseTables?.length) continue;

    // Register base container
    try {
      await processEvent(store, {
        op: 'DEF',
        target: baseTarget(base.id),
        operand: { name: base.name, _airtable: { type: 'base', base_id: base.id } },
        agent,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
        client_event_id: `at-base:${base.id}`,
      }, opts?.onEvent);
    } catch { /* idempotent */ }

    for (const table of base.tables) {
      // Skip tables not in the selection
      if (baseTables && !baseTables.includes(table.id)) continue;

      // Register table container with schema
      try {
        await processEvent(store, {
          op: 'DEF',
          target: tableTarget(base.id, table.id),
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
        }, opts?.onEvent);
      } catch { /* idempotent */ }

      // Create per-field schema entities under _schema container
      const tblT = tableTarget(base.id, table.id);
      const schemaTarget = `${tblT}._schema`;
      try {
        await processEvent(store, {
          op: 'INS',
          target: schemaTarget,
          operand: { _airtable: { type: 'schema', base_id: base.id, table_id: table.id } },
          agent,
          ts: new Date().toISOString(),
          acquired_ts: new Date().toISOString(),
          client_event_id: `at-ins-schema:${base.id}:${table.id}`,
        }, opts?.onEvent);
      } catch { /* idempotent */ }

      for (const field of table.fields) {
        const fieldTarget = `${schemaTarget}.${field.id}`;
        try {
          await processEvent(store, {
            op: 'INS',
            target: fieldTarget,
            operand: { _airtable: { type: 'field', field_id: field.id, table_id: table.id } },
            agent,
            ts: new Date().toISOString(),
            acquired_ts: new Date().toISOString(),
            client_event_id: `at-ins-field:${base.id}:${table.id}:${field.id}`,
          }, opts?.onEvent);
        } catch { /* idempotent */ }
        try {
          await processEvent(store, {
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
          }, opts?.onEvent);
        } catch { /* idempotent */ }
      }

      opts?.onProgress?.({ phase: 'syncing', base: base.name, table: table.name });

      const exclusions = fieldExclusions?.[table.id] ?? EMPTY_EXCLUSIONS;

      const result = await syncTable(
        store, client, base.id, table.id, table.name, agent, null,
        exclusions, preserveExisting,
        opts?.onEvent, opts?.onProgress, recordLimit,
      );
      syncResults.push(result);
      opts?.onTableComplete?.(result);
    }
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

// ─── Update sync ───────────────────────────────────────────────────────────

export async function updateSync(
  store: EoStore,
  client: AirtableClient,
  agent: string,
  opts?: {
    onProgress?: (progress: SyncProgress) => void;
    onEvent?: (event: any) => void;
    onTableComplete?: (result: SyncResult) => void;
    customization?: SyncCustomization;
  },
): Promise<UpdateSyncResult> {
  const start = Date.now();
  const preserveExisting = opts?.customization?.preserveExisting ?? true;
  const selectedTables = opts?.customization?.selectedTables;
  const fieldExclusions = opts?.customization?.fieldExclusions;
  const recordLimit = opts?.customization?.recordLimit;
  const syncResults: SyncResult[] = [];

  opts?.onProgress?.({ phase: 'discovering' });
  const bases = await client.listBases();

  for (const base of bases) {
    // If table selection exists but this base has no selected tables, skip
    const baseTables = selectedTables?.[base.id];
    if (selectedTables && !baseTables?.length) continue;

    const tables = await client.getBaseSchema(base.id);

    for (const table of tables) {
      // Skip tables not in the selection
      if (baseTables && !baseTables.includes(table.id)) continue;

      const cursor = await getCursor(store, base.id, table.id);
      if (!cursor) continue; // Not hydrated yet — skip

      // Refresh per-field schema entities (handles field adds/renames)
      const tblT = tableTarget(base.id, table.id);
      const schemaTarget = `${tblT}._schema`;
      try {
        await processEvent(store, {
          op: 'INS',
          target: schemaTarget,
          operand: { _airtable: { type: 'schema', base_id: base.id, table_id: table.id } },
          agent,
          ts: new Date().toISOString(),
          acquired_ts: new Date().toISOString(),
          client_event_id: `at-ins-schema:${base.id}:${table.id}`,
        }, opts?.onEvent);
      } catch { /* idempotent — already exists */ }

      for (const field of table.fields) {
        const fieldTarget = `${schemaTarget}.${field.id}`;
        try {
          await processEvent(store, {
            op: 'INS',
            target: fieldTarget,
            operand: { _airtable: { type: 'field', field_id: field.id, table_id: table.id } },
            agent,
            ts: new Date().toISOString(),
            acquired_ts: new Date().toISOString(),
            client_event_id: `at-ins-field:${base.id}:${table.id}:${field.id}`,
          }, opts?.onEvent);
        } catch { /* idempotent */ }
        try {
          await processEvent(store, {
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
            client_event_id: `at-field-upd:${base.id}:${table.id}:${field.id}`,
          }, opts?.onEvent);
        } catch { /* idempotent */ }
      }

      opts?.onProgress?.({ phase: 'syncing', base: base.name, table: table.name });

      const exclusions = fieldExclusions?.[table.id] ?? EMPTY_EXCLUSIONS;

      const result = await syncTable(
        store, client, base.id, table.id, table.name, agent, cursor,
        exclusions, preserveExisting,
        opts?.onEvent, opts?.onProgress, recordLimit,
      );
      syncResults.push(result);
      opts?.onTableComplete?.(result);
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
