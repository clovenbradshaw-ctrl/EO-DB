/**
 * Import Job Store — persists large CSV imports as resumable background jobs.
 *
 * CSV files are stored on the local filesystem under {dataDir}/import-jobs/{id}.csv
 * so they survive server restarts and can be processed / resumed at any time.
 *
 * Job metadata is stored in LevelDB under the key prefix "import-job:".
 *
 * Flow:
 *   1. POST /import/csv  → createImportJob() → save CSV file → return job_id
 *   2. runImportJob()    → reads file → processImport() with chunk checkpoints
 *   3. GET /import/jobs/:id → progress + status
 *   4. POST /import/jobs/:id/resume → re-run from chunks_done
 *   5. DELETE /import/jobs/:id → cancel (sets status='paused'; job stops after current chunk)
 */

import { v4 as uuid } from 'uuid';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { EoDb } from '../db/level.js';
import { encode, decode } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import { parseCsvImport, processImport } from './log-import.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export type ImportJobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed';

export interface ImportJob {
  id: string;
  status: ImportJobStatus;
  agent: string;
  created_at: string;
  updated_at: string;
  /** Approximate row count (header excluded). */
  total_rows: number;
  processed_rows: number;
  skipped_rows: number;
  /** Number of 5 000-row chunks fully committed. Used for resume. */
  chunks_done: number;
  total_chunks: number;
  errors: Array<{ index: number; error: string }>;
  options: {
    delimiter?: string;
    target_prefix?: string;
    halt_on_error?: boolean;
  };
  /** Set when status === 'failed'. */
  error_message?: string;
}

// ─── Storage helpers ───────────────────────────────────────────────────────

const KEY_PREFIX = 'import-job:';

function jobKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

export function getJobCsvPath(dataDir: string, jobId: string): string {
  return join(dataDir, 'import-jobs', `${jobId}.csv`);
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

export async function createImportJob(
  db: EoDb,
  dataDir: string,
  csvText: string,
  agent: string,
  options: ImportJob['options'],
): Promise<ImportJob> {
  const id = uuid();
  const now = new Date().toISOString();

  // Save CSV to disk before writing job metadata so the file always exists
  // when the job record references it.
  const jobsDir = join(dataDir, 'import-jobs');
  await mkdir(jobsDir, { recursive: true });
  await writeFile(getJobCsvPath(dataDir, id), csvText, 'utf8');

  // Approximate row count without full parse (subtract header row).
  const totalRows = Math.max(0, csvText.split(/\r?\n/).filter(l => l.trim().length > 0).length - 1);
  const CHUNK_SIZE = 5000;
  const totalChunks = Math.ceil(totalRows / CHUNK_SIZE);

  const job: ImportJob = {
    id,
    status: 'queued',
    agent,
    created_at: now,
    updated_at: now,
    total_rows: totalRows,
    processed_rows: 0,
    skipped_rows: 0,
    chunks_done: 0,
    total_chunks: totalChunks,
    errors: [],
    options,
  };

  await db.put(jobKey(id), encode(job));
  return job;
}

export async function getImportJob(db: EoDb, id: string): Promise<ImportJob | null> {
  try {
    const buf = await db.get(jobKey(id));
    return decode(buf) as ImportJob;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

export async function updateImportJob(
  db: EoDb,
  id: string,
  patch: Partial<ImportJob>,
): Promise<void> {
  const job = await getImportJob(db, id);
  if (!job) throw new Error(`Import job not found: ${id}`);
  await db.put(jobKey(id), encode({
    ...job,
    ...patch,
    updated_at: new Date().toISOString(),
  }));
}

export async function listImportJobs(db: EoDb): Promise<ImportJob[]> {
  const jobs: ImportJob[] = [];
  for await (const [, value] of db.iterator({
    gte: KEY_PREFIX,
    lte: `${KEY_PREFIX}\xff`,
  })) {
    jobs.push(decode(value) as ImportJob);
  }
  return jobs.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function deleteJobCsv(dataDir: string, jobId: string): Promise<void> {
  try {
    await unlink(getJobCsvPath(dataDir, jobId));
  } catch {
    // File may already be gone — not an error.
  }
}

// ─── Background runner ─────────────────────────────────────────────────────

/**
 * Process an import job in the background.
 *
 * Safe to call multiple times — re-entrant guard checks current status.
 * Resumes from `chunks_done` so it can pick up after a crash or cancellation.
 *
 * Cancellation: set status='paused' via DELETE /import/jobs/:id.
 * The runner checks for 'paused' in onChunkComplete and stops after the
 * current chunk finishes.
 */
export async function runImportJob(
  db: EoDb,
  feed: Feed,
  dataDir: string,
  jobId: string,
): Promise<void> {
  const job = await getImportJob(db, jobId);
  if (!job) throw new Error(`Import job not found: ${jobId}`);
  if (job.status === 'done') return;
  if (job.status === 'running') return; // already processing

  await updateImportJob(db, jobId, { status: 'running' });

  let cancelled = false;

  try {
    const csvText = await readFile(getJobCsvPath(dataDir, jobId), 'utf8');

    const rows = parseCsvImport(csvText, {
      delimiter: job.options.delimiter,
      targetPrefix: job.options.target_prefix,
    });

    // Track accumulated error list (processImport returns per-chunk errors)
    const allErrors = [...job.errors];

    const result = await processImport(db, feed, rows, job.agent, {
      halt_on_error: job.options.halt_on_error,
      chunk_size: 5000,
      startFromChunk: job.chunks_done,
      onChunkComplete: async (chunkIndex, chunkResult) => {
        // Merge any new errors from this chunk
        const newErrors = chunkResult.errors.slice(allErrors.length);
        allErrors.push(...newErrors);

        await updateImportJob(db, jobId, {
          processed_rows: chunkResult.processed,
          skipped_rows: chunkResult.skipped,
          chunks_done: chunkIndex + 1,
          errors: allErrors,
        });

        // Check if the user cancelled while this chunk was processing
        const current = await getImportJob(db, jobId);
        if (current?.status === 'paused') {
          cancelled = true;
          throw new Error('__cancelled__');
        }
      },
    });

    await updateImportJob(db, jobId, {
      status: 'done',
      processed_rows: result.processed,
      skipped_rows: result.skipped,
      chunks_done: job.total_chunks,
      errors: allErrors,
    });

    // Remove the CSV file now that processing is complete.
    await deleteJobCsv(dataDir, jobId);
  } catch (err: any) {
    if (cancelled || err.message === '__cancelled__') {
      // Already set to 'paused' by the DELETE endpoint — don't overwrite.
      return;
    }
    await updateImportJob(db, jobId, {
      status: 'failed',
      error_message: err.message,
    });
  }
}
