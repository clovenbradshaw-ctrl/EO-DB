/**
 * Shared per-record event emission for any external-source ingestion.
 *
 * Both the System A Airtable pipeline (`airtable-sync.ts:ingestRecord`)
 * and System B's API-connection sync (`api-connection-store`) need the
 * same skeleton: look up existing state, compute a field-level diff,
 * emit INS the first time, emit DEF when the diff is non-empty, and
 * use deterministic `client_event_id`s so replays and peer convergence
 * dedup correctly.
 *
 * This module factors that skeleton out so:
 *   - Phase 4's new `generic-rest-sync.ts` can call it without copying
 *     the inline emission code from Phase 1's `_fetchRecordsInternal`.
 *   - The API-connection store can switch to it without diverging from
 *     the convention every other ingestion path uses.
 *   - Future adapters (Notion, Linear, etc.) plug in with one call
 *     instead of re-deriving the contract.
 *
 * The Airtable pipeline in `ingestion/airtable-sync.ts` is intentionally
 * *not* refactored to call this helper — it has too much
 * source-specific logic (cleared-fields tracking, linked records,
 * display-name DEF, _airtable provenance shape, change observers,
 * preserve-existing semantics, resolution stamping) for a clean
 * factoring. Both paths arrive at the same INS/DEF shape regardless;
 * this helper just packages the System B + generic adapter version.
 */

import { useEoStore } from '../store/eo-store';
import { stableStringify, valuesEqual } from './value-extract';
import { isDeleted, TOMBSTONE_KEY, type TombstoneMarker } from '../db/tombstone';
import type { EoState } from '../db/types';
import type { RemoteField, RemoteSchema } from '../lib/api-adapters/types';

/**
 * Default agent used for events emitted via the API-connection / generic
 * adapter paths. Mirrors the value used inline by api-connection-store
 * before this module existed.
 */
export const DEFAULT_INGEST_AGENT = '@local:localhost';

/** Stable event-id prefix; keeps the namespace separate from airtable-sync.ts's `at-sync:` family. */
const ID_PREFIX = 'at-conn';

/**
 * Field-level diff used to gate DEF emission. Returns only fields that
 * actually changed; for new records, returns every non-null field.
 * Mirrors `computeFieldDiff` in `ingestion/airtable-sync.ts`.
 */
export function computeFieldDiff(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  if (!existing) {
    for (const [k, v] of Object.entries(incoming)) {
      if (v !== null && v !== undefined) diff[k] = v;
    }
    return diff;
  }
  for (const [k, v] of Object.entries(incoming)) {
    if (!valuesEqual(v, existing[k])) diff[k] = v;
  }
  return diff;
}

/** Deterministic target for a per-connection record DEF. */
export function recordTarget(connectionId: string, recordId: string): string {
  return `api.records.${connectionId}.${recordId}`;
}

/** Idempotent client_event_id for the INS that births a record on this connection. */
export function insEventId(connectionId: string, recordId: string): string {
  return `${ID_PREFIX}:ins:${connectionId}:${recordId}`;
}

/**
 * Content-keyed client_event_id for a DEF carrying a field diff.
 * `stableStringify(diff)` is used directly (matches the
 * `airtable-sync.ts:recordEventId` convention — no hashing).
 */
export function defEventId(connectionId: string, recordId: string, contentKey: string): string {
  return `${ID_PREFIX}:def:${connectionId}:${recordId}:${contentKey}`;
}

/** Idempotent client_event_id for a tombstone DEF. */
export function tombstoneEventId(connectionId: string, recordId: string, at: string): string {
  return `${ID_PREFIX}:del:${connectionId}:${recordId}:${at}`;
}

// ─── Schema target + event-id helpers ──────────────────────────────────────

/** Stable target for the per-connection schema header (base + table info). */
export function schemaTarget(connectionId: string): string {
  return `api.schema.${connectionId}`;
}

/** Stable target for a per-field schema event under the connection. */
export function fieldSchemaTarget(connectionId: string, fieldId: string): string {
  return `${schemaTarget(connectionId)}.field.${fieldId}`;
}

export function schemaInsEventId(connectionId: string): string {
  return `${ID_PREFIX}:schema:ins:${connectionId}`;
}

export function schemaDefEventId(connectionId: string, contentKey: string): string {
  return `${ID_PREFIX}:schema:def:${connectionId}:${contentKey}`;
}

export function fieldInsEventId(connectionId: string, fieldId: string): string {
  return `${ID_PREFIX}:field:ins:${connectionId}:${fieldId}`;
}

export function fieldDefEventId(connectionId: string, fieldId: string, contentKey: string): string {
  return `${ID_PREFIX}:field:def:${connectionId}:${fieldId}:${contentKey}`;
}

// ─── INS / DEF / tombstone emission ────────────────────────────────────────

export interface IngestRemoteRecordParams {
  /** Stable id for the API connection this record belongs to. */
  connectionId: string;
  /** Source-side record id (Airtable `rec…`, REST id, …). */
  recordId: string;
  /** Translated fields keyed by internalName (post field-mapping). */
  fields: Record<string, unknown>;
  /** ISO timestamp from the source's "last modified" field, or null. */
  lastModifiedAt: string | null;
  /** Defaults to `DEFAULT_INGEST_AGENT`. */
  agent?: string;
}

