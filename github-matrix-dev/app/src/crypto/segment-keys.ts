/**
 * Minimal client-side segment key utilities for snapshot/peer encryption.
 */

import type { LocalKeyring, KeyringEntry } from '../db/crypto-types';

/** Look up a key by ID in the local keyring. */
export function getKeyById(
  keyring: LocalKeyring,
  keyId: string,
): KeyringEntry | null {
  return keyring.keys.get(keyId) ?? null;
}

/** Pick the first key in the keyring (for space-level snapshot encryption). */
export function resolveSnapshotKeyId(keyring: LocalKeyring): string | undefined {
  const first = keyring.keys.entries().next();
  if (first.done) return undefined;
  return first.value[0];
}

// ─── Base64 Helpers (browser) ─────────────────────────────────────────────

export function bufferToBase64(buf: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

export function base64ToBuffer(b64: string): Uint8Array {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buf[i] = binary.charCodeAt(i);
  }
  return buf;
}
