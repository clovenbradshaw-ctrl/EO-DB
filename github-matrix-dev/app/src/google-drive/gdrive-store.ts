/**
 * Google Drive session store — Zustand store for Google Drive sync state.
 *
 * Two sync modes are supported:
 *
 *   n8n (default) — Drive requests are proxied through the n8n webhook at
 *     https://n8n.intelechia.com/webhook/eo-store. The webhook validates the
 *     caller's Matrix access token and forwards Drive API calls using its own
 *     OAuth2 credentials. No Google credentials are needed client-side.
 *
 *   oauth (optional) — Each user authenticates with Google OAuth2 directly in
 *     the browser (PKCE). Tokens are stored in localStorage by gdrive-oauth.ts.
 *     Enable this in Settings → Drive Sync Mode.
 *
 * The active mode is persisted to localStorage ('eo-gdrive-sync-mode').
 */

import { create } from 'zustand';
import type { MatrixClient } from 'matrix-js-sdk';
import { gdriveList, setSyncMode as setApiSyncMode, type GDriveListEntry } from './gdrive-api';
import {
  isConnected as oauthIsConnected,
  getAccessToken,
  startOAuthFlow,
} from './gdrive-oauth';

const LS_SYNC_MODE = 'eo-gdrive-sync-mode';

function loadSyncMode(): 'n8n' | 'oauth' {
  const stored = localStorage.getItem(LS_SYNC_MODE);
  return stored === 'oauth' ? 'oauth' : 'n8n';
}

export interface SpaceFileGuids {
  log: string;
  recent: string;
  manifest: string;
}

export interface GDriveStoreState {
  /** Whether Google Drive is connected and ready. */
  connected: boolean;
  /** Loading state for connection. */
  connecting: boolean;
  /** Last error message. */
  error: string | null;
  /**
   * Active sync mode:
   *   'n8n'   — Matrix token proxied through n8n (default, no Google account needed)
   *   'oauth' — User's own Google OAuth2 token (optional, configure in Settings)
   */
  syncMode: 'n8n' | 'oauth';
  /** Matrix access token used in n8n proxy mode. */
  matrixAccessToken: string | null;
  /** Google OAuth2 access token used in direct OAuth mode. */
  googleAccessToken: string | null;
  /** Matrix client — used for reading/writing folder state to room state (oauth mode). */
  matrixClient: MatrixClient | null;
  /** Matrix main room ID for the active space. */
  mainRoomId: string | null;
  /** Currently active spaceId. */
  currentSpaceId: string | null;
  /** Space display names: spaceId -> name. */
  spaceDisplayNames: Record<string, string>;
  /** Last successful sync timestamp per space. */
  lastSyncAt: Record<string, string>;
  /** Cached file listings per data_type. */
  cachedEntries: Record<string, GDriveListEntry[]>;
  /** Active hydration slot (1–5 ring, 0 = not yet set). */
  hydrationSlot: number;
  /** True when GDrive is unreachable — app continues with local OPFS data. */
  gdriveOffline: boolean;
  /** Drive file GUIDs per spaceId — { log, recent, manifest }. */
  spaceFileGuids: Record<string, SpaceFileGuids>;

  /** Change the sync mode and persist it to localStorage. */
  setSyncMode: (mode: 'n8n' | 'oauth') => void;
  /**
   * Connect to Google Drive.
   *
   * In n8n mode (default): validates the Matrix access token against the n8n
   *   webhook. No Google credentials are needed.
   * In oauth mode: runs the Google OAuth2 PKCE flow if not already authenticated.
   *
   * @param matrixClient      Active Matrix client (used for room-state ops in oauth mode).
   * @param mainRoomId        Matrix room ID for the current space.
   * @param matrixAccessToken Matrix bearer token (required for n8n mode).
   */
  connect: (matrixClient: MatrixClient, mainRoomId: string, matrixAccessToken?: string) => Promise<void>;
  /** Disconnect (clear in-memory state). */
  disconnect: () => void;
  /** Set the current space. */
  setCurrentSpace: (spaceId: string, spaceName: string) => void;
  /** Record a successful sync for a space. */
  recordSync: (spaceId: string) => void;
  /** Refresh cached file list for a data_type. */
  refreshEntries: (dataType: string) => Promise<GDriveListEntry[]>;
  /** Update hydration slot after a bake. */
  setHydrationSlot: (slot: number) => void;
  /** Mark GDrive as offline or back online. */
  setGDriveOffline: (offline: boolean) => void;
  /** Store the computed file GUIDs for a space. */
  setSpaceFileGuids: (spaceId: string, guids: SpaceFileGuids) => void;
}

