/**
 * Import archive upload — binary archive creation, n8n Filen upload, and job tracking.
 *
 * Archives raw source data (completely unmodified) in .eodb binary format
 * and uploads to Filen via the n8n webhook before processing. This serves two purposes:
 * 1. Audit trail: compare original input vs processed EO events to detect translation errors
 * 2. Resumability: if processing is interrupted, re-download and resume
 *
 * Archive format: [4-byte "EODB" magic][msgpack body]
 * The body is an ImportArchive with raw_data preserved verbatim.
 *
 * All Filen operations route through the n8n webhook — no direct Filen
 * credentials or crypto on this server.
 */

import { pack, unpack } from 'msgpackr';
import { randomUUID } from 'crypto';
import type { EoDb } from '../db/level.js';
import { encode, decode } from '../db/level.js';
import { sha256, filenUpload, filenDownload } from './filen-api.js';

// ──────────────────────────────────────────────────────────────
// Archive format
// ──────────────────────────────────────────────────────────────

const EODB_MAGIC = new Uint8Array([0x45, 0x4F, 0x44, 0x42]); // "EODB"

export interface ImportArchive {
  version: 1;
  type: 'import-archive';
  source: 'json' | 'csv' | 'airtable';
  agent: string;
  created_at: string;
  content_hash: string;
  raw_data: any;
}

export function packImportArchive(archive: ImportArchive): Uint8Array {
  const body = pack(archive);
  const result = new Uint8Array(EODB_MAGIC.length + body.byteLength);
  result.set(EODB_MAGIC, 0);
  result.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), EODB_MAGIC.length);
  return result;
}

export function unpackImportArchive(data: Uint8Array): ImportArchive {
  for (let i = 0; i < EODB_MAGIC.length; i++) {
    if (data[i] !== EODB_MAGIC[i]) {
      throw new Error('Not a valid .eodb file (bad magic bytes)');
    }
  }
  return unpack(data.slice(EODB_MAGIC.length)) as ImportArchive;
}

// ──────────────────────────────────────────────────────────────
// Import job tracking
// ──────────────────────────────────────────────────────────────

export interface ImportJob {
  job_id: string;
  source: 'json' | 'csv' | 'airtable';
  status: 'uploading' | 'uploaded' | 'processing' | 'completed' | 'failed';
  agent: string;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  error?: string;

  /** Remote path in Filen (via n8n webhook). */
  filen_remote_path?: string;

  // Resume tracking
  content_hash: string;
  total_rows: number;
  processed_rows: number;
  last_processed_chunk: number;
}

const JOB_PREFIX = 'import:job:';
const HASH_PREFIX = 'import:job:hash:';

export async function saveImportJob(db: EoDb, job: ImportJob): Promise<void> {
  job.updated_at = new Date().toISOString();
  await db.put(`${JOB_PREFIX}${job.job_id}`, encode(job));
  if (job.content_hash) {
    await db.put(`${HASH_PREFIX}${job.source}:${job.content_hash}`, encode(job.job_id));
  }
}

export async function getImportJob(db: EoDb, jobId: string): Promise<ImportJob | null> {
  try {
    const buf = await db.get(`${JOB_PREFIX}${jobId}`);
    return decode(buf) as ImportJob;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

export async function findImportJobByHash(
  db: EoDb,
  source: string,
  contentHash: string,
): Promise<ImportJob | null> {
  try {
    const buf = await db.get(`${HASH_PREFIX}${source}:${contentHash}`);
    const jobId = decode(buf) as string;
    if (!jobId) return null;
    return getImportJob(db, jobId);
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

export function createImportJob(
  source: 'json' | 'csv' | 'airtable',
  agent: string,
  contentHash: string,
): ImportJob {
  const now = new Date().toISOString();
  return {
    job_id: randomUUID(),
    source,
    status: 'uploading',
    agent,
    started_at: now,
    updated_at: now,
    content_hash: contentHash,
    total_rows: 0,
    processed_rows: 0,
    last_processed_chunk: -1,
  };
}

// ──────────────────────────────────────────────────────────────
// Content hashing
// ──────────────────────────────────────────────────────────────

export async function computeContentHash(data: string): Promise<string> {
  return sha256(data);
}

// ──────────────────────────────────────────────────────────────
// Filen upload / download (via n8n webhook)
// ──────────────────────────────────────────────────────────────

/**
 * Upload a raw import archive to Filen via the n8n webhook.
 * Archives land in /EO-DB/uploads/archives/ (or spaceId-scoped path).
 */
export async function uploadImportArchive(
  jobId: string,
  source: string,
  archiveBinary: Uint8Array,
  spaceId?: string,
): Promise<{ remotePath: string }> {
  const filename = `archive-${source}-${jobId}-${Date.now()}.eodb`;
  const result = await filenUpload(archiveBinary, filename, {
    spaceId,
    subPath: 'archives',
  });

  if (!result.success) {
    throw new Error(result.error || 'Upload failed');
  }

  return { remotePath: result.remotePath || '' };
}

/**
 * Download and unpack an import archive from Filen via n8n webhook.
 */
export async function downloadImportArchive(
  remotePath: string,
  spaceId?: string,
): Promise<ImportArchive> {
  const result = await filenDownload({ path: remotePath, spaceId });

  if (!result.success || !result.data) {
    throw new Error(result.error || 'Download failed or no data returned');
  }

  const binary = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
  return unpackImportArchive(binary);
}
