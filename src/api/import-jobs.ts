/**
 * Import Jobs API routes.
 *
 * Manage long-running CSV import jobs:
 *
 *   GET    /import/jobs           — list all jobs (newest first)
 *   GET    /import/jobs/:id       — job status + progress
 *   POST   /import/jobs/:id/resume — resume a paused or failed job
 *   DELETE /import/jobs/:id       — cancel (stops after the current chunk)
 */

import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import {
  listImportJobs,
  getImportJob,
  updateImportJob,
  runImportJob,
} from '../ingestion/import-job-store.js';

export function registerImportJobRoutes(
  app: FastifyInstance,
  db: EoDb,
  feed: Feed,
  dataDir: string,
): void {

  /** List all import jobs, newest first. */
  app.get('/import/jobs', async (_request: AuthenticatedRequest, reply) => {
    const jobs = await listImportJobs(db);
    return reply.send({ jobs });
  });

  /** Get status and progress for a single job. */
  app.get('/import/jobs/:id', async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const job = await getImportJob(db, id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    const pct = job.total_rows > 0
      ? Math.round((job.processed_rows / job.total_rows) * 100)
      : (job.status === 'done' ? 100 : 0);

    return reply.send({ ...job, progress_pct: pct });
  });

  /**
   * Resume a paused or failed job.
   * Processing picks up from the last completed chunk.
   */
  app.post('/import/jobs/:id/resume', async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const job = await getImportJob(db, id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.status === 'done') return reply.code(400).send({ error: 'Job already completed' });
    if (job.status === 'running') return reply.code(400).send({ error: 'Job is already running' });

    await updateImportJob(db, id, { status: 'queued' });
    // Fire-and-forget: runs in background alongside other requests.
    runImportJob(db, feed, dataDir, id).catch(() => {
      // Errors are persisted inside runImportJob — nothing to do here.
    });

    return reply.send({ ok: true, job_id: id, message: 'Job resumed' });
  });

  /**
   * Cancel a running or queued job.
   * Sets status to 'paused'. The background runner will stop after its
   * current chunk completes, preserving resume state (chunks_done).
   */
  app.delete('/import/jobs/:id', async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const job = await getImportJob(db, id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.status === 'done') return reply.code(400).send({ error: 'Job already completed' });

    await updateImportJob(db, id, { status: 'paused' });
    return reply.send({ ok: true, message: 'Job will pause after the current chunk' });
  });
}
