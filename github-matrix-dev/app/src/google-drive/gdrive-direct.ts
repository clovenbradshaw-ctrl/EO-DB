/**
 * Google Drive direct API calls — replaces the n8n driveProxy().
 *
 * All functions take a Google OAuth2 access token and call the Drive API
 * directly from the browser. Binary data is sent/received as Blob/ArrayBuffer
 * — no base64 encoding required (unlike the old n8n JSON proxy).
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function checkStatus(res: Response, context: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive API ${context}: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
  }
}

/**
 * Read a Response body as JSON with a useful error when the body isn't JSON.
 *
 * Drive occasionally returns HTML with a 2xx status — typically from an
 * intermediate proxy, captive portal, or session-expired redirect. In that
 * case `res.json()` throws `SyntaxError: Unexpected token '<'…`, which tells
 * the user nothing. This helper detects HTML, tags the error so callers can
 * recognize it as transient, and includes a body preview for diagnosis.
 */
async function parseJsonResponse<T = unknown>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = text.slice(0, 200).replace(/\s+/g, ' ').trim();
    const looksHtml = /^\s*<(!doctype|html|head|body)/i.test(text);
    const label = looksHtml
      ? 'Drive returned HTML instead of JSON (transient Google outage, proxy interference, or expired session — retry in a moment)'
      : 'Drive returned an unparseable response';
    const err = new Error(`Drive API ${context}: ${label} — ${preview}`);
    (err as Error & { isTransient?: boolean }).isTransient = true;
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────
// JSON operations
// ──────────────────────────────────────────────────────────────

/**
 * GET a Drive API URL, returning parsed JSON.
 */
export async function driveGet(token: string, url: string): Promise<any> {
  console.log('[EO-DB] Drive GET', url);
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return { files: [] };
  await checkStatus(res, `GET ${url}`);
  return parseJsonResponse(res, `GET ${url}`);
}

/**
 * POST/PATCH/DELETE a Drive API URL with a JSON body.
 */
export async function driveMutation(
  token: string,
  url: string,
  method: string,
  body?: Record<string, unknown> | null,
): Promise<any> {
  console.log('[EO-DB] Drive', method, url);
  const res = await fetch(url, {
    method,
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  await checkStatus(res, `${method} ${url}`);
  return parseJsonResponse(res, `${method} ${url}`);
}

// ──────────────────────────────────────────────────────────────
// Binary download
// ──────────────────────────────────────────────────────────────

/**
 * Download a Drive file as binary. Optionally request a byte range.
 * Returns the raw bytes and the Content-Range response header (for partial content).
 */
export async function driveDownloadBinary(
  token: string,
  fileId: string,
  rangeHeader?: string,
): Promise<{ data: Uint8Array; contentRange?: string }> {
  const url = `${DRIVE_API}/${fileId}?alt=media`;
  const headers: Record<string, string> = { ...authHeaders(token) };
  if (rangeHeader) headers['Range'] = rangeHeader;

  console.log('[EO-DB] Drive download binary', fileId, rangeHeader ?? '');
  const res = await fetch(url, { headers });

  if (res.status === 404) throw new Error(`Drive file not found: ${fileId}`);
  if (!res.ok && res.status !== 206) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive download ${fileId}: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
  }

  const buffer = await res.arrayBuffer();
  return {
    data: new Uint8Array(buffer),
    contentRange: res.headers.get('Content-Range') ?? undefined,
  };
}

// ──────────────────────────────────────────────────────────────
// Binary upload
// ──────────────────────────────────────────────────────────────

/**
 * Overwrite the content of an existing Drive file with binary data.
 * Uses the simple media upload endpoint (PATCH with ?uploadType=media).
 */
export async function driveUploadBinary(
  token: string,
  fileId: string,
  binary: Uint8Array,
  mimeType = 'application/octet-stream',
): Promise<void> {
  const url = `${DRIVE_UPLOAD_API}/${fileId}?uploadType=media`;
  console.log('[EO-DB] Drive upload binary', fileId, binary.length, 'bytes');
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...authHeaders(token), 'Content-Type': mimeType },
    body: new Blob([binary.buffer as ArrayBuffer], { type: mimeType }),
  });
  await checkStatus(res, `upload ${fileId}`);
}

/**
 * Create a new Drive file with metadata + binary content in one request.
 * Uses the multipart upload endpoint.
 * Returns the created file's ID.
 */
export async function driveUploadMultipart(
  token: string,
  metadata: Record<string, unknown>,
  binary: Uint8Array,
  mimeType = 'application/octet-stream',
): Promise<{ id: string }> {
  const boundary = `eodb-boundary-${Math.random().toString(36).slice(2)}`;
  const metaPart = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
  );
  const dataPart = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const closing = new TextEncoder().encode(`\r\n--${boundary}--`);

  const body = new Blob(
    [metaPart.buffer as ArrayBuffer, dataPart.buffer as ArrayBuffer, binary.buffer as ArrayBuffer, closing.buffer as ArrayBuffer],
    { type: `multipart/related; boundary=${boundary}` },
  );

  const url = `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id`;
  console.log('[EO-DB] Drive multipart upload', metadata.name, binary.length, 'bytes');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  await checkStatus(res, 'multipart upload');
  return parseJsonResponse<{ id: string }>(res, 'multipart upload');
}

/**
 * Grant anyoneWithLink write access to a Drive file or folder.
 * Used when setting up a new shared space folder.
 */
export async function driveShareAnyone(token: string, fileId: string): Promise<void> {
  const url = `${DRIVE_API}/${fileId}/permissions`;
  console.log('[EO-DB] Drive share anyoneWithLink writer', fileId);
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'anyone', role: 'writer' }),
  });
  await checkStatus(res, `share ${fileId}`);
}
