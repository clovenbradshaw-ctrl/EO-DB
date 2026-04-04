/**
 * Snapshot & peer-sync encryption envelope (client-side).
 *
 * Wraps binary blobs (msgpack-encoded snapshots or peer event batches)
 * in an AES-256-GCM envelope before they leave the device. On download /
 * receipt, the envelope is detected via a `v: 1` marker and decrypted.
 *
 * Legacy (unencrypted) blobs lack the `v` field and are passed through
 * unchanged, enabling gradual migration.
 */

import { pack, unpack } from 'msgpackr';
import type { LocalKeyring } from '../db/crypto-types';
import { getKeyById, bufferToBase64, base64ToBuffer } from './segment-keys';

const IV_LENGTH = 12; // 96-bit IV for AES-GCM

// ─── Snapshot Envelope ─────────────────────────────────────────────────────

export interface EncryptedSnapshotEnvelope {
  v: 1;
  iv: string;
  ct: Uint8Array;
  key_id: string;
}

export async function encryptSnapshot(
  binary: Uint8Array,
  keyring: LocalKeyring,
  keyId: string,
): Promise<Uint8Array> {
  const entry = getKeyById(keyring, keyId);
  if (!entry) return binary;

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, entry.key, binary as unknown as BufferSource),
  );
  const envelope: EncryptedSnapshotEnvelope = {
    v: 1,
    iv: bufferToBase64(iv),
    ct,
    key_id: keyId,
  };
  return pack(envelope);
}

export async function decryptSnapshot(
  raw: Uint8Array,
  keyring: LocalKeyring,
): Promise<Uint8Array> {
  let outer: any;
  try {
    outer = unpack(raw);
  } catch {
    return raw;
  }

  if (outer && outer.v === 1) {
    const entry = getKeyById(keyring, outer.key_id);
    if (!entry) {
      throw new Error(
        `Missing key ${outer.key_id} for snapshot decryption. ` +
        `Request key access or trigger a key heal.`,
      );
    }
    const iv = base64ToBuffer(outer.iv);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      entry.key,
      outer.ct as unknown as BufferSource,
    );
    return new Uint8Array(plaintext);
  }

  return raw;
}

// ─── Peer Sync Payload ─────────────────────────────────────────────────────

export interface EncryptedPeerPayload {
  encrypted: true;
  iv: string;
  ct: string;
  key_id: string;
}

export async function encryptPeerPayload(
  key: CryptoKey,
  keyId: string,
  binary: Uint8Array,
): Promise<EncryptedPeerPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, binary as unknown as BufferSource),
  );
  return {
    encrypted: true,
    iv: bufferToBase64(iv),
    ct: bufferToBase64(ct),
    key_id: keyId,
  };
}

export async function decryptPeerPayload(
  key: CryptoKey,
  payload: EncryptedPeerPayload,
): Promise<Uint8Array> {
  const iv = base64ToBuffer(payload.iv);
  const ct = base64ToBuffer(payload.ct);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    ct as unknown as BufferSource,
  );
  return new Uint8Array(plaintext);
}
