/**
 * Offline authentication via IndexedDB.
 *
 * On successful online login the Matrix session is encrypted with a key
 * derived from the user's password (PBKDF2 + AES-GCM) and stored in a
 * dedicated IndexedDB object store.  When the network is unavailable the
 * user can re-enter their password; we derive the same key, decrypt the
 * stored session, and return it — proving the password is correct without
 * ever persisting the plaintext password or a verifiable hash.
 */

import { openDB } from 'idb';
import type { MatrixSession } from '../matrix/client';

const DB_NAME = 'eo-db-auth';
const DB_VERSION = 1;
const STORE_NAME = 'credentials';

const PBKDF2_ITERATIONS = 100_000;
const IV_LENGTH = 12;

// ── Helpers ──────────────────────────────────────────────────────────

async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

async function aesEncrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data.buffer as ArrayBuffer);
  const out = new Uint8Array(IV_LENGTH + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_LENGTH);
  return out;
}

async function aesDecrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = data.slice(0, IV_LENGTH);
  const ct = data.slice(IV_LENGTH);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct.buffer as ArrayBuffer);
  return new Uint8Array(pt);
}

async function openAuthDb() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    },
  });
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Persist an encrypted copy of the session, keyed by the user's password.
 * Call this after every successful online login.
 */
export async function saveOfflineCredentials(
  session: MatrixSession,
  password: string,
): Promise<void> {
  const salt = generateSalt();
  const key = await deriveKeyFromPassword(password, salt);

  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(session));
  const encrypted = await aesEncrypt(key, plaintext);

  const db = await openAuthDb();
  // Key by homeserver + userId so multiple accounts can coexist
  const storeKey = `${session.homeserver}|${session.userId}`;
  await db.put(STORE_NAME, { salt, encrypted }, storeKey);
  db.close();
}

/**
 * Attempt to decrypt a previously stored session using the provided password.
 * Returns the session if the password is correct, null otherwise.
 */
export async function verifyOfflineCredentials(
  homeserver: string,
  userId: string,
  password: string,
): Promise<MatrixSession | null> {
  const db = await openAuthDb();
  const storeKey = `${homeserver}|${userId}`;
  const record = await db.get(STORE_NAME, storeKey);
  db.close();

  if (!record) return null;

  try {
    const key = await deriveKeyFromPassword(password, new Uint8Array(record.salt));
    const plaintext = await aesDecrypt(key, new Uint8Array(record.encrypted));
    const dec = new TextDecoder();
    return JSON.parse(dec.decode(plaintext)) as MatrixSession;
  } catch {
    // Decryption failure means wrong password
    return null;
  }
}

/**
 * List homeserver+userId pairs that have stored offline credentials.
 * Useful for showing which accounts are available for offline login.
 */
export async function listOfflineAccounts(): Promise<{ homeserver: string; userId: string }[]> {
  const db = await openAuthDb();
  const keys = await db.getAllKeys(STORE_NAME);
  db.close();

  return (keys as string[]).map((k) => {
    const [homeserver, userId] = k.split('|');
    return { homeserver, userId };
  });
}

/**
 * Remove stored offline credentials for an account.
 */
export async function clearOfflineCredentials(
  homeserver: string,
  userId: string,
): Promise<void> {
  const db = await openAuthDb();
  const storeKey = `${homeserver}|${userId}`;
  await db.delete(STORE_NAME, storeKey);
  db.close();
}
