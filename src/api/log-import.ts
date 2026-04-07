/**
 * Log Import API routes.
 *
 * Endpoints for bulk-importing events from JSON, CSV, or TSV.
 * All routes are auth-protected (Matrix Bearer token).
 *
 * Upload-before-process: raw source data is archived to Filen as an
 * immutable binary (.eodb) before processing begins. This enables:
 * - Audit trail: compare original vs processed to detect translation errors
 * - Resumability: if processing crashes, re-download and resume from checkpoint
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
import { tryGetFilenSession, type FilenSession } from '../filen/filen-session.js';
import {
  computeContentHash,
  createImportJob,
  saveImportJob,
  findImportJobByHash,
  packImportArchive,
  uploadImportArchive,
  downloadImportArchive,
  type ImportJob,
  type ImportArchive,
} from '../filen/import-upload.js';

/**
 * Upload raw data to Filen and return the import job.
 * If a prior job with the same content hash exists, resume it.
 */
async function uploadOrResume(
  db: EoDb,
  session: FilenSession | null,
  source: 'json' | 'csv',
  agent: string,
  rawData: any,
  rawString: string,
): Promise<ImportJob | null> {
  const contentHash = await computeContentHash(rawString);

  // Check for existing job with same content
  const existingJob = await findImportJobByHash(db, source, contentHash);

  if (existingJob) {
    if (existingJob.status === 'completed') {
      return existingJob; // Already done — idempotent
    }
    if (existingJob.status === 'uploaded' || existingJob.status === 'processing') {
      return existingJob; // Resume from where we left off
    }
    // status='uploading' or 'failed' — retry from scratch below
  }

  if (!session) return null; // No Filen — proceed without archive

  // Create job and archive
  const job = createImportJob(source, agent, contentHash);
  await saveImportJob(db, job);

  try {
    const archive: ImportArchive = {
      version: 1,
      type: 'import-archive',
      source,
      agent,
      created_at: new Date().toISOString(),
      content_hash: contentHash,
      raw_data: rawData, // verbatim, unmodified original input
    };
    const binary = packImportArchive(archive);
    const { uuid, fileKey } = await uploadImportArchive(session, job.job_id, source, binary);

    job.filen_file_uuid = uuid;
    job.filen_file_key = fileKey;
    job.filen_folder_uuid = session.uploadsFolderUuid;
    job.status = 'uploaded';
    await saveImportJob(db, job);

    console.log(`[EO-DB] Import archive uploaded to Filen: archive-${source}-${job.job_id} (${binary.byteLength} bytes)`);
    return job;
  } catch (e: any) {
    console.warn(`[EO-DB] Filen archive upload failed: ${e.message} — proceeding without archive`);
    job.status = 'failed';
    job.error = `Upload failed: ${e.message}`;
    await saveImportJob(db, job);
    return job;
  }
}

/**
 * Process import with job tracking and resume support.
 */
