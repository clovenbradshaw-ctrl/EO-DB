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
 * Store data on Google Drive.
 * Creates `{content_hash}.json` inside EO-DB/<dataType>/.
 */
export async function gdriveStore(
  matrixAccessToken: string,
  envelope: Record<string, unknown>,
  dataType: string,
  dataId: string,
  contentHash: string,
): Promise<GDriveStoreResult> {
  const folderId = await resolveDataFolder(matrixAccessToken, dataType);

  const fileContent = JSON.stringify({
    envelope: { ...envelope, content_hash: contentHash },
    data_id: dataId,
    data_type: dataType,
    stored_at: new Date().toISOString(),
  });

  // Create file with metadata + inline content via Drive API
  const metadata: Record<string, unknown> = {
    name: `${contentHash}.json`,
    parents: [folderId],
    description: `EO-DB backup | ${dataType} | ${dataId}`,
  };

  // Create the file (metadata only)
  const created = await driveProxy(matrixAccessToken, DRIVE_API, 'POST', metadata);

  // Upload content via media endpoint
  const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${created.id}?uploadType=media`;
  await driveProxy(matrixAccessToken, uploadUrl, 'PATCH', {
    _raw_content: fileContent,
  });

  console.log('[EO-DB] GDrive file created:', created.id, contentHash);
  return {
    ok: true,
    content_hash: contentHash,
    drive_file_id: created.id,
  };
}

/**
 * Retrieve data from Google Drive by content_hash.
 */
export async function gdriveRetrieve(
  matrixAccessToken: string,
  contentHash: string,
): Promise<GDriveRetrieveResult> {
  const q = `name='${contentHash}.json' and trashed=false`;
  const url = `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;
  const data = await driveProxy(matrixAccessToken, url);
  const files = data.files || [];
  if (!files.length) {
    throw new Error(`File not found: ${contentHash}`);
  }

  const downloadUrl = `${DRIVE_API}/${files[0].id}?alt=media`;
  const content = await driveProxy(matrixAccessToken, downloadUrl);
  return { ok: true, envelope: content.envelope || content };
}

/**
 * List files on Google Drive, optionally scoped to a dataType folder.
 * Shared across all space members.
 */
export async function gdriveList(
  matrixAccessToken: string,
  dataType?: string,
): Promise<GDriveListResult> {
  let q = "trashed=false and name contains '.json' and mimeType!='application/vnd.google-apps.folder'";

  if (dataType) {
    // Try to find the specific folder
    const rootId = await findFolder(matrixAccessToken, 'EO-DB');
    if (rootId) {
      const dataFolderId = await findFolder(matrixAccessToken, dataType, rootId);
      if (dataFolderId) {
        q = `'${dataFolderId}' in parents and trashed=false and name contains '.json'`;
      } else {
        // Folder doesn't exist yet — return empty
        return { ok: true, entries: [] };
      }
    } else {
      // No EO-DB root — return empty
      return { ok: true, entries: [] };
    }
  }

  const url = `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id,name,createdTime,parents)&spaces=drive&pageSize=100`;
  const data = await driveProxy(matrixAccessToken, url);
  const files = data.files || [];

  const entries: GDriveListEntry[] = files.map((f: any) => ({
    data_id: f.id,
    content_hash: (f.name || '').replace('.json', ''),
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
