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
import { readLogForPrefix } from '../db/log';
import { markDeleted } from '../db/tombstone';
import type { EoEvent, Resolution } from '../db/types';
import {
  AirtableClient,
  AirtableApiError,
  NoLastModifiedFieldError,
  ScopeMissingError,
  WebhookGoneError,
  type AirtableBase,
  type AirtableTable,
  type AirtableRecord,
} from './airtable-client';
import { classifyFieldType, type FieldClassification } from './field-rules';
import { mapAirtableTypeOrNull } from './airtable-type-map';
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
  /**
   * Subset of `records_ingested` where the record already existed in EO-DB
   * and at least one previously non-null field value was replaced. Lets the
   * UI surface "12 new / 3 overwritten" instead of a flat "15 ingested".
   */
  records_overwritten: number;
  records_skipped_no_change: number;
  records_skipped_duplicate: number;
  cursor_before: string | null;
  cursor_after: string;
}

export interface HydrationResult {
  manifest: HydrationManifest;
  sync_results: SyncResult[];
  total_records_ingested: number;
  /** Sum of `records_overwritten` across sync_results. */
  total_records_overwritten: number;
  total_records_skipped: number;
  duration_ms: number;
}

export interface UpdateSyncResult {
  sync_results: SyncResult[];
  total_records_ingested: number;
  /** Sum of `records_overwritten` across sync_results. */
  total_records_overwritten: number;
  total_records_skipped: number;
  duration_ms: number;
}

/**
 * Runtime strategy label for a sync run — drives UI pills / toasts.
 *   - 'hydration'    — full pull (collectAirtableBundle + processHydrationBundle)
 *   - 'webhook'      — incremental via Airtable Webhooks payloads API
 *                      (POST /v0/bases/{baseId}/webhooks + poll payloads).
 *                      This is the authoritative change feed — no table scan,
 *                      no dependence on a LAST_MODIFIED_TIME() formula field.
 *   - 'lastModified' — fallback: filterByFormula(IS_AFTER(LAST_MODIFIED_TIME(), ...))
 *                      used only when a webhook can't be created (e.g. the
 *                      Airtable token lacks webhook:manage scope) or when a
 *                      previously-registered webhook has expired and the
 *                      cursor is unrecoverable.
 */
export type SyncStrategy = 'hydration' | 'webhook' | 'lastModified';

export interface SyncProgress {
  phase: 'discovering' | 'collecting' | 'syncing' | 'fetching' | 'folding' | 'table_done';
  base?: string;
  /** Human-readable base name — mirrors `base` but surfaced explicitly for the UI. */
  baseName?: string;
  baseId?: string;
  table?: string;
  tableId?: string;
  records_so_far?: number;
  /**
   * The actual Airtable API URL being queried for the current phase, e.g.
   * `https://api.airtable.com/v0/appXYZ/tblABC?filterByFormula=...`.
   * Only populated for phases that hit the network.
   */
  endpoint?: string;
  /** ISO timestamp of the LAST_MODIFIED_TIME cursor used for this table. */
  cursor?: string;
  /** Which strategy drove this run — for UI labelling. */
  strategy?: SyncStrategy;
  /** Whether this run preserves existing EO-DB field values. */
  preserveExisting?: boolean;
  /** Per-table counters emitted with `table_done`. */
  ingested?: number;
  overwritten?: number;
  skipped?: number;
  /** When set, this table was skipped before any network call. */
  skipReason?: 'no_last_modified_field';
}

/**
 * Raw, unmodified payload captured from Airtable at the start of a bulk
 * import. Uploaded to Drive for provenance BEFORE any records are folded
 * into operators, so we always have an audit trail of exactly what came in
 * — even if the fold later fails, is cancelled, or is superseded.
 */
export interface RawImportBundle {
  /** Source identifier — always "airtable" for this module. */
  source: 'airtable';
  /** Unique id for this import attempt. Used in provenance filenames and
   *  import-record targets. Generated by collectAirtableBundle(). */
  importId: string;
  /** ISO timestamp of when collection started. */
  collectedAt: string;
  /** Full discovered schema at collection time. */
  manifest: HydrationManifest;
  /** Records grouped by table, in the order they were fetched. */
  tables: Array<{
    baseId: string;
    baseName: string;
    tableId: string;
    tableName: string;
    /** Fields used the `returnFieldsByFieldId=true` encoding when true. */
    useFieldIds: boolean;
    records: AirtableRecord[];
  }>;
}

/**
 * Result of handing a RawImportBundle to the provenance hook. Returned
 * synchronously from the caller so the processing phase can reference the
 * Drive file and persist a linked import record.
 */
export interface ProvenanceResult {
  /** Drive filename the bundle was stored under. */
  fileName: string;
  /** Drive file id (useful for direct download links). */
  driveFileId: string;
  /** Encoded byte size of the raw bundle on disk. */
  byteSize: number;
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

  /**
   * Batch-level resolution stamped on every INS event constructed during
   * this import. Encodes the caller's declared stance for the import — e.g.
   * `'Making'` for fresh rows being brought into existence for the first
   * time, `'Composing'` for rows assembled from multiple upstream sources,
   * `'Binding'` for rows instantiated as concrete realizations of an
   * existing specification. When unset or `'unspecified'` (the default),
   * imported INS events carry nibble 0 — the honest "stance not recorded"
   * coordinate on the lattice's resolution axis.
   *
   * Applied ONLY to record INS events. DEF events carrying field values
   * remain at unspecified: the stance of an import is about how rows are
   * brought into existence, not about the individual value assertions.
   */
  defaultResolution?: Resolution;
}

// ─── Polling pacing ───────────────────────────────────────────────────────
//
// Sequential single-flight polling enforces a 10-second wall-clock gap
// between consecutive table polls within an updateSync cycle. Combined with
// the per-base AirtableClient TokenBucket (4 req/sec) and the leader-election
// lease (only one device polls at a time), this caps the steady-state load
// well under Airtable's 5 req/sec limit even on installations with many
// tables.

const INTER_TABLE_POLL_GAP_MS = 10_000;

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

/**
 * Seed local IndexedDB cursors from a `${baseId}/${tableId} -> ISO` map
 * sourced from Matrix room state. Takes the max of (room, local) per key so
 * a leader handoff can never regress a cursor — if local just advanced past
 * the room state value (because we wrote local first and the state event
 * hasn't propagated), local wins; if room state is fresher (a different
 * device was the previous leader), room wins.
 */
export async function seedCursorsFromMap(
  store: EoStore,
  cursors: Map<string, string>,
): Promise<void> {
  for (const [stateKey, remoteCursor] of cursors) {
    const slash = stateKey.indexOf('/');
    if (slash < 0) continue;
    const baseId = stateKey.slice(0, slash);
    const tableId = stateKey.slice(slash + 1);
    if (!baseId || !tableId) continue;
    const local = await getCursor(store, baseId, tableId);
    const winner = !local || remoteCursor > local ? remoteCursor : local;
    if (winner !== local) {
      await setCursor(store, baseId, tableId, winner);
    }
  }
}

// ─── NUL preservation index ───────────────────────────────────────────────
//
// A user can explicitly clear a cell, which logs a NUL event with
// `operand.fieldKey` (see components/cell-events.ts). Without filtering,
// the next Airtable poll would re-import the previously-cleared value and
// silently undo the user's NUL transformation.
//
// `buildNulledFieldsForTable` scans the log once per table sync to build a
// `recordTarget -> Set<fieldKey>` index of every field a user has cleared.
// `ingestRecord` then drops those keys from the diff before emitting DEF
// when the existing local value is still null (i.e. the clearing DEF that
// accompanies the NUL is still the most recent state — the user hasn't
// re-set the value locally).

async function buildNulledFieldsForTable(
  store: EoStore,
  baseId: string,
  tableId: string,
): Promise<Map<string, Set<string>>> {
  const prefix = `${tableTarget(baseId, tableId)}.`;
  const events = await readLogForPrefix(store, prefix);
  const map = new Map<string, Set<string>>();
  for (const event of events as EoEvent[]) {
    if (event.op !== 'NUL') continue;
    const fieldKey = (event.operand as { fieldKey?: unknown } | undefined)?.fieldKey;
    if (typeof fieldKey !== 'string' || !fieldKey) continue;
    let set = map.get(event.target);
    if (!set) {
      set = new Set<string>();
      map.set(event.target, set);
    }
    set.add(fieldKey);
  }
  return map;
}

// ─── Webhook state (IndexedDB meta store) ─────────────────────────────────
//
// One webhook per Airtable base subscribes to `tableData` changes for all
// tables. The payload stream is consumed via a monotonically-increasing
// integer cursor; we persist `{ webhookId, cursor }` so subsequent polls
// pick up exactly where the last one left off — no overlap windows, no
// table scans, no dependence on LAST_MODIFIED_TIME() formula semantics.

interface WebhookState {
  webhookId: string;
  /** Cursor to pass on the NEXT listWebhookPayloads call. */
  cursor: number;
  /** Wall-clock ISO timestamp the webhook was (re)created. */
  createdAt: string;
}

function webhookKey(baseId: string): string {
  return `meta:at_webhook:${baseId}`;
}

async function getWebhookState(store: EoStore, baseId: string): Promise<WebhookState | null> {
  const raw = await store.get(webhookKey(baseId));
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as WebhookState; } catch { return null; }
  }
  return raw as WebhookState;
}

async function setWebhookState(store: EoStore, baseId: string, state: WebhookState): Promise<void> {
  await store.put(webhookKey(baseId), state);
}

async function clearWebhookState(store: EoStore, baseId: string): Promise<void> {
  await store.del(webhookKey(baseId));
}

