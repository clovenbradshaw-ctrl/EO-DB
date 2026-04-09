/**
 * Google Drive session store — Zustand store for Google Drive sync state.
 *
 * Each user authenticates with Google OAuth2 directly in the browser (PKCE).
 * Tokens are stored in localStorage by gdrive-oauth.ts.
 */

import { create } from 'zustand';
import type { MatrixClient } from 'matrix-js-sdk';
import { gdriveList, type GDriveListEntry } from './gdrive-api';
import {
  isConnected as oauthIsConnected,
  getAccessToken,
  startOAuthFlow,
} from './gdrive-oauth';

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
  /** Google OAuth2 access token for Drive API calls. */
  googleAccessToken: string | null;
  /** Matrix client — used for reading/writing folder state to room state. */
  matrixClient: MatrixClient | null;
  /** Matrix main room ID for the active space — used for folder state events. */
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

  /**
   * Connect to Google Drive via the user's own Google OAuth2 account (PKCE).
   * Opens a popup for sign-in if not already authenticated.
   * Stores the Matrix client and main room ID for folder state operations.
   */
  connect: (matrixClient: MatrixClient, mainRoomId: string) => Promise<void>;
  /** Disconnect (clear in-memory state, but keeps localStorage tokens). */
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

  async connect(matrixClient: MatrixClient, mainRoomId: string) {
    set({ connecting: true, error: null, matrixClient, mainRoomId });
    try {
      // Initiate OAuth2 PKCE flow if not already authenticated
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

      set({
        connected: true,
        connecting: false,
        googleAccessToken: token,
      });
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
      googleAccessToken: null,
      matrixClient: null,
      mainRoomId: null,
      currentSpaceId: null,
      spaceDisplayNames: {},
      lastSyncAt: {},
      cachedEntries: {},
    });
  },

  setCurrentSpace(spaceId: string, spaceName: string) {
    set({
      currentSpaceId: spaceId,
      spaceDisplayNames: { ...get().spaceDisplayNames, [spaceId]: spaceName },
      cachedEntries: {},
    });
  },

  recordSync(spaceId: string) {
    set({ lastSyncAt: { ...get().lastSyncAt, [spaceId]: new Date().toISOString() } });
  },

  async refreshEntries(dataType: string) {
    const { googleAccessToken } = get();
    if (!googleAccessToken) throw new Error('Not connected to Google Drive');
    const result = await gdriveList(googleAccessToken, dataType);
    const entries = result.entries || [];
    set({ cachedEntries: { ...get().cachedEntries, [dataType]: entries } });
    return entries;
  },

  setHydrationSlot(slot: number) {
    set({ hydrationSlot: slot });
  },

  setGDriveOffline(offline: boolean) {
    set({ gdriveOffline: offline });
  },

  setSpaceFileGuids(spaceId: string, guids: SpaceFileGuids) {
    set({ spaceFileGuids: { ...get().spaceFileGuids, [spaceId]: guids } });
  },
}));
