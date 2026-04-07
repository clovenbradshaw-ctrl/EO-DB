/**
 * Filen session management — credential fetching, login caching, folder scaffolding.
 *
 * Manages Filen auth sessions server-side. A local n8n webhook (or remote,
 * configured via N8N_WEBHOOK_URL) returns Filen username/password when called
 * with a Matrix access token. Sessions are cached in-memory (30-min TTL) to
 * avoid re-running PBKDF2 on every import.
 */

import {
  fetchFilenCredentialsFromWebhook,
  filenLogin,
  filenGetBaseFolder,
  filenEnsureFolder,
} from './filen-api.js';

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface FilenSession {
  apiKey: string;
  masterKeys: string[];
  uploadsFolderUuid: string;
  expiresAt: number;
}

// ──────────────────────────────────────────────────────────────
// Session cache
// ──────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const sessionCache = new Map<string, FilenSession>();

/**
 * Get or create a Filen session for a Matrix user.
 *
 * Flow:
 * 1. Check cache → return if valid
 * 2. Call n8n webhook with Matrix token → get Filen username/password
 * 3. Login to Filen → get apiKey + masterKeys
 * 4. Scaffold folder structure: /EO-DB/uploads/
 * 5. Cache and return
 */
export async function getFilenSession(
  matrixAccessToken: string,
  matrixUserId: string,
): Promise<FilenSession> {
  // Check cache
  const cached = sessionCache.get(matrixUserId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  // Fetch credentials from n8n webhook
  const creds = await fetchFilenCredentialsFromWebhook(matrixAccessToken);

  // Login to Filen
  const { apiKey, masterKeys } = await filenLogin(creds.username, creds.password);

  // Scaffold folder structure
  const baseFolderUuid = await filenGetBaseFolder(apiKey);
  const eodbFolderUuid = await filenEnsureFolder(apiKey, baseFolderUuid, 'EO-DB', masterKeys);
  const uploadsFolderUuid = await filenEnsureFolder(apiKey, eodbFolderUuid, 'uploads', masterKeys);

  const session: FilenSession = {
    apiKey,
    masterKeys,
    uploadsFolderUuid,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  sessionCache.set(matrixUserId, session);
  return session;
}

/**
 * Try to get a Filen session, returning null on failure.
 * Used for graceful degradation — import proceeds without Filen if auth fails.
 */
export async function tryGetFilenSession(
  matrixAccessToken: string,
  matrixUserId: string,
): Promise<FilenSession | null> {
  try {
    return await getFilenSession(matrixAccessToken, matrixUserId);
  } catch (e: any) {
    console.warn(`[EO-DB] Filen session failed for ${matrixUserId}: ${e.message}`);
    return null;
  }
}