/**
 * Returns the set of tables that have been successfully synced at least once,
 * keyed by baseId → tableId[]. Derived from stored cursor keys so it never
 * goes stale — if a cursor exists, the table was hydrated.
 */
export async function getSyncedTableIds(
  store: EoStore,
): Promise<Record<string, string[]>> {
  const entries = await store.iterator('meta:at_cursor:');
  const result: Record<string, string[]> = {};
  for (const [key] of entries) {
    // key format: meta:at_cursor:{baseId}:{tableId}
    const parts = key.split(':');
    if (parts.length < 4) continue;
    const baseId = parts[2];
    const tableId = parts[3];
    if (!result[baseId]) result[baseId] = [];
    result[baseId].push(tableId);
  }
  return result;
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

/**
 * A table without a `lastModifiedTime` field can't drive an incremental sync —
 * the LAST_MODIFIED_TIME() filter has nothing to compare against, and the
 * gateway can't tell which records changed since the last cursor. Tables in
 * this state are skipped from both hydration and update sync; the user has to
 * add a Last Modified field in Airtable before they show up.
 */
export function tableHasLastModifiedField(table: { fields: { type: string }[] }): boolean {
  return table.fields.some(f => f.type === 'lastModifiedTime');
}

// ─── Field metadata ─────────────────────────────────────────────────────────

interface FieldMeta {
  id: string;
  name: string;
  type: string;
  classification: FieldClassification;
  options?: Record<string, any>;
}

/**
 * Per-record diff observation reported by `ingestRecord` whenever a fold
 * actually changes a record's stored fields. Surfaced to the UI's "Recent
 * changes" panel so users can confirm "I edited Status from Active →
 * Inactive and the sync caught it." Skip-no-change records do NOT emit a
 * change report.
 */
export interface RecordChangeReport {
  baseId: string;
  tableId: string;
  tableName?: string;
  recordId: string;
  /** Best-effort label (display field value), falls back to recordId. */
  recordLabel?: string;
  /** Field-level diffs. Field name comes from `FieldMeta` when available, else the raw id. */
  diffs: Array<{ field: string; before: unknown; after: unknown }>;
  /** Was this an INS (new record) vs an edit? Useful so the UI can group "added" vs "changed". */
  kind: 'created' | 'updated';
}

export type RecordChangeListener = (report: RecordChangeReport) => void;

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

async function getTableFieldMeta(
  store: EoStore,
  baseId: string,
  tableId: string,
): Promise<Map<string, FieldMeta>> {
  const state = await getState(store, tableTarget(baseId, tableId));
  return buildFieldMetaMap(state?.value?.fields);
}

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
  store: EoStore,
  fieldTarget: string,
  field: { id: string; type: string; options?: Record<string, any> },
  agent: string,
  baseId: string,
  tableId: string,
  onEvent?: (e: any) => void,
): Promise<void> {
  const mappings = CONSTRAINT_MAP[field.type];
  if (!mappings || !field.options) return;

  for (const { optionKey, constraintName } of mappings) {
    const value = field.options[optionKey];
    if (value == null) continue;

    try {
      await processEvent(store, {
        op: 'DEF',
        target: `${fieldTarget}.constraint.${constraintName}`,
        operand: constraintName === 'enum' ? { choices: value } : { value },
        agent,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
        client_event_id: `at-constraint:${baseId}:${tableId}:${field.id}:${constraintName}`,
      }, onEvent);
    } catch { /* idempotent */ }
  }
}

// ─── Non-transformation detection ──────────────────────────────────────────

