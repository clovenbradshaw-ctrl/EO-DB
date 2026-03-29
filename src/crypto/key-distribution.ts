/**
 * Key distribution — P2P segment key sharing via Matrix rooms.
 *
 * Design:
 * - Keys are announced to a dedicated "key room" as room state events
 * - Everyone in the room gets all keys (default access = room membership)
 * - New devices heal their keyring by paginating room history
 * - Peers can request missing keys via to-device messages (gap filling)
 *
 * Matrix event types (namespace derived from EO_EVENT_PREFIX, default "com.eo-db"):
 *   {prefix}.key.announce       — room state: segment key metadata + material
 *   {prefix}.key.heal.request   — to-device: request missing keys
 *   {prefix}.key.heal.response  — to-device: batch of keys
 *
 * Key room vs data room:
 *   The data room carries EO events (encrypted operands).
 *   The key room carries the keys to decrypt them.
 *   Separate rooms = separate membership = granular access.
 */

import type { SegmentKey, LocalKeyring, KeyringEntry } from '../db/crypto-types.js';
import { createKeyring, addToKeyring, importKey, exportKey } from './segment-keys.js';
import { keyEventTypes } from '../config/matrix-domain.js';

// ─── Matrix Event Types ─────────────────────────────────────────────────────

/** Event types are derived from the configurable event prefix (EO_EVENT_PREFIX). */
export const KEY_ANNOUNCE_TYPE = keyEventTypes().announce;
export const KEY_HEAL_REQUEST = keyEventTypes().healRequest;
export const KEY_HEAL_RESPONSE = keyEventTypes().healResponse;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Content of a key announce room state event. */
export interface KeyAnnounceContent {
  /** Segment key metadata */
  metadata: SegmentKey;
  /** Base64-encoded raw AES-256 key material (32 bytes) */
  key_material: string;
}

/** Content of a heal request (to-device). */
export interface KeyHealRequest {
  /** Key IDs this device already has */
  known_key_ids: string[];
  /** Device ID of the requester (for reply routing) */
  from_device: string;
}

/** Content of a heal response (to-device). */
export interface KeyHealResponse {
  /** Keys the requester was missing */
  keys: KeyAnnounceContent[];
}

/** Minimal Matrix client interface for key distribution. */
export interface KeyDistributionClient {
  /** Send a state event to a room. */
  sendStateEvent(roomId: string, eventType: string, content: any, stateKey: string): Promise<void>;
  /** Get all state events of a given type from a room. */
  getStateEvents(roomId: string, eventType: string): Promise<any[]>;
  /** Send a to-device message. */
  sendToDevice(eventType: string, contentMap: Map<string, Map<string, any>>): Promise<void>;
  /** Get own user ID. */
  getUserId(): string | null;
  /** Get own device ID. */
  getDeviceId(): string | null | undefined;
  /** Get room members. */
  getRoomMembers(roomId: string): { userId: string }[];
}

// ─── Announce ───────────────────────────────────────────────────────────────

/**
 * Announce a new segment key to the key room.
 * Posts the key as a room state event (state_key = key_id).
 * Everyone in the room can read it — default access = room membership.
 */
export async function announceKey(
  client: KeyDistributionClient,
  keyRoomId: string,
  metadata: SegmentKey,
  key: CryptoKey,
): Promise<void> {
  const rawBytes = await exportKey(key);
  const keyMaterial = bufferToBase64(rawBytes);

  const content: KeyAnnounceContent = {
    metadata,
    key_material: keyMaterial,
  };

  // State key = key_id so each key is a separate state event (updatable for rotation)
  await client.sendStateEvent(keyRoomId, KEY_ANNOUNCE_TYPE, content, metadata.key_id);
}

// ─── Sync Keyring (Full Rebuild) ────────────────────────────────────────────

/**
 * Rebuild the local keyring from the key room's current state.
 * Called on first login, new device setup, or manual resync.
 * Reads all key announce state events and imports every key.
 */
export async function syncKeyring(
  client: KeyDistributionClient,
  keyRoomId: string,
): Promise<LocalKeyring> {
  const keyring = createKeyring();
  const stateEvents = await client.getStateEvents(keyRoomId, KEY_ANNOUNCE_TYPE);

  for (const event of stateEvents) {
    const content = (event.getContent ? event.getContent() : event.content ?? event) as KeyAnnounceContent;
    if (!content.metadata || !content.key_material) continue;

    try {
      const rawBytes = base64ToBuffer(content.key_material);
      const cryptoKey = await importKey(rawBytes);

      addToKeyring(keyring, content.metadata.key_id, {
        key: cryptoKey,
        scope: content.metadata.scope,
        version: content.metadata.version,
      });
    } catch {
      // Skip keys that fail to import (corrupted, wrong format, etc.)
    }
  }

  return keyring;
}

