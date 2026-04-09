/**
 * Room topology — helpers for creating and managing the multi-room
 * space structure (main / restricted / governance).
 *
 * Each space maps to up to 3 Matrix rooms with different membership
 * and power level configurations. Room membership = permission boundary.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import type { SpaceConfig, FieldAssignment, AccessRole } from './types';
import { EO_POWER_LEVEL_CONTENT, ROLE_POWER_LEVELS } from './types';
import { withRetry } from '../matrix/connection-resilience';

// --- Custom Matrix event types ---

export const EO_SCHEMA_TYPE = 'com.eo-db.schema';
export const EO_GOVERNANCE_TYPE = 'com.eo-db.governance';
export const EO_KEY_ANNOUNCE_TYPE = 'com.eo-db.key.announce';
export const EO_SCHEMA_MANIFEST_TYPE = 'com.eo-db.schema.manifest';
export const EO_SPACE_CONFIG_TYPE = 'com.eo-db.space.config';
export const EO_SNAPSHOT_TYPE = 'com.eo-db.snapshot';

// --- Room creation ---

/**
 * @deprecated Use manifest.eodb field sensitivity + role-scoped keys instead.
 * Create a restricted room for a space.
 * Contains DEF events for sensitive fields (SSN, salary, etc.).
 * Membership: Owner, Admin, plus explicitly granted Editors.
 */
export async function createRestrictedRoom(
  client: MatrixClient,
  spaceName: string,
  mainRoomId: string,
): Promise<string> {
  const result = await withRetry(() => client.createRoom({
    name: `${spaceName} (restricted)`,
    room_alias_name: undefined,
    visibility: 'private' as any,
    preset: 'private_chat' as any,
    initial_state: [
      {
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      },
      {
        type: 'm.room.history_visibility',
        state_key: '',
        content: { history_visibility: 'shared' },
      },
      {
        type: 'm.room.power_levels',
        state_key: '',
        content: {
          ...EO_POWER_LEVEL_CONTENT,
          events_default: 25, // Editor+ in restricted room
        },
      },
    ],
  }));

  return result.room_id;
}

/**
 * @deprecated Use manifest.eodb + admin-log.eodb instead.
 * Create a governance room for a space.
 * Contains EVA policies, schema changes, field permission config, slice definitions.
 * Membership: Owner + Admin only.
 */
export async function createGovernanceRoom(
  client: MatrixClient,
  spaceName: string,
  mainRoomId: string,
): Promise<string> {
  const result = await withRetry(() => client.createRoom({
    name: `${spaceName} (governance)`,
    room_alias_name: undefined,
    visibility: 'private' as any,
    preset: 'private_chat' as any,
    initial_state: [
      {
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      },
      {
        type: 'm.room.history_visibility',
        state_key: '',
        content: { history_visibility: 'shared' },
      },
      {
        type: 'm.room.power_levels',
        state_key: '',
        content: {
          ...EO_POWER_LEVEL_CONTENT,
          events_default: 50, // Admin+ in governance room
        },
      },
    ],
  }));

  return result.room_id;
}

/**
 * Create a private room for a single slice.
 * Only the owner can write (events_default: 100). Others can be invited
 * with lower power levels to share the slice read-only or with edit access.
 * Each private slice gets its own room for maximum isolation.
 */
export async function createSliceRoom(
  client: MatrixClient,
  spaceName: string,
  sliceName: string,
  ownerUserId: string,
): Promise<string> {
  const result = await withRetry(() => client.createRoom({
    name: `${spaceName} — slice: ${sliceName}`,
    room_alias_name: undefined,
    visibility: 'private' as any,
    preset: 'private_chat' as any,
    initial_state: [
      {
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      },
      {
        type: 'm.room.history_visibility',
        state_key: '',
        content: { history_visibility: 'shared' },
      },
      {
        type: 'm.room.power_levels',
        state_key: '',
        content: {
          ...EO_POWER_LEVEL_CONTENT,
          events_default: 100, // Only owner can write by default
          users: {
            [ownerUserId]: 100,
          },
        },
      },
    ],
  }));

  return result.room_id;
}

// --- Space config management ---

/**
 * Publish the space config as a room state event in the governance room.
 */
export async function setSpaceConfig(
  client: MatrixClient,
  governanceRoomId: string,
  config: SpaceConfig,
): Promise<void> {
  await client.sendStateEvent(
    governanceRoomId,
    EO_SPACE_CONFIG_TYPE as any,
    config,
    '',
  );
}

/**
 * Read the space config from the governance room state.
 */
export function getSpaceConfig(
  client: MatrixClient,
  governanceRoomId: string,
): SpaceConfig | null {
  const room = client.getRoom(governanceRoomId);
  if (!room) return null;

  const event = room.currentState.getStateEvents(EO_SPACE_CONFIG_TYPE, '');
  if (!event) return null;

  return event.getContent() as SpaceConfig;
}

// --- Schema manifest ---

/**
 * Publish the schema manifest to the main room.
 * Lists all field names and which room holds their data.
 * This enables redaction bars — users see the column exists but not the values.
 */
