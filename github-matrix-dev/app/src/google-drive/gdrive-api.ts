/**
 * Google Drive API — n8n webhook proxy for EO-DB storage on Google Drive.
 *
 * All operations go through the n8n webhook at /webhook/eo-store.
 * The webhook authenticates via the Matrix access token (x-matrix-token header),
 * then uses its own Google Drive OAuth credentials to perform operations.
 *
 * Actions:
 *   store    — upload a file (content_hash-based naming, organized by data_type folder)
 *   retrieve — download a file by content_hash
 *   list     — list files, optionally filtered by data_type
 */

const EO_STORE_WEBHOOK = 'https://n8n.intelechia.com/webhook/eo-store';

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
// Low-level webhook caller
// ──────────────────────────────────────────────────────────────

async function callWebhook(
  matrixAccessToken: string,
  body: Record<string, unknown>,
): Promise<any> {
  console.log('[EO-DB] GDrive webhook call:', EO_STORE_WEBHOOK, 'action:', body.action);
  const res = await fetch(EO_STORE_WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-matrix-token': matrixAccessToken,
    },
    body: JSON.stringify(body),
  });
  console.log('[EO-DB] GDrive webhook response:', res.status, res.statusText);
  if (res.status === 401) {
    throw new Error('Unauthorized — Matrix token invalid or expired');
  }
  if (!res.ok) {
    const msg = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`EO Store webhook error: ${msg}`);
  }
  return res.json();
}

// ──────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────

/**
 * Store data on Google Drive via n8n.
 *
 * The webhook creates the file as `{content_hash}.json` inside a folder
 * named after `data_type`. The folder is auto-created by Google Drive node.
 */
export async function gdriveStore(
  matrixAccessToken: string,
  envelope: Record<string, unknown>,
  dataType: string,
  dataId: string,
  contentHash: string,
): Promise<GDriveStoreResult> {
  return callWebhook(matrixAccessToken, {
    action: 'store',
    data_type: dataType,
    data_id: dataId,
    envelope: {
      ...envelope,
      content_hash: contentHash,
    },
  });
}

/**
 * Retrieve data from Google Drive via n8n.
 * Looks up the file by content_hash.
 */
export async function gdriveRetrieve(
  matrixAccessToken: string,
  contentHash: string,
): Promise<GDriveRetrieveResult> {
  return callWebhook(matrixAccessToken, {
    action: 'retrieve',
    content_hash: contentHash,
  });
}

/**
 * List files stored on Google Drive via n8n.
 * Optionally filter by data_type (folder name).
 */
export async function gdriveList(
  matrixAccessToken: string,
  dataType?: string,
): Promise<GDriveListResult> {
  return callWebhook(matrixAccessToken, {
    action: 'list',
    ...(dataType ? { data_type: dataType } : {}),
  });
}

/**
 * Compute SHA-256 content hash for an envelope.
 * Used to generate deterministic filenames on Google Drive.
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
