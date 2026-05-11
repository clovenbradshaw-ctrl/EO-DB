/**
 * Event bridge — converts between EO events and Matrix room events.
 *
 * Custom event type derived from configurable prefix (default: "com.eo-db").
 * Agent is ALWAYS derived from the Matrix sender, never from event content.
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoEventInput } from '../db/types';
import { eoEventTypes, getDataRoomAlias } from '../lib/matrix-domain';

const _types = eoEventTypes();
export const EO_EVENT_TYPE = _types.event;
export const EO_SNAPSHOT_TYPE = _types.snapshot;
export const EO_SNAPSHOT_STATE_TYPE = _types.snapshotState;
export const EO_SNAPSHOT_CLAIM_TYPE = _types.snapshotClaim;

// --- Governance event types ---
export const EO_SCHEMA_TYPE = 'com.eo-db.schema';
export const EO_GOVERNANCE_TYPE = 'com.eo-db.governance';
export const EO_KEY_ANNOUNCE_TYPE = 'com.eo-db.key.announce';
export const EO_SCHEMA_MANIFEST_TYPE = 'com.eo-db.schema.manifest';
export const EO_SPACE_CONFIG_TYPE = 'com.eo-db.space.config';
export const EO_CHAT_ROOM_TYPE = 'com.eo-db.chat.room';

// --- Block-chain event types ---
/** State event naming the latest sealed block + tail cutoff. One per room. */
export const EO_HEAD_STATE_TYPE = 'm.eo.head';
/** Timeline message event for a sealed block (carries the mxc:// pointer). */
export const EO_BLOCK_TYPE = 'm.eo.block';
/**
 * State event flagging a previously-sealed block as disabled.
 * `state_key` = the disabled block's room-event id.
 * Content: `{ disabled: boolean, reason?: string, set_by?: string, set_at?: string }`.
 *
 * Disabled blocks stay in the chain (so prior_block_event_id pointers
 * remain intact) but are skipped by `hydrateFromBlocks` — their events
 * are not folded into the local store. Toggle back with `disabled:false`.
 * Power-level gate this event type to operator+ so only admins can
 * redact uploaded data without breaking the chain.
 */
export const EO_BLOCK_DISABLED_STATE_TYPE = 'm.eo.block.disabled';

/** Room alias — configured at runtime via `configureMatrixDomain()`. */
export function getDataRoom(): string {
  return getDataRoomAlias();
}

/** @deprecated Use getDataRoom() instead. Kept for backward compatibility. */
export const DATA_ROOM_ALIAS = '' as string;

/**
 * Send an EO event to the encrypted Matrix room.
 * The SDK handles Megolm encryption transparently.
 */
export async function sendEoEvent(
  client: MatrixClient,
  roomId: string,
  event: EoEventInput,
): Promise<string> {
  const result = await client.sendEvent(roomId, EO_EVENT_TYPE as any, {
    op: event.op,
    target: event.target,
    operand: event.operand,
    client_event_id: event.client_event_id,
    ts: event.ts,
    meta: event.meta,
    // agent is NOT included — derived from Matrix sender
  });

  return result.event_id;
}

/**
 * Convert a Matrix room event back to an EO event input.
 * The agent comes from the Matrix event sender field.
 */
export function matrixEventToEo(matrixEvent: MatrixEvent): EoEventInput {
  const content = matrixEvent.getContent();
  return {
    op: content.op,
    target: content.target,
    operand: content.operand,
    agent: matrixEvent.getSender()!,
    ts: content.ts || new Date(matrixEvent.getTs()).toISOString(),
    acquired_ts: new Date(matrixEvent.getTs()).toISOString(),
    client_event_id: content.client_event_id,
    meta: content.meta,
  };
}

// ─── Encrypted attachment helper ────────────────────────────────────────

/**
 * Standard Matrix encrypted-attachment shape — the AES key + IV embedded
 * in a (Megolm-encrypted) message event references ciphertext at `url`.
 * The `hashes.sha256` is base64(SHA-256(ciphertext)) for integrity check
 * before decryption.
 */
