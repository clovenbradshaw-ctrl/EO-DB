/**
 * n8n webhook client — talks to the deployed "EO Blob Store" workflow.
 *
 * Every request is a POST to the configured webhook with:
 *   { matrix_token, op, room_id, data_id, ... }
 *
 * The workflow:
 *   - calls Matrix /whoami to validate the token,
 *   - checks the user's membership in room_id,
 *   - enforces that data_id starts with `r_<sha256(room_id)[:8]>:`,
 *   - then routes by op to store / get / versions.
 *
 * All payloads encrypted locally (AES-256-GCM) before they touch the wire.
 * Storage lives on the n8n host's filesystem (/mnt/eo-blobs), with a
 * 5-version rolling history per data_id.
 */

import { v4 as uuid } from 'uuid';
import type { LocalKeyring } from '../db/crypto-types.js';
import { resolveKeyForTarget } from '../crypto/segment-keys.js';
import { getWebhookUrl, getN8nConfig } from './config.js';
import {
  encryptForWebhook,
  decryptFromWebhook,
  encryptBinaryForWebhook,
  decryptBinaryFromWebhook,
} from './encrypted-payload.js';
import type {
  ManifestDataType,
  ManifestEntry,
  WebhookStoreRequest,
  WebhookStoreResponse,
  WebhookGetRequest,
  WebhookGetResponse,
  WebhookVersionsRequest,
  WebhookVersionsResponse,
  WebhookRequest,
} from './types.js';

// ─── Room-scoped data_id helpers ───────────────────────────────────────────

/** SHA-256 hex digest. */
async function sha256hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource),
  );
  return Array.from(hash)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** "r_<first-8-hex-of-sha256(room_id)>" — must match the workflow's check. */
export async function roomDataIdPrefix(roomId: string): Promise<string> {
  const hex = await sha256hex(roomId);
  return `r_${hex.slice(0, 8)}`;
}

/** Mint a fresh room-scoped data_id: "r_<8hex>:<uuid>". */
export async function makeDataId(roomId: string): Promise<string> {
  const prefix = await roomDataIdPrefix(roomId);
  return `${prefix}:${uuid()}`;
}

// ─── Shared fetch helper ───────────────────────────────────────────────────

async function postToWebhook(body: WebhookRequest): Promise<Response> {
  const config = getN8nConfig();
  return fetch(getWebhookUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config?.webhookAuthToken
        ? { Authorization: `Bearer ${config.webhookAuthToken}` }
        : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config?.timeoutMs ?? 30_000),
  });
}

async function readError(resp: Response, op: string): Promise<never> {
  const text = await resp.text().catch(() => '');
  throw new Error(`n8n ${op} failed (${resp.status}): ${text}`);
}

// ─── Store ─────────────────────────────────────────────────────────────────

export interface StoreOptions {
  /** Matrix room id this blob belongs to (must start with "!"). */
  roomId: string;
  /** EO target path for key resolution (also persisted as server-side meta). */
  target: string;
  /** What kind of data this is. */
  dataType: ManifestDataType;
  /** Optional human label. */
  label?: string;
  /** Agent / user performing the store. */
  agent: string;
  /** Sequence range (for snapshots / event batches). */
  seqRange?: { from: number; to: number };
  /** Matrix access token for auth forwarding to n8n. */
  matrixToken: string;
}

export interface StoreResult {
  /** The manifest entry to publish to the Matrix room. */
  manifest: ManifestEntry;
  /** Raw response from the workflow (version, uri, pruned, etc.). */
  response: WebhookStoreResponse;
}

/**
 * Encrypt and store arbitrary data via n8n.
 * Returns a ManifestEntry ready to be published as Matrix room state.
 */
export async function storeViaN8n(
  data: unknown,
  keyring: LocalKeyring,
  opts: StoreOptions,
): Promise<StoreResult> {
  const envelope = await encryptForWebhook(data, keyring, opts.target);
  if (!envelope) {
    throw new Error(
      `No encryption key covers target "${opts.target}". ` +
      `All n8n webhook payloads must be encrypted.`,
    );
  }
  return performStore(envelope, opts);
}

