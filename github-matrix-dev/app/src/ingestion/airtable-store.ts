/**
 * Airtable sync store — Zustand store for browser-side Airtable integration.
 *
 * The Airtable API key is delivered via the n8n credentials webhook (validated
 * via Matrix access token). It is held in-memory only — never persisted to
 * IndexedDB, localStorage, or Matrix room state.
 */

import { create } from 'zustand';
import { AirtableClient } from './airtable-client';
import type { AirtableResponseInfo, AirtableResponseHook } from './airtable-client';
import { resetWebhookPermissionCache } from './airtable-sync';
import type { HydrationManifest, HydrationResult, UpdateSyncResult, SyncStrategy } from './airtable-sync';
import { AMINO_AIRTABLE_BASE_ID } from '../lib/amino-config';

// ─── Sync activity log ──────────────────────────────────────────────────────

export type SyncLogEventType =
  | 'lock_acquired'
  | 'lock_released'
  | 'sync_complete'
  | 'hydration_complete'
  | 'sync_error'
  | 'sync_start'
  /** Raw pre-fold bundle was uploaded to Drive as provenance. */
  | 'provenance_uploaded'
  /** A single webhook /payloads poll completed (one cycle of continuous sync). */
  | 'webhook_poll'
  /** Per-record field change observed by the fold. Carries before/after diffs. */
  | 'change_detected'
  /** Snapshot bytes were written to local disk via "Download from Airtable". */
  | 'snapshot_downloaded'
  /** Snapshot file was uploaded into the local DB via "Import snapshot". */
  | 'snapshot_imported'
  /** A table was skipped because it has no `lastModifiedTime` field. */
  | 'table_skipped'
  /** A continuous tick deferred because another sync (manual / resumable) was already running. */
  | 'sync_skipped';

export interface SyncLogEntry {
  /** Unix ms timestamp. */
  ts: number;
  type: SyncLogEventType;
  /** 'local' = this device, 'remote' = another device via to-device message. */
  source: 'local' | 'remote';
  /** Matrix user ID of the device that generated the event. */
  syncer: string;
  /** Device / tab ID (optional). */
  device?: string;
  /** Human-readable summary, e.g. "12 ingested, 3 unchanged". */
  detail?: string;

  // ── Richer context (optional — older entries may be missing these) ──
  /** Airtable base ID this entry refers to, e.g. "appXYZ". */
  baseId?: string;
  /** Human-readable base name. */
  baseName?: string;
  /** List of selected table IDs that were synced in this run. */
  tables?: string[];
  /** Strategy that drove this run. */
  strategy?: SyncStrategy;
  /** ISO timestamp of the LAST_MODIFIED_TIME cursor used (empty for full hydrates). */
  cursorUsed?: string;
  /** Actual Airtable API endpoint hit (the last one for multi-table runs). */
  endpoint?: string;
  /** Whether this run had preserve-existing enabled. */
  preserveExisting?: boolean;
  /** Per-table roll-up for completion entries. */
  perTable?: Array<{
    table: string;
    ingested: number;
    overwritten: number;
    skipped: number;
  }>;
  /** Wall-clock duration in ms for completion entries. */
  durationMs?: number;

  // ── Telemetry-specific fields ──
  /** HTTP status code of the last webhook poll (used for `webhook_poll` and `sync_error`). */
  httpStatus?: number;
  /** Number of records inspected by this cycle (separate from records changed). */
  recordsScanned?: number;
  /** Number of records actually changed by this cycle. */
  recordsChanged?: number;
  /** Per-record field diffs that triggered this `change_detected` entry. */
  diffs?: Array<{ field: string; before: unknown; after: unknown }>;
  /** Airtable record id this entry refers to (for `change_detected`). */
  recordId?: string;
  /** Human-readable table name this entry refers to (for `change_detected`). */
  tableName?: string;
}

// ─── Webhook health (last poll snapshot) ───────────────────────────────────

/**
 * Lightweight "what happened on the last webhook /payloads call" — surfaced
 * by the transparency UI so users can tell at a glance whether the
 * incremental feed is alive or silently 401-ing.
 *
 * Updated by `AirtableSyncService` on every poll via the `onResponse` hook
 * we register on `AirtableClient`. Cleared on `disconnect()`.
 */
