/**
 * Snapshot-level encryption — wraps entire snapshot blobs in AES-256-GCM
 * before uploading to Matrix media.
 *
 * This provides defense-in-depth on top of Matrix Megolm room encryption:
 * even if the media server is compromised, snapshot data remains encrypted.
 *
 * Envelope format (msgpack-encoded):
 *   { v: 1, iv: base64(12 bytes), ct: Uint8Array, key_id: string }
 *
 * Legacy snapshots (pre-encryption) lack the `v` field and unpack directly
 * to a DeltaSnapshot. The `isEncryptedEnvelope()` guard handles both.
 */

import { pack, unpack } from 'msgpackr';

const IV_LENGTH = 12; // 96-bit IV for AES-GCM

// ─── Types ────────────────────────────────────────────────────────────────

export interface EncryptedSnapshotEnvelope {
  /** Envelope version — distinguishes from legacy unencrypted snapshots */
  v: 1;
  /** AES-256-GCM initialization vector (12 bytes, base64) */
  iv: string;
  /** The encrypted msgpack blob */
  ct: Uint8Array;
  /** Key ID used for encryption — so downloader knows which key to use */
  key_id: string;
}

// ─── Encrypt / Decrypt ────────────────────────────────────────────────────

/**
 * Encrypt a raw msgpack snapshot binary with AES-256-GCM.
 * Returns a msgpack-encoded EncryptedSnapshotEnvelope ready for upload.
 */
export async function encryptSnapshot(
  key: CryptoKey,
  keyId: string,
  plainBinary: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plainBinary,
  );

  const envelope: EncryptedSnapshotEnvelope = {
    v: 1,
    iv: bufferToBase64(iv),
    ct: new Uint8Array(ciphertextBuf),
    key_id: keyId,
  };

  return pack(envelope);
}

/**
 * Decrypt an EncryptedSnapshotEnvelope back to raw msgpack bytes.
 * The caller then unpacks the result to a DeltaSnapshot.
 */
export async function decryptSnapshot(
  key: CryptoKey,
  envelopeBinary: Uint8Array,
): Promise<Uint8Array> {
  const envelope = unpack(envelopeBinary) as EncryptedSnapshotEnvelope;

  const iv = base64ToBuffer(envelope.iv);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    envelope.ct,
  );

  return new Uint8Array(plainBuf);
}

/**
 * Check whether a downloaded binary is an encrypted snapshot envelope
 * or a legacy unencrypted snapshot.
 */
export function isEncryptedEnvelope(binary: Uint8Array): boolean {
  try {
    const decoded = unpack(binary) as any;
    return decoded && decoded.v === 1 && typeof decoded.iv === 'string' && decoded.ct != null;
  } catch {
    return false;
  }
}

/**
 * Extract the key_id from an encrypted envelope without fully decrypting.
 */
export function getEnvelopeKeyId(binary: Uint8Array): string | null {
  try {
    const decoded = unpack(binary) as any;
    if (decoded && decoded.v === 1 && typeof decoded.key_id === 'string') {
      return decoded.key_id;
    }
  } catch { /* not an envelope */ }
  return null;
}

// ─── Peer Sync Payload Encryption ─────────────────────────────────────────

/**
 * Encrypt a peer sync event batch for to-device messaging.
 */
export async function encryptPeerPayload(
  key: CryptoKey,
  keyId: string,
  plainBinary: Uint8Array,
): Promise<{ encrypted: true; key_id: string; iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plainBinary,
  );

  return {
    encrypted: true,
    key_id: keyId,
    iv: bufferToBase64(iv),
    ct: bufferToBase64(new Uint8Array(ciphertextBuf)),
  };
}

/**
 * Decrypt a peer sync payload back to raw binary.
 */
export async function decryptPeerPayload(
  key: CryptoKey,
  payload: { iv: string; ct: string },
): Promise<Uint8Array> {
  const iv = base64ToBuffer(payload.iv);
  const ciphertext = base64ToBuffer(payload.ct);

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );

  return new Uint8Array(plainBuf);
}

// ─── Base64 Helpers ───────────────────────────────────────────────────────

function bufferToBase64(buf: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(b64: string): Uint8Array {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buf[i] = binary.charCodeAt(i);
  }
  return buf;
}
