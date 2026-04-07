/**
 * Encrypted payload envelope for n8n webhook transport.
 *
 * Every byte that leaves the device is wrapped in AES-256-GCM.
 * The content_hash (SHA-256 of plaintext) serves as the content-
 * addressable key — n8n stores blobs by hash, clients retrieve by hash.
 *
 * Reuses the keyring + crypto primitives from src/crypto/segment-keys.ts.
 */

import { pack, unpack } from 'msgpackr';
import type { LocalKeyring } from '../db/crypto-types.js';
import {
  getKeyById,
  resolveKeyForTarget,
  bufferToBase64,
  base64ToBuffer,
} from '../crypto/segment-keys.js';
import type { EncryptedWebhookEnvelope } from './types.js';

const IV_LENGTH = 12; // 96-bit for AES-GCM

// ─── Hash ──────────────────────────────────────────────────────────────────

/** SHA-256 hex digest of arbitrary bytes. */
async function sha256hex(data: Uint8Array): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', data as unknown as BufferSource),
  );
  return Array.from(hash)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Encrypt ───────────────────────────────────────────────────────────────

/**
 * Encrypt an arbitrary value for webhook transport.
 *
 * @param plaintext - Any serialisable value (will be msgpack-encoded).
 * @param keyring   - The local keyring holding AES-256-GCM keys.
 * @param target    - EO target path used for waterfall key resolution.
 * @returns The encrypted envelope, or null if no key covers the target.
 */
export async function encryptForWebhook(
  plaintext: unknown,
  keyring: LocalKeyring,
  target: string,
): Promise<EncryptedWebhookEnvelope | null> {
  const entry = resolveKeyForTarget(keyring, target);
  if (!entry) return null; // no key — caller decides whether to abort or send cleartext

  const plainBytes = pack(plaintext);
  const contentHash = await sha256hex(plainBytes);

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    entry.key,
    plainBytes as unknown as ArrayBuffer,
  );

  return {
    v: 1,
    iv: bufferToBase64(iv),
    ct: bufferToBase64(new Uint8Array(ctBuf)),
    content_hash: contentHash,
    key_id: entry.keyId,
    plaintext_size: plainBytes.byteLength,
  };
}

// ─── Decrypt ───────────────────────────────────────────────────────────────

/**
 * Decrypt a webhook envelope back to its original value.
 *
 * @param envelope - The encrypted envelope received from n8n.
 * @param keyring  - The local keyring.
 * @returns The deserialised plaintext value.
 * @throws If the key is missing or decryption fails (wrong key / tampered).
 */
export async function decryptFromWebhook(
  envelope: EncryptedWebhookEnvelope,
  keyring: LocalKeyring,
): Promise<unknown> {
  if (envelope.v !== 1) {
    throw new Error(`Unsupported webhook envelope version: ${(envelope as any).v}`);
  }

  const entry = getKeyById(keyring, envelope.key_id);
  if (!entry) {
    throw new Error(
      `Missing key ${envelope.key_id} for webhook payload decryption. ` +
      `Request key access or trigger a key heal.`,
    );
  }

  const iv = base64ToBuffer(envelope.iv);
  const ct = base64ToBuffer(envelope.ct);

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    entry.key,
    ct as unknown as ArrayBuffer,
  );

  const plainBytes = new Uint8Array(plainBuf);

  // Verify content hash integrity
  const actualHash = await sha256hex(plainBytes);
  if (actualHash !== envelope.content_hash) {
    throw new Error(
      `Content hash mismatch: expected ${envelope.content_hash}, got ${actualHash}. ` +
      `Payload may have been tampered with.`,
    );
  }

  return unpack(plainBytes);
}

// ─── Encrypt raw binary (for snapshots / archives) ─────────────────────────

/**
 * Encrypt raw binary bytes (already-packed snapshots, archive blobs, etc.)
 * without double-packing. Same envelope format.
 */
export async function encryptBinaryForWebhook(
  binary: Uint8Array,
  key: CryptoKey,
  keyId: string,
): Promise<EncryptedWebhookEnvelope> {
  const contentHash = await sha256hex(binary);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    binary as unknown as ArrayBuffer,
  );

  return {
    v: 1,
    iv: bufferToBase64(iv),
    ct: bufferToBase64(new Uint8Array(ctBuf)),
    content_hash: contentHash,
    key_id: keyId,
    plaintext_size: binary.byteLength,
  };
}

/**
 * Decrypt a webhook envelope back to raw binary bytes.
 */
export async function decryptBinaryFromWebhook(
  envelope: EncryptedWebhookEnvelope,
  keyring: LocalKeyring,
): Promise<Uint8Array> {
  const entry = getKeyById(keyring, envelope.key_id);
  if (!entry) {
    throw new Error(`Missing key ${envelope.key_id} for binary decryption.`);
  }

  const iv = base64ToBuffer(envelope.iv);
  const ct = base64ToBuffer(envelope.ct);

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    entry.key,
    ct as unknown as ArrayBuffer,
  );

  const plainBytes = new Uint8Array(plainBuf);
  const actualHash = await sha256hex(plainBytes);
  if (actualHash !== envelope.content_hash) {
    throw new Error(`Content hash mismatch on binary payload.`);
  }

  return plainBytes;
}
