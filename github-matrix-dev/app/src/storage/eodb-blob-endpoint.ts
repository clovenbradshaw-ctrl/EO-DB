/**
 * Encrypted-blob transport.
 *
 * Two parallel backends share the same `BlobEnvelope` at-rest format:
 *
 *   - `'drive'`     — n8n `/webhook/eo-store` proxy → Google Drive. URIs are
 *                     `gdrive://{fileId}`. Pre-existing path.
 *   - `'matrix-media'` — direct upload to the homeserver's content repo via
 *                     `client.uploadContent`. URIs are `mxc://{server}/{id}`.
 *                     Phase 1 of the Matrix-primary-storage plan.
 *
 * Both backends store the same JSON `BlobEnvelope` at rest. Callers can pick
 * a backend per write and dispatch on URI scheme for reads.
 */

import { base64ToBuffer, bufferToBase64 } from '../crypto/segment-keys';

export const EO_STORE_WEBHOOK = 'https://n8n.intelechia.com/webhook/eo-store';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

const PROXY_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 8_000;

/**
 * On-disk envelope (Drive file body, JSON). `v: 1` is the legacy
 * uncompressed variant; `v: 2` adds `compression` and gzips the plaintext
 * before AES-GCM. `content_hash` and `plaintext_size` always refer to the
 * ORIGINAL plaintext (msgpack bytes) — i.e. pre-compression — so reads can
 * verify integrity after gunzip.
 */
export interface BlobEnvelope {
  v: 1 | 2;
  iv: string;
  ct: string;
  content_hash: string;
  key_id: string;
  plaintext_size: number;
  compression?: 'gzip' | 'none';
}

/**
 * Metadata carried alongside the raw ciphertext when uploading via the new
 * binary mode. The proxy re-wraps `{...meta, ct: base64(body)}` into the JSON
 * envelope above before PATCHing Drive, so the at-rest format is unchanged.
 */
export interface BlobUploadMeta {
  v: 2;
  iv: string;
  content_hash: string;
  key_id: string;
  plaintext_size: number;
  compression: 'gzip' | 'none';
}

export type BlobProbe = 'exists' | 'missing' | 'unknown';

export async function eodbBlobDataIdForRoom(roomId: string): Promise<string> {
  const bytes = new TextEncoder().encode(roomId);
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource),
  );
  let hex = '';
  for (let i = 0; i < hash.length; i++) hex += hash[i].toString(16).padStart(2, '0');
  return `eodb-${hex.slice(0, 40)}`;
}

export function dataIdToFileName(dataId: string): string {
  return `${dataId}.json`;
}

interface ProxyOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function driveProxy(
  matrixToken: string,
  driveUrl: string,
  driveMethod: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  driveBody: Record<string, unknown> | null,
  spaceRoomId: string | null,
  opts: ProxyOpts = {},
): Promise<{ status: number; body: unknown; raw: string }> {
  const timeoutMs = opts.timeoutMs ?? PROXY_TIMEOUT_MS;
  const res = await fetch(EO_STORE_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      matrix_token: matrixToken,
      drive_url: driveUrl,
      drive_method: driveMethod,
      ...(spaceRoomId ? { space_room_id: spaceRoomId } : {}),
      ...(driveBody ? { drive_body: driveBody } : {}),
    }),
  });
  const raw = await res.text();
  let body: unknown = null;
  if (raw) {
    try { body = JSON.parse(raw); } catch { body = raw; }
  }
  return { status: res.status, body, raw };
}

