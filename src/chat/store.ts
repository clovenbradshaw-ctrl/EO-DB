/**
 * Chat storage layer — LevelDB keyspaces for chat rooms and messages.
 *
 * Keyspaces:
 *   chat:room:{room_id}                    — ChatRoom record
 *   chat:rooms:all                          — Set of all room IDs
 *   chat:rooms:member:{user_id}             — Set of room IDs a user belongs to
 *   chat:msg:{room_id}:{padded_ts}:{msg_id} — ChatMessage (ordered by timestamp)
 *   chat:msg:seq:{room_id}                  — Auto-incrementing message counter per room
 */

import type { EoDb } from '../db/level.js';
import { encode, decode, padSeq } from '../db/level.js';
import { v4 as uuidv4 } from 'uuid';
import type { ChatRoom, ChatMessage, CreateChatRoomInput, SendMessageInput } from './types.js';

// ─── Room Operations ──────────────────────────────────────────────────────

export async function createChatRoom(
  db: EoDb,
  input: CreateChatRoomInput,
  creatorUserId: string,
): Promise<ChatRoom> {
  const room_id = uuidv4();
  const now = new Date().toISOString();
  const members = [creatorUserId, ...(input.members ?? []).filter(m => m !== creatorUserId)];

  const room: ChatRoom = {
    room_id,
    name: input.name,
    topic: input.topic,
    created_by: creatorUserId,
    created_at: now,
    updated_at: now,
    members,
    archived: false,
  };

  const batch = db.batch();
  batch.put(`chat:room:${room_id}`, encode(room));

  // Index: all rooms
  const allRoomIds = await getAllRoomIds(db);
  allRoomIds.push(room_id);
  batch.put('chat:rooms:all', encode(allRoomIds));

  // Index: per-member
  for (const member of members) {
    const memberRooms = await getMemberRoomIds(db, member);
    memberRooms.push(room_id);
    batch.put(`chat:rooms:member:${member}`, encode(memberRooms));
  }

  // Initialize message counter
  batch.put(`chat:msg:seq:${room_id}`, encode(0));

  await batch.write();
  return room;
}