/** Outcome of an ingest call; useful for callers that want progress counts. */
export type IngestRemoteRecordOutcome =
  | 'tombstoned'
  | 'ins_emitted'
  | 'def_emitted'
  | 'no_change'
  | 'failed';

/**
 * Ingest one remote record into the EO event log. Idempotent across
 * replays and peer-sync.
 *
 * Returns an outcome string so the caller can tally counts; never
 * throws on idempotent-replay collisions (those are converted into
 * `'no_change'`), but does propagate unexpected errors.
 */
export async function ingestRemoteRecord(
  params: IngestRemoteRecordParams,
): Promise<IngestRemoteRecordOutcome> {
  const { connectionId, recordId, fields, lastModifiedAt } = params;
  const agent = params.agent ?? DEFAULT_INGEST_AGENT;
  const target = recordTarget(connectionId, recordId);
  const { dispatch, getState } = useEoStore.getState();

  const existing: EoState | null = await getState(target);
  // A local tombstone wins over an upstream re-import — the user deleted
  // this row on this device, the source's continued visibility of it
  // should not resurrect it.
  if (isDeleted(existing)) return 'tombstoned';

  const existingFields = (existing?.value as { fields?: Record<string, unknown> } | undefined)?.fields;
  const diff = computeFieldDiff(fields, existingFields);
  const nowIso = new Date().toISOString();
  let insEmitted = false;

  if (!existing) {
    try {
      await dispatch({
        op: 'INS',
        target,
        operand: { _source: { connectionId, remoteRecordId: recordId } },
        agent,
        ts: nowIso,
        acquired_ts: nowIso,
        client_event_id: insEventId(connectionId, recordId),
      });
      insEmitted = true;
    } catch {
      // Idempotent INS — already in the log on this device or a peer's.
    }
  }

  if (Object.keys(diff).length === 0) {
    return insEmitted ? 'ins_emitted' : 'no_change';
  }

  try {
    await dispatch({
      op: 'DEF',
      target,
      operand: {
        fields: diff,
        _source: { connectionId, remoteRecordId: recordId, lastModifiedAt },
      },
      agent,
      ts: nowIso,
      acquired_ts: nowIso,
      client_event_id: defEventId(connectionId, recordId, stableStringify(diff)),
    });
    return 'def_emitted';
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('already') || msg.includes('duplicate')) {
      return insEmitted ? 'ins_emitted' : 'no_change';
    }
    return 'failed';
  }
}

export interface DispatchTombstoneParams {
  connectionId: string;
  recordId: string;
  agent?: string;
  /** Free-form provenance tag stored on the tombstone marker. */
  source?: string;
}

