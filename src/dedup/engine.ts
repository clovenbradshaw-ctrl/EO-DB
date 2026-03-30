// ─── Dedup Engine: Orchestrator ──────────────────────────────────────────────
// Runs a DedupToolConfig against the DB: blocking → comparison → scoring →
// auto-merge (SYN emission) or candidate queueing for human review.

import { createHash } from 'crypto';
import type { EoDb } from '../db/level.js';
import { encode, decode } from '../db/level.js';
import { getStateByPrefix } from '../db/state.js';
import { resolveAlias } from '../db/helpers.js';
import { processEvent } from '../db/fold.js';
import type { Feed } from '../db/feed.js';
import type { EoState, EoEventInput } from '../db/types.js';
import type { DedupToolConfig, DedupCandidate, DedupJob } from './types.js';
import { candidatePairs } from './blocking.js';
import { compareRecords } from './compare.js';

/**
 * Run a full dedup job: scan records → block → compare → score → classify.
 *
 * Returns the job with stats. Auto-merges are applied immediately via SYN.
 * Uncertain candidates are stored for human review.
 */
export async function runDedupJob(
  db: EoDb,
  config: DedupToolConfig,
  feed?: Feed,
): Promise<DedupJob> {
  const jobId = 'job:' + createHash('sha256')
    .update(`${config.id}\0${Date.now()}\0${Math.random()}`)
    .digest('hex')
    .slice(0, 12);

  const job: DedupJob = {
    job_id: jobId,
    tool_id: config.id,
    status: 'running',
    started_at: new Date().toISOString(),
    stats: {
      records_scanned: 0,
      pairs_compared: 0,
      pairs_total_possible: 0,
      reduction_ratio: 0,
      auto_merged: 0,
      pending_review: 0,
      rejected: 0,
    },
  };

  await storeJob(db, job);

  try {
    // 1. Scan records in scope
    const allRecords = await getStateByPrefix(db, config.scope.collection);

    // Filter out aliases (already-merged targets) and apply optional filter
    const records: EoState[] = [];
    for (const rec of allRecords) {
      if (rec.value?._alias) continue; // skip merged targets
      const resolved = await resolveAlias(db, rec.target);
      if (resolved !== rec.target) continue; // skip if alias chain exists
      if (config.scope.filter && !matchesFilter(rec, config.scope.filter)) continue;
      records.push(rec);
    }

    job.stats.records_scanned = records.length;
    job.stats.pairs_total_possible = records.length * (records.length - 1) / 2;

    // 2. Generate candidate pairs via blocking
    const pairs = candidatePairs(records, config.blocking);
    job.stats.pairs_compared = pairs.length;
    job.stats.reduction_ratio = job.stats.pairs_total_possible > 0
      ? 1 - pairs.length / job.stats.pairs_total_possible
      : 0;

    // 3. Compare pairs and classify
    const candidates: DedupCandidate[] = [];
    for (const [a, b] of pairs) {
      const candidate = compareRecords(a, b, config);

      if (candidate.score >= config.scoring.auto_merge_threshold) {
        candidate.status = 'auto_merged';
        job.stats.auto_merged++;
      } else if (candidate.score >= config.scoring.review_threshold) {
        candidate.status = 'pending';
        job.stats.pending_review++;
      } else {
        candidate.status = 'rejected';
        job.stats.rejected++;
      }

      candidates.push(candidate);
    }

    // 4. Apply auto-merges via SYN
    const autoMergeCandidates = candidates.filter(c => c.status === 'auto_merged');
    await applyAutoMerges(db, autoMergeCandidates, config, feed);

    // 5. Store pending candidates for review
    const pendingCandidates = candidates.filter(c => c.status === 'pending');
    await storeCandidates(db, pendingCandidates, config.id);

    // 6. Complete job
    job.status = 'completed';
    job.completed_at = new Date().toISOString();
    await storeJob(db, job);

  } catch (err: any) {
    job.status = 'failed';
    job.error = err.message;
    job.completed_at = new Date().toISOString();
    await storeJob(db, job);
  }

  return job;
}

/**
 * Emit SYN events for auto-merged candidate pairs.
 */
export async function applyAutoMerges(
  db: EoDb,
  candidates: DedupCandidate[],
  config: DedupToolConfig,
  feed?: Feed,
): Promise<number> {
  let merged = 0;
  for (const candidate of candidates) {
    const synEvent: EoEventInput = {
      op: 'SYN',
      target: candidate.target_a,
      operand: {
        merge: [candidate.target_a, candidate.target_b],
        into: candidate.target_a,
      },
      agent: config.created_by,
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
      meta: {
        dedup_tool_id: config.id,
        dedup_score: candidate.score,
        dedup_field_scores: candidate.field_scores,
      },
    };

    try {
      await processEvent(db, synEvent, feed);
      merged++;
    } catch {
      // SYN may fail if targets were already merged — skip
    }
  }
  return merged;
}

/**
 * Store candidates in the database for later review.
 */