export interface WebhookHealth {
  /** Full URL of the last `/payloads` call (or other Airtable endpoint we last touched). */
  url: string | null;
  /** Unix ms when the response landed. */
  lastPolledAt: number | null;
  /** HTTP status code of the last response. */
  lastStatus: number | null;
  /** "200 OK" / "401 Unauthorized" — convenient string for the UI. */
  lastStatusText: string | null;
  /** Cursor passed (or returned) on the last poll. */
  lastCursor: string | null;
  /** Error message when the call threw before producing a response. */
  lastError: string | null;
  /**
   * Machine-readable Airtable error type (e.g. `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND`)
   * parsed from the response body. The panel uses this to decide whether to
   * show a scope hint rather than relying on brittle message matching.
   */
  lastErrorType: string | null;
  /**
   * Short, user-facing explanation for the most common webhook failures
   * (missing `webhook:manage` scope, base not in token's base list, etc.).
   * Null when no hint applies.
   */
  hint: string | null;
}

export const EMPTY_WEBHOOK_HEALTH: WebhookHealth = {
  url: null,
  lastPolledAt: null,
  lastStatus: null,
  lastStatusText: null,
  lastCursor: null,
  lastError: null,
  lastErrorType: null,
  hint: null,
};

/**
 * Build a `setWebhookHealth` patch from an `AirtableResponseInfo`. Centralised
 * so every observer (continuous sync, manual sync, snapshot download, import)
 * produces the same shape — notably: clears stale `hint`/`lastErrorType` on
 * success instead of leaving them set from a prior failure.
 */
export function webhookHealthPatch(info: AirtableResponseInfo): Partial<WebhookHealth> {
  const isWebhookUrl = info.url.includes('/webhooks');
  const isPayloads = isWebhookUrl && info.url.includes('/payloads');
  const cursorMatch = isPayloads ? info.url.match(/[?&]cursor=([^&]+)/) : null;

  const statusText = info.status != null
    ? `${info.status} ${info.statusText ?? ''}`.trim()
    : null;

  const patch: Partial<WebhookHealth> = {
    url: info.url,
    lastPolledAt: Date.now(),
    lastStatus: info.status,
    lastStatusText: statusText,
    lastError: info.ok ? null : (info.error ?? 'request failed'),
    lastErrorType: info.ok ? null : (info.errorType ?? null),
    hint: info.ok ? null : buildWebhookHint(info),
  };
  if (isPayloads) {
    patch.lastCursor = cursorMatch ? decodeURIComponent(cursorMatch[1]) : null;
  }
  return patch;
}

function buildWebhookHint(info: AirtableResponseInfo): string | null {
  if (info.ok) return null;
  const onWebhookEndpoint = info.url.includes('/webhooks');
  if (info.status === 403 && info.errorType === 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND' && onWebhookEndpoint) {
    return 'Your Airtable personal access token is missing the webhook:manage scope, or this base is not in the token\u2019s list of bases. Regenerate the token at https://airtable.com/create/tokens with webhook:manage enabled and this base selected. Sync will fall back to LAST_MODIFIED_TIME polling until resolved.';
  }
  if (info.status === 401) {
    return 'Airtable rejected the token (401). It may have been revoked or expired. Reconnect from Settings to refresh credentials.';
  }
  if (info.status === 404 && info.url.includes('/webhooks/') && info.url.includes('/payloads')) {
    return 'The Airtable webhook expired (404). Airtable drops webhooks after 7 days of inactivity; the next sync will re-register automatically.';
  }
  return null;
}

// ─── Recent changes (per-record diffs) ──────────────────────────────────────

/**
 * Per-record diff captured by `ingestRecord` during update sync. Powers the
 * "Recent changes" panel — exactly the artifact you'd inspect to confirm
 * "I edited Status from Active → Inactive and the sync caught it."
 */
export interface RecentChange {
  /** Unix ms when the diff was observed by the fold. */
  ts: number;
  baseId: string;
  tableId: string;
  tableName: string;
  recordId: string;
  /** Best-effort human label for the record (display field value, falls back to recordId). */
  recordLabel?: string;
  diffs: Array<{ field: string; before: unknown; after: unknown }>;
}

// ─── Live "what's happening right now" snapshot ────────────────────────────

/**
 * Fine-grained snapshot of the current sync run, driven by SyncProgress events
 * emitted from the sync engine. Persisted to IndexedDB so the UI can restore
 * immediately after a refresh — `startedAt` is used to detect crashed runs.
 */
