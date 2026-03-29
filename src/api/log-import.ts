/**
 * Log Import API routes.
 *
 * Endpoints for bulk-importing events from JSON or CSV.
 * All routes are auth-protected (Matrix Bearer token).
 *
 *   POST /import/json          — Import events from a JSON array
 *   POST /import/csv           — Import events from CSV text
 */

import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import {
  parseJsonImport,
  parseCsvImport,
  processImport,
} from '../ingestion/log-import.js';

export function registerLogImportRoutes(app: FastifyInstance, db: EoDb, feed: Feed): void {

  /**
   * Import events from a JSON array.
   *
   * Body: { events: [...], halt_on_error?: boolean }
   * Each event: { op, target, operand?, ts?, client_event_id?, meta? }
   */
  app.post('/import/json', async (request: AuthenticatedRequest, reply) => {
    const agent = request.matrixUser?.user_id || 'unknown';
    const body = request.body as { events?: unknown; halt_on_error?: boolean };

    if (!body.events) {
      return reply.code(400).send({ error: 'Missing required field: events' });
    }

    try {
      const rows = parseJsonImport(body.events);
      const result = await processImport(db, feed, rows, agent, {
        halt_on_error: body.halt_on_error,
      });
      return reply.send(result);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  /**
   * Import events from CSV text.
   *
   * Body: { csv: "op,target,operand,...\nINS,app.foo,{}\n...", halt_on_error?: boolean }
   * Required columns: op, target
   * Optional columns: operand (JSON), ts, client_event_id, meta (JSON)
   */
  app.post('/import/csv', async (request: AuthenticatedRequest, reply) => {
    const agent = request.matrixUser?.user_id || 'unknown';
    const body = request.body as { csv?: string; halt_on_error?: boolean };

    if (!body.csv || typeof body.csv !== 'string') {
      return reply.code(400).send({ error: 'Missing required field: csv (string)' });
    }

    try {
      const rows = parseCsvImport(body.csv);
      const result = await processImport(db, feed, rows, agent, {
        halt_on_error: body.halt_on_error,
      });
      return reply.send(result);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });
}
