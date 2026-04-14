/**
 * Resumable, chunked ingest queue for NL classification.
 *
 * Flow:
 *   1. A caller hands an ExtractedDocument to `ingestDocument()`.
 *   2. We write one INS event for the doc + INS/SEG for each clause.
 *   3. Clauses are batched (32 per chunk) through the classifier.
 *   4. Each batch emits one EVA event per clause.
 *   5. Progress is persisted to localStorage per doc_id so a tab reload
 *      resumes at the last committed batch rather than restarting.
 *
 * The fold (fold-core.ts) auto-promotes to WorkerShardPool at ≥500 events
 * and HELIX_LEVEL schedules the waves — we get parallelism for free.
 */

import { useEoStore } from '../store/eo-store';
import type { EoEventInput, Operator } from '../db/types';
import { classifyBatch, initClassifier, type Classification } from './eo-classifier';
import type { ExtractedDocument, RawClause } from './clause-extractor';

const BATCH_SIZE = 32;
const PROGRESS_KEY_PREFIX = 'eo-nl-progress:';

export interface IngestProgress {
  doc_id: string;
  total: number;
  processed: number;
  phase: 'queued' | 'embedding' | 'committing' | 'done' | 'error';
  message?: string;
  classificationsByIx: Record<number, Classification>;
}

type ProgressListener = (p: IngestProgress) => void;

function loadCheckpoint(doc_id: string): number {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY_PREFIX + doc_id);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { processed?: number };
    return parsed.processed ?? 0;
  } catch {
    return 0;
  }
}

function saveCheckpoint(doc_id: string, processed: number): void {
  try {
    localStorage.setItem(
      PROGRESS_KEY_PREFIX + doc_id,
      JSON.stringify({ processed, ts: Date.now() }),
    );
  } catch {
    /* quota — best-effort only */
  }
}

function clearCheckpoint(doc_id: string): void {
  try {
    localStorage.removeItem(PROGRESS_KEY_PREFIX + doc_id);
  } catch {
    /* ignore */
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function event(
  op: Operator,
  target: string,
  operand: Record<string, unknown>,
  agent: string,
): EoEventInput {
  return {
    op: op as EoEventInput['op'],
    target,
    operand,
    agent,
    ts: nowIso(),
    acquired_ts: nowIso(),
  };
}

/** Convert a RawClause to a stable anchor target string. */
function clauseTarget(doc_id: string, clause: RawClause): string {
  return `nl_clause:${doc_id}:${clause.clause_ix}`;
}

/**
 * Ingest a document end-to-end. Emits INS for the doc, INS+SEG for each
 * clause, then EVA for each classification as batches return.
 */
export async function ingestDocument(
  doc: ExtractedDocument,
  agent: string,
  onProgress?: ProgressListener,
): Promise<IngestProgress> {
  await initClassifier();
  const store = useEoStore.getState();
  const total = doc.clauses.length;
  const resumeFrom = loadCheckpoint(doc.doc_id);

  const progress: IngestProgress = {
    doc_id: doc.doc_id,
    total,
    processed: resumeFrom,
    phase: 'queued',
    classificationsByIx: {},
  };
  const notify = (patch: Partial<IngestProgress>) => {
    Object.assign(progress, patch);
    onProgress?.(progress);
  };

  // One INS for the doc itself. Idempotent via deterministic target+agent+ts.
  if (resumeFrom === 0) {
    await store.dispatch(
      event('INS' as Operator, doc.doc_id, {
        kind: 'nl_document',
        title: doc.title,
        source: doc.source,
        char_count: doc.char_count,
        clause_count: total,
      }, agent),
    );
    // One INS + SEG per clause — creates entities and anchors their spans.
    // We batch these without awaiting each (rely on the dispatch mutex).
    for (const c of doc.clauses) {
      const target = clauseTarget(doc.doc_id, c);
      await store.dispatch(event('INS' as Operator, target, {
        kind: 'nl_clause',
        doc_id: doc.doc_id,
        clause_ix: c.clause_ix,
      }, agent));
      await store.dispatch(event('SEG' as Operator, target, {
        kind: 'nl_clause_span',
        doc_id: doc.doc_id,
        clause_ix: c.clause_ix,
        char_span: c.char_span,
        script: c.script,
        text_preview: c.text.slice(0, 160),
      }, agent));
    }
  }

  notify({ phase: 'embedding' });

  // Classify in batches; emit EVA per clause as each batch returns.
  for (let start = resumeFrom; start < total; start += BATCH_SIZE) {
    const slice = doc.clauses.slice(start, start + BATCH_SIZE);
    const script = slice[0]?.script ?? 'latin';
    let results: Classification[];
    try {
      results = await classifyBatch(
        slice.map((c) => c.text),
        script,
      );
    } catch (err) {
      notify({ phase: 'error', message: (err as Error).message });
      return progress;
    }
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const clause = slice[i];
      r.clause_ix = clause.clause_ix;
      const target = clauseTarget(doc.doc_id, clause);
      await store.dispatch(
        event('EVA' as Operator, target, {
          eva_type: 'embedding_classification',
          cell_id: r.cell_id,
          cell_key: r.cell_key,
          operator: r.operator,
          site: r.site,
          resolution: r.resolution,
          mode: r.mode,
          domain: r.domain,
          confidence_gap: r.confidence_gap,
          similarity_profile: r.similarity_profile,
          flags: r.flags,
          script: r.script,
          model_version: 'all-MiniLM-L6-v2',
          centroid_version: 'v1.0',
          doc_id: doc.doc_id,
          clause_ix: clause.clause_ix,
          text_preview: clause.text.slice(0, 160),
        }, agent),
      );
      progress.classificationsByIx[clause.clause_ix] = r;
    }
    const processed = Math.min(total, start + slice.length);
    saveCheckpoint(doc.doc_id, processed);
    notify({ processed });
  }

  notify({ phase: 'done', processed: total });
  clearCheckpoint(doc.doc_id);
  return progress;
}

/**
 * Record a user correction — emits REC with from/to cell and a CON edge
 * describing the provenance. The fold cascades REC automatically.
 */
export async function recordCorrection(params: {
  doc_id: string;
  clause_ix: number;
  from_cell_id: string;
  to_cell_id: string;
  text: string;
  reason?: string;
  agent: string;
}): Promise<void> {
  const store = useEoStore.getState();
  const target = `nl_clause:${params.doc_id}:${params.clause_ix}`;
  await store.dispatch(
    event('REC' as Operator, target, {
      eva_type: 'embedding_classification_correction',
      from_cell_id: params.from_cell_id,
      to_cell_id: params.to_cell_id,
      reason: params.reason ?? null,
      text_preview: params.text.slice(0, 160),
      doc_id: params.doc_id,
      clause_ix: params.clause_ix,
      source: 'user_feedback',
    }, params.agent),
  );
}
