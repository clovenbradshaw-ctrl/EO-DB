/**
 * Cryptographic utilities for the encrypted IndexedDB store.
 * Uses Web Crypto API — PBKDF2 for key derivation, AES-GCM for encryption.
 */

const PBKDF2_ITERATIONS = 100_000;
const AES_KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96-bit IV for AES-GCM

/**
 * Derive an AES-GCM encryption key from the Matrix session.
 * Salt is deterministic from userId + deviceId so the same session always
 * produces the same key (enabling re-open after page reload).
 */
export async function deriveKey(
  userId: string,
  deviceId: string,
  accessToken: string,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(accessToken),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  const salt = encoder.encode(`${userId}:${deviceId}`);

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a Uint8Array with AES-GCM.
 * Returns a single buffer: [12-byte IV | ciphertext].
 */
export async function encrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new Uint8Array(data).buffer as ArrayBuffer,
  );
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);
  return result;
}

/**
 * Decrypt an AES-GCM encrypted buffer (IV prepended).
 */
export async function decrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );
  return new Uint8Array(plaintext);
}