function extractStorableFields(
  rawFields: Record<string, any>,
  fieldMeta: Map<string, FieldMeta>,
  exclusions: SyncExclusions,
  baseId: string,
): Record<string, any> {
  if (fieldMeta.size === 0) return rawFields;

  const result: Record<string, any> = {};
  for (const [fieldId, rawValue] of Object.entries(rawFields)) {
    const meta = fieldMeta.get(fieldId);
    if (!meta) { result[fieldId] = rawValue; continue; }
    if (meta.classification === 'skip' || meta.classification === 'eva') continue;
    if (isExcluded(fieldId, meta.name, exclusions)) continue;

    const extracted = extractValue(rawValue, meta.type);

    // Link fields → {linked: [target, ...]} so the UI renders clickable links
    if (meta.classification === 'con' && Array.isArray(extracted)) {
      const linkedTableId = meta.options?.linkedTableId;
      if (linkedTableId) {
        result[fieldId] = {
          linked: extracted.map((recId: string) => recordTarget(baseId, linkedTableId, recId)),
        };
        continue;
      }
    }

    result[fieldId] = extracted;
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

// ─── Deduplication ─────────────────────────────────────────────────────────

function recordEventId(baseId: string, tableId: string, recordId: string, contentKey: string): string {
  return `at-sync:${baseId}:${tableId}:${recordId}:${contentKey}`;
}

// ─── Ingest a single record ────────────────────────────────────────────────

/**
 * Exported alias for the record-ingest helper. Used by the resumable
 * streaming path so it can fold each Airtable page into the EoStore as the
 * page arrives, instead of buffering the whole table into a bundle first.
 *
 * The implementation lives in the `ingestRecord` private below — this is
 * just a re-export so the call surface from outside this module stays
 * narrow and explicit.
 */
export function ingestAirtableRecord(
  store: EoStore,
  baseId: string,
  tableId: string,
  record: AirtableRecord,
  agent: string,
  fieldMeta: Map<string, FieldMeta>,
  exclusions: SyncExclusions = EMPTY_EXCLUSIONS,
  preserveExisting: boolean = false,
  onEvent?: (event: any) => void,
  displayField?: string,
  defaultResolution?: Resolution,
  onChange?: RecordChangeListener,
  tableName?: string,
  nulledFields?: Map<string, Set<string>>,
): Promise<'ingested' | 'overwritten' | 'skipped_no_change' | 'skipped_duplicate'> {
  return ingestRecord(
    store, baseId, tableId, record, agent, fieldMeta, exclusions,
    preserveExisting, onEvent, displayField, defaultResolution, onChange,
    tableName, nulledFields,
  );
}

async function ingestRecord(
  store: EoStore,
  baseId: string,
  tableId: string,
  record: AirtableRecord,
  agent: string,
  fieldMeta: Map<string, FieldMeta>,
  exclusions: SyncExclusions = EMPTY_EXCLUSIONS,
  preserveExisting: boolean = false,
  onEvent?: (event: any) => void,
  displayField?: string,
  defaultResolution?: Resolution,
  onChange?: RecordChangeListener,
  tableName?: string,
  nulledFields?: Map<string, Set<string>>,
): Promise<'ingested' | 'overwritten' | 'skipped_no_change' | 'skipped_duplicate'> {
  const target = recordTarget(baseId, tableId, record.id);

  // 1. Extract only storable fields (skip computed/metadata, normalize values)
  const storableFields = extractStorableFields(record.fields, fieldMeta, exclusions, baseId);

  // 2. Get existing state once — used for INS check, diff, and preserveExisting
  const existing = await getState(store, target);
  const existingFields = existing?.value?.fields;

  // 3. Compute field-level diff — only fields that actually changed
  let diffFields = computeFieldDiff(storableFields, existingFields);

  // 3a. NUL preservation — drop any field the user has explicitly cleared
  //     where the local state still reflects the cleared value. If the user
  //     has since re-set the field locally, `existingFields[key]` will be
  //     non-null and the diff is allowed to proceed normally.
  const nulled = nulledFields?.get(target);
  if (nulled && nulled.size > 0) {
    const filtered: Record<string, any> = {};
    for (const [key, val] of Object.entries(diffFields)) {
      if (nulled.has(key) && (existingFields == null || existingFields[key] == null)) {
        continue;
      }
      filtered[key] = val;
    }
    diffFields = filtered;
  }

  // 3a. Detect overwrite: record already existed AND at least one diff field
  //     was replacing a previously non-null value. This is the count surfaced
  //     in the "N overwritten" UI pill so users can tell destructive changes
  //     apart from first-time ingests.
  let isOverwrite = false;
  if (existing && existingFields) {
    for (const key of Object.keys(diffFields)) {
      const prev = existingFields[key];
      if (prev !== undefined && prev !== null) {
        isOverwrite = true;
        break;
      }
    }
  }

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

  // 7. Explicit INS for new records — entity birth event in the log.
  //    defaultResolution (if set) stamps the import batch's declared stance
  //    onto every record-level INS. DEF events below intentionally stay at
  //    unspecified — the batch stance describes how rows are brought into
  //    existence, not how their individual values are asserted.
  if (!existing) {
    try {
      await processEvent(store, {
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
        ...(defaultResolution ? { resolution: defaultResolution } : {}),
      }, onEvent);
    } catch {
      // Idempotency or concurrent INS — safe to continue to DEF
    }
  }

  // 8. DEF with only the changed fields (not all storable fields)
  try {
    await processEvent(store, {
      op: 'DEF',
      target,
      operand: {
        fields: diffFields,
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

    // 9. Set display name as a separate DEF — ontologically distinct from the data import.
    let recordLabel: string | undefined;
    if (displayField) {
      const nameVal = diffFields[displayField] ?? record.fields[displayField];
      if (nameVal != null) {
        recordLabel = String(nameVal);
        await processEvent(store, {
          op: 'DEF',
          target,
          operand: { name: recordLabel },
          agent: `${agent}:display`,
          ts: new Date().toISOString(),
          acquired_ts: new Date().toISOString(),
          client_event_id: `${clientEventId}:name`,
        }, onEvent);
      }
    }

    // 10. Report the diff for the "Recent changes" UI panel. Resolves field
    //     ids → human-readable names where the schema is available; falls back
    //     to the raw id so we never drop information when fieldMeta is empty.
    if (onChange) {
      try {
        const diffs: Array<{ field: string; before: unknown; after: unknown }> = [];
        for (const [key, after] of Object.entries(diffFields)) {
          const meta = fieldMeta.get(key);
          diffs.push({
            field: meta?.name ?? key,
            before: existingFields ? existingFields[key] : undefined,
            after,
          });
        }
        if (diffs.length > 0) {
          onChange({
            baseId,
            tableId,
            tableName,
            recordId: record.id,
            recordLabel: recordLabel ?? record.id,
            diffs,
            kind: existing ? 'updated' : 'created',
          });
        }
      } catch { /* observer must never break the fold */ }
    }

    return isOverwrite ? 'overwritten' : 'ingested';
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
        fields: t.fields.map(f => ({
          id: f.id, name: f.name, type: f.type,
          ...(f.options ? { options: f.options } : {}),
        })),
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
  baseName: string | undefined,
  tableId: string,
  tableName: string,
  agent: string,
  cursorSince: string | null,
  exclusions: SyncExclusions = EMPTY_EXCLUSIONS,
  preserveExisting: boolean = false,
  onEvent?: (event: any) => void,
  onProgress?: (progress: SyncProgress) => void,
  recordLimit?: number,
  defaultResolution?: Resolution,
  strategy: SyncStrategy = 'lastModified',
  onChange?: RecordChangeListener,
): Promise<SyncResult> {
  let fetched = 0;
  let ingested = 0;
  let overwritten = 0;
  let skippedNoChange = 0;
  let skippedDuplicate = 0;
  const now = new Date().toISOString();
  const limit = recordLimit && recordLimit > 0 ? recordLimit : Infinity;

  const fieldMeta = await getTableFieldMeta(store, baseId, tableId);

  // Retrieve display field so records get a `name` property
  const tableState = await getState(store, tableTarget(baseId, tableId));
  const displayField: string | undefined = tableState?.value?._displayField;

  // Build the per-table NUL preservation index once. Skipped for hydration —
  // an empty/fresh store has no NULs to preserve, and avoiding the log scan
  // keeps initial pulls fast.
  const nulledFields = strategy === 'hydration'
    ? undefined
    : await buildNulledFieldsForTable(store, baseId, tableId);

  // Subtract a 60-second overlap window from the cursor to catch records
  // modified during clock skew or at the tail of the previous sync.
  // Use IS_AFTER+DATETIME_PARSE — the correct Airtable datetime comparison
  // form. Idempotency deduplicates any re-fetched records from the overlap.
  const filterCursor = cursorSince
    ? new Date(new Date(cursorSince).getTime() - 60_000).toISOString()
    : undefined;
  const filterByFormula = filterCursor
    ? `IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE('${filterCursor}'))`
    : undefined;

  const useFieldIds = fieldMeta.size > 0;

  // Build the human-facing endpoint URL so the UI can display exactly which
  // Airtable API request is running right now. This is the same URL Airtable
  // sees — we stringify it here instead of in the client so the progress
  // stream doesn't need to know about the network layer.
  const endpoint = buildAirtableEndpoint(baseId, tableId, { filterByFormula, returnFieldsByFieldId: useFieldIds });

  // Emit a "fetching" progress event with the full request context so the
  // status card can say: "GET <url> — checking changes since <cursor>".
  onProgress?.({
    phase: 'fetching',
    table: tableName,
    tableId,
    base: baseName,
    baseName,
    baseId,
    records_so_far: 0,
    endpoint,
    cursor: filterCursor,
    strategy,
    preserveExisting,
  });

  let limitReached = false;
  for await (const page of client.paginateRecords(baseId, tableId, {
    filterByFormula,
    returnFieldsByFieldId: useFieldIds,
  })) {
    for (const record of page) {
      if (fetched >= limit) { limitReached = true; break; }
      fetched++;
      const result = await ingestRecord(store, baseId, tableId, record, agent, fieldMeta, exclusions, preserveExisting, onEvent, displayField, defaultResolution, onChange, tableName, nulledFields);
      switch (result) {
        case 'ingested': ingested++; break;
        case 'overwritten': ingested++; overwritten++; break;
        case 'skipped_no_change': skippedNoChange++; break;
        case 'skipped_duplicate': skippedDuplicate++; break;
      }
    }
    if (limitReached) break;
    onProgress?.({
      phase: 'syncing',
      table: tableName,
      tableId,
      base: baseName,
      baseName,
      baseId,
      records_so_far: fetched,
      endpoint,
      cursor: filterCursor,
      strategy,
      preserveExisting,
    });
  }

  await setCursor(store, baseId, tableId, now);

  onProgress?.({
    phase: 'table_done',
    table: tableName,
    tableId,
    base: baseName,
    baseName,
    baseId,
    records_so_far: fetched,
    endpoint,
    cursor: filterCursor,
    strategy,
    preserveExisting,
    ingested,
    overwritten,
    skipped: skippedNoChange + skippedDuplicate,
  });

  return {
    base_id: baseId,
    table_id: tableId,
    table_name: tableName,
    records_fetched: fetched,
    records_ingested: ingested,
    records_overwritten: overwritten,
    records_skipped_no_change: skippedNoChange,
    records_skipped_duplicate: skippedDuplicate,
    cursor_before: cursorSince,
    cursor_after: now,
  };
}

/**
 * Build the same URL the AirtableClient will eventually hit — exposed here
 * so progress events can surface "which API are we actually calling" in the
 * UI without having to sniff network requests.
 */
function buildAirtableEndpoint(
  baseId: string,
  tableId: string,
  opts: { filterByFormula?: string; returnFieldsByFieldId?: boolean },
): string {
  const params = new URLSearchParams();
  if (opts.filterByFormula) params.set('filterByFormula', opts.filterByFormula);
  if (opts.returnFieldsByFieldId) params.set('returnFieldsByFieldId', 'true');
  const qs = params.toString();
  const base = `https://api.airtable.com/v0/${baseId}/${tableId}`;
  return qs ? `${base}?${qs}` : base;
}

// ─── Webhook-based incremental sync ────────────────────────────────────────
//
// The Airtable Webhooks Payloads API
// (https://airtable.com/developers/web/api/model/webhooks-payload) is the
// authoritative "what changed" feed for a base. Compared to the legacy
// filterByFormula approach it:
//
//   - Is server-indexed — no full-table scan per poll.
//   - Reports deletes (destroyedRecordIds) — filterByFormula cannot.
//   - Catches edits to computed/linked fields that LAST_MODIFIED_TIME()
//     silently misses.
//   - Uses an integer cursor with exactly-once semantics — no 60-second
//     overlap window hack, no clock-skew foot-guns.
//
// Lifecycle: on first use per base we POST /webhooks to register, persist
// { webhookId, cursor } in the meta store, then GET /payloads?cursor=N on
// every update sync, draining until mightHaveMore=false and advancing the
// cursor. Webhooks expire after 7 days of inactivity; if a poll returns 404
// we wipe the state and trigger a full re-hydration (caller's responsibility).

/**
 * Session-scoped memo of bases we've already failed to register a webhook
 * for with a permanent error (403 / missing scope). Keyed by baseId → Error
 * so subsequent ticks can short-circuit to the LAST_MODIFIED_TIME fallback
 * without hammering the same endpoint every poll — Airtable returns the
 * same 403 every time and it wastes rate budget + churns the Health panel.
 *
 * Scoped to the module so it survives a full page reload only if the tab
 * is kept open — i.e. the user fixing their token and reconnecting (which
 * calls `resetWebhookPermissionCache`) re-enables the webhook path without
 * needing a hard refresh.
 */
const webhookPermissionFailures = new Map<string, AirtableApiError>();

/**
 * Clear the session-scoped 403 cache. Called when credentials change so a
 * user that updates their PAT scopes doesn't have to reload the tab.
 */
export function resetWebhookPermissionCache(): void {
  webhookPermissionFailures.clear();
}

/**
 * Either a ScopeMissingError (403 INVALID_PERMISSIONS — the PAT lacks a
 * scope) or a plain AirtableApiError carrying 403 +
 * INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND against the create endpoint
 * (base isn't on the token's allowlist). Both are permanent for the life
 * of the token; retrying on every tick just wastes an API call.
 */
function isPermanentWebhookPermissionError(err: unknown): err is AirtableApiError {
  if (err instanceof ScopeMissingError) return true;
  return (
    err instanceof AirtableApiError
    && err.status === 403
    && err.airtableErrorType === 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND'
  );
}

/**
 * Register a webhook for this base that watches tableData changes across
 * all tables. Returns the starting cursor the next poll should use.
 */
async function ensureWebhook(
  store: EoStore,
  client: AirtableClient,
  baseId: string,
): Promise<WebhookState> {
  const priorFailure = webhookPermissionFailures.get(baseId);
  if (priorFailure) {
    throw priorFailure;
  }
  const existing = await getWebhookState(store, baseId);
  if (existing) {
    // Verify the webhook still exists upstream; Airtable GCs webhooks after
    // 7 days of inactivity even if we have local state for them.
    try {
      const upstream = await client.listWebhooks(baseId);
      if (upstream.some(w => w.id === existing.webhookId)) return existing;
    } catch {
      // If the listWebhooks call fails (e.g. no webhook:manage scope), fall
      // through and try to create a fresh one — createWebhook will produce
      // a clearer error message in that case.
    }
    // Local state is stale — drop it before re-registering.
    await clearWebhookState(store, baseId);
  }

  let created;
  try {
    created = await client.createWebhook(baseId, {
      options: {
        filters: {
          // tableData covers record-level changes (create, update, delete).
          // tableFields/tableMetadata are deliberately omitted — schema
          // changes are handled by the separate discover + schema-DEF path
          // in updateSync(), so we don't need them duplicated in payloads.
          dataTypes: ['tableData'],
        },
        includes: {
          // We refetch the full record for edits anyway, so don't pay the
          // payload-size cost of including previous values we'll never read.
          includePreviousCellValues: false,
        },
      },
    });
  } catch (e: unknown) {
    if (isPermanentWebhookPermissionError(e)) {
      webhookPermissionFailures.set(baseId, e);
    }
    throw e;
  }
  const state: WebhookState = {
    webhookId: created.id,
    // Airtable may or may not return a cursor on create. When absent the
    // documented starting cursor is 1 — the first payload ever produced.
    cursor: created.cursorForNextPayload ?? 1,
    createdAt: new Date().toISOString(),
  };
  await setWebhookState(store, baseId, state);
  return state;
}

/** Coerce an Airtable webhook cell-values map into the shape ingestRecord expects. */
function cellValuesToRecord(
  recordId: string,
  createdTime: string | undefined,
  cellValuesByFieldId: Record<string, unknown> | undefined,
): AirtableRecord {
  return {
    id: recordId,
    createdTime: createdTime ?? new Date().toISOString(),
    fields: (cellValuesByFieldId ?? {}) as Record<string, any>,
  };
}

/**
 * Drain the webhook payload queue for one base and fold every record change
 * into the EO-DB store. Returns a per-table SyncResult list so the existing
 * UI reporting surface keeps working unchanged.
 *
 * `selectedTableIds` (if provided) filters which tables we fold — changes
 * for other tables are silently skipped. The cursor still advances past them
 * so we don't re-read the same payloads on every poll.
 */
async function webhookIncrementalSyncBase(
  store: EoStore,
  client: AirtableClient,
  baseId: string,
  baseName: string,
  tables: AirtableTable[],
  agent: string,
  selectedTableIds: Set<string> | null,
  preserveExisting: boolean,
  fieldExclusions: Record<string, SyncExclusions> | undefined,
  displayFields: Record<string, string> | undefined,
  defaultResolution: Resolution | undefined,
  onEvent?: (event: any) => void,
  onProgress?: (progress: SyncProgress) => void,
  onChange?: RecordChangeListener,
): Promise<SyncResult[]> {
  const state = await ensureWebhook(store, client, baseId);
  const tableById = new Map(tables.map(t => [t.id, t]));

  // Per-table running counters — we emit one SyncResult per touched table
  // at the end so the existing UI reducers keep working.
  const counters = new Map<string, {
    fetched: number;
    ingested: number;
    overwritten: number;
    skippedNoChange: number;
    skippedDuplicate: number;
    cursorBefore: number;
  }>();

  const bumpCounter = (tableId: string) => {
    let c = counters.get(tableId);
    if (!c) {
      c = { fetched: 0, ingested: 0, overwritten: 0, skippedNoChange: 0, skippedDuplicate: 0, cursorBefore: state.cursor };
      counters.set(tableId, c);
    }
    return c;
  };

  let cursor = state.cursor;
  let mightHaveMore = true;
  let totalPayloads = 0;

  const endpointFor = (c: number) =>
    `https://api.airtable.com/v0/bases/${baseId}/webhooks/${state.webhookId}/payloads?cursor=${c}`;

  onProgress?.({
    phase: 'fetching',
    base: baseName,
    baseName,
    baseId,
    strategy: 'webhook',
    preserveExisting,
    endpoint: endpointFor(cursor),
    cursor: String(cursor),
    records_so_far: 0,
  });

  while (mightHaveMore) {
    let page: Awaited<ReturnType<typeof client.listWebhookPayloads>>;
    try {
      page = await client.listWebhookPayloads(baseId, state.webhookId, { cursor });
    } catch (e: unknown) {
      // 404 means the webhook was GC'd or the cursor is older than the
      // 7-day payload retention window. Either way local state is dead —
      // wipe it so the caller can trigger a full re-hydration.
      if (e instanceof WebhookGoneError) {
        await clearWebhookState(store, baseId);
      }
      throw e;
    }

    for (const payload of page.payloads) {
      totalPayloads++;
      if (!payload.changedTablesById) continue;
      for (const [tableId, change] of Object.entries(payload.changedTablesById)) {
        if (selectedTableIds && !selectedTableIds.has(tableId)) continue;
        const table = tableById.get(tableId);
        if (!table) continue; // Table unknown in this session — skip.

        const counter = bumpCounter(tableId);
        const fieldMeta = buildFieldMetaMap(table.fields);
        const exclusions = fieldExclusions?.[tableId] ?? EMPTY_EXCLUSIONS;
        const displayField = displayFields?.[tableId] ?? table.primaryFieldId;

        // Newly-created records — payload contains every cell value, so we
        // can ingest straight from the payload with no extra API call.
        for (const [recordId, created] of Object.entries(change.createdRecordsById ?? {})) {
          counter.fetched++;
          const rec = cellValuesToRecord(recordId, created.createdTime, created.cellValuesByFieldId);
          const result = await ingestRecord(
            store, baseId, tableId, rec, agent, fieldMeta, exclusions,
            preserveExisting, onEvent, displayField, defaultResolution,
            onChange, table.name,
          );
          switch (result) {
            case 'ingested': counter.ingested++; break;
            case 'overwritten': counter.ingested++; counter.overwritten++; break;
            case 'skipped_no_change': counter.skippedNoChange++; break;
            case 'skipped_duplicate': counter.skippedDuplicate++; break;
          }
        }

        // Edited records — the payload only carries the changed fields, so
        // refetch the full record to ensure ingestRecord sees a complete
        // snapshot (otherwise unchanged fields would look like deletions
        // relative to the existing state when computeFieldDiff runs).
        for (const recordId of Object.keys(change.changedRecordsById ?? {})) {
          counter.fetched++;
          let rec: AirtableRecord;
          try {
            rec = await client.getRecord(baseId, tableId, recordId, { returnFieldsByFieldId: true });
          } catch (e: unknown) {
            // Record was deleted between the payload being queued and our
            // fetch — treat as destroyed, don't fail the whole sync.
            if (e instanceof AirtableApiError && e.status === 404) continue;
            throw e;
          }
          const result = await ingestRecord(
            store, baseId, tableId, rec, agent, fieldMeta, exclusions,
            preserveExisting, onEvent, displayField, defaultResolution,
            onChange, table.name,
          );
          switch (result) {
            case 'ingested': counter.ingested++; break;
            case 'overwritten': counter.ingested++; counter.overwritten++; break;
            case 'skipped_no_change': counter.skippedNoChange++; break;
            case 'skipped_duplicate': counter.skippedDuplicate++; break;
          }
        }

        // Deletes: emit a tombstone marker for every destroyed record id.
        // We use DEF under the hood (see db/tombstone.ts for rationale) so
        // this propagates over Matrix like any other mutation and survives
        // replay via a stable client_event_id. Counted as both fetched
        // (we processed it) and overwritten (we mutated existing state).
        for (const recordId of change.destroyedRecordIds ?? []) {
          counter.fetched++;
          const target = recordTarget(baseId, tableId, recordId);
          const existing = await getState(store, target);
          // Skip targets we never had — destroyed ids for records that
          // never reached this device are a normal consequence of
          // incremental webhook delivery; no need to write a stub.
          if (!existing) continue;
          await markDeleted(store, target, agent, {
            clientEventId: `at-del:${baseId}:${tableId}:${recordId}`,
            source: 'airtable-webhook',
            onEvent,
          });
          counter.ingested++;
          counter.overwritten++;
        }
      }
    }

    cursor = page.cursor;
    mightHaveMore = !!page.mightHaveMore;

    // Persist the advanced cursor after every page so a crash mid-drain
    // doesn't replay payloads we've already folded. Folds are idempotent
    // so a replay is safe, but skipping the work is cheaper.
    await setWebhookState(store, baseId, { ...state, cursor });

    onProgress?.({
      phase: 'syncing',
      base: baseName,
      baseName,
      baseId,
      strategy: 'webhook',
      preserveExisting,
      endpoint: endpointFor(cursor),
      cursor: String(cursor),
      records_so_far: totalPayloads,
    });
  }

  const now = new Date().toISOString();
  const results: SyncResult[] = [];
  for (const [tableId, counter] of counters.entries()) {
    const table = tableById.get(tableId);
    const tableName = table?.name ?? tableId;
    // Keep the legacy per-table timestamp cursor fresh so a subsequent
    // fallback to filterByFormula (or a re-hydration) knows how recent
    // the store already is.
    await setCursor(store, baseId, tableId, now);
    onProgress?.({
      phase: 'table_done',
      base: baseName,
      baseName,
      baseId,
      table: tableName,
      tableId,
      strategy: 'webhook',
      preserveExisting,
      endpoint: endpointFor(cursor),
      cursor: String(cursor),
      records_so_far: counter.fetched,
      ingested: counter.ingested,
      overwritten: counter.overwritten,
      skipped: counter.skippedNoChange + counter.skippedDuplicate,
    });
    results.push({
      base_id: baseId,
      table_id: tableId,
      table_name: tableName,
      records_fetched: counter.fetched,
      records_ingested: counter.ingested,
      records_overwritten: counter.overwritten,
      records_skipped_no_change: counter.skippedNoChange,
      records_skipped_duplicate: counter.skippedDuplicate,
      cursor_before: String(counter.cursorBefore),
      cursor_after: String(cursor),
    });
  }
  return results;
}

/**
 * Best-effort refresh of every known webhook to reset the 7-day expiration
 * timer. Called at the top of updateSync so long-lived installations that
 * only ever poll (never re-register) don't lose their subscription.
 */
async function refreshKnownWebhooks(
  store: EoStore,
  client: AirtableClient,
  baseIds: string[],
): Promise<void> {
  for (const baseId of baseIds) {
    const state = await getWebhookState(store, baseId);
    if (!state) continue;
    try {
      await client.refreshWebhook(baseId, state.webhookId);
    } catch (e: unknown) {
      // 404 → webhook is gone; clear so ensureWebhook re-creates it.
      if (e instanceof WebhookGoneError) await clearWebhookState(store, baseId);
      // Other errors (network blip, rate limit) — ignore; the next poll
      // will surface them if they're persistent.
    }
  }
}

export interface WebhookRegistrationResult {
  baseId: string;
  webhookId?: string;
  cursor?: number;
  /** Error status code / message when registration failed for this base. */
  error?: string;
}

/**
 * Register (or re-use) the Airtable webhook for each base so post-hydration
 * edits are queued as payloads immediately — not on the user's next Update
 * Sync click. Without this, any change made in Airtable between the full
 * pull and the first Update Sync is invisible: Airtable only queues payloads
 * that happen AFTER the webhook exists.
 *
 * Best-effort: a failure on one base (e.g. token lacks `webhooks:manage`)
 * does not stop the others, and never throws. Callers surface the returned
 * error strings in the UI and fall back to the LAST_MODIFIED_TIME path.
 */
export async function registerWebhooksForBases(
  store: EoStore,
  client: AirtableClient,
  baseIds: string[],
): Promise<WebhookRegistrationResult[]> {
  // The Amino gateway intentionally doesn't expose webhook ops — the only
  // change-detection path for those users is op:sync polling. Skip the
  // attempt instead of letting every base log an AminoProxyUnsupportedError.
  if (client.isAminoProxy()) return [];

  const results: WebhookRegistrationResult[] = [];
  const seen = new Set<string>();
  for (const baseId of baseIds) {
    if (seen.has(baseId)) continue;
    seen.add(baseId);
    try {
      const state = await ensureWebhook(store, client, baseId);
      results.push({ baseId, webhookId: state.webhookId, cursor: state.cursor });
    } catch (e: unknown) {
      const status = e instanceof AirtableApiError ? e.status : undefined;
      const message = e instanceof Error ? e.message : String(e);
      results.push({
        baseId,
        error: `${status ?? '?'}: ${message}`,
      });
    }
  }
  return results;
}

// ─── Hydration sync ────────────────────────────────────────────────────────
//
// Bulk imports (hydrations) run in three phases so we always have a
// provenance trail, even if the fold later crashes or is cancelled:
//
//   1. collectAirtableBundle   — fetch every selected record into memory
//                                without touching the store. Produces a
//                                RawImportBundle that is safe to serialize
//                                and upload as-is.
//   2. onRawImport (optional)  — caller persists the bundle (e.g. encrypted
//                                upload to Drive) and returns a
//                                ProvenanceResult referencing the blob.
//   3. processHydrationBundle  — emits schema DEFs, an import record linked
//                                to the provenance blob, and folds every
//                                pre-fetched record.
//
// hydrationSync() below wires all three together for callers that want the
// one-shot behaviour; services that need more control (e.g. rewriting the
// on-Drive .eodb log after processing) can call the phases directly.

/** Mint a short, URL-safe id for a new import. */
function generateImportId(): string {
  // Crypto.randomUUID is available in all modern browsers + Workers.
  try {
    const id = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
    if (id) return id;
  } catch { /* fall through */ }
  // Fallback: timestamp + random suffix
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Phase 1 — discover the schema and pre-fetch every record from every
 * selected table into a single in-memory bundle. Does NOT touch the store.
 *
 * Memory footprint: a typical Airtable record is ~1-5 KB of JSON, so 3 000
 * records ≈ 3-15 MB — well within browser limits for bulk imports. Tables
 * with very large attachment fields should be excluded via customization.
 */
export async function collectAirtableBundle(
  client: AirtableClient,
  opts?: {
    customization?: SyncCustomization;
    onProgress?: (progress: SyncProgress) => void;
  },
): Promise<RawImportBundle> {
  const selectedTables = opts?.customization?.selectedTables;
  const recordLimit = opts?.customization?.recordLimit;

  opts?.onProgress?.({ phase: 'discovering' });
  const manifest = await discoverSchema(client);

  const bundle: RawImportBundle = {
    source: 'airtable',
    importId: generateImportId(),
    collectedAt: new Date().toISOString(),
    manifest,
    tables: [],
  };

  const limit = recordLimit && recordLimit > 0 ? recordLimit : Infinity;

  for (const base of manifest.bases) {
    const baseTables = selectedTables?.[base.id];
    if (selectedTables && !baseTables?.length) continue;

    for (const table of base.tables) {
      if (baseTables && !baseTables.includes(table.id)) continue;
      if (!tableHasLastModifiedField(table)) {
        opts?.onProgress?.({
          phase: 'collecting',
          base: base.name,
          table: table.name,
          records_so_far: 0,
          skipReason: 'no_last_modified_field',
        });
        continue;
      }

      // Use field-id encoding whenever the schema gives us field ids; this
      // keeps us resilient to field renames between collection and ingestion.
      const useFieldIds = table.fields.length > 0;

      opts?.onProgress?.({
        phase: 'collecting', base: base.name, table: table.name, records_so_far: 0,
      });

      const records: AirtableRecord[] = [];
      let reachedLimit = false;
      try {
        for await (const page of client.paginateRecords(base.id, table.id, {
          returnFieldsByFieldId: useFieldIds,
        })) {
          for (const record of page) {
            if (records.length >= limit) { reachedLimit = true; break; }
            records.push(record);
          }
          opts?.onProgress?.({
            phase: 'collecting', base: base.name, table: table.name, records_so_far: records.length,
          });
          if (reachedLimit) break;
        }
      } catch (e) {
        if (e instanceof NoLastModifiedFieldError) {
          opts?.onProgress?.({
            phase: 'collecting',
            base: base.name,
            table: table.name,
            records_so_far: 0,
            skipReason: 'no_last_modified_field',
          });
          continue;
        }
        throw e;
      }

      bundle.tables.push({
        baseId: base.id,
        baseName: base.name,
        tableId: table.id,
        tableName: table.name,
        useFieldIds,
        records,
      });
    }
  }

  return bundle;
}

// ─── Streaming hydration helpers ──────────────────────────────────────────
//
// These are the primitives the resumable hydration path uses to fold each
// Airtable page into the EoStore as it arrives, instead of buffering the
// whole table into a bundle first. They share their behaviour with the
// inline implementation inside `processHydrationBundle` below — both paths
// emit identical events (same `client_event_id` shape), so re-folding a
// table that streamed mid-run is a no-op when Phase B falls back to the
// bundle.

/**
 * Manifest table type with the fields needed to emit a hydration schema.
 * Mirrors what `discoverSchema` produces on the manifest.
 */
export interface HydrationTableSchema {
  id: string;
  name: string;
  primaryFieldId?: string;
  fieldCount: number;
  fields: Array<{ id: string; name: string; type: string; options?: Record<string, any> }>;
}

/**
 * Idempotently emit base + table + per-field schema events for a hydration
 * target. Safe to call repeatedly across resumes (every event uses a
 * content-aware `client_event_id` and the dedup layer treats duplicates as
 * no-ops).
 */
export async function emitHydrationSchema(
  store: EoStore,
  base: { id: string; name: string },
  table: HydrationTableSchema,
  agent: string,
  displayFieldOverride: string | undefined,
  onEvent?: (event: any) => void,
): Promise<void> {
  // Base container.
  try {
    await processEvent(store, {
      op: 'DEF',
      target: baseTarget(base.id),
      operand: { name: base.name, _airtable: { type: 'base', base_id: base.id } },
      agent,
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
      client_event_id: `at-base:${base.id}`,
    }, onEvent);
  } catch { /* idempotent */ }

  // Table container with schema.
  try {
    await processEvent(store, {
      op: 'DEF',
      target: tableTarget(base.id, table.id),
      operand: {
        name: table.name,
        field_count: table.fieldCount,
        fields: table.fields,
        _displayField: displayFieldOverride || table.primaryFieldId || undefined,
        _airtable: { type: 'table', base_id: base.id, table_id: table.id },
      },
      agent,
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
      client_event_id: `at-table:${base.id}:${table.id}`,
    }, onEvent);
  } catch { /* idempotent */ }

  // Per-field schema entities under _schema container.
  const schemaTarget = `${tableTarget(base.id, table.id)}._schema`;
  try {
    await processEvent(store, {
      op: 'INS',
      target: schemaTarget,
      operand: { _airtable: { type: 'schema', base_id: base.id, table_id: table.id } },
      agent,
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
      client_event_id: `at-ins-schema:${base.id}:${table.id}`,
    }, onEvent);
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
      }, onEvent);
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
      }, onEvent);
    } catch { /* idempotent */ }

    // Mapped EO-DB column type. multipleRecordLinks also stores the linked
    // table's EO target so consumers can resolve relationships without
    // re-querying Airtable.
    const mapped = mapAirtableTypeOrNull(field.type);
    const eoType = mapped ?? 'text';
    const typeOperand: Record<string, unknown> = { type: eoType };
    if (mapped === null) typeOperand.unknownAirtableType = field.type;
    if (field.type === 'multipleRecordLinks' && field.options?.linkedTableId) {
      typeOperand.linkedTable = tableTarget(base.id, field.options.linkedTableId as string);
    }
    try {
      await processEvent(store, {
        op: 'DEF',
        target: `${fieldTarget}.type`,
        operand: typeOperand,
        agent,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
        client_event_id: `at-field-type:${base.id}:${table.id}:${field.id}`,
      }, onEvent);
    } catch { /* idempotent */ }

    await emitFieldConstraints(store, fieldTarget, field, agent, base.id, table.id, onEvent);
  }
}

/**
 * Per-table context the streaming fold loop needs. Build once after the
 * schema has been emitted; reuse for every page. Mirrors the inline
 * derivation that `processHydrationBundle` does at lines ~1744-1746.
 */
export interface HydrationTableContext {
  fieldMeta: Map<string, FieldMeta>;
  displayField: string | undefined;
  exclusions: SyncExclusions;
  /** undefined for hydration mode — empty stores have nothing to preserve. */
  nulledFields: Map<string, Set<string>> | undefined;
}

export async function buildHydrationContext(
  store: EoStore,
  baseId: string,
  tableId: string,
  exclusions: SyncExclusions = EMPTY_EXCLUSIONS,
): Promise<HydrationTableContext> {
  const fieldMeta = await getTableFieldMeta(store, baseId, tableId);
  const tableState = await getState(store, tableTarget(baseId, tableId));
  const displayField: string | undefined = tableState?.value?._displayField;
  return { fieldMeta, displayField, exclusions, nulledFields: undefined };
}

/** Counts returned per page so the caller can drive its progress UI. */
export interface PageFoldResult {
  ingested: number;
  overwritten: number;
  skippedNoChange: number;
  skippedDuplicate: number;
}

/**
 * Fold a single page of Airtable records into the store. The caller is
 * expected to have already emitted the table's schema (via
 * `emitHydrationSchema`) and built a context (via `buildHydrationContext`).
 */
export async function ingestRecordPageStreaming(
  store: EoStore,
  baseId: string,
  tableId: string,
  ctx: HydrationTableContext,
  records: AirtableRecord[],
  agent: string,
  opts?: {
    preserveExisting?: boolean;
    defaultResolution?: Resolution;
    onEvent?: (event: any) => void;
    onChange?: RecordChangeListener;
    tableName?: string;
  },
): Promise<PageFoldResult> {
  let ingested = 0;
  let overwritten = 0;
  let skippedNoChange = 0;
  let skippedDuplicate = 0;
  for (const record of records) {
    const r = await ingestRecord(
      store, baseId, tableId, record, agent, ctx.fieldMeta,
      ctx.exclusions, opts?.preserveExisting ?? false,
      opts?.onEvent, ctx.displayField, opts?.defaultResolution,
      opts?.onChange, opts?.tableName, ctx.nulledFields,
    );
    switch (r) {
      case 'ingested': ingested++; break;
      case 'overwritten': ingested++; overwritten++; break;
      case 'skipped_no_change': skippedNoChange++; break;
      case 'skipped_duplicate': skippedDuplicate++; break;
    }
  }
  return { ingested, overwritten, skippedNoChange, skippedDuplicate };
}

/**
 * Write the per-table cursor that gates incremental polling. Called after
 * the streaming fold finishes the last page of a table, so subsequent
 * `updateSync` calls only pull rows modified after this point.
 */
export async function writeTableHydrationCursor(
  store: EoStore,
  baseId: string,
  tableId: string,
  cursor?: string,
): Promise<string> {
  const value = cursor ?? new Date().toISOString();
  await setCursor(store, baseId, tableId, value);
  return value;
}

/**
 * Phase 3 — process a pre-collected bundle against the store: emit the
 * import record (linked to provenance), emit schema DEFs, and fold every
 * record. Pre-fetching separates the network + memory cost from the store
 * write path so the provenance hook can run in between.
 */
export async function processHydrationBundle(
  store: EoStore,
  bundle: RawImportBundle,
  agent: string,
  opts?: {
    onProgress?: (progress: SyncProgress) => void;
    onEvent?: (event: any) => void;
    onTableComplete?: (result: SyncResult) => void;
    customization?: SyncCustomization;
    /**
     * If present, the bundle's raw bytes were already persisted elsewhere
     * (e.g. uploaded to Drive) and we should emit an `import.airtable.<id>`
     * record linking to that blob so users can trace / re-download it.
     */
    provenance?: ProvenanceResult;
  },
): Promise<HydrationResult> {
  const start = Date.now();
  const preserveExisting = opts?.customization?.preserveExisting ?? false;
  const fieldExclusions = opts?.customization?.fieldExclusions;
  const displayFields = opts?.customization?.displayFields;
  const defaultResolution = opts?.customization?.defaultResolution;
  const syncResults: SyncResult[] = [];

  // ── Emit an import record linking to the provenance blob ────────────────
  // This lives under target `import.airtable.<importId>` and captures enough
  // metadata to (a) find the blob in Drive, (b) show the user what was
  // imported, and (c) invalidate/download it later. Written FIRST so the
  // blob is findable even if the subsequent fold partially fails.
  if (opts?.provenance) {
    const totalRecords = bundle.tables.reduce((s, t) => s + t.records.length, 0);
    const importTarget = `import.airtable.${bundle.importId}`;
    try {
      await processEvent(store, {
        op: 'INS',
        target: importTarget,
        operand: { _airtable: { type: 'import', import_id: bundle.importId } },
        agent,
        ts: bundle.collectedAt,
        acquired_ts: bundle.collectedAt,
        client_event_id: `at-import-ins:${bundle.importId}`,
      }, opts?.onEvent);
    } catch { /* idempotent */ }
    try {
      await processEvent(store, {
        op: 'DEF',
        target: importTarget,
        operand: {
          source: 'airtable',
          import_id: bundle.importId,
          provenance_file: opts.provenance.fileName,
          provenance_drive_id: opts.provenance.driveFileId,
          provenance_byte_size: opts.provenance.byteSize,
          record_count: totalRecords,
          table_count: bundle.tables.length,
          collected_at: bundle.collectedAt,
          tables: bundle.tables.map(t => ({
            base_id: t.baseId,
            base_name: t.baseName,
            table_id: t.tableId,
            table_name: t.tableName,
            record_count: t.records.length,
          })),
          _airtable: { type: 'import', import_id: bundle.importId },
        },
        agent,
        ts: bundle.collectedAt,
        acquired_ts: bundle.collectedAt,
        client_event_id: `at-import-def:${bundle.importId}`,
      }, opts?.onEvent);
    } catch { /* idempotent */ }
  }

  // ── Emit schema + ingest records per table ──────────────────────────────
  const emittedBases = new Set<string>();

  for (const tableBundle of bundle.tables) {
    const base = bundle.manifest.bases.find(b => b.id === tableBundle.baseId);
    if (!base) continue;
    const table = base.tables.find(t => t.id === tableBundle.tableId);
    if (!table) continue;

    // Register base container (once per base)
    if (!emittedBases.has(base.id)) {
      emittedBases.add(base.id);
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
    }

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
        await processEvent(store, {
          op: 'DEF',
          target: `${fieldTarget}.type`,
          operand: typeOperand,
          agent,
          ts: new Date().toISOString(),
          acquired_ts: new Date().toISOString(),
          client_event_id: `at-field-type:${base.id}:${table.id}:${field.id}`,
        }, opts?.onEvent);
      } catch { /* idempotent */ }

      // Emit constraint DEFs from Airtable field options
      await emitFieldConstraints(store, fieldTarget, field, agent, base.id, table.id, opts?.onEvent);
    }

    opts?.onProgress?.({
      phase: 'folding',
      base: base.name,
      baseName: base.name,
      baseId: base.id,
      table: table.name,
      tableId: table.id,
      strategy: 'hydration',
      preserveExisting,
    });

    const exclusions = fieldExclusions?.[table.id] ?? EMPTY_EXCLUSIONS;
    const now = new Date().toISOString();

    // Ingest the pre-fetched records for this table. fieldMeta is read from
    // the store AFTER the schema DEFs above were applied, so it reflects the
    // types we just emitted.
    const fieldMeta = await getTableFieldMeta(store, base.id, table.id);
    const tableState = await getState(store, tableTarget(base.id, table.id));
    const displayField: string | undefined = tableState?.value?._displayField;

    let ingested = 0;
    let overwritten = 0;
    let skippedNoChange = 0;
    let skippedDuplicate = 0;
    for (let i = 0; i < tableBundle.records.length; i++) {
      const record = tableBundle.records[i];
      const r = await ingestRecord(
        store, base.id, table.id, record, agent, fieldMeta,
        exclusions, preserveExisting, opts?.onEvent, displayField,
        defaultResolution,
      );
      switch (r) {
        case 'ingested': ingested++; break;
        case 'overwritten': ingested++; overwritten++; break;
        case 'skipped_no_change': skippedNoChange++; break;
        case 'skipped_duplicate': skippedDuplicate++; break;
      }
      if ((i + 1) % 50 === 0 || i === tableBundle.records.length - 1) {
        opts?.onProgress?.({
          phase: 'syncing',
          base: base.name,
          baseName: base.name,
          baseId: base.id,
          table: table.name,
          tableId: table.id,
          records_so_far: i + 1,
          strategy: 'hydration',
          preserveExisting,
        });
      }
    }

    await setCursor(store, base.id, table.id, now);

    opts?.onProgress?.({
      phase: 'table_done',
      base: base.name,
      baseName: base.name,
      baseId: base.id,
      table: table.name,
      tableId: table.id,
      records_so_far: tableBundle.records.length,
      strategy: 'hydration',
      preserveExisting,
      ingested,
      overwritten,
      skipped: skippedNoChange + skippedDuplicate,
    });

    const result: SyncResult = {
      base_id: base.id,
      table_id: table.id,
      table_name: table.name,
      records_fetched: tableBundle.records.length,
      records_ingested: ingested,
      records_overwritten: overwritten,
      records_skipped_no_change: skippedNoChange,
      records_skipped_duplicate: skippedDuplicate,
      cursor_before: null,
      cursor_after: now,
    };
    syncResults.push(result);
    opts?.onTableComplete?.(result);
  }

  const totalIngested = syncResults.reduce((s, r) => s + r.records_ingested, 0);
  const totalOverwritten = syncResults.reduce((s, r) => s + r.records_overwritten, 0);
  const totalSkipped = syncResults.reduce(
    (s, r) => s + r.records_skipped_no_change + r.records_skipped_duplicate, 0,
  );

  return {
    manifest: bundle.manifest,
    sync_results: syncResults,
    total_records_ingested: totalIngested,
    total_records_overwritten: totalOverwritten,
    total_records_skipped: totalSkipped,
    duration_ms: Date.now() - start,
  };
}

