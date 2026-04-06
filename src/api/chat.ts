/**
 * Chat API routes — space-agnostic chat room management and messaging.
 *
 * Room management:
 *   POST   /chat/rooms                  — Create a new chat room
 *   GET    /chat/rooms                  — List rooms the caller belongs to
 *   GET    /chat/rooms/:roomId          — Get a specific chat room
 *   PUT    /chat/rooms/:roomId          — Update room name/topic
 *   DELETE /chat/rooms/:roomId          — Archive (soft-delete) a chat room
 *   POST   /chat/rooms/:roomId/members  — Add a member
 *   DELETE /chat/rooms/:roomId/members/:userId — Remove a member
 *
 * Messaging:
 *   POST   /chat/rooms/:roomId/messages          — Send a message
 *   GET    /chat/rooms/:roomId/messages           — List messages (paginated)
 *   PUT    /chat/rooms/:roomId/messages/:messageId — Edit a message
 *   DELETE /chat/rooms/:roomId/messages/:messageId — Delete a message
 */

import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import type { ChatFeed } from '../chat/feed.js';
import {
  createChatRoom,
  getChatRoom,
  listChatRooms,
  updateChatRoom,
  archiveChatRoom,
  addMember,
  removeMember,
  sendMessage,
  listMessages,
  editMessage,
  deleteMessage,
} from '../chat/store.js';

