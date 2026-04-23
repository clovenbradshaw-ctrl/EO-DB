/**
 * Google Drive API — client-side Drive logic using direct OAuth2 calls.
 *
 * All routing (find folder, create folder, upload file, list, retrieve)
 * happens here in the client. Files are organised by space:
 *   EO-DB / <dataType> /
 * where dataType is typically "eodb-<spaceId>".
 *
 * Files are stored as encrypted binary .eodb files,
 * encrypted with the room keyring (AES-256-GCM).
 *
 * Access control:
 *   1. Folder ID is stored in encrypted Matrix room state (eo.gdrive.folder)
 *      — only room members can read it.
 *   2. .eodb files are AES-256-GCM encrypted — the folder contents are
 *      opaque to anyone without the space keyring.
 *   3. The space folder has anyoneWithLink + writer sharing so all room
 *      members can read/write using their own Google OAuth token.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import {
  driveGet as _driveGet,
  driveMutation as _driveMutation,
  driveUploadBinary as _driveUploadBinary,
  driveUploadMultipart as _driveUploadMultipart,
  driveDownloadBinary as _driveDownloadBinary,
  driveShareAnyone,
} from './gdrive-direct';
import { readFolderState, publishFolderState } from './gdrive-folder-state';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
export const EO_STORE_WEBHOOK = 'https://n8n.intelechia.com/webhook/eo-store';

// ──────────────────────────────────────────────────────────────
// Sync-mode switching — n8n proxy (default) or direct OAuth
// ──────────────────────────────────────────────────────────────

let _syncMode: 'n8n' | 'oauth' = 'n8n';
let _activeSpaceRoomId: string | undefined;

/** Set the transport mode. Call whenever the user changes Drive Sync Mode in Settings. */
export function setSyncMode(mode: 'n8n' | 'oauth'): void {
  _syncMode = mode;
}

/**
 * Set the current space's Matrix main room ID for n8n membership verification.
 * Call whenever the user opens or switches spaces.
 */
export function setActiveSpaceRoomId(roomId: string | undefined): void {
  _activeSpaceRoomId = roomId;
}

// ──────────────────────────────────────────────────────────────
// n8n proxy helpers (base64 binary transport)
// ──────────────────────────────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function driveProxy(
  matrixToken: string,
  driveUrl: string,
  driveMethod = 'GET',
  driveBody?: Record<string, unknown> | null,
  spaceRoomId?: string,
): Promise<any> {
  const res = await fetch(EO_STORE_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      matrix_token: matrixToken,
      drive_url: driveUrl,
      drive_method: driveMethod,
      ...(spaceRoomId ? { space_room_id: spaceRoomId } : {}),
      ...(driveBody ? { drive_body: driveBody } : {}),
    }),
  });
  const text = await res.text();
  if (res.status === 401) throw new Error('Unauthorized — Matrix token invalid or expired');
  if (res.status === 403) throw new Error('Forbidden — not a member of this space');
  if (!text) return {};
  return JSON.parse(text);
}

// ──────────────────────────────────────────────────────────────
// Mode-dispatching transport wrappers
// ──────────────────────────────────────────────────────────────

async function driveGet(token: string, url: string): Promise<any> {
  if (_syncMode === 'n8n') return driveProxy(token, url, 'GET', null, _activeSpaceRoomId);
  return _driveGet(token, url);
}

async function driveMutation(
  token: string,
  url: string,
  method: string,
  body?: Record<string, unknown> | null,
): Promise<any> {
  if (_syncMode === 'n8n') return driveProxy(token, url, method, body ?? null, _activeSpaceRoomId);
  return _driveMutation(token, url, method, body ?? undefined);
}

async function driveUploadBinary(
  token: string,
  fileId: string,
  binary: Uint8Array,
  mimeType = 'application/octet-stream',
): Promise<void> {
  if (_syncMode === 'n8n') {
    const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
    await driveProxy(token, uploadUrl, 'PATCH', {
      _raw_content_base64: uint8ToBase64(binary),
      _content_type: mimeType,
    }, _activeSpaceRoomId);
    return;
  }
  return _driveUploadBinary(token, fileId, binary, mimeType);
}

