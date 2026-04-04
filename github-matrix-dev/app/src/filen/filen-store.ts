/**
 * Filen session store — Zustand store with localStorage persistence.
 *
 * Keeps the user logged into Filen across page reloads. Manages the /EO-DB/
 * root folder and per-space subfolders so the sync service can just call
 * `ensureSpaceFolder()` and start uploading.
 */

import { create } from 'zustand';
import {
  filenLogin as apiLogin,
  filenGetBaseFolder,
  filenEnsureFolder,
  type FilenAuth,
  type LoginResult,
} from './filen-api';

const STORAGE_KEY = 'eo-filen-session';
const EODB_ROOT_FOLDER = 'EO-DB';
const FILEN_GATEWAY = 'https://gateway.filen.io';

interface PersistedSession {
  auth: FilenAuth;
  masterKeys: string[];
  baseFolderUuid: string;
  eodbFolderUuid: string;
}

/** Config stored in Matrix room state event `eo.filen.config`. */
export interface FilenOrgConfig {
  email: string;
  apiKey: string;
  masterKey: string;
  baseFolderUuid: string;
  eodbFolderUuid: string;
}

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
  /** Whether Filen is connected and ready. */
  connected: boolean;
  /** Loading state for login. */
  connecting: boolean;
  /** Last error message. */
  error: string | null;
  /** Last successful sync timestamp per space. */
  lastSyncAt: Record<string, string>;
  /** True when creds come from Matrix room state (shared org account). */
  isOrgMode: boolean;
  /** Admin's email in org mode (for display). */
  orgEmail: string | null;

  /** Login to Filen and persist session. */
  login: (email: string, password: string, twofa?: string) => Promise<void>;
  /** Logout and clear persisted session. */
  logout: () => void;
  /** Restore session from localStorage (call on app mount). */
  restore: () => boolean;
  /** Restore from Matrix room state (org mode — no localStorage). */
  restoreFromRoomState: (config: FilenOrgConfig) => Promise<void>;
  /** Ensure the /EO-DB/ root folder exists on Filen. */
  ensureEodbFolder: () => Promise<string>;
  /** Ensure a space subfolder exists under /EO-DB/. */
  ensureSpaceFolder: (spaceId: string, spaceName: string) => Promise<string>;
  /** Ensure space folder + private subfolder for org mode. */
  ensureSpaceFolderOrg: (spaceId: string, spaceName: string, userId: string) => Promise<{ spaceFolderUuid: string; privateFolderUuid: string }>;
  /** Record a successful sync for a space. */
  recordSync: (spaceId: string) => void;
}

export const useFilenStore = create<FilenStoreState>((set, get) => ({
  auth: null,
  masterKeys: [],
  baseFolderUuid: '',
  eodbFolderUuid: '',
  spaceFolders: {},
  connected: false,
  connecting: false,
  error: null,
  lastSyncAt: {},
  isOrgMode: false,
  orgEmail: null,

  async login(email: string, password: string, twofa?: string) {
    set({ connecting: true, error: null });
    try {
      const result: LoginResult = await apiLogin(email, password, twofa);
      const auth: FilenAuth = { apiKey: result.apiKey, email };
      const baseFolderUuid = await filenGetBaseFolder(result.apiKey);

      // Ensure /EO-DB/ folder exists
      const eodbFolderUuid = await filenEnsureFolder(
        result.apiKey, baseFolderUuid, EODB_ROOT_FOLDER, result.masterKeys,
      );

      const session: PersistedSession = {
        auth,
        masterKeys: result.masterKeys,
        baseFolderUuid,
        eodbFolderUuid,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));

      set({
        auth,
        masterKeys: result.masterKeys,
        baseFolderUuid,
        eodbFolderUuid,
        connected: true,
        connecting: false,
      });
    } catch (e: any) {
      set({ connecting: false, error: e.message });
      throw e;
    }
  },

  logout() {
    localStorage.removeItem(STORAGE_KEY);
    set({
      auth: null,
      masterKeys: [],
      baseFolderUuid: '',
      eodbFolderUuid: '',
      spaceFolders: {},
      connected: false,
      connecting: false,
      error: null,
      lastSyncAt: {},
      isOrgMode: false,
      orgEmail: null,
    });
  },

  restore(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const session: PersistedSession = JSON.parse(raw);
      if (!session.auth?.apiKey || !session.masterKeys?.length) {
        localStorage.removeItem(STORAGE_KEY);
        return false;
      }
      set({
        auth: session.auth,
        masterKeys: session.masterKeys,
        baseFolderUuid: session.baseFolderUuid,
        eodbFolderUuid: session.eodbFolderUuid,
        connected: true,
      });
      return true;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
  },

  async restoreFromRoomState(config: FilenOrgConfig): Promise<void> {
    set({ connecting: true, error: null });
    try {
      // Verify session is still valid
      const res = await fetch(`${FILEN_GATEWAY}/v3/user/info`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: '{}',
      });
      const data = await res.json();

      let apiKey = config.apiKey;
      if (!data.status) {
        // Token expired — try re-login if we have creds in account_data
        // For now, just fail; the admin can update the config
        throw new Error('Filen API key expired — admin needs to update eo.filen.config');
      }

      const auth: FilenAuth = { apiKey, email: config.email };
      set({
        auth,
        masterKeys: [config.masterKey],
        baseFolderUuid: config.baseFolderUuid,
        eodbFolderUuid: config.eodbFolderUuid,
        connected: true,
        connecting: false,
        isOrgMode: true,
        orgEmail: config.email,
      });
      // Do NOT persist to localStorage — creds come from Matrix room state each session
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
    // Use space name as folder name (sanitize for filesystem safety)
    const safeName = spaceName.replace(/[^\w\s-]/g, '').trim() || spaceId;
    const uuid = await filenEnsureFolder(auth.apiKey, parentUuid, safeName, masterKeys);
    set({ spaceFolders: { ...get().spaceFolders, [spaceId]: uuid } });
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