// ─── P2P Heal (Gap Fill) ────────────────────────────────────────────────────

/**
 * Request missing keys from peers via to-device messaging.
 * Sends a heal request to all other members in the key room.
 * Peers respond with any keys the requester is missing.
 */
export async function requestKeyHeal(
  client: KeyDistributionClient,
  keyRoomId: string,
  currentKeyring: LocalKeyring,
): Promise<void> {
  const myUserId = client.getUserId()!;
  const myDeviceId = client.getDeviceId()!;
  const members = client.getRoomMembers(keyRoomId);

  const knownKeyIds = Array.from(currentKeyring.keys.keys());

  const request: KeyHealRequest = {
    known_key_ids: knownKeyIds,
    from_device: myDeviceId as string,
  };

  for (const member of members) {
    if (member.userId === myUserId) continue;

    const inner = new Map<string, any>();
    inner.set('*', request); // Send to all devices of this user
    const outer = new Map<string, Map<string, any>>();
    outer.set(member.userId, inner);

    await client.sendToDevice(KEY_HEAL_REQUEST, outer);
  }
}

/**
 * Handle an incoming heal request from a peer.
 * Responds with any keys the peer is missing from our keyring.
 */
export async function handleHealRequest(
  client: KeyDistributionClient,
  senderUserId: string,
  senderDeviceId: string,
  request: KeyHealRequest,
  localKeyring: LocalKeyring,
): Promise<void> {
  const knownSet = new Set(request.known_key_ids);
  const missingKeys: KeyAnnounceContent[] = [];

  for (const [keyId, entry] of localKeyring.keys) {
    if (knownSet.has(keyId)) continue;

    try {
      const rawBytes = await exportKey(entry.key);
      missingKeys.push({
        metadata: {
          key_id: keyId,
          scope: entry.scope,
          version: entry.version,
          created_by: '', // Not tracked in keyring entry
          created_at: '', // Not tracked in keyring entry
        },
        key_material: bufferToBase64(rawBytes),
      });
    } catch {
      // Skip keys that fail to export
    }
  }

  if (missingKeys.length === 0) return;

  const response: KeyHealResponse = { keys: missingKeys };

  const inner = new Map<string, any>();
  inner.set(senderDeviceId, response);
  const outer = new Map<string, Map<string, any>>();
  outer.set(senderUserId, inner);

  await client.sendToDevice(KEY_HEAL_RESPONSE, outer);
}

/**
 * Process an incoming heal response — import the received keys into the keyring.
 */
export async function processHealResponse(
  response: KeyHealResponse,
  keyring: LocalKeyring,
): Promise<string[]> {
  const imported: string[] = [];

  for (const keyContent of response.keys) {
    if (keyring.keys.has(keyContent.metadata.key_id)) continue;

    try {
      const rawBytes = base64ToBuffer(keyContent.key_material);
      const cryptoKey = await importKey(rawBytes);

      addToKeyring(keyring, keyContent.metadata.key_id, {
        key: cryptoKey,
        scope: keyContent.metadata.scope,
        version: keyContent.metadata.version,
      });

      imported.push(keyContent.metadata.key_id);
    } catch {
      // Skip keys that fail to import
    }
  }

  return imported;
}

// ─── Key Rotation ───────────────────────────────────────────────────────────

/**
 * Rotate a segment key — generate new version and announce it.
 * The old version stays in the keyring for decrypting historical data.
 * New writes will use the new version.
 *
 * Returns the new key metadata and CryptoKey.
 */
export async function rotateKey(
  client: KeyDistributionClient,
  keyRoomId: string,
  existingMetadata: SegmentKey,
): Promise<{ metadata: SegmentKey; key: CryptoKey }> {
  // Import generateSegmentKey here to get a fresh key
  const { generateSegmentKey } = await import('./segment-keys.js');

  const { metadata: newMeta, key: newKey } = await generateSegmentKey(
    existingMetadata.scope,
    client.getUserId()!,
    existingMetadata.label,
  );

  // Override key_id to match the existing key (same key, new version)
  const rotatedMetadata: SegmentKey = {
    ...newMeta,
    key_id: existingMetadata.key_id,
    version: existingMetadata.version + 1,
  };

  await announceKey(client, keyRoomId, rotatedMetadata, newKey);

  return { metadata: rotatedMetadata, key: newKey };
}

// ─── Base64 Helpers ─────────────────────────────────────────────────────────

function bufferToBase64(buf: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buf).toString('base64');
  }
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
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buf[i] = binary.charCodeAt(i);
  }
  return buf;
}
