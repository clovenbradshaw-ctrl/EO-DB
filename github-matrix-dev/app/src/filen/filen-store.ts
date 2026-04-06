/**
 * Filen session store — Zustand store for the shared org-mode Filen session.
 *
 * Credentials are fetched at runtime from the n8n webhook using the caller's
 * Matrix access token (see `connectOrgFromWebhook`). No credentials are
 * persisted to localStorage or to Matrix room state.
 */

import { create } from 'zustand';
import {
  filenLogin as apiLogin,
  filenGetBaseFolder,
  filenEnsureFolder,
  filenFindFolder,
  filenCreateFolder,
  fetchFilenCredentialsFromWebhook,
  type FilenAuth,
} from './filen-api';

const EODB_ROOT_FOLDER = 'EO-DB';

/** Timestamp of the last successful API key validation. */
let lastValidatedAt = 0;

export interface FilenStoreState {
  /** Current auth (null = not logged in). */
  auth: FilenAuth | null;
  /** Master keys for decrypting metadata. */
  masterKeys: string[];
  /** Filen root folder UUID. */
  baseFolderUuid: string;
  /** /EO-DB/ folder UUID. */
  eodbFolderUuid: string;
  /** Cached space folder UUIDs: spaceId -> folderUuid. */
  spaceFolders: Record<string, string>;
  /** Human-readable display names: folderUuid -> spaceName. */
  spaceDisplayNames: Record<string, string>;
  /** Whether Filen is connected and ready. */
  connected: boolean;
  /** Loading state for login. */
  connecting: boolean;
  /** Last error message. */
  error: string | null;
  /** Last successful sync timestamp per space. */
  lastSyncAt: Record<string, string>;
  /** True when creds come from the n8n webhook (shared org account). */
  isOrgMode: boolean;
  /** Shared account email in org mode (for display). */
  orgEmail: string | null;
  /** Currently active spaceId (set by ensureSpaceFolder). */
  currentSpaceId: string | null;
  /** Airtable API key from the webhook (transient, not persisted). */
  webhookAirtableKey: string | null;

  /** Fetch shared Filen creds from the n8n webhook and connect in org mode. */
  connectOrgFromWebhook: (matrixAccessToken: string) => Promise<void>;
  /** Reset the session (in-memory only — no persisted state). */
  disconnect: () => void;
  /** Ensure the /EO-DB/ root folder exists on Filen. */
  ensureEodbFolder: () => Promise<string>;
  /** Ensure a space subfolder exists under /EO-DB/. */
  ensureSpaceFolder: (spaceId: string, spaceName: string) => Promise<string>;
  /** Ensure space folder + private subfolder for org mode. */
  ensureSpaceFolderOrg: (spaceId: string, spaceName: string, userId: string) => Promise<{ spaceFolderUuid: string; privateFolderUuid: string }>;
  /** Record a successful sync for a space. */
  recordSync: (spaceId: string) => void;
}