/** Emit a tombstone DEF for a remote record. Idempotent per (connectionId, recordId, instant). */
export async function dispatchRemoteRecordTombstone(
  params: DispatchTombstoneParams,
): Promise<void> {
  const { connectionId, recordId } = params;
  const agent = params.agent ?? DEFAULT_INGEST_AGENT;
  const nowIso = new Date().toISOString();
  const marker: TombstoneMarker = {
    at: nowIso,
    by: agent,
    ...(params.source ? { source: params.source } : {}),
  };
  const target = recordTarget(connectionId, recordId);
  const { dispatch } = useEoStore.getState();
  try {
    await dispatch({
      op: 'DEF',
      target,
      operand: { [TOMBSTONE_KEY]: marker },
      agent,
      ts: nowIso,
      acquired_ts: nowIso,
      client_event_id: tombstoneEventId(connectionId, recordId, nowIso),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (!msg.includes('already') && !msg.includes('duplicate')) throw e;
  }
}

// ─── Schema emission ───────────────────────────────────────────────────────

export interface IngestConnectionSchemaParams {
  /** Stable id for the API connection this schema describes. */
  connectionId: string;
  /** Schema as returned by `ApiAdapter.discoverSchema()`. */
  schema: RemoteSchema;
  agent?: string;
}

/** Outcome rollup for caller tallies / UI status. */
export interface IngestSchemaOutcome {
  /** Header (`api.schema.{cid}`) was newly emitted (INS+DEF) on this call. */
  headerEmitted: boolean;
  /** Number of field schema events that emitted INS this call. */
  fieldsInserted: number;
  /** Number of field schema events that emitted DEF (content changed) this call. */
  fieldsUpdated: number;
  /** Total fields in the schema (= fieldsInserted + fieldsUpdated + no-changes). */
  fieldsTotal: number;
}

/**
 * Persist the schema of a remote source into the EO event log so the table
 * structure exists before any records land. Idempotent — re-running with
 * identical schema emits no new events; re-running with a changed schema
 * emits diff DEFs only for the fields that actually changed.
 *
 * Event layout:
 *   api.schema.{cid}                         — table header (baseName, tableName, ...)
 *   api.schema.{cid}.field.{fieldId}         — per-field metadata, including
 *                                              source-native `options` so
 *                                              linked-table refs, formula
 *                                              expressions, and choice lists
 *                                              survive into the log.
 */
export async function ingestConnectionSchema(
  params: IngestConnectionSchemaParams,
): Promise<IngestSchemaOutcome> {
  const { connectionId, schema } = params;
  const agent = params.agent ?? DEFAULT_INGEST_AGENT;
  const { dispatch, getState } = useEoStore.getState();
  const nowIso = new Date().toISOString();

  const headerOperand = {
    baseName: schema.baseName,
    tableName: schema.tableName,
    tableId: schema.tableId,
    fieldCount: schema.fields.length,
    _source: { connectionId, kind: 'schema-header' as const },
  };
  const headerTarget = schemaTarget(connectionId);
  const headerExisting = await getState(headerTarget);
  let headerEmitted = false;

  if (!headerExisting) {
    try {
      await dispatch({
        op: 'INS',
        target: headerTarget,
        operand: { _source: { connectionId, kind: 'schema-header' } },
        agent,
        ts: nowIso,
        acquired_ts: nowIso,
        client_event_id: schemaInsEventId(connectionId),
      });
      headerEmitted = true;
    } catch { /* idempotent INS */ }
  }

  const headerExistingValue = headerExisting?.value as Record<string, unknown> | undefined;
  if (!headerExistingValue || !valuesEqual(headerOperand, headerExistingValue)) {
    try {
      await dispatch({
        op: 'DEF',
        target: headerTarget,
        operand: headerOperand,
        agent,
        ts: nowIso,
        acquired_ts: nowIso,
        client_event_id: schemaDefEventId(connectionId, stableStringify(headerOperand)),
      });
      headerEmitted = true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (!msg.includes('already') && !msg.includes('duplicate')) throw e;
    }
  }

  let fieldsInserted = 0;
  let fieldsUpdated = 0;
  for (const field of schema.fields) {
    const result = await ingestFieldSchema({ connectionId, field, agent, ts: nowIso });
    if (result === 'ins') fieldsInserted++;
    if (result === 'def') fieldsUpdated++;
  }

  return {
    headerEmitted,
    fieldsInserted,
    fieldsUpdated,
    fieldsTotal: schema.fields.length,
  };
}

async function ingestFieldSchema(args: {
  connectionId: string;
  field: RemoteField;
  agent: string;
  ts: string;
}): Promise<'ins' | 'def' | 'no_change'> {
  const { connectionId, field, agent, ts } = args;
  const { dispatch, getState } = useEoStore.getState();
  const target = fieldSchemaTarget(connectionId, field.id);
  const operand = {
    fieldId: field.id,
    name: field.name,
    type: field.type,
    ...(field.options ? { options: field.options } : {}),
    _source: { connectionId, kind: 'schema-field' as const, fieldId: field.id },
  };

  const existing = await getState(target);
  let didIns = false;

  if (!existing) {
    try {
      await dispatch({
        op: 'INS',
        target,
        operand: { _source: { connectionId, kind: 'schema-field', fieldId: field.id } },
        agent,
        ts,
        acquired_ts: ts,
        client_event_id: fieldInsEventId(connectionId, field.id),
      });
      didIns = true;
    } catch { /* idempotent INS */ }
  }

  const existingValue = existing?.value as Record<string, unknown> | undefined;
  if (existingValue && valuesEqual(operand, existingValue)) {
    return didIns ? 'ins' : 'no_change';
  }

  try {
    await dispatch({
      op: 'DEF',
      target,
      operand,
      agent,
      ts,
      acquired_ts: ts,
      client_event_id: fieldDefEventId(connectionId, field.id, stableStringify(operand)),
    });
    return 'def';
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (!msg.includes('already') && !msg.includes('duplicate')) throw e;
    return didIns ? 'ins' : 'no_change';
  }
}

export interface DispatchUpdateParams {
  connectionId: string;
  recordId: string;
  /** Fields to update, keyed by internalName. */
  fields: Record<string, unknown>;
  agent?: string;
}

/**
 * Emit a DEF carrying a user-driven field update (inline edit). Unlike
 * `ingestRemoteRecord`, this does not gate on a field-level diff — the
 * caller has already decided these fields should be written. Includes
 * `nowIso` in the client_event_id so the same user-driven edit can land
 * twice if the user actually issues it twice (different content key per
 * timestamp).
 */
export async function dispatchRemoteRecordUpdate(
  params: DispatchUpdateParams,
): Promise<void> {
  const { connectionId, recordId, fields } = params;
  const agent = params.agent ?? DEFAULT_INGEST_AGENT;
  const nowIso = new Date().toISOString();
  const target = recordTarget(connectionId, recordId);
  const { dispatch } = useEoStore.getState();
  try {
    await dispatch({
      op: 'DEF',
      target,
      operand: {
        fields,
        _source: { connectionId, remoteRecordId: recordId, lastModifiedAt: nowIso },
      },
      agent,
      ts: nowIso,
      acquired_ts: nowIso,
      client_event_id: defEventId(connectionId, recordId, stableStringify(fields) + ':' + nowIso),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (!msg.includes('already') && !msg.includes('duplicate')) throw e;
  }
}
