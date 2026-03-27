import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import { getCurrentSeq } from '../db/level.js';
import { readLogSince } from '../db/log.js';
import { Feed } from '../db/feed.js';
import { verifyMatrixToken } from '../auth/matrix.js';
import type { EoEvent, Operator } from '../db/types.js';
import websocketPlugin from '@fastify/websocket';

interface SyncMessage {
  type: string;
  since?: number;
  pattern?: string;
  ops?: Operator[];
}

export function registerSyncRoute(app: FastifyInstance, db: EoDb, feed: Feed): void {
  app.register(websocketPlugin);

  app.register(async (instance) => {
    instance.get('/sync', { websocket: true }, (connection, request) => {
      // connection is SocketStream; connection.socket is the actual WebSocket
      const socket = connection.socket;

      const token = (request.query as { access_token?: string }).access_token;
      if (!token) {
        socket.close(4001, 'Missing access_token');
        return;
      }

      verifyMatrixToken(token).then(async (user) => {
        const userId = user.user_id;
        const currentSeq = await getCurrentSeq(db);

        socket.send(JSON.stringify({
          type: 'connected',
          user_id: userId,
          current_seq: currentSeq,
        }));

        let feedSubId: string | null = null;

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
          } catch (e) {
            socket.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
          }
        });

        socket.on('close', () => {
          if (feedSubId) {
            feed.unsubscribe(feedSubId);
            feedSubId = null;
          }
        });
      }).catch(() => {
        socket.close(4001, 'Invalid access_token');
      });
    });
  });
}
