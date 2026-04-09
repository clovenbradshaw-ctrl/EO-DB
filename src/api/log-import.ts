/**
 * Log Import API routes.
 *
 * Endpoints for bulk-importing events from JSON, CSV, or TSV.
 * All routes are auth-protected (Matrix Bearer token).
 *
 *   POST /import/json          — Import from JSON (event format or generic)
 *   POST /import/csv           — Import from CSV or TSV text (event format or generic)
 */

import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import type { SyncManager } from '../matrix/sync-manager.js';
import {
  parseJsonImport,
  parseCsvImport,
  processImport,
  type ImportResult,
} from '../ingestion/log-import.js';
import { createEventSink } from '../ingestion/event-sink.js';

export function registerLogImportRoutes(app: FastifyInstance, db: EoDb, feed: Feed, syncManager?: SyncManager): void {

  /**
   * Import from JSON.
   *
   * Body: { events: [...], halt_on_error?: boolean, target_prefix?: string }
   * Events can be event-format (with op+target) or generic objects.
   */
  app.post('/import/json', async (request: AuthenticatedRequest, reply) => {
    const agent = request.matrixUser?.user_id || 'unknown';
    const body = request.body as { events?: unknown; halt_on_error?: boolean; target_prefix?: string; ground?: boolean };

    if (!body.events) {
      return reply.code(400).send({ error: 'Missing required field: events' });
    }

    try {
      const rows = parseJsonImport(body.events, body.target_prefix);

      const useGround = body.ground !== false;
      const sink = useGround
        ? createEventSink(db, feed, syncManager, { source: 'json' })
        : createEventSink(db, feed);

      const result: ImportResult = await processImport(db, feed, rows, agent, {
        halt_on_error: body.halt_on_error,
        sink,
      });

      const flushResult = await sink.flush();

      return reply.send({ ...result, grounded: flushResult });
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  /**
   * Import from CSV or TSV text.
   *
   * Body: { csv: "...", halt_on_error?: boolean, delimiter?: string, target_prefix?: string }
   * If the file has op+target columns, imports as events. Otherwise, generic → INS.
   */
  app.post('/import/csv', async (request: AuthenticatedRequest, reply) => {
    const agent = request.matrixUser?.user_id || 'unknown';
    const body = request.body as { csv?: string; halt_on_error?: boolean; delimiter?: string; target_prefix?: string; ground?: boolean };

    if (!body.csv || typeof body.csv !== 'string') {
      return reply.code(400).send({ error: 'Missing required field: csv (string)' });
    }

    try {
      const rows = parseCsvImport(body.csv, {
        delimiter: body.delimiter,
        targetPrefix: body.target_prefix,
      });

      const useGround = body.ground !== false;
      const sink = useGround
        ? createEventSink(db, feed, syncManager, { source: 'csv' })
        : createEventSink(db, feed);

      const result: ImportResult = await processImport(db, feed, rows, agent, {
        halt_on_error: body.halt_on_error,
        sink,
      });

      const flushResult = await sink.flush();

      return reply.send({ ...result, grounded: flushResult });
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });
}