export interface CurrentSyncSnapshot {
  /** Unix ms when the sync started. */
  startedAt: number;
  phase: 'preparing' | 'discovering' | 'collecting' | 'fetching' | 'folding' | 'syncing' | 'table_done';
  strategy: SyncStrategy;
  preserveExisting: boolean;
  baseId?: string;
  baseName?: string;
  table?: string;
  tableId?: string;
  /** Records observed so far for the current table. */
  recordsSoFar: number;
  /** Airtable API URL currently being queried, when known. */
  endpoint?: string;
  /** ISO cursor used for this table's fetch. */
  cursorUsed?: string;
  /** Per-table roll-up accumulated during the run so the UI can show a live table. */
  perTable: Array<{
    table: string;
    tableId?: string;
    ingested: number;
    overwritten: number;
    skipped: number;
  }>;
}

/**
 * Configurable sync settings — persisted to Matrix room state
 * (`eo.airtable.config`) so all devices in the room share them.
 */
export interface AirtableSyncSettings {
  /** Seconds between automatic sync polls. Min 15, max 600, default 30. */
  syncIntervalSec: number;
  /** Whether to preserve existing EO-DB values (never overwrite). */
  preserveExisting: boolean;
  /** Maximum records per table per sync (0 = no limit). */
  recordLimit: number;
  /**
   * When true, refresh the Airtable schema manifest (bases → tables → fields)
   * before each sync run (both manual and continuous). When false, sync uses
   * the last discovered manifest and only records are fetched.
   */
  syncSchemaOnEachSync: boolean;
}

export const DEFAULT_SYNC_SETTINGS: AirtableSyncSettings = {
  syncIntervalSec: 30,
  preserveExisting: false,
  recordLimit: 0,
  syncSchemaOnEachSync: false,
};

export interface AirtableSyncState {
  /**
   * Credential token used to authenticate Airtable API calls.
   *
   * - When `viaAminoProxy` is true: a Matrix access token for
   *   `app.aminoimmigration.com`. The token is sent to the n8n
   *   `airtable-proxy-amino` webhook, which validates it before
   *   forwarding the request with n8n-side credentials. The user's
   *   browser never sees the actual Airtable PAT.
   * - When `viaAminoProxy` is false: a user-provided Airtable PAT sent
   *   as a Bearer token directly to `api.airtable.com`. Used by the
   *   "bring your own PAT" flow in ApiConnectionsView.
   *
   * In-memory only — never persisted to IndexedDB, localStorage, or
   * Matrix room state.
   */
  apiKey: string | null;
  /**
   * Whether `apiKey` should be treated as a Matrix access token and
   * routed through the amino n8n proxy. Set by `connectFromWebhook`
   * (the hosted-deployment path); cleared by `connectWithKey` and
   * `disconnect`.
   */
  viaAminoProxy: boolean;
  /** Whether we have a valid API key. */
  connected: boolean;
  /** Loading state during webhook call. */
  connecting: boolean;
  /** Last error message. */
  error: string | null;

  // ── Sync coordination ──
  /** Whether this client is currently running a sync. */
  isSyncing: boolean;
  /** Whether this client is the elected primary syncer. */
  isPrimarySyncer: boolean;
  /** ISO timestamp of last successful sync (any client, from room state). */
  lastSyncAt: string | null;
  /** Result of the last sync run by this client. */
  lastSyncResult: HydrationResult | UpdateSyncResult | null;
  /** Whether the continuous sync loop is enabled. */
  continuousSyncEnabled: boolean;
  /** Whether a remote device currently holds the sync lock (via to-device signal). */
  remoteLockHeld: boolean;

  // ── Sync activity log (newest first, capped at 100, persisted to IndexedDB) ──
  /** Ring-buffer of recent sync coordination events for all devices. */
  syncLog: SyncLogEntry[];

  // ── Live progress snapshot (null when idle) ──
  /** Granular snapshot of the currently-running sync — phase, table, endpoint, cursor, per-table counts. */
  currentSync: CurrentSyncSnapshot | null;
  /** Unix ms when the next continuous-sync tick is scheduled to fire (null if not scheduled). */
  nextTickAt: number | null;

  // ── Transparency telemetry ──
  /** Number of sync cycles (full + webhook polls) this browser session has run. Reset on disconnect. */
  cyclesThisSession: number;
  /** Snapshot of the most recent webhook /payloads response. */
  webhookHealth: WebhookHealth;
  /** Rolling buffer of per-record diffs (newest first), capped at 50. */
  recentChanges: RecentChange[];

  // ── Sync settings (shared across room via Matrix state) ──
  /** Configurable sync parameters. */
  syncSettings: AirtableSyncSettings;

  // ── Schema cache (in-memory) ──
  /** Discovered Airtable schema (bases/tables/fields). */
  manifest: HydrationManifest | null;

