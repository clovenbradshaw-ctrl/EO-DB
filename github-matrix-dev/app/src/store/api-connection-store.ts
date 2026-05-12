/**
 * API Connections store — manages external API source connections.
 *
 * Connection configs (credentials + field mappings) are persisted as DEF
 * events under `api.connections.<connectionId>` so they survive reloads and
 * are automatically shared with all Matrix room members.
 *
 * Remote records are held in an in-memory cache per connection — keyed by
 * internal field names (post-mapping). The cache is rebuilt on each sync.
 */

import { create } from 'zustand';
import { useEoStore } from './eo-store';
import type {
  ApiConnectionConfig,
  ApiAdapter,
  ApiCredentials,
  RemoteField,
  RemoteRecord,
  FieldMapping,
} from '../lib/api-adapters/types';
import { normalizeTimestamp } from '../lib/api-adapters/types';
import { AirtableAdapter } from '../lib/api-adapters/airtable';
import { GenericRestAdapter } from '../lib/api-adapters/generic-rest';
import { isDeleted } from '../db/tombstone';
import {
  DEFAULT_INGEST_AGENT,
  dispatchRemoteRecordTombstone,
  dispatchRemoteRecordUpdate,
  ingestRemoteRecord,
} from '../ingestion/event-sourced-ingest';

const RECORD_AGENT = DEFAULT_INGEST_AGENT;
const RECORD_TARGET_PREFIX = 'api.records.';

// ─── Record cache ─────────────────────────────────────────────────────────────

interface RecordsCache {
  /** Records with fields keyed by internalName (post-mapping). */
  records: RemoteRecord[];
  loadedAt: string;
}

// ─── Store state ──────────────────────────────────────────────────────────────

interface ApiConnectionState {
  connections: Record<string, ApiConnectionConfig>;
  connectionsLoading: boolean;
  recordsCache: Record<string, RecordsCache>;
  recordsLoading: Record<string, boolean>;
  errors: Record<string, string>;
  /** In-memory timestamp (ms) of the most recent sync attempt per connectionId. */
  lastSyncAttemptAt: Record<string, number>;

  /**
   * Returns the remaining cooldown ms for a connection (0 = ready to sync).
   * Reads from lastSyncAttemptAt (in-memory) and lastSyncAt (persisted),
   * capped by minSyncIntervalMs.
   */
  getSyncCooldownMs: (connectionId: string) => number;

  loadConnections: () => Promise<void>;

  /**
   * Test credentials and return discovered fields on success.
   * Throws a user-readable Error on failure.
   */
  testAndDiscover: (credentials: ApiCredentials) => Promise<RemoteField[]>;

  /**
   * Persist a new or updated connection as a DEF event.
   * Returns the connectionId.
   */
  saveConnection: (
    partial: Omit<ApiConnectionConfig, 'createdAt' | 'lastSyncAt' | 'syncCursor' | 'minSyncIntervalMs'> & {
      connectionId?: string;
      minSyncIntervalMs?: number;
    },
  ) => Promise<string>;

  deleteConnection: (connectionId: string) => Promise<void>;

  /** Fetch records into the in-memory cache (incremental if cache exists). */
  fetchRecords: (connectionId: string) => Promise<void>;

  /** Force a full re-fetch (ignores cursor). */
  fetchRecordsFull: (connectionId: string) => Promise<void>;

  updateRecord: (
    connectionId: string,
    recordId: string,
    /** Fields keyed by remoteFieldId */
    remoteFields: Record<string, unknown>,
    /** Updated fields keyed by internalName for the optimistic cache update */
    internalFields: Record<string, unknown>,
  ) => Promise<void>;

  deleteRecord: (connectionId: string, recordId: string) => Promise<void>;

  clearError: (connectionId: string) => void;

  /** Reset all state on space switch — prevents data from a previous space leaking in. */
  reset: () => void;

  // Internal — not part of the public interface but typed here to avoid TS errors
  _fetchRecordsInternal: (connectionId: string, fullRefresh: boolean) => Promise<void>;
}

// ─── Adapter factory ──────────────────────────────────────────────────────────

function buildAdapter(
  credentials: ApiCredentials,
  fieldMappings: FieldMapping = {},
): ApiAdapter {
  if (credentials.sourceType === 'airtable') {
    // Find the remoteFieldId of any lastModifiedTime field so the adapter
    // can use it for precise per-record modification timestamps.
    const lastModifiedFieldId: string | null = null;
    void lastModifiedFieldId; // resolved below via discoverFields at save time — adapter falls back to createdTime
    return new AirtableAdapter(
      credentials.baseId,
      credentials.tableId,
      credentials.apiKey,
      null, // injected after discoverFields if a lastModifiedTime field exists in mappings
    );
  }
  if (credentials.sourceType === 'generic_rest') {
    return new GenericRestAdapter(credentials);
  }
  throw new Error(`Adapter for sourceType "${(credentials as ApiCredentials).sourceType}" is not yet implemented`);
}