/**
 * Payload handed to {@link hydrationSync} callers via `onSnapshotReady`.
 * Contains everything needed to persist a one-shot hydration as an `.eodb`
 * snapshot that future devices can replay instead of re-pulling the full
 * base from Airtable.
 *
 * Events are the ordered stream that `processHydrationBundle()` folded into
 * the store — replaying them on a fresh device reproduces the same state.
 * Cursors reflect the per-table lastModified watermarks captured at the end
 * of the run; seeding them on the replaying device means the first live
 * `updateSync()` only pulls post-snapshot deltas.
 */
export interface HydrationSnapshotPayload {
  /** Every event emitted by the fold, in order. */
  events: any[];
  /** `{ [baseId]: { [tableId]: { lastModified } } }` — safe to embed in the snapshot header. */
  cursors: Record<string, Record<string, { lastModified: string }>>;
  /** Bases touched by this hydration — used to derive per-base snapshot filenames. */
  baseIds: string[];
  /** Mirrors the top-level HydrationResult so callers can correlate snapshot metadata with sync stats. */
  result: HydrationResult;
}

/**
 * One-shot hydration: collect everything, optionally hand the raw bundle
 * to `onRawImport` for provenance persistence, then process into operators.
 *
 * Throwing from onRawImport aborts the sync before ANY store mutations —
 * ideal for enforcing "don't process until Drive upload confirms".
 *
 * When `onSnapshotReady` is supplied, hydrationSync captures every emitted
 * event and the final per-table cursors, then invokes the callback after
 * the fold completes. The caller is expected to serialise the payload via
 * `encodeAirtableSnapshot()` and persist the result (typically to Drive).
 * The callback fires AFTER the store write, so a failing upload doesn't
 * roll back the local hydration — snapshot publishing is an optimisation,
 * not a correctness requirement.
 */