async function driveUploadMultipart(
  token: string,
  metadata: Record<string, unknown>,
  binary: Uint8Array,
  mimeType = 'application/octet-stream',
): Promise<{ id: string }> {
  if (_syncMode === 'n8n') {
    const created = await driveProxy(token, DRIVE_API, 'POST', metadata, _activeSpaceRoomId);
    const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${created.id}?uploadType=media`;
    await driveProxy(token, uploadUrl, 'PATCH', {
      _raw_content_base64: uint8ToBase64(binary),
      _content_type: mimeType,
    }, _activeSpaceRoomId);
    return created;
  }
  return _driveUploadMultipart(token, metadata, binary, mimeType);
}

async function driveDownloadBinary(
  token: string,
  fileId: string,
  rangeHeader?: string,
): Promise<{ data: Uint8Array; contentRange?: string }> {
  if (_syncMode === 'n8n') {
    const downloadUrl = `${DRIVE_API}/${fileId}?alt=media`;
    if (rangeHeader) {
      const res = await fetch(EO_STORE_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Range': rangeHeader },
        body: JSON.stringify({
          matrix_token: token,
          drive_url: downloadUrl,
          drive_method: 'GET',
        }),
      });
      if (!res.ok && res.status !== 206) throw new Error(`Range request failed: ${res.status}`);
      const buffer = await res.arrayBuffer();
      return { data: new Uint8Array(buffer), contentRange: res.headers.get('Content-Range') ?? undefined };
    }
    const content = await driveProxy(token, downloadUrl, 'GET', null, _activeSpaceRoomId);
    const b64 = content._raw_content_base64 || content;
    const data = typeof b64 === 'string' ? base64ToUint8(b64) : (b64 as Uint8Array);
    return { data };
  }
  return _driveDownloadBinary(token, fileId, rangeHeader);
}

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface GDriveStoreResult {
  ok: boolean;
  content_hash: string;
  drive_file_id: string;
}

export interface GDriveRetrieveResult {
  ok: boolean;
  envelope: any;
}

export interface GDriveListEntry {
  data_id: string;
  content_hash: string;
  data_type: string;
  stored_at: string;
  /** The raw Drive file name (e.g. "op-00000001.eodb"). */
  name: string;
}

export interface GDriveListResult {
  ok: boolean;
  entries: GDriveListEntry[];
}

// ──────────────────────────────────────────────────────────────
// Folder helpers
// ──────────────────────────────────────────────────────────────

/** Cache: "parentId/name" → folderId (avoids repeated lookups within a session). */
const folderIdCache = new Map<string, string>();

/** Clear the folder ID cache. Call this on every space switch. */
export function clearFolderIdCache(): void {
  folderIdCache.clear();
}

/**
 * Clear cache entries for a specific dataType only.
 * Call when a Drive folder may have been deleted mid-session so the next
 * resolveDataFolder call performs a fresh lookup and recreates it if needed.
 */
export function clearFolderCacheForDataType(dataType: string): void {
  for (const key of Array.from(folderIdCache.keys())) {
    if (key.endsWith(`/${dataType}`) || key === `space/${dataType}`) {
      folderIdCache.delete(key);
    }
  }
}

/**
 * Find a folder by name, optionally inside a parent. Returns ID or null.
 */
async function findFolder(
  token: string,
  name: string,
  parentId?: string,
): Promise<string | null> {
  const cacheKey = `${parentId || 'root'}/${name}`;
  const cached = folderIdCache.get(cacheKey);
  if (cached) return cached;

  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const url = `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;
  const data = await driveGet(token, url);
  const files = data.files || [];
  if (files.length > 0) {
    folderIdCache.set(cacheKey, files[0].id);
    return files[0].id;
  }
  return null;
}

/**
 * Create a folder, optionally inside a parent. Returns the new ID.
 */
async function createFolder(
  token: string,
  name: string,
  parentId?: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) body.parents = [parentId];
  const data = await driveMutation(token, DRIVE_API, 'POST', body);
  const cacheKey = `${parentId || 'root'}/${name}`;
  folderIdCache.set(cacheKey, data.id);
  return data.id;
}

