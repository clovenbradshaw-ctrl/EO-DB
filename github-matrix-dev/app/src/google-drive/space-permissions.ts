/**
 * Space permission manifests — per-user Drive-backed access control.
 *
 * Each space member has a short EO event log stored at
 *   EO-DB/eodb-{spaceId}/members/@{userId}.eodb
 * (encrypted with the space viewer-key).
 *
 * Folding that log gives the user's current access state: role, which
 * tier files they can reach, shadow field values, and which key IDs to use.
 *
 * Key bytes themselves are never stored here — they travel via Matrix
 * to-device messages. The manifest only records key IDs (routing info).
 */

import type { MatrixClient } from 'matrix-js-sdk';
import type { LocalKeyring } from '../db/crypto-types';
import type { EoEvent } from '../db/types';
import type { AccessRole } from '../permissions/types';
import { ROLE_POWER_LEVELS } from '../permissions/types';
import { packEodb, unpackEodb } from './eodb-format';
import { encryptSnapshot, decryptSnapshot } from '../crypto/snapshot-crypto';
import { resolveSnapshotKeyId, bufferToBase64, base64ToBuffer } from '../crypto/segment-keys';
import { gdriveStoreNamed, gdriveRetrieveNamed } from './gdrive-api';
import { PERMISSIONS_KEY_DELIVER, PERMISSIONS_UPDATED } from '../lib/matrix-domain';
import { buildToDeviceContent } from '../matrix/peer-sync';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserManifest {
  userId: string;
  spaceId: string;
  /** Folded role — the highest role granted and not subsequently revoked. */
  role: AccessRole;
  /** Drive file IDs the user can access (populated via CON events). */
  fileAccess: {
    'space-log': string | null;
    'space-recent': string | null;
    'restricted-log': string | null;
    'admin-log': string | null;
  };
  /**
   * Shadow values for restricted fields (populated via DEF events).
   * The user sees these placeholders instead of the real restricted values.
   */
  shadowFields: Record<string, { shadowValue: string | null; shadowLabel: string }>;
  /** Key IDs to use per tier (the actual keys arrive via Matrix to-device). */
  keyIds: {
    viewer?: string;
    restricted?: string;
    admin?: string;
  };
  /** Whether access has been explicitly revoked (NUL event present). */
  revoked: boolean;
}

// Internal fold state while building the manifest from events.
interface ManifestFold {
  role: AccessRole | null;
  fileAccess: UserManifest['fileAccess'];
  shadowFields: UserManifest['shadowFields'];
  keyIds: UserManifest['keyIds'];
  revoked: boolean;
}

// ─── File naming ──────────────────────────────────────────────────────────────

/** Folder dataType for a space's Drive folder. */
function spaceDataType(spaceId: string): string {
  return 'eodb-' + spaceId;
}

/**
 * Filename for a user's manifest within the space folder.
 * Uses 'members/' prefix so files are visually grouped in the Drive UI.
 * Note: Drive filenames can contain '/' and '@' — this is a flat filename,
 * not an actual subfolder path.
 */
function manifestFileName(userId: string): string {
  return 'members/' + userId + '.eodb';
}

// ─── Manifest fold ────────────────────────────────────────────────────────────