/** Derive a deterministic UUID-like folder name from a spaceId using SHA-256. */
async function spaceIdToFolderName(spaceId: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(spaceId));
  const hex = Array.from(new Uint8Array(hash).slice(0, 16))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const useFilenStore = create<FilenStoreState>((set, get) => ({
  auth: null,
  masterKeys: [],
  baseFolderUuid: '',
  eodbFolderUuid: '',
  spaceFolders: {},
  spaceDisplayNames: {},
  connected: false,
  connecting: false,
  error: null,
  lastSyncAt: {},
  isOrgMode: false,
  orgEmail: null,
  currentSpaceId: null,
  webhookAirtableKey: null,

  disconnect() {
    set({
      auth: null,
      masterKeys: [],
      baseFolderUuid: '',
      eodbFolderUuid: '',
      spaceFolders: {},
      spaceDisplayNames: {},
      connected: false,
      connecting: false,
      error: null,
      lastSyncAt: {},
      isOrgMode: false,
      orgEmail: null,
      webhookAirtableKey: null,
    });
  },

  async connectOrgFromWebhook(matrixAccessToken: string): Promise<void> {
    set({ connecting: true, error: null });
    try {
      const webhookResult = await fetchFilenCredentialsFromWebhook(matrixAccessToken);
      const { username, password } = webhookResult;
      // Surface the Airtable API key so callers can pass it to the Airtable store.
      if (webhookResult.airtable_api_key) {
        set({ webhookAirtableKey: webhookResult.airtable_api_key });
      }
      const result = await apiLogin(username, password);
      const baseFolderUuid = await filenGetBaseFolder(result.apiKey);
      const eodbFolderUuid = await filenEnsureFolder(
        result.apiKey, baseFolderUuid, EODB_ROOT_FOLDER, result.masterKeys,
      );
      const auth: FilenAuth = { apiKey: result.apiKey, email: username };
      set({
        auth,
        masterKeys: result.masterKeys,
        baseFolderUuid,
        eodbFolderUuid,
        connected: true,
        connecting: false,
        isOrgMode: true,
        orgEmail: username,
      });
      lastValidatedAt = Date.now();
    } catch (e: any) {
      set({ connecting: false, error: e.message });
      throw e;
    }
  },

  async ensureEodbFolder(): Promise<string> {
    const { auth, baseFolderUuid, eodbFolderUuid, masterKeys } = get();
    if (eodbFolderUuid) return eodbFolderUuid;
    if (!auth) throw new Error('Not connected to Filen');

    const uuid = await filenEnsureFolder(
      auth.apiKey, baseFolderUuid, EODB_ROOT_FOLDER, masterKeys,
    );
    set({ eodbFolderUuid: uuid });
    return uuid;
  },

  async ensureSpaceFolder(spaceId: string, spaceName: string): Promise<string> {
    const { auth, eodbFolderUuid, masterKeys, spaceFolders } = get();
    if (spaceFolders[spaceId]) return spaceFolders[spaceId];
    if (!auth) throw new Error('Not connected to Filen');

    const parentUuid = eodbFolderUuid || await get().ensureEodbFolder();

    // Use a deterministic UUID derived from spaceId for anonymized folder names
    const anonName = await spaceIdToFolderName(spaceId);

    // Try the new UUID-based name first
    let uuid = await filenFindFolder(auth.apiKey, parentUuid, anonName, masterKeys);
    if (!uuid) {
      // Fall back to legacy readable name (migration for existing folders)
      const legacyName = spaceName.replace(/[^\w\s-]/g, '').trim() || spaceId;
      uuid = await filenFindFolder(auth.apiKey, parentUuid, legacyName, masterKeys);
    }
    if (!uuid) {
      // Neither exists — create with anonymized name
      uuid = await filenCreateFolder(auth.apiKey, parentUuid, anonName, masterKeys[0]);
    }

    // Cache folder UUID, display name, and mark as current space
    set({
      spaceFolders: { ...get().spaceFolders, [spaceId]: uuid },
      spaceDisplayNames: { ...get().spaceDisplayNames, [uuid]: spaceName },
      currentSpaceId: spaceId,
    });
    return uuid;
  },

  async ensureSpaceFolderOrg(spaceId: string, spaceName: string, userId: string) {
    const spaceFolderUuid = await get().ensureSpaceFolder(spaceId, spaceName);
    const { auth, masterKeys } = get();
    if (!auth) throw new Error('Not connected to Filen');

    // Ensure /EO-DB/{spaceName}/private/ exists
    const privateDirUuid = await filenEnsureFolder(auth.apiKey, spaceFolderUuid, 'private', masterKeys);
    // Ensure /EO-DB/{spaceName}/private/{userId}/ exists
    const safeUserId = userId.replace(/[^\w@.:_-]/g, '_');
    const userPrivateUuid = await filenEnsureFolder(auth.apiKey, privateDirUuid, safeUserId, masterKeys);

    return { spaceFolderUuid, privateFolderUuid: userPrivateUuid };
  },

  recordSync(spaceId: string) {
    set({ lastSyncAt: { ...get().lastSyncAt, [spaceId]: new Date().toISOString() } });
  },
}));