async function processWithTracking(
  db: EoDb,
  feed: Feed,
  rows: ReturnType<typeof parseJsonImport>,
  agent: string,
  job: ImportJob | null,
  options: { halt_on_error?: boolean; sink?: ReturnType<typeof createEventSink> },
): Promise<ImportResult> {
  const startFromChunk = job && job.status === 'processing' ? job.last_processed_chunk + 1 : 0;

  if (job) {
    job.status = 'processing';
    job.total_rows = rows.length;
    await saveImportJob(db, job);
  }

  const result = await processImport(db, feed, rows, agent, {
    halt_on_error: options.halt_on_error,
    sink: options.sink,
    startFromChunk,
    onChunkComplete: job ? async (chunkIndex, partialResult) => {
      job.last_processed_chunk = chunkIndex;
      job.processed_rows = partialResult.processed;
      await saveImportJob(db, job);
    } : undefined,
  });

  if (job) {
    job.status = 'completed';
    job.processed_rows = result.processed;
    job.completed_at = new Date().toISOString();
    await saveImportJob(db, job);
  }

  return result;
}

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
      // Extract Matrix token for Filen auth
      const authHeader = request.headers.authorization as string;
      const matrixToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

      // Get Filen session (graceful failure)
      const session = matrixToken ? await tryGetFilenSession(matrixToken, agent) : null;

      // Serialize raw data for archiving (verbatim — the original events payload)
      const rawString = JSON.stringify(body.events);

      // Upload archive to Filen or resume existing job
      const job = await uploadOrResume(db, session, 'json', agent, body.events, rawString);

      // If job already completed, return idempotent result
      if (job?.status === 'completed') {
        return reply.send({
          total: job.total_rows,
          processed: job.processed_rows,
          skipped: 0,
          errors: [],
          sequences: [],
          import_job_id: job.job_id,
          filen_upload: true,
          resumed: true,
        });
      }

      // Parse and process
      const rows = parseJsonImport(body.events, body.target_prefix);

      // Attach _import provenance to the first INS event if we have a Filen archive
      if (job?.filen_file_uuid) {
        attachImportProvenance(rows, job);
      }

      const useGround = body.ground !== false;
      const sink = useGround
        ? createEventSink(db, feed, syncManager, { source: 'json' })
        : createEventSink(db, feed);

      const result = await processWithTracking(db, feed, rows, agent, job, {
        halt_on_error: body.halt_on_error,
        sink,
      });

      const flushResult = await sink.flush();

      return reply.send({
        ...result,
        grounded: flushResult,
        import_job_id: job?.job_id,
        filen_upload: !!job?.filen_file_uuid,
      });
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
      // Extract Matrix token for Filen auth
      const authHeader = request.headers.authorization as string;
      const matrixToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

      // Get Filen session (graceful failure)
      const session = matrixToken ? await tryGetFilenSession(matrixToken, agent) : null;

      // Upload archive to Filen or resume existing job
      // For CSV, raw_data is the raw CSV string — completely unmodified
      const job = await uploadOrResume(db, session, 'csv', agent, body.csv, body.csv);

      // If job already completed, return idempotent result
      if (job?.status === 'completed') {
        return reply.send({
          total: job.total_rows,
          processed: job.processed_rows,
          skipped: 0,
          errors: [],
          sequences: [],
          import_job_id: job.job_id,
          filen_upload: true,
          resumed: true,
        });
      }

      // Parse and process
      const rows = parseCsvImport(body.csv, {
        delimiter: body.delimiter,
        targetPrefix: body.target_prefix,
      });

      // Attach _import provenance to the first INS event
      if (job?.filen_file_uuid) {
        attachImportProvenance(rows, job);
      }

      const useGround = body.ground !== false;
      const sink = useGround
        ? createEventSink(db, feed, syncManager, { source: 'csv' })
        : createEventSink(db, feed);

      const result = await processWithTracking(db, feed, rows, agent, job, {
        halt_on_error: body.halt_on_error,
        sink,
      });

      const flushResult = await sink.flush();

      return reply.send({
        ...result,
        grounded: flushResult,
        import_job_id: job?.job_id,
        filen_upload: !!job?.filen_file_uuid,
      });
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });
}

/**
 * Attach _import provenance metadata to the first INS event in the row set.
 * This links the parent container to the Filen archive for audit trail.
 */
function attachImportProvenance(
  rows: ReturnType<typeof parseJsonImport>,
  job: ImportJob,
): void {
  const firstIns = rows.find(r => r.op.toUpperCase() === 'INS');
  if (!firstIns) return;

  firstIns.meta = {
    ...firstIns.meta,
    _import: {
      job_id: job.job_id,
      archive_uuid: job.filen_file_uuid,
      archive_key: job.filen_file_key,
      archive_folder_uuid: job.filen_folder_uuid,
      source: job.source,
      archived_at: job.updated_at,
      content_hash: job.content_hash,
    },
  };
}
