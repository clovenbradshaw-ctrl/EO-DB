import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import { processEvent } from '../db/fold.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import type { EoEventInput } from '../db/types.js';

export function registerWebhookRoutes(app: FastifyInstance, db: EoDb, feed: Feed): void {
  app.post('/webhook', async (request: AuthenticatedRequest, reply) => {
    const agent = request.matrixUser?.user_id || 'unknown';
    const body = request.body as EoEventInput | EoEventInput[];

    const now = new Date().toISOString();

    if (Array.isArray(body)) {
      const sequences: number[] = [];
      for (const event of body) {
        const seq = await processEvent(db, {
          ...event,
          agent,
          ts: event.ts || now,
          acquired_ts: now,
        }, feed);
        sequences.push(seq);
      }
      return reply.send({ sequences });
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