export function registerChatRoutes(
  app: FastifyInstance,
  db: EoDb,
  chatFeed: ChatFeed,
): void {

  // ── Room CRUD ─────────────────────────────────────────────────────────

  app.post('/chat/rooms', async (request: AuthenticatedRequest, reply) => {
    const userId = request.matrixUser?.user_id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const body = request.body as { name?: string; topic?: string; members?: string[] };
    if (!body.name) {
      return reply.code(400).send({ error: 'Missing required field: name' });
    }

    const room = await createChatRoom(db, {
      name: body.name,
      topic: body.topic,
      members: body.members,
    }, userId);

    chatFeed.notifyRoomEvent(room.room_id, 'room_created', room);
    return reply.code(201).send(room);
  });

  app.get('/chat/rooms', async (request: AuthenticatedRequest, reply) => {
    const userId = request.matrixUser?.user_id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const rooms = await listChatRooms(db, userId);
    return reply.send({ rooms });
  });

  app.get('/chat/rooms/:roomId', async (request: AuthenticatedRequest, reply) => {
    const userId = request.matrixUser?.user_id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { roomId } = request.params as { roomId: string };
    const room = await getChatRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Chat room not found' });
    if (!room.members.includes(userId)) {
      return reply.code(403).send({ error: 'Not a member of this chat room' });
    }

    return reply.send(room);
  });

  app.put('/chat/rooms/:roomId', async (request: AuthenticatedRequest, reply) => {
    const userId = request.matrixUser?.user_id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { roomId } = request.params as { roomId: string };
    const room = await getChatRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Chat room not found' });
    if (!room.members.includes(userId)) {
      return reply.code(403).send({ error: 'Not a member of this chat room' });
    }

    const body = request.body as { name?: string; topic?: string };
    const updated = await updateChatRoom(db, roomId, body);
    if (!updated) return reply.code(404).send({ error: 'Chat room not found' });

    chatFeed.notifyRoomEvent(roomId, 'room_updated', updated);
    return reply.send(updated);
  });

  app.delete('/chat/rooms/:roomId', async (request: AuthenticatedRequest, reply) => {
    const userId = request.matrixUser?.user_id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { roomId } = request.params as { roomId: string };
    const room = await getChatRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Chat room not found' });
    if (room.created_by !== userId) {
      return reply.code(403).send({ error: 'Only the room creator can archive a chat room' });
    }

    await archiveChatRoom(db, roomId);
    chatFeed.notifyRoomEvent(roomId, 'room_archived', { room_id: roomId });
    return reply.code(204).send();
  });

  // ── Membership ────────────────────────────────────────────────────────

  app.post('/chat/rooms/:roomId/members', async (request: AuthenticatedRequest, reply) => {
    const userId = request.matrixUser?.user_id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { roomId } = request.params as { roomId: string };
    const room = await getChatRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Chat room not found' });
    if (!room.members.includes(userId)) {
      return reply.code(403).send({ error: 'Not a member of this chat room' });
    }

    const body = request.body as { user_id?: string };
    if (!body.user_id) {
      return reply.code(400).send({ error: 'Missing required field: user_id' });
    }

    const updated = await addMember(db, roomId, body.user_id);
    if (!updated) return reply.code(404).send({ error: 'Chat room not found' });

    chatFeed.notifyRoomEvent(roomId, 'member_added', { room_id: roomId, user_id: body.user_id });
    return reply.send(updated);
  });

  app.delete('/chat/rooms/:roomId/members/:userId', async (request: AuthenticatedRequest, reply) => {
    const callerUserId = request.matrixUser?.user_id;
    if (!callerUserId) return reply.code(401).send({ error: 'Unauthorized' });

    const { roomId, userId: targetUserId } = request.params as { roomId: string; userId: string };
    const room = await getChatRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Chat room not found' });

    // Only creator or the user themselves can remove a member
    if (callerUserId !== room.created_by && callerUserId !== targetUserId) {
      return reply.code(403).send({ error: 'Only the room creator or the user themselves can remove a member' });
    }

    const updated = await removeMember(db, roomId, targetUserId);
    if (!updated) return reply.code(404).send({ error: 'Chat room not found' });

    chatFeed.notifyRoomEvent(roomId, 'member_removed', { room_id: roomId, user_id: targetUserId });
    return reply.send(updated);
  });

  // ── Messaging ─────────────────────────────────────────────────────────

  app.post('/chat/rooms/:roomId/messages', async (request: AuthenticatedRequest, reply) => {
    const userId = request.matrixUser?.user_id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { roomId } = request.params as { roomId: string };
    const room = await getChatRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Chat room not found' });
    if (!room.members.includes(userId)) {
      return reply.code(403).send({ error: 'Not a member of this chat room' });
    }

    const body = request.body as { body?: string; reply_to?: string };
    if (!body.body) {
      return reply.code(400).send({ error: 'Missing required field: body' });
    }

    const message = await sendMessage(db, roomId, userId, {
      body: body.body,
      reply_to: body.reply_to,
    });

    chatFeed.notifyMessage(roomId, message);
    return reply.code(201).send(message);
  });

  app.get('/chat/rooms/:roomId/messages', async (request: AuthenticatedRequest, reply) => {
    const userId = request.matrixUser?.user_id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { roomId } = request.params as { roomId: string };
    const room = await getChatRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Chat room not found' });
    if (!room.members.includes(userId)) {
      return reply.code(403).send({ error: 'Not a member of this chat room' });
    }

    const query = request.query as { limit?: string; before?: string };
    const messages = await listMessages(db, roomId, {
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      before: query.before ? parseInt(query.before, 10) : undefined,
    });

    return reply.send({ messages });
  });

  app.put('/chat/rooms/:roomId/messages/:messageId', async (request: AuthenticatedRequest, reply) => {
    const userId = request.matrixUser?.user_id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { roomId, messageId } = request.params as { roomId: string; messageId: string };
    const room = await getChatRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Chat room not found' });
    if (!room.members.includes(userId)) {
      return reply.code(403).send({ error: 'Not a member of this chat room' });
    }

    const body = request.body as { body?: string };
    if (!body.body) {
      return reply.code(400).send({ error: 'Missing required field: body' });
    }

    const updated = await editMessage(db, roomId, messageId, body.body);
    if (!updated) return reply.code(404).send({ error: 'Message not found' });
    if (updated.sender !== userId) {
      return reply.code(403).send({ error: 'Only the sender can edit a message' });
    }

    chatFeed.notifyRoomEvent(roomId, 'message_edited', updated);
    return reply.send(updated);
  });

  app.delete('/chat/rooms/:roomId/messages/:messageId', async (request: AuthenticatedRequest, reply) => {
    const userId = request.matrixUser?.user_id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { roomId, messageId } = request.params as { roomId: string; messageId: string };
    const room = await getChatRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Chat room not found' });
    if (!room.members.includes(userId)) {
      return reply.code(403).send({ error: 'Not a member of this chat room' });
    }

    const deleted = await deleteMessage(db, roomId, messageId);
    if (!deleted) return reply.code(404).send({ error: 'Message not found' });

    chatFeed.notifyRoomEvent(roomId, 'message_deleted', { room_id: roomId, message_id: messageId });
    return reply.code(204).send();
  });
}
