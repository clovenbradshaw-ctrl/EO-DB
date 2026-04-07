/**
 * Google Drive session store — Zustand store for Google Drive sync state.
 *
 * Google Drive operations are proxied through the n8n webhook (/webhook/eo-store).
 * The webhook handles OAuth2 credentials; the client only needs a Matrix access token.
 * No Google credentials are stored client-side.
 */

import { create } from 'zustand';
import { gdriveList, type GDriveListEntry } from './gdrive-api';

export interface GDriveStoreState {
  /** Whether Google Drive is connected and ready. */
  connected: boolean;
  /** Loading state for connection. */
  connecting: boolean;
  /** Last error message. */
  error: string | null;
  /** Matrix access token used for webhook auth. */
  matrixAccessToken: string | null;
  /** Currently active spaceId. */
  currentSpaceId: string | null;
  /** Space display names: spaceId -> name. */
  spaceDisplayNames: Record<string, string>;
  /** Last successful sync timestamp per space. */
  lastSyncAt: Record<string, string>;
  /** Cached file listings per data_type. */
  cachedEntries: Record<string, GDriveListEntry[]>;

  /** Connect to Google Drive via the n8n webhook (validates Matrix token). */
  connect: (matrixAccessToken: string) => Promise<void>;
  /** Disconnect (clear in-memory state). */
  disconnect: () => void;
  /** Set the current space. */
  setCurrentSpace: (spaceId: string, spaceName: string) => void;
  /** Record a successful sync for a space. */
  recordSync: (spaceId: string) => void;
  /** Refresh cached file list for a data_type. */
  refreshEntries: (dataType: string) => Promise<GDriveListEntry[]>;
}

export const useGDriveStore = create<GDriveStoreState>((set, get) => ({
  connected: false,
  connecting: false,
  error: null,
  matrixAccessToken: null,
  currentSpaceId: null,
  spaceDisplayNames: {},
  lastSyncAt: {},
  cachedEntries: {},

  async connect(matrixAccessToken: string) {
    set({ connecting: true, error: null });
    try {
      // Validate the token works by doing a list call
      await gdriveList(matrixAccessToken);
      set({
        connected: true,
        connecting: false,
        matrixAccessToken,
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
      matrixAccessToken: null,
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
    });
  },

  recordSync(spaceId: string) {
    set({ lastSyncAt: { ...get().lastSyncAt, [spaceId]: new Date().toISOString() } });
  },

  async refreshEntries(dataType: string) {
    const { matrixAccessToken } = get();
    if (!matrixAccessToken) throw new Error('Not connected to Google Drive');
    const result = await gdriveList(matrixAccessToken, dataType);
    const entries = result.entries || [];
    set({ cachedEntries: { ...get().cachedEntries, [dataType]: entries } });
    return entries;
  },
}));
