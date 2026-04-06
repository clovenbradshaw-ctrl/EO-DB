/**
 * Chat room topology — Matrix room creation for chat rooms.
 *
 * Chat rooms are space-agnostic. They use standard Matrix messaging
 * (`m.room.message`) rather than EO-DB custom event types.
 * Power levels allow any member to send messages (events_default: 0).
 */

import type { IMatrixClient } from '../matrix/types.js';

/** Custom state event type to mark a Matrix room as an EO-DB chat room. */
export const EO_CHAT_ROOM_TYPE = 'com.eo-db.chat.room';

/** Custom event type for chat messages sent through EO-DB. */
export const EO_CHAT_MESSAGE_TYPE = 'com.eo-db.chat.message';

/**
 * Create a Matrix room dedicated to chat.
 *
 * - Encrypted by default (Megolm).
 * - All members can send messages (events_default: 0).
 * - Only the creator can change room settings (state_default: 50).
 */
export async function createMatrixChatRoom(
  client: IMatrixClient,
  name: string,
  topic?: string,
  inviteUserIds?: string[],
): Promise<string> {
  const result = await client.createRoom({
    name,
    topic,
    visibility: 'private',
    preset: 'private_chat',
    invite: inviteUserIds ?? [],
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
          users_default: 0,
          events_default: 0,       // All members can send messages
          state_default: 50,       // Only admins can change room state
          invite: 0,               // Any member can invite others
          kick: 50,
          ban: 50,
          events: {
            'm.room.name': 50,
            'm.room.power_levels': 100,
            'm.room.encryption': 100,
          },
        },
      },
      // Mark this as an EO-DB chat room
      {
        type: EO_CHAT_ROOM_TYPE,
        state_key: '',
        content: { version: 1 },
      },
    ],
  });

  return result.room_id;
}

/**
 * Send a chat message to a Matrix room via the EO-DB chat event type.
 * Agent is derived from the Matrix sender (same pattern as EO events).
 */
export async function sendMatrixChatMessage(
  client: IMatrixClient,
  matrixRoomId: string,
  body: string,
  replyTo?: string,
): Promise<string> {
  const content: Record<string, any> = {
    body,
    msgtype: 'text',
  };
  if (replyTo) {
    content.reply_to = replyTo;
  }

  const result = await client.sendEvent(matrixRoomId, EO_CHAT_MESSAGE_TYPE, content);
  return result.event_id;
}