/**
 * Find or create a folder by name inside an optional parent.
 */
async function ensureFolder(
  token: string,
  name: string,
  parentId?: string,
): Promise<string> {
  const existing = await findFolder(token, name, parentId);
  if (existing) return existing;
  return createFolder(token, name, parentId);
}

/**
 * Resolve the shared space folder for a given dataType.
 *
 * For the first run (no room state event yet), creates EO-DB/<dataType>/,
 * enables anyoneWithLink + writer sharing, then publishes the folder ID
 * to Matrix room state so other members can find it.
 *
 * On subsequent calls (or for other members joining later), reads the
 * folder ID directly from Matrix room state.
 */
export async function resolveSpaceFolder(
  token: string,
  dataType: string,
  matrixClient: MatrixClient,
  mainRoomId: string,
): Promise<string> {
  // Check in-memory cache first (warm path)
  const cacheKey = `space/${dataType}`;
  const cached = folderIdCache.get(cacheKey);
  if (cached) return cached;

  // Read from Matrix room state
  const fromRoomState = readFolderState(matrixClient, mainRoomId);
  if (fromRoomState) {
    folderIdCache.set(cacheKey, fromRoomState);
    return fromRoomState;
  }

  // First-time setup: create the folder, share it (OAuth mode only), publish to room state
  const rootId = await ensureFolder(token, 'EO-DB');
  const folderId = await ensureFolder(token, dataType, rootId);
  // In n8n mode the proxy owns the Drive OAuth credentials, so sharing is
  // already implicit — skip driveShareAnyone (which requires a Google token).
  if (_syncMode === 'oauth') await driveShareAnyone(token, folderId);
  // Extract spaceId from dataType (convention: "eodb-{spaceId}")
  const spaceId = dataType.startsWith('eodb-') ? dataType.slice('eodb-'.length) : dataType;
  await publishFolderState(matrixClient, mainRoomId, spaceId, folderId).catch(e => {
    // Non-fatal: other members can still set the folder state later
    console.warn('[EO-DB] Could not publish folder state to Matrix room:', e);
  });
  folderIdCache.set(cacheKey, folderId);
  return folderId;
}

/**
 * Resolve folder path: EO-DB / <dataType>
 * Used when no matrixClient is available (legacy list/retrieve calls).
 * Does NOT enable sharing or publish to room state.
 */
async function resolveDataFolder(
  token: string,
  dataType: string,
): Promise<string> {
  const cacheKey = `space/${dataType}`;
  const cached = folderIdCache.get(cacheKey);
  if (cached) return cached;
  const rootId = await ensureFolder(token, 'EO-DB');
  const folderId = await ensureFolder(token, dataType, rootId);
  folderIdCache.set(cacheKey, folderId);
  return folderId;
}

// ──────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────

/**
 * Find an existing file by name inside a folder. Returns file ID or null.
 */
async function findFileInFolder(
  token: string,
  fileName: string,
  folderId: string,
): Promise<string | null> {
  const q = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
  const url = `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`;
  const data = await driveGet(token, url);
  const files = data.files || [];
  return files.length > 0 ? files[0].id : null;
}

/**
 * Store encrypted .eodb binary on Google Drive.
 * Creates or overwrites `{content_hash}.eodb` inside EO-DB/<dataType>/.
 */
export async function gdriveStore(
  googleAccessToken: string,
  encryptedBinary: Uint8Array,
  dataType: string,
  dataId: string,
  contentHash: string,
): Promise<GDriveStoreResult> {
  const folderId = await resolveDataFolder(googleAccessToken, dataType);
  const fileName = `${contentHash}.eodb`;

  const existingId = await findFileInFolder(googleAccessToken, fileName, folderId);

  let fileId: string;

  if (existingId) {
    fileId = existingId;
    console.log('[EO-DB] GDrive overwriting .eodb file:', fileId, contentHash);
    await driveUploadBinary(googleAccessToken, fileId, encryptedBinary);
  } else {
    const metadata: Record<string, unknown> = {
      name: fileName,
      parents: [folderId],
      mimeType: 'application/octet-stream',
      description: `EO-DB encrypted backup | ${dataType} | ${dataId}`,
    };
    const created = await driveUploadMultipart(googleAccessToken, metadata, encryptedBinary);
    fileId = created.id;
    console.log('[EO-DB] GDrive .eodb file created:', fileId, contentHash);
  }

  return {
    ok: true,
    content_hash: contentHash,
    drive_file_id: fileId,
  };
}