export interface EncryptedAttachment {
  url: string;
  key: {
    kty: 'oct';
    alg: 'A256CTR';
    k: string; // base64url
    ext: true;
    key_ops: ['encrypt', 'decrypt'];
  };
  iv: string; // base64
  hashes: { sha256: string };
  v: 'v2';
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(b64u: string): Uint8Array {
  const pad = b64u.length % 4 === 0 ? '' : '='.repeat(4 - (b64u.length % 4));
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Download an mxc:// URI as raw bytes.
 *
 * Tries the authenticated media endpoint first
 * (`/_matrix/client/v1/media/download/{server}/{mediaId}`, MSC3916).
 * Modern Synapse (1.118+) enables this by default and returns 404 on
 * the legacy unauthenticated `/_matrix/media/v3/download/...`. Falls
 * back to the legacy endpoint if the authenticated request returns
 * 404 or 401 — those signal "server doesn't support auth media yet"
 * (older Synapse, Dendrite, Conduit pre-MSC3916).
 *
 * Throws with the most informative error from the path that was
 * actually tried last.
 */
async function downloadMediaBytes(
  client: MatrixClient,
  mxc: string,
): Promise<Uint8Array> {
  // Try authenticated media first.
  const authUrl = (client as any).mxcUrlToHttp?.(
    mxc, undefined, undefined, undefined, false, false, true,
  ) as string | null | undefined;
  const accessToken = (client as any).getAccessToken?.() as string | null;

  if (authUrl && accessToken) {
    let resp: Response;
    try {
      resp = await fetch(authUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (e) {
      // Network error on the authenticated path — try legacy.
      resp = new Response(null, { status: 599, statusText: String(e) });
    }
    if (resp.ok) {
      return new Uint8Array(await resp.arrayBuffer());
    }
    // 404/401 = server doesn't support auth media. Anything else
    // (403, 500, network) is also worth retrying via the legacy path
    // for maximum compatibility — the legacy path will surface its own
    // error if it also fails.
    if (resp.status !== 404 && resp.status !== 401 && resp.status !== 599) {
      // For unexpected errors (e.g. 500), still try legacy but log.
      console.warn(
        `[media] auth download ${resp.status} ${resp.statusText} for ${mxc}, falling back to legacy`,
      );
    }
  }

  // Legacy unauthenticated endpoint.
  const legacyUrl = client.mxcUrlToHttp(mxc);
  if (!legacyUrl) {
    throw new Error(`Cannot resolve mxc URL ${mxc}`);
  }
  const legacy = await fetch(legacyUrl);
  if (!legacy.ok) {
    throw new Error(
      `Block download failed: ${legacy.status} ${legacy.statusText} (${legacyUrl})`,
    );
  }
  return new Uint8Array(await legacy.arrayBuffer());
}

/**
 * Encrypt arbitrary bytes with a fresh AES-256-CTR key, upload the ciphertext
 * to Matrix media, and return the standard `m.file`-style `{url, key, iv,
 * hashes}` object suitable for embedding in a message event.
 *
 * The key lives only in the returned object (and ultimately inside the
 * Megolm-encrypted block message event). The bytes on `mxc://` are useless
 * without the key + IV.
 *
 * `bytes` here is already-meaningful plaintext (e.g. a `.eodb` payload).
 * For double-encryption (key-distribution wrap + media wrap) wrap the bytes
 * with `encryptSnapshot()` first; this helper handles the media layer.
 */
export async function uploadEncryptedAttachment(
  client: MatrixClient,
  bytes: Uint8Array,
  name: string = 'block.eodb',
): Promise<EncryptedAttachment> {
  // 256-bit key + 128-bit IV for AES-CTR
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    'raw',
    rawKey as unknown as BufferSource,
    { name: 'AES-CTR', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );

  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: iv as unknown as BufferSource, length: 64 },
    key,
    bytes as unknown as BufferSource,
  );
  const ciphertext = new Uint8Array(ctBuf);

  const shaBuf = await crypto.subtle.digest('SHA-256', ciphertext as unknown as BufferSource);
  const sha256 = bytesToBase64(new Uint8Array(shaBuf));

  const uploadResult = await client.uploadContent(new Blob([ciphertext]), {
    name,
    type: 'application/octet-stream',
  });

  return {
    url: uploadResult.content_uri,
    key: {
      kty: 'oct',
      alg: 'A256CTR',
      k: bytesToBase64Url(rawKey),
      ext: true,
      key_ops: ['encrypt', 'decrypt'],
    },
    iv: bytesToBase64(iv),
    hashes: { sha256 },
    v: 'v2',
  };
}

/**
 * Inverse of {@link uploadEncryptedAttachment}: fetch ciphertext from
 * `attachment.url`, verify SHA-256 against `attachment.hashes.sha256`,
 * decrypt with `attachment.key` + `attachment.iv`, and return plaintext.
 *
 * Throws on integrity failure (hash mismatch) before attempting decryption.
 *
 * Tries the authenticated media endpoint first (MSC3916, required by
 * modern Synapse with `enable_authenticated_media: true`, which is the
 * default in Synapse 1.118+). Falls back to the legacy unauthenticated
 * endpoint for older homeservers that don't yet support `/client/v1/media`.
 */
export async function downloadEncryptedAttachment(
  client: MatrixClient,
  attachment: EncryptedAttachment,
): Promise<Uint8Array> {
  const ciphertext = await downloadMediaBytes(client, attachment.url);

  const shaBuf = await crypto.subtle.digest('SHA-256', ciphertext as unknown as BufferSource);
  const actualSha = bytesToBase64(new Uint8Array(shaBuf));
  if (actualSha !== attachment.hashes.sha256) {
    throw new Error(
      `Block integrity check failed for ${attachment.url}: ` +
      `expected sha256=${attachment.hashes.sha256}, got ${actualSha}`,
    );
  }

  const rawKey = base64UrlToBytes(attachment.key.k);
  const iv = base64ToBytes(attachment.iv);
  const key = await crypto.subtle.importKey(
    'raw',
    rawKey as unknown as BufferSource,
    { name: 'AES-CTR', length: 256 },
    false,
    ['decrypt'],
  );
  const ptBuf = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: iv as unknown as BufferSource, length: 64 },
    key,
    ciphertext as unknown as BufferSource,
  );
  return new Uint8Array(ptBuf);
}

/**
 * Resolve the data room alias to a room ID.
 *
 * First checks joined rooms for a matching alias (avoids a network
 * round-trip and the 404 console noise when the alias doesn't exist
 * in the homeserver directory). Falls back to the directory API only
 * when no local match is found.
 */
export async function resolveDataRoom(client: MatrixClient): Promise<string> {
  const alias = getDataRoom();
  if (!alias) {
    throw new Error('Data room alias not configured — call configureMatrixDomain() first');
  }

  // Check joined rooms first — avoids a GET /directory/room 404 when the
  // alias hasn't been registered on the homeserver.
  for (const room of client.getRooms()) {
    const aliases = room.getAltAliases?.() ?? [];
    const canonical = room.getCanonicalAlias?.();
    if (canonical) aliases.push(canonical);
    if (aliases.includes(alias)) {
      return room.roomId;
    }
  }

  // Per-space rooms are the norm — skip the directory API call to avoid a
  // 404 network request that clutters the browser console.
  throw new Error(`No joined room matches alias ${alias}`);
}
