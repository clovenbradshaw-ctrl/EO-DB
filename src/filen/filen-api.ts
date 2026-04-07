/**
 * Filen API — routes all file operations through the n8n webhook.
 *
 * All Filen credentials live on the n8n server. The EO-DB server never
 * touches Filen directly for file operations — it POSTs to the unified
 * n8n webhook which handles auth, encryption, and folder navigation.
 *
 * Endpoint: POST https://n8n.intelechia.com/webhook/filen
 * Actions: init, upload, download, list
 *
 * The socket listener (listener.ts) still connects to Filen directly
 * for real-time events — that's a persistent connection that can't be
 * routed through a webhook.
 */

const N8N_FILEN_WEBHOOK =
  process.env.N8N_FILEN_WEBHOOK || 'https://n8n.intelechia.com/webhook/filen';

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface FilenUploadResult {
  success: boolean;
  fileName?: string;
  remotePath?: string;
  size?: number;
  error?: string;
}

export interface FilenDownloadResult {
  success: boolean;
  fileName?: string;
  remotePath?: string;
  size?: number;
  data?: string;       // base64-encoded file content
  mimeType?: string;
  error?: string;
}

export interface FilenListEntry {
  name: string;
  type: 'file' | 'directory' | 'unknown';
  path: string;
  size: number | null;
}

export interface FilenListResult {
  success: boolean;
  path?: string;
  count?: number;
  entries?: FilenListEntry[];
  error?: string;
}

export interface FilenInitResult {
  success: boolean;
  created?: string[];
  error?: string;
}

// ──────────────────────────────────────────────────────────────
// Crypto helpers (local only — used for content hashing)
// ──────────────────────────────────────────────────────────────

export async function sha256(input: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ──────────────────────────────────────────────────────────────
// n8n webhook helpers
// ──────────────────────────────────────────────────────────────

function sanitizePath(p: string): string {
  return p.replace(/\.\./g, '').replace(/\/\//g, '/');
}

async function postJson(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(N8N_FILEN_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`n8n Filen webhook HTTP ${res.status}`);
  }
  return res.json();
}

// ──────────────────────────────────────────────────────────────
// Init — scaffold base directory structure
// ──────────────────────────────────────────────────────────────

export async function filenInit(): Promise<FilenInitResult> {
  return postJson({ action: 'init' });
}

// ──────────────────────────────────────────────────────────────
// Upload — send binary data to Filen via n8n
// ──────────────────────────────────────────────────────────────

export async function filenUpload(
  data: Uint8Array,
  fileName: string,
  options?: { spaceId?: string; subPath?: string },
): Promise<FilenUploadResult> {
  const formData = new FormData();
  formData.append('action', 'upload');
  if (options?.spaceId) formData.append('spaceId', sanitizePath(options.spaceId));
  if (options?.subPath) formData.append('subPath', sanitizePath(options.subPath));
  formData.append('fileName', fileName);
  formData.append('file', new Blob([data]), fileName);

  const res = await fetch(N8N_FILEN_WEBHOOK, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    throw new Error(`n8n Filen webhook HTTP ${res.status}`);
  }
  return res.json();
}

// ──────────────────────────────────────────────────────────────
// Download — fetch a file from Filen via n8n
// ──────────────────────────────────────────────────────────────

/**
 * Download by exact path within a space.
 *
 * NOTE: The n8n workflow must include `data` (base64) in the JSON
 * response for this to return file content. Add to the download
 * return in the Code node:
 *   json: { ..., data: buf.toString('base64') }
 */
export async function filenDownload(options: {
  path: string;
  spaceId?: string;
}): Promise<FilenDownloadResult> {
  return postJson({
    action: 'download',
    path: sanitizePath(options.path),
    spaceId: options.spaceId,
  });
}

/**
 * Download by searching for a filename within a space subtree.
 */
export async function filenDownloadSearch(options: {
  search: string;
  spaceId?: string;
  subPath?: string;
}): Promise<FilenDownloadResult> {
  return postJson({
    action: 'download',
    search: options.search,
    spaceId: options.spaceId,
    subPath: options.subPath,
  });
}

// ──────────────────────────────────────────────────────────────
// List — enumerate directory contents
// ──────────────────────────────────────────────────────────────

export async function filenList(options?: {
  spaceId?: string;
  subPath?: string;
  recursive?: boolean;
  filesOnly?: boolean;
  dirsOnly?: boolean;
}): Promise<FilenListResult> {
  return postJson({
    action: 'list',
    spaceId: options?.spaceId,
    subPath: options?.subPath ? sanitizePath(options.subPath) : undefined,
    recursive: options?.recursive,
    filesOnly: options?.filesOnly,
    dirsOnly: options?.dirsOnly,
  });
}
