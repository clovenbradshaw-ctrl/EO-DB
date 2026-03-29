import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import { processEvent } from '../db/fold.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import type { ExternalOperator } from '../db/types.js';

// REC is system-generated — only the eight human-initiated operators are exposed via API.
const OPS: ExternalOperator[] = ['INS', 'DEF', 'CON', 'SEG', 'SYN', 'EVA'];

export function registerOpsRoutes(app: FastifyInstance, db: EoDb, feed: Feed): void {
  for (const op of OPS) {
    app.post(`/ops/${op.toLowerCase()}`, async (request: AuthenticatedRequest, reply) => {
      const body = request.body as { target?: string; operand?: any; ts?: string; client_event_id?: string };

      if (!body.target) {
        return reply.code(400).send({ error: 'Missing required field: target' });
      }

      const agent = request.matrixUser?.user_id || 'unknown';
      const now = new Date().toISOString();

      try {
        const seq = await processEvent(db, {
          op,
          target: body.target,
          operand: body.operand,
          agent,
          ts: body.ts || now,
          acquired_ts: now,
          client_event_id: body.client_event_id,
        }, feed);
        return reply.send({ seq });
      } catch (e: any) {
        return reply.code(400).send({ error: e.message });
      }
    });
  }
}
