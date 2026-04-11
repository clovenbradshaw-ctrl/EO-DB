/**
 * Space permissions — manifest.eodb CRUD, fold, and shadow helpers.
 *
 * The manifest.eodb is an append-only EO event log stored on Google Drive.
 * It is the source of truth for role assignments and field sensitivity config.
 * Encrypted with the space's viewer-key so only members can read it.
 *
 * Structure in the Drive folder EO-DB/eodb-{spaceId}/:
 *   manifest.eodb  — role grants/revocations + field restriction config
 *
 * Event schema inside the manifest:
 *   INS("{spaceId}.space")
 *   DEF("{spaceId}.space.name",  "Amino")
 *   DEF("{spaceId}.member.@alice:server",  { role, grantedBy, grantedAt, keyIds })
 *   NUL("{spaceId}.member.@alice:server")          — revocation
 *   DEF("{spaceId}.field.ssn",  { sensitivity, shadowValue, shadowLabel })
 *
 * Security:
 *   - Viewer-key encrypted at rest.  Non-members who download the bytes cannot decrypt them.
 *   - n8n blocks non-members at the proxy layer via Matrix room membership check.
 *   - Three independent enforcement layers (token + membership + encryption).
 *
 * Bootstrap note:
 *   A new member must receive the viewer-key via Matrix to-device BEFORE attempting
 *   to download and decrypt the manifest.  The client should wait for key delivery
 *   rather than failing permanently if the manifest cannot be decrypted on first try.
 */

import type { EoEvent } from '../db/types';
import type { LocalKeyring } from '../db/crypto-types';
import { packEodb, unpackEodb, type EodbFile } from './eodb-format';
import { encryptSnapshot, decryptSnapshot } from '../crypto/snapshot-crypto';
import { gdriveRetrieveNamed, gdriveStoreNamed } from './gdrive-api';

// ─── Role tier ordering ────────────────────────────────────────────────────────

/** Space-level roles in ascending capability order. */
export type SpaceRole = 'viewer' | 'editor' | 'restricted' | 'admin' | 'owner';

const ROLE_ORDER: SpaceRole[] = ['viewer', 'editor', 'restricted', 'admin', 'owner'];

