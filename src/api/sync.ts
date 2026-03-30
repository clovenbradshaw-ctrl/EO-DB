import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import { getCurrentSeq } from '../db/level.js';
import { readLogSince } from '../db/log.js';
import { Feed } from '../db/feed.js';
import { verifyMatrixToken } from '../auth/matrix.js';
import { isAccountAllowed } from '../auth/matrix-auth-config.js';
import type { EoEvent, Operator } from '../db/types.js';
import type { RoomSyncCoordinator } from '../ingestion/room-sync-coordinator.js';
import websocketPlugin from '@fastify/websocket';

interface SyncMessage {
  type: string;
  since?: number;
  pattern?: string;
  ops?: Operator[];
  /** Room ID the user is joining (for room sync coordinator). */
  room_id?: string;
}

/** Tracks all connected WebSocket users for presence. */
export interface ConnectedUser {
  user_id: string;
  connected_at: string;
  /** Rooms this user has joined (for room sync coordinator). */
  rooms: Set<string>;
}

const connectedUsers = new Map</*socket id*/ string, ConnectedUser>();
let socketCounter = 0;

/** Get a snapshot of all currently connected users (serializable). */
export function getConnectedUsers(): Array<{ user_id: string; connected_at: string; rooms: string[] }> {
  return Array.from(connectedUsers.values()).map(u => ({
    user_id: u.user_id,
    connected_at: u.connected_at,
    rooms: Array.from(u.rooms),
  }));
}

/** Reset presence tracking (for tests). */
export function resetPresence(): void {
  connectedUsers.clear();
  socketCounter = 0;
}

/** Broadcast a message to all connected sockets except the sender. */
function broadcastPresence(
  sockets: Map<string, any>,
  message: object,
  excludeSocketId?: string,
): void {
  const payload = JSON.stringify(message);
  for (const [id, socket] of sockets) {
    if (id !== excludeSocketId && socket.readyState === 1) {
      socket.send(payload);
    }
  }
}

export function registerSyncRoute(
  app: FastifyInstance,
  db: EoDb,
  feed: Feed,
  coordinator?: RoomSyncCoordinator,
): void {
  app.register(websocketPlugin);

  // Map of socketId → raw WebSocket for broadcasting
  const activeSockets = new Map<string, any>();

  app.register(async (instance) => {
    instance.get('/sync', { websocket: true }, (connection, request) => {
      const socket = connection.socket;

      const token = (request.query as { access_token?: string }).access_token;
      if (!token) {
        socket.close(4401, 'Missing access_token');
        return;
      }

      const socketId = `ws_${++socketCounter}`;

      // Return the promise so @fastify/websocket can handle errors
      return verifyMatrixToken(token).then(async (user) => {
        // Enforce account allowlist for WebSocket connections
        const allowed = await isAccountAllowed(db, user.user_id);
        if (!allowed) {
          socket.close(4403, 'Account not authorized for this database');
          return;
        }

        const userId = user.user_id;
        const currentSeq = await getCurrentSeq(db);

        // Register presence
        const connectedUser: ConnectedUser = {
          user_id: userId,
          connected_at: new Date().toISOString(),
          rooms: new Set(),
        };
        connectedUsers.set(socketId, connectedUser);
        activeSockets.set(socketId, socket);

        // Register close handler BEFORE sending messages to avoid race conditions
        let feedSubId: string | null = null;

        socket.on('close', () => {
          if (feedSubId) {
            feed.unsubscribe(feedSubId);
            feedSubId = null;
          }
          // Notify coordinator that this user left all their rooms
          if (coordinator) {
            coordinator.userLeft(userId);
          }
          // Remove presence and broadcast departure
          connectedUsers.delete(socketId);
          activeSockets.delete(socketId);
          broadcastPresence(activeSockets, {
            type: 'presence',
            action: 'left',
            user_id: userId,
            online_users: getConnectedUsers(),
          });
        });

        socket.on('message', async (data: any) => {
          try {
            const msg: SyncMessage = JSON.parse(data.toString());

            if (msg.type === 'sync') {
              const since = msg.since ?? 0;
              const events = await readLogSince(db, since);
              for (const event of events) {
                socket.send(JSON.stringify({ type: 'event', event }));
              }
              const throughSeq = await getCurrentSeq(db);
              socket.send(JSON.stringify({ type: 'sync_complete', through_seq: throughSeq }));

              if (!feedSubId) {
                feedSubId = feed.subscribe('**', (event: EoEvent) => {
                  if (socket.readyState === 1) {
                    socket.send(JSON.stringify({ type: 'event', event }));
                  }
                });
              }
            }

            if (msg.type === 'subscribe') {
              if (feedSubId) {
                feed.unsubscribe(feedSubId);
              }
              feedSubId = feed.subscribe(
                msg.pattern || '**',
                (event: EoEvent) => {
                  if (socket.readyState === 1) {
                    socket.send(JSON.stringify({ type: 'event', event }));
                  }
                },
                msg.ops
              );
            }

            if (msg.type === 'unsubscribe') {
              if (feedSubId) {
                feed.unsubscribe(feedSubId);
                feedSubId = null;
              }
            }

            if (msg.type === 'who') {
              socket.send(JSON.stringify({
                type: 'who_response',
                online_users: getConnectedUsers(),
              }));
            }

            // ── Room sync: join/leave a room for coordinator election ──
            if (msg.type === 'join_room' && msg.room_id) {
              connectedUser.rooms.add(msg.room_id);
              if (coordinator) {
                coordinator.userJoined(msg.room_id, userId);
              }
              socket.send(JSON.stringify({
                type: 'room_joined',
                room_id: msg.room_id,
              }));
            }

            if (msg.type === 'leave_room' && msg.room_id) {
              connectedUser.rooms.delete(msg.room_id);
              // Re-check if this user is still in the room via another socket
              // (edge case: multiple tabs). Only tell coordinator to remove if
              // no other socket for this user is in the room.
              let stillInRoom = false;
              for (const [sid, cu] of connectedUsers) {
                if (sid !== socketId && cu.user_id === userId && cu.rooms.has(msg.room_id)) {
                  stillInRoom = true;
                  break;
                }
              }
              if (!stillInRoom && coordinator) {
                // Temporarily remove and re-add without this room
                coordinator.userLeft(userId);
                // Re-join any rooms this user is still in via other sockets
                const remainingRooms = new Set<string>();
                for (const cu of connectedUsers.values()) {
                  if (cu.user_id === userId) {
                    for (const r of cu.rooms) remainingRooms.add(r);
                  }
                }
                for (const r of remainingRooms) {
                  coordinator.userJoined(r, userId);
                }
              }
              socket.send(JSON.stringify({
                type: 'room_left',
                room_id: msg.room_id,
              }));
            }
          } catch (e) {
            socket.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
          }
        });

        // Send connection ack with current online users
        const onlineUsers = getConnectedUsers();
        socket.send(JSON.stringify({
          type: 'connected',
          user_id: userId,
          current_seq: currentSeq,
          online_users: onlineUsers,
        }));

        // Broadcast join to everyone else
        broadcastPresence(activeSockets, {
          type: 'presence',
          action: 'joined',
          user_id: userId,
          online_users: getConnectedUsers(),
        }, socketId);

      }).catch(() => {
        socket.close(4401, 'Invalid access_token');
      });
    });
  });
}
