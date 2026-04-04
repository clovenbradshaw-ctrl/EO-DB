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
  filenFindFolder,
  filenCreateFolder,
  type FilenAuth,
  type LoginResult,
} from './filen-api';

const STORAGE_KEY = 'eo-filen-session';
const EODB_ROOT_FOLDER = 'EO-DB';
const FILEN_GATEWAY = 'https://gateway.filen.io';
/** Only re-validate Filen API key if last check was more than 5 minutes ago. */
const VALIDATION_INTERVAL_MS = 5 * 60 * 1000;

interface PersistedSession {
  auth: FilenAuth;
  masterKeys: string[];
  baseFolderUuid: string;
  eodbFolderUuid: string;
  /** Base64-encoded password for automatic re-login on API key expiry. */
  savedPassword?: string;
}

/** Timestamp of the last successful API key validation. */
let lastValidatedAt = 0;

/** Config stored in Matrix room state event `eo.filen.config`. */
export interface FilenOrgConfig {
  email: string;
  apiKey: string;
  masterKey: string;
  baseFolderUuid: string;
  eodbFolderUuid: string;
  /** Base64-encoded password for automatic re-login on API key expiry. */
  savedPassword?: string;
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
  /** True when creds come from Matrix room state (shared org account). */
  isOrgMode: boolean;
  /** Admin's email in org mode (for display). */
  orgEmail: string | null;
  /** Currently active spaceId (set by ensureSpaceFolder). */
  currentSpaceId: string | null;

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
        savedPassword: btoa(password),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      lastValidatedAt = Date.now();

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
      spaceDisplayNames: {},
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
      // Optimistically set connected so the UI shows the session immediately,
      // then validate the API key in the background. If expired, try re-login.
      set({
        auth: session.auth,
        masterKeys: session.masterKeys,
        baseFolderUuid: session.baseFolderUuid,
        eodbFolderUuid: session.eodbFolderUuid,
        connected: true,
      });

      // Skip validation if we checked recently (avoids hammering on re-mounts)
      if (Date.now() - lastValidatedAt < VALIDATION_INTERVAL_MS) {
        return true;
      }

      // Background validation — try re-login on API key expiry
      fetch(`${FILEN_GATEWAY}/v3/user/info`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.auth.apiKey}`,
        },
        body: '{}',
      })
        .then(r => r.json())
        .then(async (d) => {
          if (d.status) {
            lastValidatedAt = Date.now();
            return;
          }
          // API key expired — attempt automatic re-login with saved credentials
          console.warn('[EO-DB] Filen API key expired — attempting re-login');
          if (session.savedPassword && session.auth.email) {
            try {
              await get().login(session.auth.email, atob(session.savedPassword));
              console.log('[EO-DB] Filen re-login successful');
            } catch (e) {
              console.warn('[EO-DB] Filen re-login failed — clearing session:', e);
              localStorage.removeItem(STORAGE_KEY);
              set({
                auth: null,
                masterKeys: [],
                baseFolderUuid: '',
                eodbFolderUuid: '',
                spaceFolders: {},
                connected: false,
                error: 'Filen session expired — please log in again',
              });
            }
          } else {
            console.warn('[EO-DB] Filen session expired — no saved credentials for re-login');
            localStorage.removeItem(STORAGE_KEY);
            set({
              auth: null,
              masterKeys: [],
              baseFolderUuid: '',
              eodbFolderUuid: '',
              spaceFolders: {},
              connected: false,
              error: 'Filen session expired — please log in again',
            });
          }
        })
        .catch(() => {
          // Network error — keep session, will retry on next sync cycle
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
      let masterKeys = [config.masterKey];

      if (!data.status) {
        // Token expired — auto re-login if saved password is available
        if (config.savedPassword) {
          console.log('[EO-DB] Filen API key expired — auto re-logging in');
          const result = await apiLogin(config.email, atob(config.savedPassword));
          apiKey = result.apiKey;
          masterKeys = result.masterKeys;
        } else {
          throw new Error('Filen API key expired — admin needs to update credentials');
        }
      }

      const auth: FilenAuth = { apiKey, email: config.email };
      set({
        auth,
        masterKeys,
        baseFolderUuid: config.baseFolderUuid,
        eodbFolderUuid: config.eodbFolderUuid,
        connected: true,
        connecting: false,
        isOrgMode: true,
        orgEmail: config.email,
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
