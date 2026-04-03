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

interface PersistedSession {
  auth: FilenAuth;
  masterKeys: string[];
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

  /** Login to Filen and persist session. */
  login: (email: string, password: string, twofa?: string) => Promise<void>;
  /** Logout and clear persisted session. */
  logout: () => void;
  /** Restore session from localStorage (call on app mount). */
  restore: () => boolean;
  /** Ensure the /EO-DB/ root folder exists on Filen. */
  ensureEodbFolder: () => Promise<string>;
  /** Ensure a space subfolder exists under /EO-DB/. */
  ensureSpaceFolder: (spaceId: string, spaceName: string) => Promise<string>;
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

  recordSync(spaceId: string) {
    set({ lastSyncAt: { ...get().lastSyncAt, [spaceId]: new Date().toISOString() } });
  },
}));