export async function storeCandidates(
  db: EoDb,
  candidates: DedupCandidate[],
  toolId: string,
): Promise<void> {
  const candidateIds: string[] = [];
  for (const candidate of candidates) {
    await db.put(`dedup:candidate:${candidate.id}`, encode(candidate));
    candidateIds.push(candidate.id);
  }

  // Append to tool's candidate list
  let existing: string[] = [];
  try {
    const buf = await db.get(`dedup:candidates:${toolId}`);
    existing = decode(buf) as string[];
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
  await db.put(`dedup:candidates:${toolId}`, encode([...existing, ...candidateIds]));
}

/**
 * Review a candidate: approve (→ emit SYN) or reject.
 */
export async function reviewCandidate(
  db: EoDb,
  candidateId: string,
  decision: 'approved' | 'rejected',
  agent: string,
  feed?: Feed,
): Promise<DedupCandidate> {
  const buf = await db.get(`dedup:candidate:${candidateId}`);
  const candidate = decode(buf) as DedupCandidate;

  candidate.status = decision;
  candidate.reviewed_by = agent;
  candidate.reviewed_at = new Date().toISOString();

  if (decision === 'approved') {
    // Load tool config for metadata
    let toolMeta: any = {};
    try {
      const toolBuf = await db.get(`dedup:tool:${candidate.tool_id}`);
      const tool = decode(toolBuf) as DedupToolConfig;
      toolMeta = { dedup_tool_id: tool.id };
    } catch { /* tool config may have been deleted */ }

    const synEvent: EoEventInput = {
      op: 'SYN',
      target: candidate.target_a,
      operand: {
        merge: [candidate.target_a, candidate.target_b],
        into: candidate.target_a,
      },
      agent,
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
      meta: {
        ...toolMeta,
        dedup_score: candidate.score,
        dedup_review: 'manual',
      },
    };

    await processEvent(db, synEvent, feed);
  }

  await db.put(`dedup:candidate:${candidateId}`, encode(candidate));
  return candidate;
}

// ─── Tool Config CRUD ────────────────────────────────────────────────────────

export async function storeTool(db: EoDb, config: DedupToolConfig): Promise<void> {
  await db.put(`dedup:tool:${config.id}`, encode(config));

  // Maintain tool list
  let toolIds: string[] = [];
  try {
    const buf = await db.get('dedup:tools');
    toolIds = decode(buf) as string[];
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
  if (!toolIds.includes(config.id)) {
    toolIds.push(config.id);
    await db.put('dedup:tools', encode(toolIds));
  }
}

export async function getTool(db: EoDb, id: string): Promise<DedupToolConfig | null> {
  try {
    const buf = await db.get(`dedup:tool:${id}`);
    return decode(buf) as DedupToolConfig;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

export async function listTools(db: EoDb): Promise<DedupToolConfig[]> {
  let toolIds: string[] = [];
  try {
    const buf = await db.get('dedup:tools');
    toolIds = decode(buf) as string[];
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return [];
    throw e;
  }

  const tools: DedupToolConfig[] = [];
  for (const id of toolIds) {
    const tool = await getTool(db, id);
    if (tool) tools.push(tool);
  }
  return tools;
}

export async function deleteTool(db: EoDb, id: string): Promise<void> {
  try { await db.del(`dedup:tool:${id}`); } catch {}

  let toolIds: string[] = [];
  try {
    const buf = await db.get('dedup:tools');
    toolIds = decode(buf) as string[];
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
  const idx = toolIds.indexOf(id);
  if (idx >= 0) {
    toolIds.splice(idx, 1);
    await db.put('dedup:tools', encode(toolIds));
  }
}

// ─── Job CRUD ────────────────────────────────────────────────────────────────

async function storeJob(db: EoDb, job: DedupJob): Promise<void> {
  await db.put(`dedup:job:${job.job_id}`, encode(job));
}

export async function getJob(db: EoDb, jobId: string): Promise<DedupJob | null> {
  try {
    const buf = await db.get(`dedup:job:${jobId}`);
    return decode(buf) as DedupJob;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

export async function getCandidates(
  db: EoDb,
  toolId: string,
  statusFilter?: DedupCandidate['status'],
): Promise<DedupCandidate[]> {
  let candidateIds: string[] = [];
  try {
    const buf = await db.get(`dedup:candidates:${toolId}`);
    candidateIds = decode(buf) as string[];
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return [];
    throw e;
  }

  const candidates: DedupCandidate[] = [];
  for (const id of candidateIds) {
    try {
      const buf = await db.get(`dedup:candidate:${id}`);
      const candidate = decode(buf) as DedupCandidate;
      if (!statusFilter || candidate.status === statusFilter) {
        candidates.push(candidate);
      }
    } catch { /* candidate may have been deleted */ }
  }
  return candidates;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function matchesFilter(state: EoState, filter: Record<string, any>): boolean {
  if (!state.value || typeof state.value !== 'object') return false;
  for (const [key, expected] of Object.entries(filter)) {
    if (state.value[key] !== expected) return false;
  }
  return true;
}
