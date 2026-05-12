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