  // ── Actions ──
  /** Fetch the Airtable API key from the n8n webhook using the Matrix token. */
  connectFromWebhook: (matrixAccessToken: string) => Promise<void>;
  /** Set the API key directly. Verifies the key first. */
  connectWithKey: (apiKey: string) => Promise<void>;
  /** Clear the in-memory session. */
  disconnect: () => void;
  setManifest: (m: HydrationManifest | null) => void;
  setSyncing: (v: boolean) => void;
  setPrimarySyncer: (v: boolean) => void;
  setLastSyncAt: (ts: string) => void;
  setLastSyncResult: (r: HydrationResult | UpdateSyncResult | null) => void;
  setContinuousSync: (v: boolean) => void;
  setRemoteLockHeld: (v: boolean) => void;
  setSyncSettings: (s: Partial<AirtableSyncSettings>) => void;
  setError: (e: string | null) => void;
  addSyncLogEntry: (entry: SyncLogEntry) => void;
  clearSyncLog: () => void;
  /** Replace the in-memory log with `entries` — used to restore from IndexedDB on mount. */
  hydrateSyncLog: (entries: SyncLogEntry[]) => void;
  setCurrentSync: (snapshot: CurrentSyncSnapshot | null) => void;
  setNextTickAt: (ts: number | null) => void;
  /** Increment the session cycle counter — called once per sync tick. */
  incCycle: () => void;
  /** Replace the webhook health snapshot. Pass partial fields to merge. */
  setWebhookHealth: (h: Partial<WebhookHealth>) => void;
  /** Append a per-record diff observation (newest first, capped at 50). */
  addRecentChange: (change: RecentChange) => void;
  /** Wipe the recent-changes buffer (UI "clear" affordance). */
  clearRecentChanges: () => void;
}

/**
 * Connection ID for the legacy single-PAT Amino flow. Every existing
 * callsite that uses `useAirtableStore`'s singleton credentials is
 * conceptually operating on connection `"amino-default"`. Phase 4 adds
 * additional connection IDs (one per BYOPAT entry in ApiConnectionsView)
 * that read their credentials from `api-connection-store` instead of this
 * Zustand store.
 */
export const AMINO_CONNECTION_ID = 'amino-default';

/**
 * Build an `AirtableClient` that matches the current connection mode
 * (amino proxy vs direct PAT). Throws if no credentials are available.
 *
 * Defaults: reads `apiKey` and `viaAminoProxy` from the singleton store,
 * keeping the existing single-connection flow (Amino-room sync,
 * AirtableSettings.tsx, sync-service tick) working unchanged. Callers
 * that manage their own credentials — e.g. the multi-connection
 * ApiConnectionsView in Phase 4 of the consolidation — can override by
 * passing `apiKey` / `viaAminoProxy` / `aminoBaseId` explicitly. This is
 * the seam that lets multiple connections share one client implementation
 * without each carrying its own singleton store.
 */
export function createAirtableClient(
  opts: {
    onResponse?: AirtableResponseHook;
    ratePerSec?: number;
    /** Explicit PAT or Matrix access token; falls back to the singleton store. */
    apiKey?: string;
    /** When set, routes through the Amino n8n proxy; falls back to the store. */
    viaAminoProxy?: boolean;
    /** Required when viaAminoProxy is true and the caller wants a non-default base. */
    aminoBaseId?: string;
  } = {},
): AirtableClient {
  const store = useAirtableStore.getState();
  const apiKey = opts.apiKey ?? store.apiKey;
  if (!apiKey) {
    throw new Error('Airtable store is not connected — call connectFromWebhook or connectWithKey first');
  }
  const viaAminoProxy = opts.viaAminoProxy ?? store.viaAminoProxy;
  const aminoBaseId = opts.aminoBaseId ?? AMINO_AIRTABLE_BASE_ID;
  return new AirtableClient(apiKey, opts.ratePerSec ?? 4, {
    onResponse: opts.onResponse,
    viaAminoProxy,
    ...(viaAminoProxy ? { aminoBaseId } : {}),
  });
}