/**
 * Retrieve encrypted .eodb binary from Google Drive by content_hash.
 */
export async function gdriveRetrieve(
  googleAccessToken: string,
  contentHash: string,
): Promise<GDriveRetrieveResult> {
  const qEodb = `name='${contentHash}.eodb' and trashed=false`;
  const urlEodb = `${DRIVE_API}?q=${encodeURIComponent(qEodb)}&fields=files(id,name)&spaces=drive`;
  const dataEodb = await driveGet(googleAccessToken, urlEodb);
  let files = dataEodb.files || [];

  if (!files.length) {
    // Legacy: fall back to .json files
    const qJson = `name='${contentHash}.json' and trashed=false`;
    const urlJson = `${DRIVE_API}?q=${encodeURIComponent(qJson)}&fields=files(id,name)&spaces=drive`;
    const dataJson = await driveGet(googleAccessToken, urlJson);
    files = dataJson.files || [];

    if (!files.length) throw new Error(`File not found: ${contentHash}`);

    // Legacy JSON — download and parse
    const { data } = await driveDownloadBinary(googleAccessToken, files[0].id);
    const text = new TextDecoder().decode(data);
    const parsed = JSON.parse(text);
    return { ok: true, envelope: parsed.envelope || parsed };
  }

  const { data } = await driveDownloadBinary(googleAccessToken, files[0].id);
  return { ok: true, envelope: data };
}

/**
 * List .eodb files on Google Drive, optionally scoped to a dataType folder.
 */
export async function gdriveList(
  googleAccessToken: string,
  dataType?: string,
): Promise<GDriveListResult> {
  let q = "trashed=false and (name contains '.eodb' or name contains '.json') and mimeType!='application/vnd.google-apps.folder'";

  if (dataType) {
    const rootId = await findFolder(googleAccessToken, 'EO-DB');
    if (rootId) {
      const dataFolderId = await findFolder(googleAccessToken, dataType, rootId);
      if (dataFolderId) {
        q = `'${dataFolderId}' in parents and trashed=false and (name contains '.eodb' or name contains '.json')`;
      } else {
        return { ok: true, entries: [] };
      }
    } else {
      return { ok: true, entries: [] };
    }
  }

  const url = `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id,name,createdTime,parents)&spaces=drive&pageSize=100`;
  const data = await driveGet(googleAccessToken, url);
  const files = data.files || [];

  const entries: GDriveListEntry[] = files.map((f: any) => ({
    data_id: f.id,
    content_hash: (f.name || '').replace(/\.(eodb|json)$/, ''),
    data_type: dataType || 'unknown',
    stored_at: f.createdTime || '',
    name: f.name || '',
  }));

  return { ok: true, entries };
}

/**
 * Store binary on Google Drive under an explicit filename (not content-hash-derived).
 * Creates or overwrites `{fileName}` inside EO-DB/<dataType>/.
 * Used for op-{seq}.eodb, hydration-{slot}.eodb, etc.
 */