function escapeDriveQueryString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findDriveFileIdByName(
  matrixToken: string,
  fileName: string,
  spaceRoomId: string | null,
  opts: ProxyOpts = {},
): Promise<string | null> {
  const q = `name='${escapeDriveQueryString(fileName)}' and trashed=false`;
  const url =
    `${DRIVE_API}?q=${encodeURIComponent(q)}` +
    `&spaces=drive&fields=${encodeURIComponent('files(id,name,modifiedTime,size)')}` +
    `&pageSize=1`;
  const { status, body, raw } = await driveProxy(matrixToken, url, 'GET', null, spaceRoomId, opts);
  if (status === 401) throw new Error('Unauthorized — Matrix token invalid or expired');
  if (status === 403) throw new Error('Forbidden — not a member of this space');
  if (status < 200 || status >= 300) {
    throw new Error(`Drive list failed: HTTP ${status} ${raw.slice(0, 200)}`);
  }
  const files = (body as { files?: Array<{ id?: string }> } | null)?.files ?? [];
  return files[0]?.id ?? null;
}

export interface DriveStoreResult {
  fileId: string;
  uri: string;
  created: boolean;
}

export async function storeBlobToDrive(
  matrixToken: string,
  dataId: string,
  meta: BlobUploadMeta,
  ciphertext: Uint8Array,
  spaceRoomId: string | null,
): Promise<DriveStoreResult> {
  const fileName = dataIdToFileName(dataId);

  let fileId = await findDriveFileIdByName(matrixToken, fileName, spaceRoomId);
  let created = false;

  if (!fileId) {
    const { status, body, raw } = await driveProxy(
      matrixToken,
      DRIVE_API,
      'POST',
      { name: fileName, mimeType: 'application/json' },
      spaceRoomId,
    );
    if (status < 200 || status >= 300) {
      throw new Error(`Drive create failed: HTTP ${status} ${raw.slice(0, 200)}`);
    }
    const id = (body as { id?: string } | null)?.id;
    if (!id) throw new Error('Drive create returned no file id');
    fileId = id;
    created = true;
  }

  const uploadUrl = `${DRIVE_UPLOAD}/${encodeURIComponent(fileId)}?uploadType=media`;

  // Binary upload mode: ciphertext goes on the wire as raw bytes; metadata
  // travels in X-Eo-* headers. The proxy re-wraps it into the JSON envelope
  // expected at rest. Skips the +33% base64 + JSON-escape tax on the
  // browser→nginx hop, which is the only hop that's size-constrained.
  const res = await fetch(EO_STORE_WEBHOOK, {
    method: 'POST',
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Eo-Matrix-Token': matrixToken,
      ...(spaceRoomId ? { 'X-Eo-Space-Room-Id': spaceRoomId } : {}),
      'X-Eo-Drive-Url': uploadUrl,
      'X-Eo-Drive-Method': 'PATCH',
      'X-Eo-Envelope-Version': String(meta.v),
      'X-Eo-Iv': meta.iv,
      'X-Eo-Key-Id': meta.key_id,
      'X-Eo-Content-Hash': meta.content_hash,
      'X-Eo-Plaintext-Size': String(meta.plaintext_size),
      'X-Eo-Compression': meta.compression,
    },
    body: new Blob([ciphertext as BlobPart]),
  });
  const raw = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Drive media upload failed: HTTP ${res.status} ${raw.slice(0, 200)}`);
  }

  return { fileId, uri: `gdrive://${fileId}`, created };
}

export interface DriveFetchResult {
  fileId: string;
  uri: string;
  envelope: BlobEnvelope;
}

