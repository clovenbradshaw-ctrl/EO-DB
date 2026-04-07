/**
 * n8n webhook client — single endpoint, action-routed.
 *
 * Every request is a POST to /webhook/eo-store with an `action` field:
 *   { action: "store",    envelope, data_id, data_type }
 *   { action: "retrieve", content_hash, data_id }
 *   { action: "list",     data_type? }
 *
 * All payloads encrypted locally (AES-256-GCM) before they touch the wire.
 * n8n routes via a Switch node, stores/retrieves from Google Drive.
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
  WebhookRetrieveRequest,
  WebhookRetrieveResponse,
  WebhookListRequest,
  WebhookListResponse,
} from './types.js';

// ─── Shared fetch helper ───────────────────────────────────────────────────

async function postToWebhook(
  body: WebhookStoreRequest | WebhookRetrieveRequest | WebhookListRequest,
  matrixToken: string,
): Promise<Response> {
  const config = getN8nConfig();
  return fetch(getWebhookUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config?.webhookAuthToken
        ? { Authorization: `Bearer ${config.webhookAuthToken}` }
        : {}),
    },
    body: JSON.stringify({ ...body, matrix_token: matrixToken }),
    signal: AbortSignal.timeout(config?.timeoutMs ?? 30_000),
  });
}

// ─── Store ─────────────────────────────────────────────────────────────────

export interface StoreOptions {
  /** EO target path for key resolution. */
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
  /** Google Drive file ID (if returned by n8n). */
  driveFileId?: string;
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

  const dataId = uuid();
  const body: WebhookStoreRequest = {
    action: 'store',
    envelope,
    data_id: dataId,
    data_type: opts.dataType,
  };

  const resp = await postToWebhook(body, opts.matrixToken);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`n8n store failed (${resp.status}): ${text}`);
  }

  const result: WebhookStoreResponse = await resp.json();
  if (!result.ok) {
    throw new Error(`n8n rejected the payload: ${JSON.stringify(result)}`);
  }
  if (result.content_hash !== envelope.content_hash) {
    throw new Error(
      `Hash mismatch from n8n: sent ${envelope.content_hash}, got ${result.content_hash}`,
    );
  }

  const manifest: ManifestEntry = {
    data_id: dataId,
    content_hash: envelope.content_hash,
    key_id: envelope.key_id,
    size: envelope.plaintext_size,
    created_at: new Date().toISOString(),
    data_type: opts.dataType,
    label: opts.label,
    stored_by: opts.agent,
    seq_range: opts.seqRange,
  };

  return { manifest, driveFileId: result.drive_file_id };
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
  const dataId = uuid();
  const body: WebhookStoreRequest = {
    action: 'store',
    envelope,
    data_id: dataId,
    data_type: opts.dataType,
  };

  const resp = await postToWebhook(body, opts.matrixToken);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`n8n store (binary) failed (${resp.status}): ${text}`);
  }

  const result: WebhookStoreResponse = await resp.json();
  if (!result.ok || result.content_hash !== envelope.content_hash) {
    throw new Error(`n8n binary store failed or hash mismatch.`);
  }

  const manifest: ManifestEntry = {
    data_id: dataId,
    content_hash: envelope.content_hash,
    key_id: envelope.key_id,
    size: envelope.plaintext_size,
    created_at: new Date().toISOString(),
    data_type: opts.dataType,
    label: opts.label,
    stored_by: opts.agent,
    seq_range: opts.seqRange,
  };

  return { manifest, driveFileId: result.drive_file_id };
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
  const body: WebhookRetrieveRequest = {
    action: 'retrieve',
    content_hash: manifest.content_hash,
    data_id: manifest.data_id,
  };

  const resp = await postToWebhook(body, matrixToken);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`n8n retrieve failed (${resp.status}): ${text}`);
  }

  const result: WebhookRetrieveResponse = await resp.json();
  if (!result.ok || !result.envelope) {
    throw new Error(`Blob not found in n8n for hash=${manifest.content_hash}`);
  }

  return decryptFromWebhook(result.envelope, keyring);
}

/**
 * Fetch and decrypt raw binary from n8n (for snapshots, archives).
 */
export async function retrieveBinaryViaN8n(
  manifest: ManifestEntry,
  keyring: LocalKeyring,
  matrixToken: string,
): Promise<Uint8Array> {
  const body: WebhookRetrieveRequest = {
    action: 'retrieve',
    content_hash: manifest.content_hash,
    data_id: manifest.data_id,
  };

  const resp = await postToWebhook(body, matrixToken);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`n8n retrieve (binary) failed (${resp.status}): ${text}`);
  }

  const result: WebhookRetrieveResponse = await resp.json();
  if (!result.ok || !result.envelope) {
    throw new Error(`Binary blob not found for hash=${manifest.content_hash}`);
  }

  return decryptBinaryFromWebhook(result.envelope, keyring);
}

// ─── List ──────────────────────────────────────────────────────────────────

/**
 * List blobs stored in n8n (from Google Drive), optionally filtered by type.
 */
export async function listViaN8n(
  matrixToken: string,
  dataType?: ManifestDataType,
): Promise<WebhookListResponse> {
  const body: WebhookListRequest = {
    action: 'list',
    data_type: dataType,
  };

  const resp = await postToWebhook(body, matrixToken);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`n8n list failed (${resp.status}): ${text}`);
  }

  return resp.json();
}