export async function hydrationSync(
  store: EoStore,
  client: AirtableClient,
  agent: string,
  opts?: {
    onProgress?: (progress: SyncProgress) => void;
    onEvent?: (event: any) => void;
    onTableComplete?: (result: SyncResult) => void;
    customization?: SyncCustomization;
    /**
     * Fires after raw records are collected but BEFORE any store write.
     * Return a ProvenanceResult to link the uploaded blob to an import
     * record in the event log. Throw to abort the hydration.
     */
    onRawImport?: (bundle: RawImportBundle) => Promise<ProvenanceResult | void>;
    /**
     * Fires AFTER the full hydration completes successfully. Receives the
     * captured event stream + cursor map — the caller bakes these into an
     * `.eodb` snapshot and publishes it (e.g. to Google Drive).
     */
    onSnapshotReady?: (payload: HydrationSnapshotPayload) => Promise<void> | void;
  },
): Promise<HydrationResult> {
  const bundle = await collectAirtableBundle(client, {
    customization: opts?.customization,
    onProgress: opts?.onProgress,
  });

  let provenance: ProvenanceResult | undefined;
  if (opts?.onRawImport) {
    const result = await opts.onRawImport(bundle);
    if (result) provenance = result;
  }

  // Tee onEvent so we can both forward to the caller AND collect the full
  // stream for snapshot publishing. Zero allocation when onSnapshotReady
  // is unset — we keep the original callback reference.
  const collected: any[] = [];
  const wantSnapshot = !!opts?.onSnapshotReady;
  const teeEvent = wantSnapshot
    ? (ev: any) => {
        collected.push(ev);
        opts?.onEvent?.(ev);
      }
    : opts?.onEvent;

  const result = await processHydrationBundle(store, bundle, agent, {
    onProgress: opts?.onProgress,
    onEvent: teeEvent,
    onTableComplete: opts?.onTableComplete,
    customization: opts?.customization,
    provenance,
  });

  // Register the Airtable webhook for every hydrated base now, not on the
  // first updateSync. Without this, any edit the user makes in Airtable
  // between hydration and their first Update Sync click is silently dropped:
  // Airtable only queues payloads generated after the webhook exists.
  //
  // Best-effort — a token without `webhooks:manage` scope will fall back to
  // the LAST_MODIFIED_TIME path on the next updateSync, exactly as before.
  const hydratedBaseIds = Array.from(
    new Set(result.sync_results.map(r => r.base_id)),
  );
  if (hydratedBaseIds.length) {
    const webhookResults = await registerWebhooksForBases(store, client, hydratedBaseIds);
    for (const r of webhookResults) {
      if (r.error) {
        // eslint-disable-next-line no-console
        console.warn(
          `[airtable-sync] could not register webhook for base ${r.baseId} at hydration: ${r.error}. ` +
          `Update sync will fall back to LAST_MODIFIED_TIME until this is resolved.`,
        );
      }
    }
  }

  if (wantSnapshot) {
    // Build the cursor map by reading back the per-table cursors we just
    // wrote during fold. Using the store (not the result) guarantees we
    // capture the exact ISO string that the next updateSync() will compare
    // against — no drift from recomputing `now` at publish time.
    const cursors: Record<string, Record<string, { lastModified: string }>> = {};
    const baseIds = new Set<string>();
    for (const r of result.sync_results) {
      baseIds.add(r.base_id);
      const stored = await getCursor(store, r.base_id, r.table_id);
      if (stored) {
        (cursors[r.base_id] ??= {})[r.table_id] = { lastModified: stored };
      }
    }
    try {
      await opts!.onSnapshotReady!({
        events: collected,
        cursors,
        baseIds: Array.from(baseIds),
        result,
      });
    } catch (e) {
      // Snapshot publish is best-effort. Log and continue — the hydration
      // itself succeeded and the next run will retry.
      console.warn('[EO-DB] onSnapshotReady failed (hydration unaffected):', e);
    }
  }

  return result;
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
    /**
     * Fires every time `ingestRecord` actually changes a record's stored
     * fields (skip-no-change records do NOT fire). Surfaced to the UI's
     * "Recent changes" panel.
     */
    onChange?: RecordChangeListener;
    /**
     * Fires after each successful per-table poll with the new cursor value
     * (the same value `setCursor` just wrote to IndexedDB). Used by the
     * service to mirror cursors into Matrix room state so a leader handoff
     * to a different device picks up where the previous leader left off.
     */
    onCursorAdvance?: (baseId: string, tableId: string, cursor: string) => Promise<void>;
  },
): Promise<UpdateSyncResult> {
  const start = Date.now();
  const preserveExisting = opts?.customization?.preserveExisting ?? false;
  const selectedTables = opts?.customization?.selectedTables;
  const fieldExclusions = opts?.customization?.fieldExclusions;
  const recordLimit = opts?.customization?.recordLimit;
  const defaultResolution = opts?.customization?.defaultResolution;
  const displayFields = opts?.customization?.displayFields;
  const syncResults: SyncResult[] = [];

  opts?.onProgress?.({ phase: 'discovering' });
  const bases = await client.listBases();

  for (const base of bases) {
    // If table selection exists but this base has no selected tables, skip
    const baseTables = selectedTables?.[base.id];
    if (selectedTables && !baseTables?.length) continue;

    const tables = await client.getBaseSchema(base.id);

    // Refresh base container name (captures renames and repairs missing state).
    // Uses a content-aware client_event_id so renames emit a new DEF while
    // unchanged names stay idempotent.
    const existingBaseState = await getState(store, baseTarget(base.id));
    if (existingBaseState?.value?.name !== base.name) {
      try {
        await processEvent(store, {
          op: 'DEF',
          target: baseTarget(base.id),
          operand: { name: base.name, _airtable: { type: 'base', base_id: base.id } },
          agent,
          ts: new Date().toISOString(),
          acquired_ts: new Date().toISOString(),
          client_event_id: `at-base-upd:${base.id}:${base.name}`,
        }, opts?.onEvent);
      } catch { /* idempotent */ }
    }

    for (const table of tables) {
      // Skip tables not in the selection
      if (baseTables && !baseTables.includes(table.id)) continue;

      const cursor = await getCursor(store, base.id, table.id);
      if (!cursor) continue; // Not hydrated yet — skip

      // Refresh table container name (captures renames and repairs missing state).
      // Content-aware client_event_id lets renames through while keeping the
      // steady-state fold idempotent.
      const existingTableState = await getState(store, tableTarget(base.id, table.id));
      if (existingTableState?.value?.name !== table.name) {
        try {
          await processEvent(store, {
            op: 'DEF',
            target: tableTarget(base.id, table.id),
            operand: {
              name: table.name,
              field_count: table.fields.length,
              fields: table.fields,
              _airtable: { type: 'table', base_id: base.id, table_id: table.id },
            },
            agent,
            ts: new Date().toISOString(),
            acquired_ts: new Date().toISOString(),
            client_event_id: `at-table-upd:${base.id}:${table.id}:${table.name}`,
          }, opts?.onEvent);
        } catch { /* idempotent */ }
      }

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

        // Emit .type DEF with mapped EO-DB column type
        const mapped = mapAirtableTypeOrNull(field.type);
        const eoType = mapped ?? 'text';
        const updTypeOperand: Record<string, unknown> = { type: eoType };
        if (mapped === null) updTypeOperand.unknownAirtableType = field.type;
        try {
          await processEvent(store, {
            op: 'DEF',
            target: `${fieldTarget}.type`,
            operand: updTypeOperand,
            agent,
            ts: new Date().toISOString(),
            acquired_ts: new Date().toISOString(),
            client_event_id: `at-field-type-upd:${base.id}:${table.id}:${field.id}`,
          }, opts?.onEvent);
        } catch { /* idempotent */ }

        // Emit constraint DEFs from Airtable field options
        await emitFieldConstraints(store, fieldTarget, field, agent, base.id, table.id, opts?.onEvent);
      }

      // Schema-only iteration body ends here. Record ingestion for this
      // base is driven below by the webhook-payloads path (with
      // filterByFormula as a documented fallback), not by a per-table
      // loop. Table-local variables only used by the removed syncTable
      // call are intentionally scoped inside this `for (const table)`
      // block so they don't bleed into the base-wide sync step.
      void cursor;
    }

    // ── Record ingestion for this base ──────────────────────────────────
    //
    // Preferred path: drain the Airtable Webhooks payload queue. This is
    // the authoritative "what changed" feed — no LAST_MODIFIED_TIME()
    // table scan, no clock-skew overlap window, catches computed-field
    // edits and deletes too.
    //
    // Fallback path: if the webhook can't be created (e.g. the access
    // token lacks `webhooks:manage`) we fall back to the legacy
    // per-table filterByFormula(IS_AFTER(LAST_MODIFIED_TIME(), ...))
    // sync so the app still works on read-only tokens.
    //
    // Only tables with an existing cursor are eligible — if a table was
    // never hydrated we must not fold sparse change events into a store
    // that has no baseline. The initial hydrationSync path handles those.
    const hydratedTableIds = new Set<string>();
    for (const table of tables) {
      if (baseTables && !baseTables.includes(table.id)) continue;
      const c = await getCursor(store, base.id, table.id);
      if (c) hydratedTableIds.add(table.id);
    }
    if (!hydratedTableIds.size) continue;
    {
      // Polling-only sync. The webhook subscription path was removed in
      // favour of a strict per-table LAST_MODIFIED_TIME filter — see
      // commit message for the rationale (one-leader, sequential, 10s gap,
      // diff-before-emit with NUL preservation).
      //
      // Build the eligible-table list up front so the inter-table sleep only
      // runs between tables we'll actually poll (skipped tables don't burn
      // 10s of wall clock).
      const tablesToSync = tables.filter((t) => {
        if (baseTables && !baseTables.includes(t.id)) return false;
        if (!hydratedTableIds.has(t.id)) return false;
        if (!tableHasLastModifiedField(t)) {
          opts?.onProgress?.({
            phase: 'syncing',
            base: base.name,
            baseName: base.name,
            baseId: base.id,
            table: t.name,
            tableId: t.id,
            strategy: 'lastModified',
            preserveExisting,
            skipReason: 'no_last_modified_field',
          });
          return false;
        }
        return true;
      });
      for (let i = 0; i < tablesToSync.length; i++) {
        const table = tablesToSync[i];
        const cursor = await getCursor(store, base.id, table.id);
        if (!cursor) continue;
        const exclusions = fieldExclusions?.[table.id] ?? EMPTY_EXCLUSIONS;
        opts?.onProgress?.({
          phase: 'syncing',
          base: base.name,
          baseName: base.name,
          baseId: base.id,
          table: table.name,
          tableId: table.id,
          strategy: 'lastModified',
          preserveExisting,
          cursor,
        });
        let result: SyncResult;
        try {
          result = await syncTable(
            store, client, base.id, base.name, table.id, table.name, agent, cursor,
            exclusions, preserveExisting,
            opts?.onEvent, opts?.onProgress, recordLimit,
            defaultResolution,
            'lastModified',
            opts?.onChange,
          );
        } catch (e) {
          if (e instanceof NoLastModifiedFieldError) {
            opts?.onProgress?.({
              phase: 'syncing',
              base: base.name,
              baseName: base.name,
              baseId: base.id,
              table: table.name,
              tableId: table.id,
              strategy: 'lastModified',
              preserveExisting,
              skipReason: 'no_last_modified_field',
            });
            continue;
          }
          throw e;
        }
        syncResults.push(result);
        opts?.onTableComplete?.(result);

        // Mirror the freshly-advanced cursor to Matrix room state so a
        // leader handoff doesn't restart from a stale position. Read-back
        // (vs reusing `cursor` above — which is the PRE-poll value) lets us
        // emit whatever syncTable actually wrote, including any internal
        // bumping of the value beyond `now`.
        if (opts?.onCursorAdvance) {
          const advanced = await getCursor(store, base.id, table.id);
          if (advanced) {
            try {
              await opts.onCursorAdvance(base.id, table.id, advanced);
            } catch (e) {
              // Best-effort: a state-event write failure shouldn't abort the
              // whole sync cycle. The next leader will re-derive from
              // IndexedDB until the next successful mirror.
              console.warn(
                `[airtable-sync] cursor mirror failed for ${base.id}/${table.id}:`,
                e,
              );
            }
          }
        }

        // Strict sequential polling: 10s gap between tables (not after the
        // last one) so a leader doing the rounds across a base doesn't burst
        // through the rate limiter and so a non-trivial number of tables
        // doesn't monopolize the bucket.
        if (i < tablesToSync.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, INTER_TABLE_POLL_GAP_MS));
        }
      }
    }
  }

  const totalIngested = syncResults.reduce((s, r) => s + r.records_ingested, 0);
  const totalOverwritten = syncResults.reduce((s, r) => s + r.records_overwritten, 0);
  const totalSkipped = syncResults.reduce(
    (s, r) => s + r.records_skipped_no_change + r.records_skipped_duplicate, 0,
  );

  return {
    sync_results: syncResults,
    total_records_ingested: totalIngested,
    total_records_overwritten: totalOverwritten,
    total_records_skipped: totalSkipped,
    duration_ms: Date.now() - start,
  };
}

