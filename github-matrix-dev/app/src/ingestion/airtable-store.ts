/**
 * Airtable sync store — Zustand store for browser-side Airtable integration.
 *
 * The Airtable API key is delivered via the n8n credentials webhook (validated
 * via Matrix access token). It is held in-memory only — never persisted to
 * IndexedDB, localStorage, or Matrix room state.
 */

import { create } from 'zustand';
import { AirtableClient } from './airtable-client';
import type { HydrationManifest, HydrationResult, UpdateSyncResult, SyncStrategy } from './airtable-sync';

// ─── Sync activity log ──────────────────────────────────────────────────────

export type SyncLogEventType =
  | 'lock_acquired'
  | 'lock_released'
  | 'sync_complete'
  | 'hydration_complete'
  | 'sync_error'
  | 'sync_start'
  /** Raw pre-fold bundle was uploaded to Drive as provenance. */
  | 'provenance_uploaded';

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
  /** What triggers a sync check: 'lastModified' uses Airtable's LAST_MODIFIED_TIME,
   *  'fullDiff' re-fetches all and diffs locally (more thorough but heavier). */
  syncStrategy: 'lastModified' | 'fullDiff';
  /** Whether to preserve existing EO-DB values (never overwrite). */
  preserveExisting: boolean;
  /** Maximum records per table per sync (0 = no limit). */
  recordLimit: number;
}

export const DEFAULT_SYNC_SETTINGS: AirtableSyncSettings = {
  syncIntervalSec: 30,
  syncStrategy: 'lastModified',
  preserveExisting: false,
  recordLimit: 0,
};

export interface AirtableSyncState {
  /** Airtable Personal Access Token (in-memory only, from webhook). */
  apiKey: string | null;
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
}

export const useAirtableStore = create<AirtableSyncState>((set, get) => ({
  apiKey: null,
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

  async connectFromWebhook(matrixAccessToken: string): Promise<void> {
    set({ connecting: true, error: null });
    try {
      // Fetch credentials from the n8n webhook (validates Matrix token server-side)
      const CREDS_WEBHOOK = 'https://n8n.intelechia.com/webhook/2caa4b94-873d-4a78-9770-d73a4d5b3c79';
      const res = await fetch(CREDS_WEBHOOK, {
        headers: { Authorization: `Bearer ${matrixAccessToken}` },
      });
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = null; }
      const key = data?.['airtable PAT'] || data?.airtablePat;
      if (!key) {
        throw new Error('Webhook did not return an Airtable API key');
      }
      // Verify the key is valid by making a lightweight API call
      const client = new AirtableClient(key);
      await client.listBases();
      set({ apiKey: key, connected: true, connecting: false });
    } catch (e: any) {
      set({ connecting: false, error: e.message });
      throw e;
    }
  },

  async connectWithKey(apiKey: string): Promise<void> {
    set({ connecting: true, error: null });
    try {
      const client = new AirtableClient(apiKey);
      await client.listBases();
      set({ apiKey, connected: true, connecting: false, error: null });
    } catch (e: any) {
      set({ connecting: false, error: `Invalid Airtable API key: ${e.message}` });
      throw e;
    }
  },

  disconnect() {
    set({
      apiKey: null,
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
}));
