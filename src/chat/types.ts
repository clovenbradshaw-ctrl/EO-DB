/**
 * Chat room types — space-agnostic messaging system.
 *
 * Chat rooms are independent of the EO-DB space topology (main/restricted/governance).
 * They exist solely for real-time conversation between users.
 */

/** A chat room — a dedicated space for user-to-user messaging. */
export interface ChatRoom {
  room_id: string;                     // Unique identifier (UUID)
  name: string;                        // Human-readable room name
  topic?: string;                      // Optional topic/description
  created_by: string;                  // Matrix user ID of creator
  created_at: string;                  // ISO 8601
  updated_at: string;                  // ISO 8601
  /** Matrix room ID, set when the room is bridged to Matrix. */
  matrix_room_id?: string;
  /** Member user IDs. Creator is always a member. */
  members: string[];
  /** Whether the room is archived (soft-delete). */
  archived: boolean;
}

/** A single chat message within a room. */
export interface ChatMessage {
  message_id: string;                  // Unique identifier (UUID)
  room_id: string;                     // Parent chat room
  sender: string;                      // Matrix user ID
  body: string;                        // Message text (plain text or markdown)
  sent_at: string;                     // ISO 8601
  edited_at?: string;                  // ISO 8601, set on edit
  /** Optional reply-to for threading. */
  reply_to?: string;                   // message_id of parent message
  /** Soft-deleted messages keep the record but clear the body. */
  deleted: boolean;
}

/** Input for creating a chat room. */
export interface CreateChatRoomInput {
  name: string;
  topic?: string;
  members?: string[];                  // Additional members besides the creator
}

/** Input for sending a chat message. */
export interface SendMessageInput {
  body: string;
  reply_to?: string;
}
