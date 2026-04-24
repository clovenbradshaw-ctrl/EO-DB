/**
 * Role-scoped key delivery — sends space encryption keys to users via Matrix
 * to-device messages when roles are granted or changed.
 *
 * Four fixed key scopes per space:
 *   {spaceId}.viewer     — All members.  Decrypts manifest + space-log.
 *   {spaceId}.editor     — editor+.  Write authority (signing).
 *   {spaceId}.restricted — restricted+.  Decrypts restricted-log.
 *   {spaceId}.admin      — admin/owner.  Decrypts admin-log.
 *
 * Key delivery:
 *   When an admin grants a role to a user, they call deliverRoleKeys().
 *   This sends all tier keys ≤ the granted role to the user's device(s) via
 *   Matrix sendToDevice.  Key material is base64-encoded AES-256 raw bytes.
 *
 * Heal request safety:
 *   The existing heal-request protocol (peer asks for keys it's missing) has a
 *   gap: without a role check, any peer could request a restricted-key by
 *   simply listing it as missing.  handleManifestCheckedHealRequest() closes
 *   this by folding the space manifest to determine the requester's role before
 *   responding — it only sends keys ≤ their tier.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import type { LocalKeyring } from '../db/crypto-types';
import {
  type SpaceRole,
  type ManifestState,
  roleAtLeast,
} from '../permissions/space-manifest';
import { getKeyById } from './segment-keys';
import { bufferToBase64, base64ToBuffer } from './segment-keys';

// ─── Event type ───────────────────────────────────────────────────────────────

export const KEY_DELIVER_TYPE = 'com.eo-db.key.deliver';
export const KEY_HEAL_REQUEST_TYPE = 'com.eo-db.key.heal.request';
export const KEY_HEAL_RESPONSE_TYPE = 'com.eo-db.key.heal.response';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Payload for a key deliver to-device message. */
export interface KeyDeliverPayload {
  space_id: string;
  /** Map of key_id → base64-encoded raw AES-256 key bytes. */
  keys: Record<string, string>;
}

/** Payload for a heal request to-device message. */
export interface KeyHealRequest {
  space_id: string;
  known_key_ids: string[];
  from_device: string;
}

/** Payload for a heal response to-device message. */
export interface KeyHealResponse {
  space_id: string;
  /** Map of key_id → base64-encoded raw AES-256 key bytes. */
  keys: Record<string, string>;
}

// ─── Role → key-scope mapping ─────────────────────────────────────────────────

/** Which key scopes a given role is entitled to receive. */
const ROLE_KEY_SCOPES: Record<SpaceRole, Array<'viewer' | 'editor' | 'restricted' | 'admin'>> = {
  viewer:     ['viewer'],
  editor:     ['viewer', 'editor'],
  restricted: ['viewer', 'editor', 'restricted'],
  admin:      ['viewer', 'editor', 'restricted', 'admin'],
  owner:      ['viewer', 'editor', 'restricted', 'admin'],
};

// ─── Key scope → keyring key lookup ──────────────────────────────────────────

/**
 * Resolve a keyring entry for a specific role tier.
 * Looks for a key whose scope matches `{spaceId}.{tier}`.
 */
function findTierKey(
  keyring: LocalKeyring,
  spaceId: string,
  tier: 'viewer' | 'editor' | 'restricted' | 'admin',
): { keyId: string; key: CryptoKey } | null {
  const targetScope = `${spaceId}.${tier}`;
  for (const [keyId, entry] of keyring.keys) {
    if (entry.scope === targetScope) {
      return { keyId, key: entry.key };
    }
  }
  return null;
}

// ─── Export / import helpers ──────────────────────────────────────────────────

async function exportKeyToBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bufferToBase64(new Uint8Array(raw));
}