/**
 * Encrypt and store raw binary (already-packed snapshot, archive, etc.).
 */
export async function storeBinaryViaN8n(
  binary: Uint8Array,
  keyring: LocalKeyring,
  opts: StoreOptions,
): Promise<StoreResult> {
  const entry = resolveKeyForTarget(keyring, opts.target);
  if (!entry) {
    throw new Error(
      `No encryption key covers target "${opts.target}". ` +
      `All n8n webhook payloads must be encrypted.`,
    );
  }
  const envelope = await encryptBinaryForWebhook(binary, entry.key, entry.keyId);
  return performStore(envelope, opts);
}

async function performStore(
  envelope: Awaited<ReturnType<typeof encryptForWebhook>> & object,
  opts: StoreOptions,
): Promise<StoreResult> {
  const dataId = await makeDataId(opts.roomId);
  const body: WebhookStoreRequest = {
    op: 'store',
    matrix_token: opts.matrixToken,
    room_id: opts.roomId,
    data_id: dataId,
    envelope,
    target: opts.target,
    label: opts.label,
  };

  const resp = await postToWebhook(body);
  if (!resp.ok) await readError(resp, 'store');

  const result = (await resp.json()) as WebhookStoreResponse;
  if (result.content_hash !== envelope.content_hash) {
    throw new Error(
      `Hash mismatch from n8n: sent ${envelope.content_hash}, got ${result.content_hash}`,
    );
  }

  const manifest: ManifestEntry = {
    data_id: result.data_id,
    room_id: result.room_id,
    version: result.version,
    uri: result.uri,
    content_hash: result.content_hash,
    key_id: envelope.key_id,
    size: envelope.plaintext_size,
    created_at: result.created_at,
    data_type: opts.dataType,
    label: opts.label,
    stored_by: opts.agent,
    seq_range: opts.seqRange,
  };

  return { manifest, response: result };
}

// ─── Retrieve ──────────────────────────────────────────────────────────────

/**
 * Fetch and decrypt a data blob from n8n using a manifest entry.
 */
export async function retrieveViaN8n(
  manifest: ManifestEntry,
  keyring: LocalKeyring,
  matrixToken: string,
): Promise<unknown> {
  const envelope = await fetchEnvelope(manifest, matrixToken);
  return decryptFromWebhook(envelope, keyring);
}

/**
 * Fetch and decrypt raw binary from n8n (for snapshots, archives).
 */
export async function retrieveBinaryViaN8n(
  manifest: ManifestEntry,
  keyring: LocalKeyring,
  matrixToken: string,
): Promise<Uint8Array> {
  const envelope = await fetchEnvelope(manifest, matrixToken);
  return decryptBinaryFromWebhook(envelope, keyring);
}

async function fetchEnvelope(
  manifest: ManifestEntry,
  matrixToken: string,
): Promise<WebhookGetResponse['envelope']> {
  const body: WebhookGetRequest = {
    op: 'get',
    matrix_token: matrixToken,
    room_id: manifest.room_id,
    data_id: manifest.data_id,
    version: manifest.version,
  };

  const resp = await postToWebhook(body);
  if (!resp.ok) await readError(resp, 'get');

  const result = (await resp.json()) as WebhookGetResponse;
  if (!result.envelope) {
    throw new Error(
      `Blob not found in n8n for data_id=${manifest.data_id} v${manifest.version}`,
    );
  }
  return result.envelope;
}

// ─── Versions ──────────────────────────────────────────────────────────────

/**
 * List all server-retained versions of a single data_id.
 * Replaces the old `listViaN8n` — cross-blob listing is done by reading
 * Matrix room state, not by polling the webhook.
 */
export async function versionsViaN8n(
  roomId: string,
  dataId: string,
  matrixToken: string,
): Promise<WebhookVersionsResponse> {
  const body: WebhookVersionsRequest = {
    op: 'versions',
    matrix_token: matrixToken,
    room_id: roomId,
    data_id: dataId,
  };

  const resp = await postToWebhook(body);
  if (!resp.ok) await readError(resp, 'versions');

  return (await resp.json()) as WebhookVersionsResponse;
}
