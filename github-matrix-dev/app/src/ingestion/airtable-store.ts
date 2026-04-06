/**
 * Airtable sync store — Zustand store for browser-side Airtable integration.
 *
 * The Airtable API key is delivered via the same n8n webhook used for Filen
 * credentials. It is held in-memory only — never persisted to IndexedDB,
 * localStorage, or Matrix room state.
 *
 * Mirrors the pattern established by `filen/filen-store.ts`.
 */

import { create } from 'zustand';
import { fetchFilenCredentialsFromWebhook } from '../filen/filen-api';
import type { HydrationManifest, HydrationResult, UpdateSyncResult } from './airtable-sync';

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
  /** Whether the 30s continuous sync loop is enabled. */
  continuousSyncEnabled: boolean;

  // ── Schema cache (in-memory) ──
  /** Discovered Airtable schema (bases/tables/fields). */
  manifest: HydrationManifest | null;

  // ── Actions ──
  /** Fetch the Airtable API key from the n8n webhook using the Matrix token. */
  connectFromWebhook: (matrixAccessToken: string) => Promise<void>;
  /** Set the API key directly (when piggybacked from Filen webhook call). */
  connectWithKey: (apiKey: string) => void;
  /** Clear the in-memory session. */
  disconnect: () => void;
  setManifest: (m: HydrationManifest | null) => void;
  setSyncing: (v: boolean) => void;
  setPrimarySyncer: (v: boolean) => void;
  setLastSyncAt: (ts: string) => void;
  setLastSyncResult: (r: HydrationResult | UpdateSyncResult | null) => void;
  setContinuousSync: (v: boolean) => void;
  setError: (e: string | null) => void;
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
  manifest: null,

  async connectFromWebhook(matrixAccessToken: string): Promise<void> {
    set({ connecting: true, error: null });
    try {
      const result = await fetchFilenCredentialsFromWebhook(matrixAccessToken);
      const key = result.airtable_api_key;
      if (!key) {
        throw new Error('Webhook did not return an Airtable API key');
      }
      set({ apiKey: key, connected: true, connecting: false });
    } catch (e: any) {
      set({ connecting: false, error: e.message });
      throw e;
    }
  },

  connectWithKey(apiKey: string) {
    set({ apiKey, connected: true, connecting: false, error: null });
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
      manifest: null,
    });
  },

  setManifest(m) { set({ manifest: m }); },
  setSyncing(v) { set({ isSyncing: v }); },
  setPrimarySyncer(v) { set({ isPrimarySyncer: v }); },
  setLastSyncAt(ts) { set({ lastSyncAt: ts }); },
  setLastSyncResult(r) { set({ lastSyncResult: r }); },
  setContinuousSync(v) { set({ continuousSyncEnabled: v }); },
  setError(e) { set({ error: e }); },
}));
