/**
 * n8n webhook client — POST (store) and GET (retrieve) with E2E encryption.
 *
 * Every payload is encrypted locally before it touches the network.
 * n8n only ever sees opaque ciphertext + a content hash for addressing.
 *
 * Flow:
 *   STORE:  encrypt → POST /webhook/eo-store  → n8n persists blob by hash
 *   FETCH:  GET /webhook/eo-store?hash=<hash>&id=<id> → decrypt locally
 */

import { v4 as uuid } from 'uuid';
import { pack } from 'msgpackr';
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
  WebhookRetrieveResponse,
  EncryptedWebhookEnvelope,
} from './types.js';

// ─── Store (POST) ──────────────────────────────────────────────────────────

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
  /** The n8n storage reference (if returned). */
  ref?: string;
}

/**
 * Encrypt and POST arbitrary data to n8n.
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
    envelope,
    data_id: dataId,
    data_type: opts.dataType,
  };

  const config = getN8nConfig();
  const resp = await fetch(getWebhookUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config?.webhookAuthToken
        ? { Authorization: `Bearer ${config.webhookAuthToken}` }
        : {}),
      'X-Matrix-Token': opts.matrixToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config?.timeoutMs ?? 30_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`n8n webhook POST failed (${resp.status}): ${text}`);
  }

  const result: WebhookStoreResponse = await resp.json();
  if (!result.ok) {
    throw new Error(`n8n rejected the payload: ${JSON.stringify(result)}`);
  }

  // Verify n8n echoed the correct hash
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

  return { manifest, ref: result.ref };
}

// ─── Store binary (snapshots, archives) ────────────────────────────────────

/**
 * Encrypt and POST raw binary (already-packed snapshot, archive, etc.).
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
    envelope,
    data_id: dataId,
    data_type: opts.dataType,
  };

  const config = getN8nConfig();
  const resp = await fetch(getWebhookUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config?.webhookAuthToken
        ? { Authorization: `Bearer ${config.webhookAuthToken}` }
        : {}),
      'X-Matrix-Token': opts.matrixToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config?.timeoutMs ?? 30_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`n8n webhook POST (binary) failed (${resp.status}): ${text}`);
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

  return { manifest, ref: result.ref };
}

// ─── Retrieve (GET) ────────────────────────────────────────────────────────

/**
 * Fetch and decrypt a data blob from n8n using a manifest entry.
 * The Matrix room provides the manifest; this function does the rest.
 */
export async function retrieveViaN8n(
  manifest: ManifestEntry,
  keyring: LocalKeyring,
  matrixToken: string,
): Promise<unknown> {
  const config = getN8nConfig();
  const url = new URL(getWebhookUrl());
  url.searchParams.set('hash', manifest.content_hash);
  url.searchParams.set('id', manifest.data_id);

  const resp = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      ...(config?.webhookAuthToken
        ? { Authorization: `Bearer ${config.webhookAuthToken}` }
        : {}),
      'X-Matrix-Token': matrixToken,
    },
    signal: AbortSignal.timeout(config?.timeoutMs ?? 30_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`n8n webhook GET failed (${resp.status}): ${text}`);
  }

  const body: WebhookRetrieveResponse = await resp.json();
  if (!body.ok || !body.envelope) {
    throw new Error(`Blob not found in n8n for hash=${manifest.content_hash}`);
  }

  return decryptFromWebhook(body.envelope, keyring);
}

/**
 * Fetch and decrypt raw binary from n8n (for snapshots, archives).
 */
export async function retrieveBinaryViaN8n(
  manifest: ManifestEntry,
  keyring: LocalKeyring,
  matrixToken: string,
): Promise<Uint8Array> {
  const config = getN8nConfig();
  const url = new URL(getWebhookUrl());
  url.searchParams.set('hash', manifest.content_hash);
  url.searchParams.set('id', manifest.data_id);

  const resp = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      ...(config?.webhookAuthToken
        ? { Authorization: `Bearer ${config.webhookAuthToken}` }
        : {}),
      'X-Matrix-Token': matrixToken,
    },
    signal: AbortSignal.timeout(config?.timeoutMs ?? 30_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`n8n webhook GET (binary) failed (${resp.status}): ${text}`);
  }

  const body: WebhookRetrieveResponse = await resp.json();
  if (!body.ok || !body.envelope) {
    throw new Error(`Binary blob not found in n8n for hash=${manifest.content_hash}`);
  }

  return decryptBinaryFromWebhook(body.envelope, keyring);
}
