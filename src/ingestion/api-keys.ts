/**
 * Airtable API key storage.
 *
 * Keys are stored per-source (keyed by a user-chosen label) in LevelDB
 * under `ingestion:airtable:key:{label}`. All users within the same Matrix
 * instance (same EO-DB server) share the stored keys, so any device can
 * leverage them for sync without each user needing their own key.
 *
 * Keys are encrypted at rest using AES-256-GCM with a key derived from the
 * server-held EO_INGESTION_SECRET. Startup fails if the secret is unset or
 * shorter than 32 characters.
 */

import type { EoDb } from '../db/level.js';
import { encode, decode } from '../db/level.js';
import { encryptWithPassword, decryptWithPassword } from '../crypto/encrypted-local-store.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StoredApiKey {
  /** User-chosen label, e.g. "immigration-base" or "main" */
  label: string;
  /** The Airtable personal access token (stored obfuscated) */
  api_key: string;
  /** Which Matrix user stored this key */
  added_by: string;
  /** When the key was stored */
  added_at: string;
  /** When the key was last used for a sync */
  last_used_at?: string;
  /** Optional: restrict to specific base IDs (empty = all bases) */
  base_ids?: string[];
}

// ─── Key prefix ─────────────────────────────────────────────────────────────

const KEY_PREFIX = 'ingestion:airtable:key:';

// ─── Encryption ─────────────────────────────────────────────────────────────

const ENCRYPTED_PREFIX = 'v2:';
const MIN_SECRET_LEN = 32;

function requireSecret(): string {
  const secret = process.env.EO_INGESTION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LEN) {
    throw new Error(
      `EO_INGESTION_SECRET must be set to at least ${MIN_SECRET_LEN} characters before storing or reading ingestion API keys.`,
    );
  }
  return secret;
}

function obfuscate(plain: string): string {
  const secret = requireSecret();
  const ciphertext = encryptWithPassword(Buffer.from(plain, 'utf8'), secret);
  return ENCRYPTED_PREFIX + ciphertext.toString('base64');
}

function deobfuscate(encoded: string): string {
  if (!encoded.startsWith(ENCRYPTED_PREFIX)) {
    throw new Error('Stored API key uses legacy XOR obfuscation and must be re-added.');
  }
  const secret = requireSecret();
  const blob = Buffer.from(encoded.slice(ENCRYPTED_PREFIX.length), 'base64');
  return decryptWithPassword(blob, secret).toString('utf8');
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/** Store an Airtable API key under a label. Overwrites if label already exists. */
export async function storeApiKey(
  db: EoDb,
  label: string,
  apiKey: string,
  actor: string,
  baseIds?: string[],
): Promise<StoredApiKey> {
  const entry: StoredApiKey = {
    label,
    api_key: obfuscate(apiKey),
    added_by: actor,
    added_at: new Date().toISOString(),
    base_ids: baseIds,
  };
  await db.put(`${KEY_PREFIX}${label}`, encode(entry));
  return { ...entry, api_key: '***' };
}

/** Retrieve an API key by label. Returns the decrypted key. */
export async function getApiKey(db: EoDb, label: string): Promise<StoredApiKey | null> {
  try {
    const buf = await db.get(`${KEY_PREFIX}${label}`);
    const entry = decode(buf) as StoredApiKey;
    return { ...entry, api_key: deobfuscate(entry.api_key) };
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

/** Retrieve an API key by label, returning a redacted version (no secret). */
export async function getApiKeyRedacted(db: EoDb, label: string): Promise<StoredApiKey | null> {
  try {
    const buf = await db.get(`${KEY_PREFIX}${label}`);
    const entry = decode(buf) as StoredApiKey;
    return { ...entry, api_key: '***' };
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

/** List all stored API key labels (redacted — no secrets returned). */
export async function listApiKeys(db: EoDb): Promise<StoredApiKey[]> {
  const keys: StoredApiKey[] = [];
  for await (const [key, value] of db.iterator({
    gte: KEY_PREFIX,
    lte: `${KEY_PREFIX}\xff`,
  })) {
    const entry = decode(value) as StoredApiKey;
    keys.push({ ...entry, api_key: '***' });
  }
  return keys;
}

/** Delete a stored API key by label. */
export async function deleteApiKey(db: EoDb, label: string): Promise<boolean> {
  try {
    await db.get(`${KEY_PREFIX}${label}`);
    await db.del(`${KEY_PREFIX}${label}`);
    return true;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return false;
    throw e;
  }
}

/** Mark a key as recently used (updates last_used_at). */
export async function touchApiKey(db: EoDb, label: string): Promise<void> {
  try {
    const buf = await db.get(`${KEY_PREFIX}${label}`);
    const entry = decode(buf) as StoredApiKey;
    entry.last_used_at = new Date().toISOString();
    await db.put(`${KEY_PREFIX}${label}`, encode(entry));
  } catch {
    // Silently ignore if key doesn't exist
  }
}