export const useGDriveStore = create<GDriveStoreState>((set, get) => ({
  connected: false,
  connecting: false,
  error: null,
  syncMode: loadSyncMode(),
  matrixAccessToken: null,
  googleAccessToken: null,
  matrixClient: null,
  mainRoomId: null,
  currentSpaceId: null,
  spaceDisplayNames: {},
  lastSyncAt: {},
  cachedEntries: {},
  hydrationSlot: 0,
  gdriveOffline: false,
  spaceFileGuids: {},

  setSyncMode(mode) {
    localStorage.setItem(LS_SYNC_MODE, mode);
    setApiSyncMode(mode);
    set({ syncMode: mode, connected: false, matrixAccessToken: null, googleAccessToken: null });
  },

  async connect(matrixClient, mainRoomId, matrixAccessToken) {
    const mode = get().syncMode;
    set({ connecting: true, error: null, matrixClient, mainRoomId });
    // Keep the api module in sync with the persisted mode
    setApiSyncMode(mode);

    try {
      if (mode === 'n8n') {
        // n8n proxy mode — only a Matrix access token is required
        const token = matrixAccessToken || matrixClient.getAccessToken() || '';
        if (!token) throw new Error('No Matrix access token available for n8n Drive proxy');

        // Validate by doing a lightweight list call through the proxy
        await gdriveList(token);

        set({ connected: true, connecting: false, matrixAccessToken: token });
      } else {
        // OAuth mode — run PKCE flow if not already authenticated
        if (!oauthIsConnected()) {
          await startOAuthFlow();
        }
        const token = await getAccessToken();

        // Ping Drive to confirm the token works
        await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
          headers: { Authorization: `Bearer ${token}` },
        }).then(async res => {
          if (!res.ok) throw new Error(`Drive ping failed: ${res.status}`);
        });

        set({ connected: true, connecting: false, googleAccessToken: token });
      }
    } catch (e: any) {
      set({ connecting: false, error: e.message });
      throw e;
    }
  },

  disconnect() {
    set({
      connected: false,
      connecting: false,
      error: null,
      matrixAccessToken: null,
      googleAccessToken: null,
      matrixClient: null,
      mainRoomId: null,
      currentSpaceId: null,
      spaceDisplayNames: {},
      lastSyncAt: {},
      cachedEntries: {},
    });
  },

  setCurrentSpace(spaceId, spaceName) {
    set({
      currentSpaceId: spaceId,
      spaceDisplayNames: { ...get().spaceDisplayNames, [spaceId]: spaceName },
      cachedEntries: {},
    });
  },

  recordSync(spaceId) {
    set({ lastSyncAt: { ...get().lastSyncAt, [spaceId]: new Date().toISOString() } });
  },

  async refreshEntries(dataType) {
    const { syncMode, matrixAccessToken, googleAccessToken } = get();
    const token = syncMode === 'n8n' ? matrixAccessToken : googleAccessToken;
    if (!token) throw new Error('Not connected to Google Drive');
    const result = await gdriveList(token, dataType);
    const entries = result.entries || [];
    set({ cachedEntries: { ...get().cachedEntries, [dataType]: entries } });
    return entries;
  },

  setHydrationSlot(slot) {
    set({ hydrationSlot: slot });
  },

  setGDriveOffline(offline) {
    set({ gdriveOffline: offline });
  },

  setSpaceFileGuids(spaceId, guids) {
    set({ spaceFileGuids: { ...get().spaceFileGuids, [spaceId]: guids } });
  },
}));