async function importKeyFromBase64(b64: string): Promise<CryptoKey> {
  const raw = base64ToBuffer(b64);
  return crypto.subtle.importKey(
    'raw',
    raw as unknown as BufferSource,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

// ─── sendToDevice helper ──────────────────────────────────────────────────────

function buildToDeviceMap(
  userId: string,
  deviceId: string,
  content: object,
): Map<string, Map<string, object>> {
  const inner = new Map<string, object>();
  inner.set(deviceId, content);
  const outer = new Map<string, Map<string, object>>();
  outer.set(userId, inner);
  return outer;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Deliver role-appropriate encryption keys to a user via Matrix to-device.
 *
 * Sends all tier keys the user is entitled to based on their new role.
 * Uses '*' as the device ID so all of the user's devices receive the keys.
 *
 * Call this BEFORE adding the user to the Matrix room and BEFORE appending
 * the grant event to manifest.eodb, so the user has keys ready when they
 * first open the space.
 */
export async function deliverRoleKeys(
  client: MatrixClient,
  targetUserId: string,
  spaceId: string,
  role: SpaceRole,
  adminKeyring: LocalKeyring,
): Promise<void> {
  const scopes = ROLE_KEY_SCOPES[role];
  const keysToSend: Record<string, string> = {};

  for (const tier of scopes) {
    const found = findTierKey(adminKeyring, spaceId, tier);
    if (!found) {
      console.warn(`[key-delivery] No ${tier}-key found for space ${spaceId} — skipping`);
      continue;
    }
    const b64 = await exportKeyToBase64(found.key);
    keysToSend[found.keyId] = b64;
  }

  if (Object.keys(keysToSend).length === 0) {
    console.warn(`[key-delivery] No keys to deliver to ${targetUserId} for role ${role}`);
    return;
  }

  const payload: KeyDeliverPayload = { space_id: spaceId, keys: keysToSend };

  // Send to all devices ('*')
  const inner = new Map<string, object>();
  inner.set('*', payload);
  const outer = new Map<string, Map<string, object>>();
  outer.set(targetUserId, inner);

  await client.sendToDevice(KEY_DELIVER_TYPE, outer as any);
  console.log(`[key-delivery] Delivered ${Object.keys(keysToSend).length} key(s) to ${targetUserId} (role: ${role})`);
}

/**
 * Import keys received in a KEY_DELIVER to-device message into the local keyring.
 *
 * Call this from the Matrix to-device event handler when receiving
 * a `com.eo-db.key.deliver` event.
 */
export async function receiveDeliveredKeys(
  payload: KeyDeliverPayload,
  keyring: LocalKeyring,
  spaceId: string,
): Promise<string[]> {
  if (payload.space_id !== spaceId) return [];

  const imported: string[] = [];
  for (const [keyId, b64] of Object.entries(payload.keys)) {
    if (keyring.keys.has(keyId)) continue;
    try {
      const key = await importKeyFromBase64(b64);
      // Determine scope from the key ID convention — the delivering admin
      // should have set the scope in the keyring; we reconstruct a minimal entry.
      keyring.keys.set(keyId, { key, scope: `${spaceId}.delivered`, version: 1 });
      imported.push(keyId);
    } catch {
      console.warn(`[key-delivery] Failed to import key ${keyId}`);
    }
  }
  return imported;
}

/**
 * Handle a peer's heal request, gating responses against the manifest.
 *
 * Only sends keys ≤ the requester's role in the manifest.  This closes the
 * gap where a viewer could request a restricted-key by exploiting the heal
 * mechanism.
 *
 * If the requester is not in the manifest at all, no keys are sent.
 */
export async function handleManifestCheckedHealRequest(
  client: MatrixClient,
  senderUserId: string,
  senderDeviceId: string,
  request: KeyHealRequest,
  localKeyring: LocalKeyring,
  manifestState: ManifestState,
): Promise<void> {
  // Determine requester's role from the manifest.
  const member = manifestState.members[senderUserId];
  if (!member) {
    console.warn(`[key-delivery] Heal request from non-member ${senderUserId} — ignoring`);
    return;
  }

  const requesterRole = member.role;
  const allowedScopes = ROLE_KEY_SCOPES[requesterRole].map(
    tier => `${request.space_id}.${tier}`,
  );

  const knownSet = new Set(request.known_key_ids);
  const keysToSend: Record<string, string> = {};

  for (const [keyId, entry] of localKeyring.keys) {
    if (knownSet.has(keyId)) continue;
    // Only send if the key's scope is within the requester's allowed tiers.
    if (!allowedScopes.includes(entry.scope)) {
      console.log(
        `[key-delivery] Withholding key ${keyId} (scope: ${entry.scope}) from ${senderUserId} (role: ${requesterRole})`,
      );
      continue;
    }
    try {
      const b64 = await exportKeyToBase64(entry.key);
      keysToSend[keyId] = b64;
    } catch {
      // Skip keys that fail to export.
    }
  }

  if (Object.keys(keysToSend).length === 0) return;

  const response: KeyHealResponse = {
    space_id: request.space_id,
    keys: keysToSend,
  };

  await client.sendToDevice(
    KEY_HEAL_RESPONSE_TYPE,
    buildToDeviceMap(senderUserId, senderDeviceId, response) as any,
  );
}

/**
 * Process an incoming heal response — import received keys into the keyring.
 */
export async function processHealResponse(
  response: KeyHealResponse,
  keyring: LocalKeyring,
  spaceId: string,
): Promise<string[]> {
  if (response.space_id !== spaceId) return [];

  const imported: string[] = [];
  for (const [keyId, b64] of Object.entries(response.keys)) {
    if (keyring.keys.has(keyId)) continue;
    try {
      const key = await importKeyFromBase64(b64);
      keyring.keys.set(keyId, { key, scope: `${spaceId}.delivered`, version: 1 });
      imported.push(keyId);
    } catch {
      console.warn(`[key-delivery] Failed to import heal key ${keyId}`);
    }
  }
  return imported;
}
