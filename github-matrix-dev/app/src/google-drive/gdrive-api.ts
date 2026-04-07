/**
 * Google Drive API — client-side Drive logic, proxied through n8n for OAuth.
 *
 * The n8n webhook at /webhook/eo-store is a thin proxy:
 *   1. Validates the Matrix access token (body.matrix_token)
 *   2. Forwards { drive_url, drive_method, drive_body } to the Google Drive API
 *      using its own OAuth2 credentials
 *   3. Returns the Drive API response verbatim
 *
 * All routing (find folder, create folder, upload file, list, retrieve)
 * happens here in the client. Files are organized by space:
 *   EO-DB / <dataType> /
 * where dataType is typically "eodb-<spaceId>".
 *
 * Files are stored as encrypted binary .eodb files (same format as Filen),
 * encrypted with the room keyring (AES-256-GCM) — no Filen-specific encryption.
 *
 * Binary data is base64-encoded for transport through the JSON proxy.
 * The proxy decodes `_raw_content_base64` back to binary before uploading,
 * and base64-encodes binary responses in `_raw_content_base64`.
 *
 * Access control is enforced by Matrix — only authenticated users can
 * call the webhook. Sharing works naturally: all space members can
 * read/write the same space folder.
 */

const EO_STORE_WEBHOOK = 'https://n8n.intelechia.com/webhook/eo-store';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';

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
}

export interface GDriveListResult {
  ok: boolean;
  entries: GDriveListEntry[];
}

// ──────────────────────────────────────────────────────────────
// Binary ↔ base64 helpers (for JSON proxy transport)
// ──────────────────────────────────────────────────────────────

/** Convert Uint8Array to base64 (safe for large arrays). */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Convert base64 string to Uint8Array. */
function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ──────────────────────────────────────────────────────────────
// Low-level proxy caller
// ──────────────────────────────────────────────────────────────

/**
 * Send a Drive API request through the n8n proxy.
 * The proxy validates Matrix token then forwards to Google Drive with OAuth creds.
 */
async function driveProxy(
  matrixAccessToken: string,
  driveUrl: string,
  driveMethod: string = 'GET',
  driveBody?: Record<string, unknown> | null,
): Promise<any> {
  console.log('[EO-DB] GDrive proxy:', driveMethod, driveUrl);
  const res = await fetch(EO_STORE_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      matrix_token: matrixAccessToken,
      drive_url: driveUrl,
      drive_method: driveMethod,
      ...(driveBody ? { drive_body: driveBody } : {}),
    }),
  });
  const text = await res.text();
  console.log('[EO-DB] GDrive proxy response:', res.status, text.slice(0, 300));
  if (res.status === 401) {
    throw new Error('Unauthorized — Matrix token invalid or expired');
  }
  if (!text) return {};
  return JSON.parse(text);
}

// ──────────────────────────────────────────────────────────────
// Folder helpers
// ──────────────────────────────────────────────────────────────

/** Cache: "parentId/name" → folderId (avoids repeated lookups within a session). */
const folderIdCache = new Map<string, string>();

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
  const data = await driveProxy(token, url);
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
  const data = await driveProxy(token, DRIVE_API, 'POST', body);
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
 * Resolve folder path: EO-DB / <dataType>
 * Shared by all users in the same space.
 */
async function resolveDataFolder(
  token: string,
  dataType: string,
): Promise<string> {
  const rootId = await ensureFolder(token, 'EO-DB');
  return ensureFolder(token, dataType, rootId);
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
  const data = await driveProxy(token, url);
  const files = data.files || [];
  return files.length > 0 ? files[0].id : null;
}

/**
 * Store encrypted .eodb binary on Google Drive.
 * Creates or overwrites `{content_hash}.eodb` inside EO-DB/<dataType>/.
 *
 * Binary is base64-encoded for transport through the JSON proxy.
 * The proxy decodes `_raw_content_base64` → raw binary before uploading.
 */