function foldManifestEvents(events: EoEvent[]): ManifestFold {
  const fold: ManifestFold = {
    role: null,
    fileAccess: {
      'space-log': null,
      'space-recent': null,
      'restricted-log': null,
      'admin-log': null,
    },
    shadowFields: {},
    keyIds: {},
    revoked: false,
  };

  for (const evt of events) {
    switch (evt.op) {
      case 'SEG':
        // SEG event sets the role.
        if (evt.operand?.role && typeof evt.operand.role === 'string') {
          fold.role = evt.operand.role as AccessRole;
        }
        // SEG event may also carry a key ID for a tier.
        if (evt.operand?.key_id && typeof evt.operand.key_id === 'string') {
          const tier = evt.operand.tier as keyof UserManifest['keyIds'] | undefined;
          if (tier === 'viewer' || tier === 'restricted' || tier === 'admin') {
            fold.keyIds[tier] = evt.operand.key_id;
          }
        }
        break;

      case 'CON':
        // CON event maps a file tier to its Drive file ID.
        if (evt.operand?.file && evt.operand?.file_id) {
          const file = evt.operand.file as keyof UserManifest['fileAccess'];
          if (file in fold.fileAccess) {
            fold.fileAccess[file] = evt.operand.file_id as string;
          }
        }
        break;

      case 'DEF':
        // DEF event records a shadow value for a restricted field.
        if (evt.operand?.field && typeof evt.operand.field === 'string') {
          fold.shadowFields[evt.operand.field] = {
            shadowValue: evt.operand.shadow_value ?? null,
            shadowLabel: evt.operand.shadow_label ?? '[restricted]',
          };
        }
        break;

      case 'NUL':
        // NUL event revokes access.
        fold.revoked = true;
        fold.role = null;
        break;
    }
  }

  return fold;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read and fold a user's permission manifest from Drive.
 * Returns `null` if no manifest exists or if access has been revoked.
 */
export async function readUserManifest(
  matrixAccessToken: string,
  spaceId: string,
  userId: string,
  keyring: LocalKeyring,
): Promise<UserManifest | null> {
  const result = await gdriveRetrieveNamed(
    matrixAccessToken,
    spaceDataType(spaceId),
    manifestFileName(userId),
  );
  if (!result) return null;

  let decrypted: Uint8Array;
  try {
    decrypted = await decryptSnapshot(result.data, keyring);
  } catch {
    // If decryption fails the keyring doesn't have the right key yet.
    console.warn('[EO-DB] readUserManifest: decryption failed for', userId);
    return null;
  }

  let file;
  try {
    file = unpackEodb(decrypted);
  } catch {
    console.warn('[EO-DB] readUserManifest: unpack failed for', userId);
    return null;
  }

  const fold = foldManifestEvents(file.events);
  if (fold.revoked || !fold.role) return null;

  return {
    userId,
    spaceId,
    role: fold.role,
    fileAccess: fold.fileAccess,
    shadowFields: fold.shadowFields,
    keyIds: fold.keyIds,
    revoked: false,
  };
}

/**
 * Read the raw event list from a user's manifest without folding.
 * Returns an empty array if the manifest doesn't exist.
 * Used by writeUserManifest to preserve existing history.
 */
async function readManifestEvents(
  matrixAccessToken: string,
  spaceId: string,
  userId: string,
  keyring: LocalKeyring,
): Promise<EoEvent[]> {
  const result = await gdriveRetrieveNamed(
    matrixAccessToken,
    spaceDataType(spaceId),
    manifestFileName(userId),
  );
  if (!result) return [];

  let decrypted: Uint8Array;
  try {
    decrypted = await decryptSnapshot(result.data, keyring);
  } catch {
    return [];
  }

  try {
    const file = unpackEodb(decrypted);
    return file.events;
  } catch {
    return [];
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Write (or overwrite) a user's manifest by combining existing events with
 * new events, encrypting, and uploading.
 *
 * @param existingEvents  Pass `null` to have this function fetch existing
 *                        events automatically. Pass `[]` to start fresh.
 */
export async function writeUserManifest(
  matrixAccessToken: string,
  spaceId: string,
  userId: string,
  newEvents: EoEvent[],
  keyring: LocalKeyring,
  existingEvents?: EoEvent[] | null,
): Promise<void> {
  const prior = existingEvents !== undefined && existingEvents !== null
    ? existingEvents
    : await readManifestEvents(matrixAccessToken, spaceId, userId, keyring);

  const allEvents = [...prior, ...newEvents];
  const now = new Date().toISOString();

  const file = packEodb({
    version: 1,
    type: 'current',
    space_id: spaceId,
    space_name: spaceId,
    from_seq: allEvents[0]?.seq ?? 1,
    to_seq: allEvents[allEvents.length - 1]?.seq ?? 1,
    created_by: userId,
    created_at: now,
    events: allEvents,
    prev_snapshots: [],
  });

  const keyId = resolveSnapshotKeyId(keyring);
  const encrypted = keyId
    ? await encryptSnapshot(file, keyring, keyId)
    : file;

  await gdriveStoreNamed(
    matrixAccessToken,
    encrypted,
    spaceDataType(spaceId),
    manifestFileName(userId),
  );
}

// ─── Grant / Revoke ───────────────────────────────────────────────────────────

/**
 * Grant (or update) a user's role in a space.
 *
 * Creates or appends to the user's manifest with:
 * - A SEG event recording the role
 * - A SEG event recording the viewer key ID (for encryption routing)
 *
 * Then delivers the key bytes via Matrix to-device and signals peers that
 * permissions changed.
 *
 * @param adminUserId  The Matrix user ID performing the grant.
 * @param keyring      The admin's keyring (used to encrypt the manifest).
 * @param matrixClient Optional — if provided, key delivery and peer signaling fire.
 */
export async function grantRole(
  matrixAccessToken: string,
  spaceId: string,
  userId: string,
  role: AccessRole,
  adminUserId: string,
  keyring: LocalKeyring,
  matrixClient?: MatrixClient,
): Promise<void> {
  const existingEvents = await readManifestEvents(
    matrixAccessToken, spaceId, userId, keyring,
  );
  const nextSeq = (existingEvents[existingEvents.length - 1]?.seq ?? 0) + 1;
  const now = new Date().toISOString();
  const pl = ROLE_POWER_LEVELS[role];

  const newEvents: EoEvent[] = [
    {
      seq: nextSeq,
      op: 'SEG',
      target: userId + '/role',
      operand: { role, power_level: pl },
      agent: adminUserId,
      ts: now,
      acquired_ts: now,
    },
  ];

  // Record the viewer key ID in the manifest so the client knows which
  // key to look up in its local keyring when decrypting space files.
  const viewerKeyId = resolveSnapshotKeyId(keyring);
  if (viewerKeyId) {
    newEvents.push({
      seq: nextSeq + 1,
      op: 'SEG',
      target: userId + '/keys',
      operand: { tier: 'viewer', key_id: viewerKeyId },
      agent: adminUserId,
      ts: now,
      acquired_ts: now,
    });
  }

  await writeUserManifest(
    matrixAccessToken, spaceId, userId, newEvents, keyring, existingEvents,
  );

  if (matrixClient) {
    await deliverKeyToUser(matrixClient, userId, keyring);
    await signalPermissionsUpdated(matrixClient, userId);
  }
}

/**
 * Revoke a user's access to a space by appending a NUL event.
 * Does not delete the manifest — the history is preserved for audit.
 *
 * TODO: Rotate the restricted-key after revocation if the user had
 * restricted-tier access, then re-deliver the new key to remaining members.
 */
export async function revokeRole(
  matrixAccessToken: string,
  spaceId: string,
  userId: string,
  adminUserId: string,
  keyring: LocalKeyring,
  matrixClient?: MatrixClient,
): Promise<void> {
  const existingEvents = await readManifestEvents(
    matrixAccessToken, spaceId, userId, keyring,
  );
  const nextSeq = (existingEvents[existingEvents.length - 1]?.seq ?? 0) + 1;
  const now = new Date().toISOString();

  const revokeEvent: EoEvent = {
    seq: nextSeq,
    op: 'NUL',
    target: userId + '/role',
    operand: { reason: 'access_revoked' },
    agent: adminUserId,
    ts: now,
    acquired_ts: now,
  };

  await writeUserManifest(
    matrixAccessToken, spaceId, userId, [revokeEvent], keyring, existingEvents,
  );

  if (matrixClient) {
    await signalPermissionsUpdated(matrixClient, userId);
  }
}

// ─── Key delivery helpers ─────────────────────────────────────────────────────

/**
 * Deliver the viewer-tier key bytes to a user via Matrix to-device message.
 * The key_bytes_b64 field carries the raw AES key so the recipient can add
 * it to their local keyring and decrypt space files.
 */
async function deliverKeyToUser(
  matrixClient: MatrixClient,
  userId: string,
  keyring: LocalKeyring,
): Promise<void> {
  const keyId = resolveSnapshotKeyId(keyring);
  if (!keyId) return;

  const entry = keyring.keys.get(keyId);
  if (!entry) return;

  // Export the CryptoKey to raw bytes so we can transmit it.
  let keyBytes: Uint8Array;
  try {
    const exported = await crypto.subtle.exportKey('raw', entry.key);
    keyBytes = new Uint8Array(exported);
  } catch (e) {
    console.warn('[EO-DB] deliverKeyToUser: key export failed', e);
    return;
  }

  const payload = {
    key_id: keyId,
    key_bytes_b64: bufferToBase64(keyBytes),
    scope: entry.scope,
    tier: 'viewer',
  };

  try {
    await matrixClient.sendToDevice(
      PERMISSIONS_KEY_DELIVER,
      buildToDeviceContent(userId, '*', payload),
    );
  } catch (e) {
    console.warn('[EO-DB] deliverKeyToUser: to-device send failed', e);
  }
}

/**
 * Broadcast to the target user (all their devices) that their permissions
 * have changed. The recipient should re-fetch their manifest and invalidate
 * any cached permission state.
 */
async function signalPermissionsUpdated(
  matrixClient: MatrixClient,
  userId: string,
): Promise<void> {
  try {
    await matrixClient.sendToDevice(
      PERMISSIONS_UPDATED,
      buildToDeviceContent(userId, '*', { updated_at: new Date().toISOString() }),
    );
  } catch (e) {
    console.warn('[EO-DB] signalPermissionsUpdated: to-device send failed', e);
  }
}

// ─── Key ingestion helper ─────────────────────────────────────────────────────

/**
 * Parse an incoming `com.eo-db.key.grant` to-device message and return a
 * keyring entry ready to be added to the local keyring.
 *
 * Returns null if the message is malformed or the key cannot be imported.
 */
export async function ingestDeliveredKey(
  content: Record<string, unknown>,
): Promise<{ keyId: string; keyringEntry: import('../db/crypto-types').KeyringEntry } | null> {
  const { key_id, key_bytes_b64, scope } = content;
  if (
    typeof key_id !== 'string' ||
    typeof key_bytes_b64 !== 'string' ||
    typeof scope !== 'string'
  ) {
    return null;
  }

  try {
    const keyBytes = base64ToBuffer(key_bytes_b64);
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyBytes as unknown as BufferSource,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    return {
      keyId: key_id,
      keyringEntry: { key: cryptoKey, scope, version: 1 },
    };
  } catch (e) {
    console.warn('[EO-DB] ingestDeliveredKey: import failed', e);
    return null;
  }
}