export async function setSchemaManifest(
  client: MatrixClient,
  mainRoomId: string,
  fields: Array<{ name: string; room: 'main' | 'restricted' }>,
): Promise<void> {
  await client.sendStateEvent(
    mainRoomId,
    EO_SCHEMA_MANIFEST_TYPE as any,
    { fields },
    '',
  );
}

/**
 * Read the schema manifest from the main room state.
 */
export function getSchemaManifest(
  client: MatrixClient,
  mainRoomId: string,
): Array<{ name: string; room: 'main' | 'restricted' }> {
  const room = client.getRoom(mainRoomId);
  if (!room) return [];

  const event = room.currentState.getStateEvents(EO_SCHEMA_MANIFEST_TYPE, '');
  if (!event) return [];

  return event.getContent()?.fields ?? [];
}

// --- Power level management ---

/**
 * Set a user's role by updating their Matrix power level.
 */
export async function setUserRole(
  client: MatrixClient,
  roomId: string,
  userId: string,
  role: AccessRole,
): Promise<void> {
  const pl = ROLE_POWER_LEVELS[role];
  await client.setPowerLevel(roomId, userId, pl);
}

/**
 * Apply EO-DB power level configuration to a room.
 * Call this on room creation or when upgrading a legacy single-room space.
 */
export async function applyEoPowerLevels(
  client: MatrixClient,
  roomId: string,
  ownerUserId: string,
): Promise<void> {
  const room = client.getRoom(roomId);
  if (!room) throw new Error(`Room not found: ${roomId}`);

  const currentPl = room.currentState.getStateEvents('m.room.power_levels', '');
  const currentContent = currentPl?.getContent() ?? {};

  const updatedContent = {
    ...currentContent,
    ...EO_POWER_LEVEL_CONTENT,
    users: {
      ...currentContent.users,
      [ownerUserId]: 100,
    },
  };

  await client.sendStateEvent(roomId, 'm.room.power_levels' as any, updatedContent, '');
}

// --- Membership management ---

/**
 * Invite a user to a room (restricted or governance).
 * Only Admin+ (PL 50) can invite — Matrix enforces this.
 */
export async function inviteToRoom(
  client: MatrixClient,
  roomId: string,
  userId: string,
): Promise<void> {
  await client.invite(roomId, userId);
}

/**
 * Remove a user from a room.
 * Only Admin+ (PL 50) can kick — Matrix enforces this.
 */
export async function removeFromRoom(
  client: MatrixClient,
  roomId: string,
  userId: string,
  reason?: string,
): Promise<void> {
  await client.kick(roomId, userId, reason);
}

// --- Multi-room topology helpers ---

/**
 * Get room IDs for a space's topology from the space config.
 */
export interface SpaceRooms {
  main: string;
  restricted: string | null;
  governance: string | null;
}

/**
 * @deprecated Use single-room topology with manifest.eodb permissions model instead.
 * Build the full space room topology. Creates restricted/governance rooms
 * if they don't exist yet and the caller requests them.
 */
export async function ensureSpaceRooms(
  client: MatrixClient,
  spaceName: string,
  mainRoomId: string,
  options?: { createRestricted?: boolean; createGovernance?: boolean },
): Promise<SpaceRooms> {
  const rooms: SpaceRooms = {
    main: mainRoomId,
    restricted: null,
    governance: null,
  };

  if (options?.createRestricted) {
    rooms.restricted = await createRestrictedRoom(client, spaceName, mainRoomId);
  }

  if (options?.createGovernance) {
    rooms.governance = await createGovernanceRoom(client, spaceName, mainRoomId);
  }

  return rooms;
}

// --- Field assignment helpers ---

/**
 * Assign a field to a room (main or restricted).
 */
export function assignFieldToRoom(
  assignments: FieldAssignment[],
  field: string,
  room: 'main' | 'restricted',
  lockedTo?: AccessRole[],
): FieldAssignment[] {
  const existing = assignments.findIndex(a => a.field === field);
  const entry: FieldAssignment = { field, room, locked_to: lockedTo };

  if (existing >= 0) {
    return assignments.map((a, i) => i === existing ? entry : a);
  }
  return [...assignments, entry];
}

/**
 * Remove a field assignment.
 */
export function removeFieldAssignment(
  assignments: FieldAssignment[],
  field: string,
): FieldAssignment[] {
  return assignments.filter(a => a.field !== field);
}

// --- Migration ---

/**
 * Migrate a legacy `_sharing` array to Matrix power levels.
 * Call once per space when upgrading from the old 3-tier system.
 */
export async function migrateShareToMatrix(
  client: MatrixClient,
  roomId: string,
  owner: string,
  sharing: Array<{ user_id: string; access: 'read' | 'write' | 'admin' }>,
): Promise<void> {
  // Set owner
  await client.setPowerLevel(roomId, owner, 100);

  // Set member power levels
  for (const entry of sharing) {
    let pl: number;
    switch (entry.access) {
      case 'admin': pl = 50; break;
      case 'write': pl = 25; break;
      default: pl = 0; break;
    }
    await client.setPowerLevel(roomId, entry.user_id, pl);
  }

  // Apply EO-DB event type configuration
  await applyEoPowerLevels(client, roomId, owner);
}
