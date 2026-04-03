/**
 * Room topology — helpers for creating and managing the multi-room
 * space structure (main / restricted / governance).
 *
 * Each EO-DB space can span up to 3 Matrix rooms:
 *
 * | Room         | Contents                        | Power level required |
 * |--------------|---------------------------------|---------------------|
 * | Main         | General records, public fields  | Viewer (PL 0)       |
 * | Restricted   | Sensitive fields (SSN, salary)  | Editor (PL 25+)     |
 * | Governance   | Policies, schema, views         | Admin (PL 50+)      |
 *
 * Membership = access boundary. A user who is not invited to the restricted
 * room never receives its events. The SDK's Megolm session management ensures
 * decryption keys are only shared with room members.
 *
 * Lazy room creation: restricted and governance rooms are created on-demand.
 * A space may start as a single main room and gain additional rooms only when
 * an admin enables restricted fields or governance features.
 */

import type {
  IMatrixClient,
  SpaceConfig,
  SpaceRooms,
  FieldAssignment,
  AccessRole,
} from './types.js';
import { EO_POWER_LEVEL_CONTENT, ROLE_POWER_LEVELS } from './types.js';
import { EO_SPACE_CONFIG_TYPE, EO_SCHEMA_MANIFEST_TYPE } from './event-bridge.js';

// ─── Room Creation ─────────────────────────────────────────────────────────

/**
 * Create a restricted room for a space.
 * Contains DEF events for sensitive fields (SSN, salary, etc.).
 * Membership: Owner, Admin, plus explicitly granted Editors.
 */
export async function createRestrictedRoom(
  client: IMatrixClient,
  spaceName: string,
  _mainRoomId: string,
): Promise<string> {
  const result = await client.createRoom({
    name: `${spaceName} (restricted)`,
    visibility: 'private',
    preset: 'private_chat',
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
  });

  return result.room_id;
}

/**
 * Create a governance room for a space.
 * Contains EVA policies, schema changes, field permission config, view definitions.
 * Membership: Owner + Admin only.
 */
export async function createGovernanceRoom(
  client: IMatrixClient,
  spaceName: string,
  _mainRoomId: string,
): Promise<string> {
  const result = await client.createRoom({
    name: `${spaceName} (governance)`,
    visibility: 'private',
    preset: 'private_chat',
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
  });

  return result.room_id;
}

/**
 * Create a private room for a single view.
 * Only the owner can write (events_default: 100). Others can be invited
 * with lower power levels to share the view read-only or with edit access.
 * Each private view gets its own room for maximum isolation.
 */
export async function createViewRoom(
  client: IMatrixClient,
  spaceName: string,
  viewName: string,
  ownerUserId: string,
): Promise<string> {
  const result = await client.createRoom({
    name: `${spaceName} — view: ${viewName}`,
    visibility: 'private',
    preset: 'private_chat',
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
  });

  return result.room_id;
}

// ─── Space Config Management ───────────────────────────────────────────────

/**
 * Publish the space config as a room state event in the governance room
 * (or main room if governance doesn't exist yet).
 *
 * This is the sole marker that identifies a Matrix room as part of an EO-DB space.
 */
export async function setSpaceConfig(
  client: IMatrixClient,
  governanceRoomId: string,
  config: SpaceConfig,
): Promise<void> {
  await client.sendStateEvent(governanceRoomId, EO_SPACE_CONFIG_TYPE, config as any, '');
}

/**
 * Read the space config from the governance room state.
 */
export function getSpaceConfig(
  client: IMatrixClient,
  governanceRoomId: string,
): SpaceConfig | null {
  const room = client.getRoom(governanceRoomId);
  if (!room) return null;

  const event = room.currentState.getStateEvents(EO_SPACE_CONFIG_TYPE, '');
  if (!event) return null;

  return event.getContent() as SpaceConfig;
}

// ─── Schema Manifest ───────────────────────────────────────────────────────

/**
 * Publish the schema manifest to the main room.
 * Lists all field names and which room holds their data.
 * This enables redaction bars — users see the column exists but not the values.
 */
export async function setSchemaManifest(
  client: IMatrixClient,
  mainRoomId: string,
  fields: Array<{ name: string; room: 'main' | 'restricted' }>,
): Promise<void> {
  await client.sendStateEvent(mainRoomId, EO_SCHEMA_MANIFEST_TYPE, { fields }, '');
}

/**
 * Read the schema manifest from the main room state.
 */
export function getSchemaManifest(
  client: IMatrixClient,
  mainRoomId: string,
): Array<{ name: string; room: 'main' | 'restricted' }> {
  const room = client.getRoom(mainRoomId);
  if (!room) return [];

  const event = room.currentState.getStateEvents(EO_SCHEMA_MANIFEST_TYPE, '');
  if (!event) return [];

  return event.getContent()?.fields ?? [];
}

// ─── Power Level Management ────────────────────────────────────────────────

/**
 * Set a user's role by updating their Matrix power level.
 */
export async function setUserRole(
  client: IMatrixClient,
  roomId: string,
  userId: string,
  role: AccessRole,
): Promise<void> {
  const pl = ROLE_POWER_LEVELS[role];
  await client.setPowerLevel(roomId, userId, pl);
}

/**
 * Apply EO-DB power level configuration to a room.
 * Call on room creation or when upgrading a legacy single-room space.
 */
export async function applyEoPowerLevels(
  client: IMatrixClient,
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
      ...(currentContent.users || {}),
      [ownerUserId]: 100,
    },
  };

  await client.sendStateEvent(roomId, 'm.room.power_levels', updatedContent, '');
}

// ─── Membership Management ─────────────────────────────────────────────────

/**
 * Invite a user to a room (restricted or governance).
 */
export async function inviteToRoom(
  client: IMatrixClient,
  roomId: string,
  userId: string,
): Promise<void> {
  await client.invite(roomId, userId);
}

/**
 * Remove a user from a room.
 */
export async function removeFromRoom(
  client: IMatrixClient,
  roomId: string,
  userId: string,
  reason?: string,
): Promise<void> {
  await client.kick(roomId, userId, reason);
}

// ─── Multi-Room Topology ───────────────────────────────────────────────────

/**
 * Build the full space room topology. Creates restricted/governance rooms
 * on demand if the caller requests them.
 */
export async function ensureSpaceRooms(
  client: IMatrixClient,
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

// ─── Field Assignment Helpers ──────────────────────────────────────────────

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

// ─── Migration ─────────────────────────────────────────────────────────────

/**
 * Migrate a legacy `_sharing` array to Matrix power levels.
 * Call once per space when upgrading from the old 3-tier system.
 */
export async function migrateShareToMatrix(
  client: IMatrixClient,
  roomId: string,
  owner: string,
  sharing: Array<{ user_id: string; access: 'read' | 'write' | 'admin' }>,
): Promise<void> {
  await client.setPowerLevel(roomId, owner, 100);

  for (const entry of sharing) {
    let pl: number;
    switch (entry.access) {
      case 'admin': pl = 50; break;
      case 'write': pl = 25; break;
      default: pl = 0; break;
    }
    await client.setPowerLevel(roomId, entry.user_id, pl);
  }

  await applyEoPowerLevels(client, roomId, owner);
}