export const useAirtableStore = create<AirtableSyncState>((set, get) => ({
  apiKey: null,
  viaAminoProxy: false,
  connected: false,
  connecting: false,
  error: null,
  isSyncing: false,
  isPrimarySyncer: false,
  lastSyncAt: null,
  lastSyncResult: null,
  continuousSyncEnabled: false,
  remoteLockHeld: false,
  syncSettings: { ...DEFAULT_SYNC_SETTINGS },
  manifest: null,
  syncLog: [],
  currentSync: null,
  nextTickAt: null,
  cyclesThisSession: 0,
  webhookHealth: { ...EMPTY_WEBHOOK_HEALTH },
  recentChanges: [],

  async connectFromWebhook(matrixAccessToken: string): Promise<void> {
    set({ connecting: true, error: null });
    try {
      // Hosted-Amino path: every Airtable call goes through the n8n
      // EO/// DB Airtable Gateway (`webhook/eodb/airtable`), which
      // validates the Matrix access token against
      // `app.aminoimmigration.com` before forwarding to Airtable with
      // its own OAuth credential. The browser never sees an Airtable
      // PAT, and the gateway exposes only one pre-configured base.
      const client = new AirtableClient(matrixAccessToken, undefined, {
        viaAminoProxy: true,
        aminoBaseId: AMINO_AIRTABLE_BASE_ID,
      });
      // Validate by fetching the schema for the Amino base — this
      // round-trips the matrix token through the gateway's whoami check
      // and confirms the gateway can reach Airtable. The synthetic
      // `listBases` would succeed without a network call, which would
      // give us a false positive on auth failure.
      await client.getBaseSchema(AMINO_AIRTABLE_BASE_ID);
      resetWebhookPermissionCache();
      set({
        apiKey: matrixAccessToken,
        viaAminoProxy: true,
        connected: true,
        connecting: false,
      });
    } catch (e: any) {
      set({ connecting: false, error: e.message });
      throw e;
    }
  },

  async connectWithKey(apiKey: string): Promise<void> {
    set({ connecting: true, error: null });
    try {
      // Bring-your-own-PAT path: the token is a real Airtable PAT sent
      // directly to `api.airtable.com`. Not proxied.
      const client = new AirtableClient(apiKey);
      await client.listBases();
      resetWebhookPermissionCache();
      set({ apiKey, viaAminoProxy: false, connected: true, connecting: false, error: null });
    } catch (e: any) {
      set({ connecting: false, error: `Invalid Airtable API key: ${e.message}` });
      throw e;
    }
  },

  disconnect() {
    resetWebhookPermissionCache();
    set({
      apiKey: null,
      viaAminoProxy: false,
      connected: false,
      connecting: false,
      error: null,
      isSyncing: false,
      isPrimarySyncer: false,
      lastSyncResult: null,
      continuousSyncEnabled: false,
      remoteLockHeld: false,
      syncSettings: { ...DEFAULT_SYNC_SETTINGS },
      manifest: null,
      currentSync: null,
      nextTickAt: null,
      cyclesThisSession: 0,
      webhookHealth: { ...EMPTY_WEBHOOK_HEALTH },
      recentChanges: [],
    });
  },

  setManifest(m) { set({ manifest: m }); },
  setSyncing(v) { set({ isSyncing: v }); },
  setPrimarySyncer(v) { set({ isPrimarySyncer: v }); },
  setLastSyncAt(ts) { set({ lastSyncAt: ts }); },
  setLastSyncResult(r) { set({ lastSyncResult: r }); },
  setContinuousSync(v) { set({ continuousSyncEnabled: v }); },
  setRemoteLockHeld(v) { set({ remoteLockHeld: v }); },
  setSyncSettings(s) {
    set((state) => ({
      syncSettings: { ...state.syncSettings, ...s },
    }));
  },
  setError(e) { set({ error: e }); },
  addSyncLogEntry(entry) {
    set((state) => ({ syncLog: [entry, ...state.syncLog].slice(0, 100) }));
  },
  clearSyncLog() { set({ syncLog: [] }); },
  hydrateSyncLog(entries) {
    // Sort newest-first and cap to the ring-buffer size just in case the
    // caller passed an unsorted or oversized array.
    const sorted = [...entries].sort((a, b) => b.ts - a.ts).slice(0, 100);
    set({ syncLog: sorted });
  },
  setCurrentSync(snapshot) { set({ currentSync: snapshot }); },
  setNextTickAt(ts) { set({ nextTickAt: ts }); },
  incCycle() { set((state) => ({ cyclesThisSession: state.cyclesThisSession + 1 })); },
  setWebhookHealth(h) {
    set((state) => ({ webhookHealth: { ...state.webhookHealth, ...h } }));
  },
  addRecentChange(change) {
    set((state) => ({ recentChanges: [change, ...state.recentChanges].slice(0, 50) }));
  },
  clearRecentChanges() { set({ recentChanges: [] }); },
}));