/**
 * Re-build adapter with lastModifiedFieldId resolved from the connection's
 * fieldMappings and discovered field metadata.
 * We detect it by checking whether any mapped field has type 'lastModifiedTime'
 * — that information is stored as `_fieldTypes` on the config (see saveConnection).
 */
function buildAdapterForConnection(config: ApiConnectionConfig): ApiAdapter {
  const { credentials, fieldMappings } = config;
  if (credentials.sourceType !== 'airtable') {
    return buildAdapter(credentials, fieldMappings);
  }

  // Resolve lastModifiedFieldId from _fieldTypes metadata stored at save time
  const fieldTypes =
    '_fieldTypes' in config ? (config as ApiConnectionConfig & { _fieldTypes: Record<string, string> })._fieldTypes : {};
  const lastModifiedFieldId =
    Object.entries(fieldMappings).find(([fid]) => fieldTypes[fid] === 'lastModifiedTime')?.[0] ?? null;

  return new AirtableAdapter(
    credentials.baseId,
    credentials.tableId,
    credentials.apiKey,
    lastModifiedFieldId,
  );
}

// ─── Field translation helpers ────────────────────────────────────────────────

/** Translate a record's fields from remoteFieldId keys to internalName keys. */
function applyMappings(
  record: RemoteRecord,
  fieldMappings: FieldMapping,
): RemoteRecord {
  const translated: Record<string, unknown> = {};
  for (const [remoteId, internalName] of Object.entries(fieldMappings)) {
    if (internalName && remoteId in record.fields) {
      translated[internalName] = record.fields[remoteId];
    }
  }
  return { ...record, fields: translated };
}

/** Reverse lookup: internalName → remoteFieldId */
function reverseMapping(fieldMappings: FieldMapping): Record<string, string> {
  const reverse: Record<string, string> = {};
  for (const [remoteId, internalName] of Object.entries(fieldMappings)) {
    if (internalName) reverse[internalName] = remoteId;
  }
  return reverse;
}

// ─── Merge helper ─────────────────────────────────────────────────────────────