export async function gdriveStore(
  matrixAccessToken: string,
  encryptedBinary: Uint8Array,
  dataType: string,
  dataId: string,
  contentHash: string,
): Promise<GDriveStoreResult> {
  const folderId = await resolveDataFolder(matrixAccessToken, dataType);
  const fileName = `${contentHash}.eodb`;

  const base64Data = uint8ToBase64(encryptedBinary);

  // Check if a file with this name already exists in the folder
  const existingId = await findFileInFolder(matrixAccessToken, fileName, folderId);

  let fileId: string;

  if (existingId) {
    fileId = existingId;
    console.log('[EO-DB] GDrive overwriting .eodb file:', fileId, contentHash);
  } else {
    const metadata: Record<string, unknown> = {
      name: fileName,
      parents: [folderId],
      mimeType: 'application/octet-stream',
      description: `EO-DB encrypted backup | ${dataType} | ${dataId}`,
    };
    const created = await driveProxy(matrixAccessToken, DRIVE_API, 'POST', metadata);
    fileId = created.id;
    console.log('[EO-DB] GDrive .eodb file created:', fileId, contentHash);
  }

  // Upload binary via media endpoint (base64 for proxy transport)
  const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
  await driveProxy(matrixAccessToken, uploadUrl, 'PATCH', {
    _raw_content_base64: base64Data,
    _content_type: 'application/octet-stream',
  });

  return {
    ok: true,
    content_hash: contentHash,
    drive_file_id: fileId,
  };
}

/**
 * Retrieve encrypted .eodb binary from Google Drive by content_hash.
 * Falls back to legacy .json files for backward compatibility.
 */
export async function gdriveRetrieve(
  matrixAccessToken: string,
  contentHash: string,
): Promise<GDriveRetrieveResult> {
  // Try .eodb first, fall back to legacy .json
  const qEodb = `name='${contentHash}.eodb' and trashed=false`;
  const urlEodb = `${DRIVE_API}?q=${encodeURIComponent(qEodb)}&fields=files(id,name)&spaces=drive`;
  const dataEodb = await driveProxy(matrixAccessToken, urlEodb);
  let files = dataEodb.files || [];
  let isBinary = true;

  if (!files.length) {
    const qJson = `name='${contentHash}.json' and trashed=false`;
    const urlJson = `${DRIVE_API}?q=${encodeURIComponent(qJson)}&fields=files(id,name)&spaces=drive`;
    const dataJson = await driveProxy(matrixAccessToken, urlJson);
    files = dataJson.files || [];
    isBinary = false;
  }

  if (!files.length) {
    throw new Error(`File not found: ${contentHash}`);
  }

  const downloadUrl = `${DRIVE_API}/${files[0].id}?alt=media`;
  const content = await driveProxy(matrixAccessToken, downloadUrl);

  if (isBinary) {
    // Proxy returns base64-encoded binary in _raw_content_base64
    const b64 = content._raw_content_base64 || content;
    const binary = typeof b64 === 'string' ? base64ToUint8(b64) : b64;
    return { ok: true, envelope: binary };
  }

  // Legacy JSON format
  return { ok: true, envelope: content.envelope || content };
}

/**
 * List .eodb files on Google Drive, optionally scoped to a dataType folder.
 * Also picks up legacy .json files for backward compatibility.
 */
export async function gdriveList(
  matrixAccessToken: string,
  dataType?: string,
): Promise<GDriveListResult> {
  let q = "trashed=false and (name contains '.eodb' or name contains '.json') and mimeType!='application/vnd.google-apps.folder'";

  if (dataType) {
    const rootId = await findFolder(matrixAccessToken, 'EO-DB');
    if (rootId) {
      const dataFolderId = await findFolder(matrixAccessToken, dataType, rootId);
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
  const data = await driveProxy(matrixAccessToken, url);
  const files = data.files || [];

  const entries: GDriveListEntry[] = files.map((f: any) => ({
    data_id: f.id,
    content_hash: (f.name || '').replace(/\.(eodb|json)$/, ''),
    data_type: dataType || 'unknown',
    stored_at: f.createdTime || '',
  }));

  return { ok: true, entries };
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