/** Return true if `a` >= `b` in capability order. */
export function roleAtLeast(a: SpaceRole, b: SpaceRole): boolean {
  return ROLE_ORDER.indexOf(a) >= ROLE_ORDER.indexOf(b);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ManifestMember {
  role: SpaceRole;
  grantedBy: string;
  grantedAt: string;
  /** Active key IDs for each tier the member can access (set at grant time). */
  keyIds: Partial<Record<'viewer' | 'editor' | 'restricted' | 'admin', string>>;
}

export interface FieldShadowConfig {
  /** Log tier required to decrypt this field's events. */
  sensitivity: 'restricted' | 'admin';
  /**
   * Value rendered for users who cannot decrypt this field.
   * null = hide the column entirely.
   * string = show this placeholder (e.g. "***-**-****").
   */
  shadowValue: string | null;
  /** Optional column header override when the field is shadowed. */
  shadowLabel?: string;
}

export interface ManifestState {
  spaceName?: string;
  /** userId → current member entry (NUL events remove entries). */
  members: Record<string, ManifestMember>;
  /** fieldKey → restriction config for fields above viewer tier. */
  fields: Record<string, FieldShadowConfig>;
}

// ─── Filename constant ────────────────────────────────────────────────────────

const MANIFEST_FILENAME = 'manifest.eodb';

// ─── Fold ─────────────────────────────────────────────────────────────────────

/**
 * Fold a list of manifest events into a ManifestState snapshot.
 *
 * Rules:
 *   DEF("{spaceId}.space.name", "...")           → spaceName
 *   DEF("{spaceId}.member.{userId}", {...})       → members[userId]
 *   NUL("{spaceId}.member.{userId}")              → delete members[userId]
 *   DEF("{spaceId}.field.{fieldKey}", {...})      → fields[fieldKey]
 *   NUL("{spaceId}.field.{fieldKey}")             → delete fields[fieldKey]
 */
export function foldManifest(events: EoEvent[]): ManifestState {
  const state: ManifestState = { members: {}, fields: {} };

  for (const ev of events) {
    const parts = ev.target.split('.');
    // parts[0] = spaceId, parts[1] = segment type, parts[2..] = identifier

    if (parts.length < 3) continue;
    const segment = parts[1]; // "space" | "member" | "field"
    const key = parts.slice(2).join('.'); // userId or fieldKey

    if (segment === 'space' && key === 'name' && ev.op === 'DEF') {
      state.spaceName = ev.operand as string;
      continue;
    }

    if (segment === 'member') {
      if (ev.op === 'DEF' && ev.operand && typeof ev.operand === 'object') {
        state.members[key] = ev.operand as ManifestMember;
      } else if (ev.op === 'NUL') {
        delete state.members[key];
      }
      continue;
    }

    if (segment === 'field') {
      if (ev.op === 'DEF' && ev.operand && typeof ev.operand === 'object') {
        state.fields[key] = ev.operand as FieldShadowConfig;
      } else if (ev.op === 'NUL') {
        delete state.fields[key];
      }
    }
  }

  return state;
}

/** Get the resolved role for a user ID, or null if not a member. */
export function getOwnRole(state: ManifestState, userId: string): SpaceRole | null {
  return state.members[userId]?.role ?? null;
}

/** Get all field shadow configs keyed by field name. */
export function getFieldShadows(state: ManifestState): Record<string, FieldShadowConfig> {
  return { ...state.fields };
}

// ─── Encrypt / Decrypt helpers ────────────────────────────────────────────────
// Uses the same encryptSnapshot / decryptSnapshot pattern as gdrive-sync.ts.
// Callers pass a LocalKeyring containing the viewer-key for the space.

async function encryptManifest(
  events: EoEvent[],
  spaceId: string,
  spaceName: string,
  viewerKeyring: LocalKeyring,
  viewerKeyId: string,
): Promise<Uint8Array> {
  const file: EodbFile = {
    version: 1,
    type: 'current',
    space_id: spaceId,
    space_name: spaceName,
    from_seq: events[0]?.seq ?? 0,
    to_seq: events[events.length - 1]?.seq ?? 0,
    created_by: 'manifest',
    created_at: new Date().toISOString(),
    events,
    prev_snapshots: [],
  };
  const packed = packEodb(file);
  return encryptSnapshot(packed, viewerKeyring, viewerKeyId);
}

async function decryptManifest(
  encryptedBytes: Uint8Array,
  viewerKeyring: LocalKeyring,
): Promise<EoEvent[]> {
  const decrypted = await decryptSnapshot(encryptedBytes, viewerKeyring);
  const file = unpackEodb(decrypted);
  return file.events;
}

// ─── Download / Upload ────────────────────────────────────────────────────────

/**
 * Download and decrypt manifest.eodb from the space's Drive folder.
 *
 * Returns the raw event list so callers can fold it with `foldManifest()`.
 * Returns null if the manifest does not exist yet (new space).
 *
 * Bootstrap: if decryption fails due to a missing viewer-key, callers should
 * retry after key delivery arrives via Matrix to-device, rather than failing.
 */
export async function downloadManifest(
  token: string,
  spaceId: string,
  viewerKeyring: LocalKeyring,
): Promise<EoEvent[] | null> {
  const dataType = `eodb-${spaceId}`;
  const result = await gdriveRetrieveNamed(token, dataType, MANIFEST_FILENAME);
  if (!result) return null;

  return decryptManifest(result.data, viewerKeyring);
}

/**
 * Download, append new events, re-encrypt and upload manifest.eodb.
 *
 * This is a read-modify-write cycle. Concurrent writes from multiple admins
 * could result in one overwriting the other — acceptable for the low-frequency
 * permission management use case. The event log is append-only so the fold
 * result converges regardless of ordering.
 */
export async function appendManifestEvents(
  token: string,
  spaceId: string,
  spaceName: string,
  viewerKeyring: LocalKeyring,
  viewerKeyId: string,
  newEvents: EoEvent[],
): Promise<void> {
  const existing = await downloadManifest(token, spaceId, viewerKeyring) ?? [];
  const allEvents = [...existing, ...newEvents];
  const encrypted = await encryptManifest(allEvents, spaceId, spaceName, viewerKeyring, viewerKeyId);
  await gdriveStoreNamed(token, encrypted, `eodb-${spaceId}`, MANIFEST_FILENAME);
}

/**
 * Write a brand-new manifest.eodb (for space creation).
 * Overwrites any existing file at the same path.
 */
export async function initManifest(
  token: string,
  spaceId: string,
  spaceName: string,
  creatorUserId: string,
  viewerKeyring: LocalKeyring,
  viewerKeyId: string,
  editorKeyId: string,
  restrictedKeyId: string,
  adminKeyId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const baseSeq = 1;

  const initEvents: EoEvent[] = [
    {
      seq: baseSeq,
      op: 'INS',
      target: `${spaceId}.space`,
      operand: null,
      agent: creatorUserId,
      ts: now,
      acquired_ts: now,
    },
    {
      seq: baseSeq + 1,
      op: 'DEF',
      target: `${spaceId}.space.name`,
      operand: spaceName,
      agent: creatorUserId,
      ts: now,
      acquired_ts: now,
    },
    {
      seq: baseSeq + 2,
      op: 'DEF',
      target: `${spaceId}.member.${creatorUserId}`,
      operand: {
        role: 'owner',
        grantedBy: creatorUserId,
        grantedAt: now,
        keyIds: {
          viewer: viewerKeyId,
          editor: editorKeyId,
          restricted: restrictedKeyId,
          admin: adminKeyId,
        },
      } satisfies ManifestMember,
      agent: creatorUserId,
      ts: now,
      acquired_ts: now,
    },
  ];

  const encrypted = await encryptManifest(initEvents, spaceId, spaceName, viewerKeyring, viewerKeyId);
  await gdriveStoreNamed(token, encrypted, `eodb-${spaceId}`, MANIFEST_FILENAME);
}

// ─── Permission grant / revoke helpers ────────────────────────────────────────

/**
 * Build the DEF event for granting a role to a user.
 * Caller is responsible for delivering keys via to-device BEFORE uploading
 * the updated manifest to Drive.
 */
export function buildGrantEvent(
  spaceId: string,
  targetUserId: string,
  role: SpaceRole,
  grantedByUserId: string,
  keyIds: ManifestMember['keyIds'],
  seq: number,
): EoEvent {
  const now = new Date().toISOString();
  return {
    seq,
    op: 'DEF',
    target: `${spaceId}.member.${targetUserId}`,
    operand: {
      role,
      grantedBy: grantedByUserId,
      grantedAt: now,
      keyIds,
    } satisfies ManifestMember,
    agent: grantedByUserId,
    ts: now,
    acquired_ts: now,
  };
}

/**
 * Build the NUL event for revoking a user's access.
 * After appending this event, the admin must:
 *   1. Remove the user from the Matrix main room (hard revocation at proxy layer)
 *   2. Rotate affected tier keys and re-deliver to remaining eligible members
 */
export function buildRevokeEvent(
  spaceId: string,
  targetUserId: string,
  revokedByUserId: string,
  seq: number,
): EoEvent {
  const now = new Date().toISOString();
  // Revocation is a deliberate removal — resolution 'Clearing' in the
  // lattice model. `nul_state: 'cleared'` is retained for backward-compatible
  // consumers that still read the legacy field.
  return {
    seq,
    op: 'NUL',
    target: `${spaceId}.member.${targetUserId}`,
    operand: null,
    agent: revokedByUserId,
    ts: now,
    acquired_ts: now,
    resolution: 'Clearing',
    nul_state: 'cleared',
  };
}

/**
 * Build DEF events for setting field sensitivity / shadow config.
 */
export function buildFieldConfigEvent(
  spaceId: string,
  fieldKey: string,
  config: FieldShadowConfig,
  agentUserId: string,
  seq: number,
): EoEvent {
  const now = new Date().toISOString();
  return {
    seq,
    op: 'DEF',
    target: `${spaceId}.field.${fieldKey}`,
    operand: config,
    agent: agentUserId,
    ts: now,
    acquired_ts: now,
  };
}

// ─── Key-tier helpers ─────────────────────────────────────────────────────────

/**
 * The fixed Drive file names for each encrypted log tier.
 * Clients use these to know which files to download based on their role.
 */
export const LOG_FILE_NAMES: Record<'viewer' | 'restricted' | 'admin', string> = {
  viewer: 'space-log.eodb',
  restricted: 'restricted-log.eodb',
  admin: 'admin-log.eodb',
};

export const RECENT_FILE_NAMES: Record<'viewer' | 'restricted', string> = {
  viewer: 'space-recent.eodb',
  restricted: 'restricted-recent.eodb',
};

/**
 * Given a resolved role, return the set of log tiers the user can access.
 */
export function accessibleTiers(role: SpaceRole): Array<'viewer' | 'restricted' | 'admin'> {
  const tiers: Array<'viewer' | 'restricted' | 'admin'> = ['viewer'];
  if (roleAtLeast(role, 'restricted')) tiers.push('restricted');
  if (roleAtLeast(role, 'admin')) tiers.push('admin');
  return tiers;
}