// ─── Smart sync ────────────────────────────────────────────────────────────
//
// Per-table routing: hydrate tables with no cursor, incremental-update the
// rest. Solves two long-standing rough edges:
//   1. A newly-selected table after the initial hydration sat blank forever,
//      because `updateSync` skips never-hydrated tables (no cursor → nothing
//      to compare LAST_MODIFIED_TIME() against).
//   2. Continuous-tick's global "needsHydration" check (any cursor anywhere
//      → incremental) re-pulled nothing for the new table.
//
// Implementation is intentionally thin: split the selection into two sets by
// cursor presence and dispatch each to the existing hydrationSync /
// updateSync. No new fold path, no new persistence — just better routing.

export async function smartSync(
  store: EoStore,
  client: AirtableClient,
  agent: string,
  opts?: {
    onProgress?: (progress: SyncProgress) => void;
    onEvent?: (event: any) => void;
    onTableComplete?: (result: SyncResult) => void;
    customization?: SyncCustomization;
    onChange?: RecordChangeListener;
    onCursorAdvance?: (baseId: string, tableId: string, cursor: string) => Promise<void>;
  },
): Promise<UpdateSyncResult> {
  const start = Date.now();
  const userSelection = opts?.customization?.selectedTables;

  // Determine the universe of (base, table) pairs to consider. When the
  // caller passes selectedTables we trust it; when not, ask Airtable so we
  // can still split correctly. The schema fetch is cheap (one call per base)
  // and matches what updateSync would do anyway.
  let universe: Record<string, string[]>;
  if (userSelection && Object.keys(userSelection).length > 0) {
    universe = userSelection;
  } else {
    universe = {};
    const bases = await client.listBases();
    for (const base of bases) {
      const tables = await client.getBaseSchema(base.id);
      universe[base.id] = tables.map((t) => t.id);
    }
  }

  const synced = await getSyncedTableIds(store);
  const toHydrate: Record<string, string[]> = {};
  const toUpdate: Record<string, string[]> = {};
  for (const [baseId, tableIds] of Object.entries(universe)) {
    const cursored = new Set(synced[baseId] ?? []);
    const hyd: string[] = [];
    const upd: string[] = [];
    for (const tid of tableIds) {
      if (cursored.has(tid)) upd.push(tid);
      else hyd.push(tid);
    }
    if (hyd.length) toHydrate[baseId] = hyd;
    if (upd.length) toUpdate[baseId] = upd;
  }

  const allResults: SyncResult[] = [];

  if (Object.keys(toHydrate).length > 0) {
    const hydResult = await hydrationSync(store, client, agent, {
      onProgress: opts?.onProgress,
      onEvent: opts?.onEvent,
      onTableComplete: opts?.onTableComplete,
      customization: { ...opts?.customization, selectedTables: toHydrate },
    });
    allResults.push(...hydResult.sync_results);
  }

  if (Object.keys(toUpdate).length > 0) {
    const updResult = await updateSync(store, client, agent, {
      onProgress: opts?.onProgress,
      onEvent: opts?.onEvent,
      onTableComplete: opts?.onTableComplete,
      onChange: opts?.onChange,
      onCursorAdvance: opts?.onCursorAdvance,
      customization: { ...opts?.customization, selectedTables: toUpdate },
    });
    allResults.push(...updResult.sync_results);
  }

  const totalIngested = allResults.reduce((s, r) => s + r.records_ingested, 0);
  const totalOverwritten = allResults.reduce((s, r) => s + r.records_overwritten, 0);
  const totalSkipped = allResults.reduce(
    (s, r) => s + r.records_skipped_no_change + r.records_skipped_duplicate,
    0,
  );

  return {
    sync_results: allResults,
    total_records_ingested: totalIngested,
    total_records_overwritten: totalOverwritten,
    total_records_skipped: totalSkipped,
    duration_ms: Date.now() - start,
  };
}
