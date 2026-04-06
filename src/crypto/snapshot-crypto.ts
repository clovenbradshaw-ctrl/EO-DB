/**
 * Snapshot & peer-sync encryption envelope.
 *
 * Wraps binary blobs (msgpack-encoded snapshots or peer event batches)
 * in an AES-256-GCM envelope before they leave the device. On download /
 * receipt, the envelope is detected via a `v: 1` marker and decrypted.
 *
 * Legacy (unencrypted) blobs lack the `v` field and are passed through
 * unchanged, enabling gradual migration.
 */

import { pack, unpack } from 'msgpackr';
import type { LocalKeyring } from '../db/crypto-types.js';
import { getKeyById, bufferToBase64, base64ToBuffer } from './segment-keys.js';

const IV_LENGTH = 12; // 96-bit IV for AES-GCM

// ─── Snapshot Envelope ─────────────────────────────────────────────────────

export interface EncryptedSnapshotEnvelope {
  /** Version marker for future format changes. */
  v: 1;
  /** AES-256-GCM initialization vector (12 bytes, base64). */
  iv: string;
  /** The encrypted msgpack blob. */
  ct: Uint8Array;
  /** The key_id used — so the downloader knows which key to use. */
  key_id: string;
}

/**
 * Encrypt a raw binary blob (e.g. `pack(delta)`) for upload.
 * If the key is not in the keyring (unencrypted space), returns the
 * binary unchanged — the caller uploads raw msgpack as before.
 */
export async function encryptSnapshot(
  binary: Uint8Array,
  keyring: LocalKeyring,
  keyId: string,
): Promise<Uint8Array> {
  const entry = getKeyById(keyring, keyId);
  if (!entry) return binary; // unencrypted space — pass through

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, entry.key, binary as unknown as ArrayBuffer),
  );
  const envelope: EncryptedSnapshotEnvelope = {
    v: 1,
    iv: bufferToBase64(iv),
    ct,
    key_id: keyId,
  };
  return pack(envelope);
}

/**
 * Decrypt a downloaded blob. Detects encrypted envelopes via the `v: 1`
 * marker; legacy unencrypted blobs are returned as-is.
 */
export async function decryptSnapshot(
  raw: Uint8Array,
  keyring: LocalKeyring,
): Promise<Uint8Array> {
  // Attempt to unpack the outer layer to check for envelope marker
  let outer: any;
  try {
    outer = unpack(raw);
  } catch {
    // If we can't even unpack, return raw — caller will handle the error
    return raw;
  }

  if (outer && outer.v === 1) {
    // Encrypted envelope
    const entry = getKeyById(keyring, outer.key_id);
    if (!entry) {
      throw new Error(
        `Missing key ${outer.key_id} for snapshot decryption. ` +
        `Request key access or trigger a key heal.`,
      );
    }
    const iv = base64ToBuffer(outer.iv) as unknown as BufferSource;
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      entry.key,
      outer.ct as unknown as ArrayBuffer,
    );
    return new Uint8Array(plaintext);
  }

  // Legacy unencrypted — raw IS the msgpack blob (already unpacked as `outer`,
  // but the caller expects raw bytes to unpack themselves)
  return raw;
}

// ─── Peer Sync Payload ─────────────────────────────────────────────────────

export interface EncryptedPeerPayload {
  /** Signals this is an encrypted payload. */
  encrypted: true;
  /** AES-256-GCM initialization vector (12 bytes, base64). */
  iv: string;
  /** Encrypted msgpack blob (base64). */
  ct: string;
  /** Key ID used for encryption. */
  key_id: string;
}

/**
 * Encrypt a peer sync event batch for to-device transmission.
 * The `binary` param should be `pack(batch)` — the msgpack-encoded
 * array of events.
 */
export async function encryptPeerPayload(
  key: CryptoKey,
  keyId: string,
  binary: Uint8Array,
): Promise<EncryptedPeerPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, binary as unknown as ArrayBuffer),
  );
  return {
    encrypted: true,
    iv: bufferToBase64(iv),
    ct: bufferToBase64(ct),
    key_id: keyId,
  };
}

/**
 * Decrypt a peer sync payload. Returns the raw plaintext bytes
 * (caller unpacks via `unpack(result)`).
 */
export async function decryptPeerPayload(
  key: CryptoKey,
  payload: EncryptedPeerPayload,
): Promise<Uint8Array> {
  const iv = base64ToBuffer(payload.iv) as unknown as BufferSource;
  const ct = base64ToBuffer(payload.ct);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ct as unknown as ArrayBuffer,
  );
  return new Uint8Array(plaintext);
}