/** Merge incoming records into an existing cache using lastModifiedAt. */
function mergeRecords(
  existing: RemoteRecord[],
  incoming: RemoteRecord[],
): RemoteRecord[] {
  const map = new Map(existing.map((r) => [r.id, r]));
  for (const rec of incoming) {
    const cached = map.get(rec.id);
    const inTs = normalizeTimestamp(rec.lastModifiedAt);
    const cachedTs = normalizeTimestamp(cached?.lastModifiedAt ?? null);
    if (!cached || !cachedTs || !inTs || inTs >= cachedTs) {
      map.set(rec.id, rec);
    }
  }
  return Array.from(map.values());
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useApiConnectionStore = create<ApiConnectionState>((set, get) => ({
  connections: {},
  connectionsLoading: false,
  recordsCache: {},
  recordsLoading: {},
  errors: {},
  lastSyncAttemptAt: {},

  getSyncCooldownMs(connectionId: string): number {
    const config = get().connections[connectionId];
    const minMs = config?.minSyncIntervalMs ?? 60_000;
    const attemptTs = get().lastSyncAttemptAt[connectionId] ?? 0;
    const syncAtTs = config?.lastSyncAt ? new Date(config.lastSyncAt).getTime() : 0;
    const lastTs = Math.max(attemptTs, syncAtTs);
    return Math.max(0, lastTs + minMs - Date.now());
  },

  async loadConnections() {
    set({ connectionsLoading: true });
    try {
      const { getStateByPrefix } = useEoStore.getState();
      const states = await getStateByPrefix('api.connections.');
      const connections: Record<string, ApiConnectionConfig> = {};
      for (const state of states) {
        if (state.value && typeof state.value === 'object' && 'connectionId' in state.value) {
          const config = state.value as ApiConnectionConfig;
          // Skip nullified connection configs (DEF with operand: null in deleteConnection).
          if (!config.connectionId) continue;
          connections[config.connectionId] = config;
        }
      }

      // Rebuild the in-memory record cache from EO state so records survive
      // reloads, space switches, and second-device replay. The DEF events
      // emitted by _fetchRecordsInternal are the canonical store; this cache
      // is just an O(1) lookup for the UI table.
      const now = new Date().toISOString();
      const recordsCache: Record<string, RecordsCache> = {};
      for (const cid of Object.keys(connections)) {
        const recordStates = await getStateByPrefix(`${RECORD_TARGET_PREFIX}${cid}.`);
        const records: RemoteRecord[] = [];
        for (const st of recordStates) {
          if (isDeleted(st)) continue;
          const value = st.value as
            | { fields?: Record<string, unknown>; _source?: { remoteRecordId?: string; lastModifiedAt?: string | null } }
            | null
            | undefined;
          if (!value || typeof value !== 'object') continue;
          const recordId =
            value._source?.remoteRecordId ?? st.target.slice(`${RECORD_TARGET_PREFIX}${cid}.`.length);
          if (!recordId) continue;
          records.push({
            id: recordId,
            fields: value.fields ?? {},
            lastModifiedAt: value._source?.lastModifiedAt ?? null,
          });
        }
        recordsCache[cid] = { records, loadedAt: now };
      }

      set({ connections, recordsCache, connectionsLoading: false });
    } catch (e: unknown) {
      set({ connectionsLoading: false });
      throw e;
    }
  },

  async testAndDiscover(credentials) {
    const adapter = buildAdapter(credentials);
    await adapter.testConnection();
    return adapter.discoverFields();
  },

  async saveConnection(partial) {
    const { dispatch } = useEoStore.getState();
    const connectionId = partial.connectionId ?? crypto.randomUUID();
    const existing = partial.connectionId
      ? get().connections[partial.connectionId]
      : undefined;

    const config: ApiConnectionConfig = {
      connectionId,
      label: partial.label,
      credentials: partial.credentials,
      fieldMappings: partial.fieldMappings,
      minSyncIntervalMs: partial.minSyncIntervalMs ?? existing?.minSyncIntervalMs ?? 60_000,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastSyncAt: existing?.lastSyncAt ?? null,
      syncCursor: existing?.syncCursor ?? null,
    };

    // Carry over _fieldTypes if provided by the caller
    if ('_fieldTypes' in partial) {
      (config as ApiConnectionConfig & { _fieldTypes: unknown })._fieldTypes =
        (partial as { _fieldTypes: unknown })._fieldTypes;
    }

    const now = new Date().toISOString();
    await dispatch({
      op: 'DEF',
      target: `api.connections.${connectionId}`,
      operand: config,
      agent: '@local:localhost',
      ts: now,
      acquired_ts: now,
    });

    set((state) => ({
      connections: { ...state.connections, [connectionId]: config },
    }));

    return connectionId;
  },

  async deleteConnection(connectionId) {
    const { dispatch } = useEoStore.getState();
    const now = new Date().toISOString();
    await dispatch({
      op: 'DEF',
      target: `api.connections.${connectionId}`,
      operand: null,
      agent: '@local:localhost',
      ts: now,
      acquired_ts: now,
    });
    set((state) => {
      const connections = { ...state.connections };
      delete connections[connectionId];
      const recordsCache = { ...state.recordsCache };
      delete recordsCache[connectionId];
      const errors = { ...state.errors };
      delete errors[connectionId];
      const lastSyncAttemptAt = { ...state.lastSyncAttemptAt };
      delete lastSyncAttemptAt[connectionId];
      return { connections, recordsCache, errors, lastSyncAttemptAt };
    });
  },

  async fetchRecords(connectionId) {
    return get()._fetchRecordsInternal(connectionId, false);
  },

  async fetchRecordsFull(connectionId) {
    return get()._fetchRecordsInternal(connectionId, true);
  },

  // Internal — not exposed in the interface type; called from fetchRecords/fetchRecordsFull
  async _fetchRecordsInternal(connectionId: string, fullRefresh: boolean) {
    const config = get().connections[connectionId];
    if (!config) return;

    // Hard rate limit — check before touching loading state
    const cooldownMs = get().getSyncCooldownMs(connectionId);
    if (cooldownMs > 0) {
      if (fullRefresh) {
        // User-initiated: surface the wait time
        const secs = Math.ceil(cooldownMs / 1000);
        set((state) => ({
          errors: {
            ...state.errors,
            [connectionId]: `Sync rate limited — try again in ${secs}s`,
          },
        }));
      }
      // Auto-fetch (fullRefresh=false): silently skip
      return;
    }

    // Record the attempt timestamp before any async work
    set((state) => ({
      lastSyncAttemptAt: { ...state.lastSyncAttemptAt, [connectionId]: Date.now() },
    }));

    set((state) => ({
      recordsLoading: { ...state.recordsLoading, [connectionId]: true },
      errors: { ...state.errors, [connectionId]: '' },
    }));

    try {
      const adapter = buildAdapterForConnection(config);
      const cursor = fullRefresh ? null : (config.syncCursor ?? null);
      const { records: rawRecords, nextCursor } = await adapter.fetchRecords({ cursor });

      // Translate field IDs to internal names
      const translatedRecords = rawRecords.map((r) =>
        applyMappings(r, config.fieldMappings),
      );

      // Event-source each record into the EO log so it survives reloads,
      // peer-syncs to other devices in the room, and dedupes on replay.
      // The helper handles the INS/DEF emission and idempotency contract
      // shared with the upcoming generic-rest-sync service (Phase 4).
      for (const rec of translatedRecords) {
        await ingestRemoteRecord({
          connectionId,
          recordId: rec.id,
          fields: rec.fields,
          lastModifiedAt: rec.lastModifiedAt,
          agent: RECORD_AGENT,
        });
      }

      // Merge with existing cache for the UI to consume.
      const existing = get().recordsCache[connectionId]?.records ?? [];
      const merged = fullRefresh
        ? translatedRecords
        : mergeRecords(existing, translatedRecords);

      const now = new Date().toISOString();
      set((state) => ({
        recordsLoading: { ...state.recordsLoading, [connectionId]: false },
        recordsCache: {
          ...state.recordsCache,
          [connectionId]: { records: merged, loadedAt: now },
        },
      }));

      // Persist updated cursor + lastSyncAt
      const updatedConfig: ApiConnectionConfig = {
        ...config,
        syncCursor: nextCursor,
        lastSyncAt: now,
      };
      const { dispatch } = useEoStore.getState();
      await dispatch({
        op: 'DEF',
        target: `api.connections.${connectionId}`,
        operand: updatedConfig,
        agent: RECORD_AGENT,
        ts: now,
        acquired_ts: now,
      });
      set((state) => ({
        connections: { ...state.connections, [connectionId]: updatedConfig },
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      set((state) => ({
        recordsLoading: { ...state.recordsLoading, [connectionId]: false },
        errors: { ...state.errors, [connectionId]: msg },
      }));
    }
  },

  async updateRecord(connectionId, recordId, remoteFields, internalFields) {
    const config = get().connections[connectionId];
    if (!config) return;

    const adapter = buildAdapterForConnection(config);
    // Write through to the remote source first so a NOT_SUPPORTED adapter
    // surfaces the error before we mutate the local log. A future writeback
    // queue would let us go DEF-first; until then this preserves "no phantom
    // local edits on a read-only source."
    await adapter.updateRecord(recordId, remoteFields);

    await dispatchRemoteRecordUpdate({
      connectionId,
      recordId,
      fields: internalFields,
      agent: RECORD_AGENT,
    });

    // Optimistic cache update — keeps the UI row in sync without a re-render
    // round-trip through getStateByPrefix.
    const nowIso = new Date().toISOString();
    set((state) => {
      const cache = state.recordsCache[connectionId];
      if (!cache) return state;
      const records = cache.records.map((r) => {
        if (r.id !== recordId) return r;
        return {
          ...r,
          fields: { ...r.fields, ...internalFields },
          lastModifiedAt: nowIso,
        };
      });
      return {
        recordsCache: {
          ...state.recordsCache,
          [connectionId]: { ...cache, records },
        },
      };
    });
  },

  async deleteRecord(connectionId, recordId) {
    const config = get().connections[connectionId];
    if (!config) return;

    const adapter = buildAdapterForConnection(config);
    await adapter.deleteRecord(recordId);

    await dispatchRemoteRecordTombstone({
      connectionId,
      recordId,
      agent: RECORD_AGENT,
      source: 'api-connection-delete',
    });

    set((state) => {
      const cache = state.recordsCache[connectionId];
      if (!cache) return state;
      return {
        recordsCache: {
          ...state.recordsCache,
          [connectionId]: {
            ...cache,
            records: cache.records.filter((r) => r.id !== recordId),
          },
        },
      };
    });
  },

  clearError(connectionId) {
    set((state) => ({
      errors: { ...state.errors, [connectionId]: '' },
    }));
  },

  reset() {
    set({
      connections: {},
      connectionsLoading: false,
      recordsCache: {},
      recordsLoading: {},
      errors: {},
      lastSyncAttemptAt: {},
    });
  },
}));

// Export the reverseMapping helper for use in the UI layer
export { reverseMapping };