export async function gdriveStoreNamed(
  googleAccessToken: string,
  binary: Uint8Array,
  dataType: string,
  fileName: string,
): Promise<{ ok: boolean; drive_file_id: string }> {
  const doStore = async (): Promise<{ ok: boolean; drive_file_id: string }> => {
    const folderId = await resolveDataFolder(googleAccessToken, dataType);
    const existingId = await findFileInFolder(googleAccessToken, fileName, folderId);

    let fileId: string;
    if (existingId) {
      fileId = existingId;
      console.log('[EO-DB] GDrive overwriting named file:', fileName);
      await driveUploadBinary(googleAccessToken, fileId, binary);
    } else {
      const metadata: Record<string, unknown> = {
        name: fileName,
        parents: [folderId],
        mimeType: 'application/octet-stream',
      };
      const created = await driveUploadMultipart(googleAccessToken, metadata, binary);
      fileId = created.id;
      console.log('[EO-DB] GDrive created named file:', fileName, fileId);
    }
    return { ok: true, drive_file_id: fileId };
  };

  try {
    return await doStore();
  } catch (e) {
    // Drive folder may have been deleted (stale cache). Clear cache and retry once —
    // resolveDataFolder will create a new folder automatically.
    console.warn('[EO-DB] gdriveStoreNamed failed, clearing folder cache and retrying:', fileName, e);
    clearFolderCacheForDataType(dataType);
  }

  // Transient-failure retry: HTML responses from proxies/captive portals, 5xx
  // gateway errors, and network hiccups. Retrying through the full doStore() is
  // safe because findFileInFolder() detects any partially-created file and
  // switches to the idempotent PATCH path on the next attempt — no duplicates.
  let lastError: unknown;
  const backoffsMs = [500, 1500, 4000];
  for (let attempt = 0; attempt < backoffsMs.length; attempt++) {
    try {
      return await doStore();
    } catch (e) {
      lastError = e;
      if (!isTransientDriveError(e)) break;
      const delay = backoffsMs[attempt];
      console.warn(
        `[EO-DB] gdriveStoreNamed transient failure (attempt ${attempt + 1}/${backoffsMs.length}), retrying in ${delay}ms:`,
        fileName,
        (e as Error).message ?? e,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function isTransientDriveError(e: unknown): boolean {
  if (!e) return false;
  if ((e as { isTransient?: boolean }).isTransient) return true;
  const msg = (e as Error).message ?? '';
  // Drive API checkStatus messages include the status code; retry on 5xx and 429.
  if (/\b(500|502|503|504|429)\b/.test(msg)) return true;
  if (/network|failed to fetch|load failed/i.test(msg)) return true;
  return false;
}

/**
 * List files in EO-DB/<dataType>/ whose names start with the given prefix.
 */
export async function gdriveListByPrefix(
  googleAccessToken: string,
  dataType: string,
  prefix: string,
): Promise<GDriveListResult> {
  const rootId = await findFolder(googleAccessToken, 'EO-DB');
  if (!rootId) return { ok: true, entries: [] };
  const dataFolderId = await findFolder(googleAccessToken, dataType, rootId);
  if (!dataFolderId) return { ok: true, entries: [] };

  const q = `'${dataFolderId}' in parents and trashed=false and name contains '${prefix}'`;
  const url = `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id,name,createdTime)&spaces=drive&pageSize=1000`;
  const data = await driveGet(googleAccessToken, url);
  const files = data.files || [];

  const entries: GDriveListEntry[] = files.map((f: any) => ({
    data_id: f.id,
    content_hash: (f.name || '').replace(/\.(eodb|json)$/, ''),
    data_type: dataType,
    stored_at: f.createdTime || '',
    name: f.name || '',
  }));

  return { ok: true, entries };
}

/**
 * Trash (soft-delete) a Drive file by its file ID.
 */
export async function gdriveDeleteFile(
  googleAccessToken: string,
  fileId: string,
): Promise<void> {
  const url = `${DRIVE_API}/${fileId}`;
  await driveMutation(googleAccessToken, url, 'PATCH', { trashed: true });
}

/**
 * Store a JSON object as a named file in EO-DB/<dataType>/.
 * Used for coordination files like bake-intent-{userId}.json.
 */
export async function gdriveStoreJson(
  googleAccessToken: string,
  dataType: string,
  fileName: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; drive_file_id: string }> {
  const text = JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);

  const doStore = async (): Promise<{ ok: boolean; drive_file_id: string }> => {
    const folderId = await resolveDataFolder(googleAccessToken, dataType);
    const existingId = await findFileInFolder(googleAccessToken, fileName, folderId);

    let fileId: string;
    if (existingId) {
      fileId = existingId;
      await driveUploadBinary(googleAccessToken, fileId, bytes, 'application/json');
    } else {
      const metadata: Record<string, unknown> = {
        name: fileName,
        parents: [folderId],
        mimeType: 'application/json',
      };
      const created = await driveUploadMultipart(googleAccessToken, metadata, bytes, 'application/json');
      fileId = created.id;
    }
    return { ok: true, drive_file_id: fileId };
  };

  try {
    return await doStore();
  } catch (e) {
    // Drive folder may have been deleted (stale cache). Clear cache and retry once.
    console.warn('[EO-DB] gdriveStoreJson failed, clearing folder cache and retrying:', fileName, e);
    clearFolderCacheForDataType(dataType);
    return doStore();
  }
}

/**
 * Download and parse a named JSON file from EO-DB/<dataType>/.
 * Returns null if the file does not exist.
 */
export async function gdriveReadJson(
  googleAccessToken: string,
  dataType: string,
  fileName: string,
): Promise<Record<string, unknown> | null> {
  const rootId = await findFolder(googleAccessToken, 'EO-DB');
  if (!rootId) return null;
  const dataFolderId = await findFolder(googleAccessToken, dataType, rootId);
  if (!dataFolderId) return null;
  const fileId = await findFileInFolder(googleAccessToken, fileName, dataFolderId);
  if (!fileId) return null;

  const { data } = await driveDownloadBinary(googleAccessToken, fileId);
  return JSON.parse(new TextDecoder().decode(data));
}

/**
 * Download a named file from EO-DB/<dataType>/ by file name.
 * Returns null if the file does not exist.
 */
export async function gdriveRetrieveNamed(
  googleAccessToken: string,
  dataType: string,
  fileName: string,
): Promise<{ ok: boolean; data: Uint8Array; fileId?: string } | null> {
  const folderId = await resolveDataFolder(googleAccessToken, dataType).catch(() => null);
  if (!folderId) return null;
  const fileId = await findFileInFolder(googleAccessToken, fileName, folderId);
  if (!fileId) return null;

  const { data } = await driveDownloadBinary(googleAccessToken, fileId);
  return { ok: true, data, fileId };
}

/**
 * Download a byte range from a named binary file in EO-DB/<dataType>/.
 * Returns null if the file does not exist.
 */
export async function gdriveRetrieveRange(
  googleAccessToken: string,
  dataType: string,
  fileName: string,
  fromByte: number,
  toByte?: number,
): Promise<{ ok: boolean; data: Uint8Array; contentRange?: string } | null> {
  const folderId = await resolveDataFolder(googleAccessToken, dataType).catch(() => null);
  if (!folderId) return null;
  const fileId = await findFileInFolder(googleAccessToken, fileName, folderId);
  if (!fileId) return null;

  const rangeHeader = toByte !== undefined
    ? `bytes=${fromByte}-${toByte}`
    : `bytes=${fromByte}-`;

  try {
    const { data, contentRange } = await driveDownloadBinary(googleAccessToken, fileId, rangeHeader);
    return { ok: true, data, contentRange };
  } catch {
    return null;
  }
}

/**
 * Derive a stable, deterministic UUID for a space's Drive file.
 *
 * Uses SHA-256 of "eo-db:space-file:{spaceId}:{role}", formatted as UUID v4.
 * Because the derivation is deterministic, all space members independently
 * compute the same GUID — no coordination needed.
 *
 * @param spaceId  The space's internal ID (e.g. "space_amino")
 * @param role     File role: "log" | "recent" | "manifest" | "restricted-log" | etc.
 */
export async function deriveSpaceFileGuid(spaceId: string, role: string): Promise<string> {
  const input = `eo-db:space-file:${spaceId}:${role}`;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const bytes = new Uint8Array(hash).slice(0, 16);
  // Set UUID v4 version and RFC 4122 variant bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Compute SHA-256 content hash for deterministic filenames.
 */
export async function computeContentHash(data: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
