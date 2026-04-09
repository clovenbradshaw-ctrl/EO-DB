/**
 * Log Import API routes.
 *
 * Endpoints for bulk-importing events from JSON, CSV, or TSV.
 * All routes are auth-protected (Matrix Bearer token).
 *
 *   POST /import/json          — Import from JSON (event format or generic)
 *   POST /import/csv           — Import from CSV or TSV text (event format or generic)
 *
 * Large CSV imports (>10 000 rows or async=true) are processed as background
 * jobs. The response includes a job_id that can be polled via GET /import/jobs/:id.
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
import {
  createImportJob,
  runImportJob,
} from '../ingestion/import-job-store.js';

/** Rows above this threshold are automatically processed as a background job. */
const ASYNC_THRESHOLD_ROWS = 10_000;

export function registerLogImportRoutes(
  app: FastifyInstance,
  db: EoDb,
  feed: Feed,
  syncManager?: SyncManager,
  dataDir?: string,
): void {

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
   * Body: { csv: "...", halt_on_error?: boolean, delimiter?: string,
   *         target_prefix?: string, async?: boolean }
   *
   * When `async` is true OR the CSV has more than 10 000 rows, the import
   * runs in the background and the response is { job_id, total_rows, message }.
   * Poll GET /import/jobs/:job_id for progress.
   *
   * When `async` is false (default for small files), the import runs
   * synchronously and the full ImportResult is returned.
   */
  app.post('/import/csv', async (request: AuthenticatedRequest, reply) => {
    const agent = request.matrixUser?.user_id || 'unknown';
    const body = request.body as {
      csv?: string;
      halt_on_error?: boolean;
      delimiter?: string;
      target_prefix?: string;
      ground?: boolean;
      async?: boolean;
    };

    if (!body.csv || typeof body.csv !== 'string') {
      return reply.code(400).send({ error: 'Missing required field: csv (string)' });
    }

    try {
      // Count rows quickly to decide sync vs async path.
      const rawLineCount = body.csv.split(/\r?\n/).filter(l => l.trim().length > 0).length;
      const estimatedRows = Math.max(0, rawLineCount - 1); // subtract header

      const useAsync = body.async === true || estimatedRows > ASYNC_THRESHOLD_ROWS;

      if (useAsync && dataDir) {
        // ── Async path: save file, start background job, return immediately ──
        const job = await createImportJob(db, dataDir, body.csv, agent, {
          delimiter: body.delimiter,
          target_prefix: body.target_prefix,
          halt_on_error: body.halt_on_error,
        });

        // Fire-and-forget: runs in background alongside other requests.
        runImportJob(db, feed, dataDir, job.id).catch(() => {
          // Errors are persisted in the job record — nothing to propagate here.
        });

        return reply.send({
          job_id: job.id,
          total_rows: job.total_rows,
          total_chunks: job.total_chunks,
          message: `Import started in background. Poll GET /import/jobs/${job.id} for progress.`,
        });
      }

      // ── Sync path: process inline (small files / async not requested) ──
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
