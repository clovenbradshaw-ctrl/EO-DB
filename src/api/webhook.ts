import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import { processEvent } from '../db/fold.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import type { EoEventInput } from '../db/types.js';
import type { SyncManager } from '../matrix/sync-manager.js';
import { createEventSink } from '../ingestion/event-sink.js';

export function registerWebhookRoutes(app: FastifyInstance, db: EoDb, feed: Feed, syncManager?: SyncManager): void {
  app.post('/webhook', async (request: AuthenticatedRequest, reply) => {
    const agent = request.matrixUser?.user_id || 'unknown';
    const body = request.body as EoEventInput | EoEventInput[];

    const now = new Date().toISOString();

    if (Array.isArray(body)) {
      // Batch array payloads into a single media store upload
      const sink = createEventSink(db, feed, syncManager, { source: 'webhook' });
      const sequences: number[] = [];
      for (const event of body) {
        const seq = await sink.emit({
          ...event,
          agent,
          ts: event.ts || now,
          acquired_ts: now,
        });
        sequences.push(seq);
      }
      const grounded = await sink.flush();
      return reply.send({ sequences, grounded });
    }

    const seq = await processEvent(db, {
      ...body,
      agent,
      ts: body.ts || now,
      acquired_ts: now,
    }, feed);
    return reply.send({ seq });
  });
}