export async function getChatRoom(db: EoDb, roomId: string): Promise<ChatRoom | null> {
  try {
    const buf = await db.get(`chat:room:${roomId}`);
    return decode(buf) as ChatRoom;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

export async function listChatRooms(db: EoDb, userId: string): Promise<ChatRoom[]> {
  const roomIds = await getMemberRoomIds(db, userId);
  const rooms: ChatRoom[] = [];
  for (const id of roomIds) {
    const room = await getChatRoom(db, id);
    if (room && !room.archived) rooms.push(room);
  }
  return rooms;
}

export async function updateChatRoom(
  db: EoDb,
  roomId: string,
  updates: { name?: string; topic?: string },
): Promise<ChatRoom | null> {
  const room = await getChatRoom(db, roomId);
  if (!room) return null;

  if (updates.name !== undefined) room.name = updates.name;
  if (updates.topic !== undefined) room.topic = updates.topic;
  room.updated_at = new Date().toISOString();

  await db.put(`chat:room:${roomId}`, encode(room));
  return room;
}

export async function archiveChatRoom(db: EoDb, roomId: string): Promise<boolean> {
  const room = await getChatRoom(db, roomId);
  if (!room) return false;

  room.archived = true;
  room.updated_at = new Date().toISOString();
  await db.put(`chat:room:${roomId}`, encode(room));
  return true;
}

export async function addMember(db: EoDb, roomId: string, userId: string): Promise<ChatRoom | null> {
  const room = await getChatRoom(db, roomId);
  if (!room) return null;
  if (room.members.includes(userId)) return room;

  room.members.push(userId);
  room.updated_at = new Date().toISOString();

  const batch = db.batch();
  batch.put(`chat:room:${roomId}`, encode(room));

  const memberRooms = await getMemberRoomIds(db, userId);
  memberRooms.push(roomId);
  batch.put(`chat:rooms:member:${userId}`, encode(memberRooms));

  await batch.write();
  return room;
}

export async function removeMember(db: EoDb, roomId: string, userId: string): Promise<ChatRoom | null> {
  const room = await getChatRoom(db, roomId);
  if (!room) return null;

  room.members = room.members.filter(m => m !== userId);
  room.updated_at = new Date().toISOString();

  const batch = db.batch();
  batch.put(`chat:room:${roomId}`, encode(room));

  const memberRooms = await getMemberRoomIds(db, userId);
  batch.put(`chat:rooms:member:${userId}`, encode(memberRooms.filter(id => id !== roomId)));

  await batch.write();
  return room;
}

// ─── Message Operations ───────────────────────────────────────────────────

async function nextMsgSeq(db: EoDb, roomId: string): Promise<number> {
  let current = 0;
  try {
    const buf = await db.get(`chat:msg:seq:${roomId}`);
    current = decode(buf) as number;
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
  const next = current + 1;
  await db.put(`chat:msg:seq:${roomId}`, encode(next));
  return next;
}

export async function sendMessage(
  db: EoDb,
  roomId: string,
  senderUserId: string,
  input: SendMessageInput,
): Promise<ChatMessage> {
  const seq = await nextMsgSeq(db, roomId);
  const message_id = uuidv4();
  const now = new Date().toISOString();

  const message: ChatMessage = {
    message_id,
    room_id: roomId,
    sender: senderUserId,
    body: input.body,
    sent_at: now,
    reply_to: input.reply_to,
    deleted: false,
  };

  // Key uses padded seq for ordered iteration
  const key = `chat:msg:${roomId}:${padSeq(seq)}:${message_id}`;
  await db.put(key, encode(message));

  return message;
}

export async function listMessages(
  db: EoDb,
  roomId: string,
  options?: { limit?: number; before?: number },
): Promise<ChatMessage[]> {
  const limit = options?.limit ?? 50;
  const prefix = `chat:msg:${roomId}:`;
  const messages: ChatMessage[] = [];

  // If `before` is given, seek to that sequence; otherwise read from the end
  const rangeOpts: any = {
    gte: prefix,
    lte: prefix + '\xff',
    reverse: true,
    limit,
  };

  if (options?.before) {
    rangeOpts.lt = prefix + padSeq(options.before);
    delete rangeOpts.lte;
  }

  for await (const [_key, buf] of db.iterator(rangeOpts)) {
    messages.push(decode(buf as Buffer) as ChatMessage);
  }

  // Return oldest-first
  return messages.reverse();
}

export async function editMessage(
  db: EoDb,
  roomId: string,
  messageId: string,
  newBody: string,
): Promise<ChatMessage | null> {
  const msg = await findMessage(db, roomId, messageId);
  if (!msg) return null;

  msg.message.body = newBody;
  msg.message.edited_at = new Date().toISOString();
  await db.put(msg.key, encode(msg.message));
  return msg.message;
}

export async function deleteMessage(
  db: EoDb,
  roomId: string,
  messageId: string,
): Promise<boolean> {
  const msg = await findMessage(db, roomId, messageId);
  if (!msg) return false;

  msg.message.deleted = true;
  msg.message.body = '';
  await db.put(msg.key, encode(msg.message));
  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function getAllRoomIds(db: EoDb): Promise<string[]> {
  try {
    const buf = await db.get('chat:rooms:all');
    return decode(buf) as string[];
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return [];
    throw e;
  }
}

async function getMemberRoomIds(db: EoDb, userId: string): Promise<string[]> {
  try {
    const buf = await db.get(`chat:rooms:member:${userId}`);
    return decode(buf) as string[];
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return [];
    throw e;
  }
}

async function findMessage(
  db: EoDb,
  roomId: string,
  messageId: string,
): Promise<{ key: string; message: ChatMessage } | null> {
  const prefix = `chat:msg:${roomId}:`;
  for await (const [key, buf] of db.iterator({ gte: prefix, lte: prefix + '\xff' })) {
    if ((key as string).endsWith(`:${messageId}`)) {
      return { key: key as string, message: decode(buf as Buffer) as ChatMessage };
    }
  }
  return null;
}
