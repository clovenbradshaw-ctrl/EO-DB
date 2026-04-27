/**
 * Per-space AES-256 keyring persisted to localStorage.
 *
 * The n8n blob webhook is a dumb pipe that only stores ciphertext — keys never
 * leave the browser via HTTP. Keys are minted locally the first time a space
 * is opened on a fresh device (and no remote blob exists yet), or imported via
 * Matrix `com.eo-db.key.deliver` / `com.eo-db.key.heal.response` to-device
 * messages.
 *
 * Storage layout:
 *   localStorage['eo-db:keyring:<roomId>'] = JSON stringified {
 *     keys: { [keyId]: { raw: base64, scope: string, version: number } }
 *   }
 *
 * AES-256 raw key material is 32 bytes → 44 base64 chars per key. At a
 * typical 4–8 keys per space, a 1000-space user consumes ≪ 100 KB — well
 * under any localStorage quota.
 *
 * This store holds EVERY space's keys the device has ever received. A
 * LocalKeyring returned here is scoped to a single space so existing
 * subsystems (blob-writer, peer-sync, etc.) continue to operate on a
 * single-space view.
 */

import type { LocalKeyring } from '../db/crypto-types';
import { bufferToBase64, base64ToBuffer } from './segment-keys';

interface PersistedKeyEntry {
  /** Base64-encoded raw AES-256 key bytes (32 bytes → 44 chars). */
  raw: string;
  scope: string;
  version: number;
}

interface PersistedKeyring {
  keys: Record<string, PersistedKeyEntry>;
}

const STORAGE_PREFIX = 'eo-db:keyring:';

function storageKey(spaceId: string): string {
  return `${STORAGE_PREFIX}${spaceId}`;
}

async function importRawAesKey(rawB64: string): Promise<CryptoKey> {
  const raw = base64ToBuffer(rawB64);
  return crypto.subtle.importKey(
    'raw',
    raw as unknown as BufferSource,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

async function exportRawAesKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bufferToBase64(new Uint8Array(raw));
}

/** Load a space's keyring from localStorage. Missing → empty keyring. */
export async function loadSpaceKeyring(spaceId: string): Promise<LocalKeyring> {
  const keyring: LocalKeyring = { keys: new Map() };
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey(spaceId));
  } catch {
    return keyring;
  }
  if (!raw) return keyring;
  let parsed: PersistedKeyring;
  try {
    parsed = JSON.parse(raw) as PersistedKeyring;
  } catch {
    console.warn('[keyring-store] Corrupt keyring JSON for space', spaceId, '— discarding');
    return keyring;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.keys) return keyring;
  for (const [keyId, entry] of Object.entries(parsed.keys)) {
    if (!entry || typeof entry.raw !== 'string') continue;
    try {
      const key = await importRawAesKey(entry.raw);
      keyring.keys.set(keyId, {
        key,
        scope: entry.scope ?? `${spaceId}.blob`,
        version: typeof entry.version === 'number' ? entry.version : 1,
      });
    } catch (e) {
      console.warn('[keyring-store] Failed to import persisted key', keyId, e);
    }
  }
  return keyring;
}

/** Serialize a keyring's current contents back to localStorage. */
export async function persistSpaceKeyring(
  spaceId: string,
  keyring: LocalKeyring,
): Promise<void> {
  const out: PersistedKeyring = { keys: {} };
  for (const [keyId, entry] of keyring.keys) {
    try {
      out.keys[keyId] = {
        raw: await exportRawAesKey(entry.key),
        scope: entry.scope,
        version: entry.version,
      };
    } catch (e) {
      console.warn('[keyring-store] Failed to export key for persistence', keyId, e);
    }
  }
  try {
    localStorage.setItem(storageKey(spaceId), JSON.stringify(out));
  } catch (e) {
    console.warn('[keyring-store] Failed to write keyring to localStorage', e);
  }
}

/**
 * Generate a fresh AES-256-GCM key for the space, add it to the keyring, and
 * persist. Returns the new key id.
 *
 * The key id is a random 24-char hex string — collision-resistant enough for
 * a per-space namespace without pulling in UUID deps.
 */
export async function generateSpaceKey(
  spaceId: string,
  keyring: LocalKeyring,
  scope: string = `${spaceId}.blob`,
): Promise<string> {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const idBytes = crypto.getRandomValues(new Uint8Array(12));
  let keyId = '';
  for (const b of idBytes) keyId += b.toString(16).padStart(2, '0');
  keyring.keys.set(keyId, { key, scope, version: 1 });
  await persistSpaceKeyring(spaceId, keyring);
  return keyId;
}

/**
 * Import a key delivered over Matrix to-device (KEY_DELIVER or heal response)
 * into an existing keyring and persist. Returns true if the key was new.
 */
export async function importDeliveredKey(
  spaceId: string,
  keyring: LocalKeyring,
  keyId: string,
  rawB64: string,
  scope: string,
): Promise<boolean> {
  if (keyring.keys.has(keyId)) return false;
  try {
    const key = await importRawAesKey(rawB64);
    keyring.keys.set(keyId, { key, scope, version: 1 });
    await persistSpaceKeyring(spaceId, keyring);
    return true;
  } catch (e) {
    console.warn('[keyring-store] Failed to import delivered key', keyId, e);
    return false;
  }
}

/** Export a keyring entry's raw bytes for an outgoing heal response. */
export async function exportKeyMaterial(
  keyring: LocalKeyring,
  keyId: string,
): Promise<string | null> {
  const entry = keyring.keys.get(keyId);
  if (!entry) return null;
  try {
    return await exportRawAesKey(entry.key);
  } catch {
    return null;
  }
}
