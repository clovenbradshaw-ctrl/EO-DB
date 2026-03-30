/**
 * Segment key operations: generation, encryption, decryption, waterfall resolution.
 * Uses Web Crypto API — AES-256-GCM, same pattern as github-matrix-dev/app/src/lib/crypto.ts.
 */

import { v4 as uuid } from 'uuid';
import type { EncryptedOperand, SegmentKey, LocalKeyring, KeyringEntry } from '../db/crypto-types.js';
import { isEncryptedOperand } from '../db/crypto-types.js';
import { pack, unpack } from 'msgpackr';

const AES_KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96-bit IV for AES-GCM

// ─── Key Generation ─────────────────────────────────────────────────────────

/**
 * Generate a new segment key for the given scope.
 * Returns the metadata and the raw CryptoKey (caller stores the key locally
 * and announces the metadata to the key room).
 */
export async function generateSegmentKey(
  scope: string,
  agent: string,
  label?: string,
): Promise<{ metadata: SegmentKey; key: CryptoKey }> {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    true, // extractable — needed for export/wrapping
    ['encrypt', 'decrypt'],
  );

  const metadata: SegmentKey = {
    key_id: uuid(),
    scope,
    version: 1,
    created_by: agent,
    created_at: new Date().toISOString(),
    label,
  };

  return { metadata, key };
}

// ─── Encrypt / Decrypt ──────────────────────────────────────────────────────

/**
 * Encrypt a plaintext operand with a segment key.
 * Returns an EncryptedOperand envelope ready to store in an EoEvent.
 */
export async function encryptOperand(
  key: CryptoKey,
  keyId: string,
  keyVersion: number,
  plainOperand: any,
): Promise<EncryptedOperand> {
  const plainBytes = pack(plainOperand);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plainBytes as unknown as ArrayBuffer,
  );

  // Combine IV + ciphertext into one buffer, then base64-encode
  const combined = new Uint8Array(IV_LENGTH + ciphertextBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertextBuf), IV_LENGTH);

  return {
    _encrypted: true,
    key_id: keyId,
    ciphertext: bufferToBase64(combined),
    key_version: keyVersion,
  };
}

/**
 * Decrypt an EncryptedOperand back to its plaintext value.
 * Throws if the key cannot decrypt (wrong key, tampered data, etc.).
 */
export async function decryptOperand(
  key: CryptoKey,
  encrypted: EncryptedOperand,
): Promise<any> {
  const combined = base64ToBuffer(encrypted.ciphertext);
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );

  return unpack(new Uint8Array(plainBuf));
}

// ─── Keyring & Waterfall Resolution ─────────────────────────────────────────

/** Create an empty keyring. */
export function createKeyring(): LocalKeyring {
  return { keys: new Map() };
}

/** Add a key to the local keyring. */
export function addToKeyring(
  keyring: LocalKeyring,
  keyId: string,
  entry: KeyringEntry,
): void {
  keyring.keys.set(keyId, entry);
}

/**
 * Resolve the encryption key for a target by walking up the prefix hierarchy.
 * Returns the keyring entry whose scope is the longest prefix match, or null
 * if no key covers this target (plaintext).
 *
 * This is the "waterfall" — a key at "app.tblClients" covers
 * "app.tblClients.rec123.fldSSN" unless a more specific key exists.
 */
export function resolveKeyForTarget(
  keyring: LocalKeyring,
  target: string,
): KeyringEntry | null {
  // Build candidate scopes: exact target + all ancestor prefixes
  const parts = target.split('.');
  let bestMatch: KeyringEntry | null = null;
  let bestDepth = -1;

  for (const [, entry] of keyring.keys) {
    // Check if this key's scope is a prefix of (or equal to) the target
    if (target === entry.scope || target.startsWith(entry.scope + '.')) {
      const depth = entry.scope.split('.').length;
      if (depth > bestDepth) {
        bestDepth = depth;
        bestMatch = entry;
      }
    }
  }

  return bestMatch;
}

/**
 * Find a key in the keyring by key_id (for decrypting a specific EncryptedOperand).
 */
export function getKeyById(
  keyring: LocalKeyring,
  keyId: string,
): KeyringEntry | null {
  return keyring.keys.get(keyId) ?? null;
}

/**
 * Export a CryptoKey to raw bytes (for wrapping / transport).
 */
export async function exportKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(raw);
}

/**
 * Import raw key bytes into a CryptoKey.
 */
export async function importKey(rawBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    rawBytes as unknown as ArrayBuffer,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    true,
    ['encrypt', 'decrypt'],
  );
}

// ─── Base64 Helpers ─────────────────────────────────────────────────────────

function bufferToBase64(buf: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buf).toString('base64');
  }
  // Browser fallback
  let binary = '';
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  // Browser fallback
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buf[i] = binary.charCodeAt(i);
  }
  return buf;
}