export async function fetchBlobFromDrive(
  matrixToken: string,
  dataId: string,
  spaceRoomId: string | null,
): Promise<DriveFetchResult | null> {
  const fileName = dataIdToFileName(dataId);
  const fileId = await findDriveFileIdByName(matrixToken, fileName, spaceRoomId);
  if (!fileId) return null;

  const downloadUrl = `${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media`;
  const res = await fetch(EO_STORE_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    body: JSON.stringify({
      matrix_token: matrixToken,
      drive_url: downloadUrl,
      drive_method: 'GET',
      ...(spaceRoomId ? { space_room_id: spaceRoomId } : {}),
    }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Drive download failed: HTTP ${res.status}`);
  const text = await res.text();
  if (!text) return null;
  let envelope: BlobEnvelope;
  try {
    envelope = JSON.parse(text) as BlobEnvelope;
  } catch (e) {
    throw new Error(`Drive download returned non-JSON body: ${(e as Error).message}`);
  }
  return { fileId, uri: `gdrive://${fileId}`, envelope };
}

/** gzip a buffer using the browser CompressionStream API. */
export async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** Inverse of gzipBytes. */
export async function gunzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Probe whether a room's blob has ever been written. Used by the client
 * before minting a fresh space key — if a ciphertext blob already exists,
 * we must wait for key delivery instead of generating a divergent key that
 * would overwrite unreadable data.
 *
 * `exists` = a Drive file with that name was found.
 * `missing` = no matching file.
 * `unknown` = anything else (network error, 5xx, timeout) — callers should
 *             treat this as "do not generate" to stay safe.
 */
export async function probeBlobExists(
  matrixToken: string,
  roomId: string,
  dataId: string,
): Promise<BlobProbe> {
  try {
    const fileName = dataIdToFileName(dataId);
    const fileId = await findDriveFileIdByName(matrixToken, fileName, roomId, {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return fileId ? 'exists' : 'missing';
  } catch {
    return 'unknown';
  }
}

/**
 * Round-trip the proxy with a low-cost call (a list query that filters to a
 * sentinel filename) to confirm reachability and Matrix auth without
 * mutating any Drive state. Returns the upstream HTTP status as observed by
 * the client.
 */
/* ── Matrix-media backend ─────────────────────────────────────────── */

export type BlobBackend = 'drive' | 'matrix-media';

/** Inspect a stored-blob URI and report which backend can read it. */
export function backendForUri(uri: string): BlobBackend | null {
  if (uri.startsWith('mxc://')) return 'matrix-media';
  if (uri.startsWith('gdrive://')) return 'drive';
  return null;
}

export interface MatrixMediaStoreResult {
  uri: string;       // mxc://{server}/{mediaId}
  created: boolean;  // always true — Matrix media uploads always mint a new id
}

export interface MatrixMediaFetchResult {
  uri: string;
  envelope: BlobEnvelope;
}

/** Minimal subset of MatrixClient used by the Matrix-media backend. */
export interface MatrixMediaClient {
  uploadContent(
    file: Blob,
    opts?: { name?: string; type?: string },
  ): Promise<{ content_uri: string }>;
  mxcUrlToHttp(mxc: string): string | null;
}

/**
 * Upload an encrypted blob to the homeserver's content repo. Body is the
 * same JSON `BlobEnvelope` that the Drive backend stores at rest, so a
 * reader doesn't care which backend wrote it.
 */
export async function storeBlobToMatrixMedia(
  client: MatrixMediaClient,
  meta: BlobUploadMeta,
  ciphertext: Uint8Array,
  opts: { name?: string } = {},
): Promise<MatrixMediaStoreResult> {
  const envelope: BlobEnvelope = {
    v: meta.v,
    iv: meta.iv,
    ct: bufferToBase64(ciphertext),
    content_hash: meta.content_hash,
    key_id: meta.key_id,
    plaintext_size: meta.plaintext_size,
    compression: meta.compression,
  };
  const json = new TextEncoder().encode(JSON.stringify(envelope));
  const body = new Blob([json as BlobPart], { type: 'application/json' });
  const result = await client.uploadContent(body, {
    name: opts.name ?? 'eo-blob.json',
    type: 'application/json',
  });
  return { uri: result.content_uri, created: true };
}

/** Download and parse an mxc-stored blob envelope. */
export async function fetchBlobFromMatrixMedia(
  client: MatrixMediaClient,
  mxcUri: string,
): Promise<MatrixMediaFetchResult | null> {
  const httpUrl = client.mxcUrlToHttp(mxcUri);
  if (!httpUrl) return null;
  const res = await fetch(httpUrl, {
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Matrix media fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  if (!text) return null;
  let envelope: BlobEnvelope;
  try {
    envelope = JSON.parse(text) as BlobEnvelope;
  } catch (e) {
    throw new Error(`Matrix media returned non-JSON body: ${(e as Error).message}`);
  }
  return { uri: mxcUri, envelope };
}

/**
 * Unified reader. Dispatches by URI scheme — `gdrive://` → Drive proxy,
 * `mxc://` → homeserver content repo. Returns null if the URI scheme is
 * unrecognized or the blob is missing.
 */
export async function fetchBlobByUri(
  opts: {
    matrixToken: string;
    spaceRoomId: string | null;
    mediaClient?: MatrixMediaClient;
    /** For `gdrive://` URIs we still need the dataId to find the file. */
    dataId?: string;
  },
  uri: string,
): Promise<{ uri: string; envelope: BlobEnvelope } | null> {
  const backend = backendForUri(uri);
  if (backend === 'matrix-media') {
    if (!opts.mediaClient) throw new Error('fetchBlobByUri: mediaClient required for mxc:// URIs');
    return fetchBlobFromMatrixMedia(opts.mediaClient, uri);
  }
  if (backend === 'drive') {
    if (!opts.dataId) throw new Error('fetchBlobByUri: dataId required for gdrive:// URIs');
    return fetchBlobFromDrive(opts.matrixToken, opts.dataId, opts.spaceRoomId);
  }
  return null;
}

/**
 * Read + decrypt + verify a stored blob by URI, dispatching by scheme.
 *
 * Single canonical reader so any code path that holds a URI (from a snapshot
 * state event, a block manifest, an airtable bundle, etc.) doesn't have to
 * know which backend the bytes live in. Encapsulates the full envelope path:
 *   fetch → AES-GCM decrypt → optional gunzip → SHA-256 verify.
 *
 * Returns `null` if the blob is missing or the URI scheme is unrecognized.
 * Throws if decryption fails, the content_hash mismatches, or the caller's
 * `resolveKey` cannot find the envelope's `key_id`.
 */
export async function readEoBlob(
  opts: {
    matrixToken: string;
    spaceRoomId: string | null;
    mediaClient?: MatrixMediaClient;
    dataId?: string;
    resolveKey: (keyId: string) => Promise<CryptoKey | null>;
  },
  uri: string,
): Promise<Uint8Array | null> {
  const fetched = await fetchBlobByUri(opts, uri);
  if (!fetched) return null;

  const envelope = fetched.envelope;
  const key = await opts.resolveKey(envelope.key_id);
  if (!key) {
    throw new Error(`readEoBlob: no key in keyring for key_id "${envelope.key_id}"`);
  }

  const iv = base64ToBuffer(envelope.iv);
  const ct = base64ToBuffer(envelope.ct);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    ct as unknown as ArrayBuffer,
  );
  const decrypted = new Uint8Array(plainBuf);
  const plaintext = envelope.compression === 'gzip'
    ? await gunzipBytes(decrypted)
    : decrypted;

  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', plaintext as unknown as BufferSource),
  );
  let observed = '';
  for (let i = 0; i < hash.length; i++) observed += hash[i].toString(16).padStart(2, '0');
  if (observed !== envelope.content_hash) {
    throw new Error(
      `readEoBlob: content_hash mismatch (envelope=${envelope.content_hash} observed=${observed})`,
    );
  }

  return plaintext;
}

export async function pingDriveProxy(
  matrixToken: string,
  spaceRoomId: string | null,
): Promise<{ status: number; ok: boolean; detail?: string }> {
  const q = `name='_eo_db_healthcheck_' and trashed=false`;
  const url =
    `${DRIVE_API}?q=${encodeURIComponent(q)}` +
    `&spaces=drive&fields=${encodeURIComponent('files(id)')}` +
    `&pageSize=1`;
  try {
    const { status, raw } = await driveProxy(matrixToken, url, 'GET', null, spaceRoomId, {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return { status, ok: status >= 200 && status < 300, detail: raw.slice(0, 200) };
  } catch (e) {
    return { status: 0, ok: false, detail: (e as Error).message };
  }
}
