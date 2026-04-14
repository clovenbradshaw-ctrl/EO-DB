/**
 * Resumable, chunked ingest queue for NL classification.
 *
 * Flow (three-tier):
 *   1. A caller hands an ExtractedDocument to `ingestDocument()`.
 *   2. We derive a SegmentedDocument (paragraph / sentence / clause tiers)
 *      via segment.ts. Each tier is a lattice position: paragraph asks
 *      "what is this region about", sentence asks "what does this assert",
 *      clause asks "what functional unit changed what".
 *   3. INS for the doc; INS + SEG for each paragraph, sentence, and clause.
 *   4. classifyBatchWithEmbeddings runs per tier — same forward pass yields
 *      both 27-cell classification AND the embedding vector that gets
 *      cached to OPFS so the Document Explorer query path can cosine-match
 *      without re-running the model.
 *   5. One EVA per tier chunk, tagged with resolution_tier + window
 *      provenance. Mode of givenness scaffolded as 'derived'.
 *   6. SPO triples extracted on clauses (unchanged from before).
 *
 * The fold (fold-core.ts) auto-promotes to WorkerShardPool at ≥500 events
 * and HELIX_LEVEL schedules the waves — we get parallelism for free.
 */

import { useEoStore } from '../store/eo-store';
import type { EoEventInput, Operator } from '../db/types';
import {
  classifyBatchWithEmbeddings,
  initClassifier,
  type Classification,
  type ResolutionTier,
} from './eo-classifier';
import {
  extractTriples,
  getSpoExtractorStatus,
  initSpoExtractor,
  type ExtractedTriple,
} from './spo-extractor';
import type { ExtractedDocument, RawClause } from './clause-extractor';
import {
  segmentFromExtracted,
  type SegmentedDocument,
  type LinkedClause,
  type RawParagraph,
  type RawSentence,
} from './segment';
import { putBatch as cacheEmbeddings } from './embedding-cache';

const BATCH_SIZE = 32;
const SPO_BATCH_SIZE = 8;
const PROGRESS_KEY_PREFIX = 'eo-nl-progress:';

type IngestPhase =
  | 'queued'
  | 'embedding_paragraphs'
  | 'embedding_sentences'
  | 'embedding_clauses'
  | 'embedding' // legacy alias, kept for any external consumers
  | 'extracting_triples'
  | 'committing'
  | 'done'
  | 'error';

export interface IngestProgress {
  doc_id: string;
  /** Total clause count (kept for backward compat). */
  total: number;
  /** Number of clauses processed — backwards-compatible progress numerator. */
  processed: number;
  phase: IngestPhase;
  message?: string;
  /** Clause-level classifications, indexed by clause_ix. */
  classificationsByIx: Record<number, Classification>;
  /** Paragraph-level classifications, indexed by para_ix. */
  paragraphClassificationsByIx?: Record<number, Classification>;
  /** Sentence-level classifications, indexed by sent_ix. */
  sentenceClassificationsByIx?: Record<number, Classification>;
  /** Extracted triples grouped by clause_ix. Populated as SPO extraction progresses. */
  triplesByIx: Record<number, ExtractedTriple[]>;
  /** Per-triple 27-cell classification keyed by `${clause_ix}:${triple_ix}`. */
  tripleClassifications: Record<string, Classification>;
  /** True when SPO was attempted but the extractor failed to load or was disabled. */
  tripleExtractionSkipped?: boolean;
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

/** Target strings — one family per tier so query/state lookups prefix cleanly. */
function clauseTarget(doc_id: string, clause: RawClause): string {
  return clauseTargetById(doc_id, clause.clause_ix);
}
function clauseTargetById(doc_id: string, clause_ix: number): string {
  return `nl_clause:${doc_id}:${clause_ix}`;
}
function paragraphTarget(doc_id: string, para_ix: number): string {
  return `nl_paragraph:${doc_id}:${para_ix}`;
}
function sentenceTarget(doc_id: string, sent_ix: number): string {
  return `nl_sentence:${doc_id}:${sent_ix}`;
}
function tripleTarget(doc_id: string, clause_ix: number, triple_ix: number): string {
  return `${clauseTargetById(doc_id, clause_ix)}:triple:${triple_ix}`;
}

/**
 * Window specification — scaffold for Phase-2 entity-type attributions.
 * Every EVA carries the grain / bounds / lattice position it was read at,
 * so downstream consumers (trajectory signatures, cohesion scores) can
 * audit what window produced what claim.
 */
interface WindowSpec {
  grain: ResolutionTier;
  bounds: [number, number];
  lattice_position: string;
}

/** Provenance scaffold — mode of givenness as first-class field. */
type ModeOfGivenness = 'perceived' | 'reported' | 'measured' | 'received' | 'derived';

/**
 * Ingest a document end-to-end. Emits INS for the doc, INS+SEG for each
 * paragraph / sentence / clause, EVA for each classification tier, and
 * SEG/EVA for each SPO triple.
 */
export async function ingestDocument(
  doc: ExtractedDocument,
  agent: string,
  onProgress?: ProgressListener,
): Promise<IngestProgress> {
  await initClassifier();
  const store = useEoStore.getState();
  const segmented = segmentFromExtracted(doc);
  const total = segmented.linkedClauses.length;
  const resumeFrom = loadCheckpoint(segmented.doc_id);

  const progress: IngestProgress = {
    doc_id: segmented.doc_id,
    total,
    processed: resumeFrom,
    phase: 'queued',
    classificationsByIx: {},
    paragraphClassificationsByIx: {},
    sentenceClassificationsByIx: {},
    triplesByIx: {},
    tripleClassifications: {},
  };
  const notify = (patch: Partial<IngestProgress>) => {
    Object.assign(progress, patch);
    onProgress?.(progress);
  };

  // Emit structural events (INS + SEG at all three tiers) once, on the
  // initial ingest. Subsequent resumes skip straight to classification.
  if (resumeFrom === 0) {
    await dispatchStructure(segmented, agent);
  }

  // Paragraphs first — quick, thematic overview.
  notify({ phase: 'embedding_paragraphs' });
  const paraByIx = await classifyTier(
    segmented,
    segmented.paragraphs,
    'paragraph',
    (p) => paragraphTarget(segmented.doc_id, p.para_ix),
    (p) => p.text,
    (p) => p.char_span,
    (p) => p.script,
    (p) => p.para_ix,
    agent,
  );
  progress.paragraphClassificationsByIx = paraByIx;
  notify({ paragraphClassificationsByIx: { ...paraByIx } });

  // Sentences — claim grain.
  notify({ phase: 'embedding_sentences' });
  const sentByIx = await classifyTier(
    segmented,
    segmented.sentences,
    'sentence',
    (s) => sentenceTarget(segmented.doc_id, s.sent_ix),
    (s) => s.text,
    (s) => s.char_span,
    (s) => s.script,
    (s) => s.sent_ix,
    agent,
  );
  progress.sentenceClassificationsByIx = sentByIx;
  notify({ sentenceClassificationsByIx: { ...sentByIx } });

  // Clauses — the original classification tier. Uses the chunked loop so
  // we can save checkpoint + progress along the way. Other tiers complete
  // too quickly (few-to-tens of items) to need checkpoint granularity.
  notify({ phase: 'embedding_clauses' });
  for (let start = resumeFrom; start < total; start += BATCH_SIZE) {
    const slice = segmented.linkedClauses.slice(start, start + BATCH_SIZE);
    const script = slice[0]?.script ?? 'latin';
    let batch: Awaited<ReturnType<typeof classifyBatchWithEmbeddings>>;
    try {
      batch = await classifyBatchWithEmbeddings(
        slice.map((c) => c.text),
        script,
      );
    } catch (err) {
      notify({ phase: 'error', message: (err as Error).message });
      return progress;
    }
    const cacheEntries: { target: string; vec: Float32Array }[] = [];
    for (let i = 0; i < batch.classifications.length; i++) {
      const r = batch.classifications[i];
      const clause = slice[i];
      r.clause_ix = clause.clause_ix;
      r.resolution_tier = 'clause';
      const target = clauseTarget(segmented.doc_id, clause);
      cacheEntries.push({ target, vec: batch.embeddings[i] });
      await store.dispatch(
        event('EVA' as Operator, target, {
          eva_type: 'embedding_classification',
          resolution_tier: 'clause' as ResolutionTier,
          window: {
            grain: 'clause' as ResolutionTier,
            bounds: clause.char_span,
            lattice_position: target,
          } satisfies WindowSpec,
          mode_of_givenness: 'derived' as ModeOfGivenness,
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
          doc_id: segmented.doc_id,
          clause_ix: clause.clause_ix,
          sent_ix: clause.sent_ix,
          para_ix: clause.para_ix,
          text_preview: clause.text.slice(0, 160),
        }, agent),
      );
      progress.classificationsByIx[clause.clause_ix] = r;
    }
    // Cache all embeddings for this batch in one OPFS append.
    await cacheEmbeddings(cacheEntries);
    const processed = Math.min(total, start + slice.length);
    saveCheckpoint(segmented.doc_id, processed);
    notify({ processed });
  }

  // ── SPO triple extraction ──────────────────────────────────────────────
  notify({ phase: 'extracting_triples' });
  try {
    const spoStatus = await initSpoExtractor();
    if (spoStatus.state === 'ready') {
      await ingestTriples(segmented, progress, agent, notify);
    } else {
      notify({ tripleExtractionSkipped: true });
    }
  } catch (err) {
    notify({
      tripleExtractionSkipped: true,
      message: `SPO skipped: ${(err as Error).message ?? String(err)}`,
    });
  }

  notify({ phase: 'done', processed: total });
  clearCheckpoint(segmented.doc_id);
  return progress;
}

/**
 * Emit the structural events (doc INS + per-tier INS/SEG) that anchor every
 * paragraph / sentence / clause to its span in the source. This is idempotent
 * on resume only by virtue of the checkpoint; callers that re-ingest without
 * clearing state will double-dispatch (acceptable — the fold dedupes by seq).
 */
async function dispatchStructure(
  doc: SegmentedDocument,
  agent: string,
): Promise<void> {
  const store = useEoStore.getState();
  // Doc itself.
  await store.dispatch(
    event('INS' as Operator, doc.doc_id, {
      kind: 'nl_document',
      title: doc.title,
      source: doc.source,
      char_count: doc.char_count,
      clause_count: doc.linkedClauses.length,
      paragraph_count: doc.paragraphs.length,
      sentence_count: doc.sentences.length,
    }, agent),
  );

  // Paragraphs.
  for (const p of doc.paragraphs) {
    const target = paragraphTarget(doc.doc_id, p.para_ix);
    await store.dispatch(event('INS' as Operator, target, {
      kind: 'nl_paragraph',
      doc_id: doc.doc_id,
      para_ix: p.para_ix,
    }, agent));
    await store.dispatch(event('SEG' as Operator, target, {
      kind: 'nl_paragraph_span',
      doc_id: doc.doc_id,
      para_ix: p.para_ix,
      char_span: p.char_span,
      script: p.script,
      text_preview: p.text.slice(0, 240),
    }, agent));
  }

  // Sentences.
  for (const s of doc.sentences) {
    const target = sentenceTarget(doc.doc_id, s.sent_ix);
    await store.dispatch(event('INS' as Operator, target, {
      kind: 'nl_sentence',
      doc_id: doc.doc_id,
      sent_ix: s.sent_ix,
      para_ix: s.para_ix,
    }, agent));
    await store.dispatch(event('SEG' as Operator, target, {
      kind: 'nl_sentence_span',
      doc_id: doc.doc_id,
      sent_ix: s.sent_ix,
      para_ix: s.para_ix,
      char_span: s.char_span,
      script: s.script,
      text_preview: s.text.slice(0, 200),
    }, agent));
  }

  // Clauses (preserves backward-compatible target family `nl_clause:*`).
  for (const c of doc.linkedClauses) {
    const target = clauseTarget(doc.doc_id, c);
    await store.dispatch(event('INS' as Operator, target, {
      kind: 'nl_clause',
      doc_id: doc.doc_id,
      clause_ix: c.clause_ix,
      sent_ix: c.sent_ix,
      para_ix: c.para_ix,
    }, agent));
    await store.dispatch(event('SEG' as Operator, target, {
      kind: 'nl_clause_span',
      doc_id: doc.doc_id,
      clause_ix: c.clause_ix,
      sent_ix: c.sent_ix,
      para_ix: c.para_ix,
      char_span: c.char_span,
      script: c.script,
      text_preview: c.text.slice(0, 160),
    }, agent));
  }
}

/**
 * Generic tier classifier — paragraph and sentence tiers both route through
 * this. Batches through the classifier, caches embeddings, emits EVA per
 * chunk tagged with resolution_tier + window provenance.
 */
async function classifyTier<T extends RawParagraph | RawSentence>(
  doc: SegmentedDocument,
  items: T[],
  tier: ResolutionTier,
  getTarget: (item: T) => string,
  getText: (item: T) => string,
  getSpan: (item: T) => [number, number],
  getScript: (item: T) => string,
  getKey: (item: T) => number,
  agent: string,
): Promise<Record<number, Classification>> {
  const store = useEoStore.getState();
  const indexByTarget: Record<number, Classification> = {};
  if (items.length === 0) return indexByTarget;
  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    const slice = items.slice(start, start + BATCH_SIZE);
    const script = getScript(slice[0]) ?? 'latin';
    let batch: Awaited<ReturnType<typeof classifyBatchWithEmbeddings>>;
    try {
      batch = await classifyBatchWithEmbeddings(
        slice.map(getText),
        script,
      );
    } catch {
      // Tier-level failure is non-fatal — the clause tier is authoritative
      // for the existing export format; paragraph/sentence are additive.
      continue;
    }
    const cacheEntries: { target: string; vec: Float32Array }[] = [];
    for (let i = 0; i < batch.classifications.length; i++) {
      const r = batch.classifications[i];
      const item = slice[i];
      r.resolution_tier = tier;
      const target = getTarget(item);
      const span = getSpan(item);
      cacheEntries.push({ target, vec: batch.embeddings[i] });
      await store.dispatch(
        event('EVA' as Operator, target, {
          eva_type: 'embedding_classification',
          resolution_tier: tier,
          window: {
            grain: tier,
            bounds: span,
            lattice_position: target,
          } satisfies WindowSpec,
          mode_of_givenness: 'derived' as ModeOfGivenness,
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
          text_preview: getText(item).slice(0, 240),
        }, agent),
      );
      // Tier-local index key — para_ix for paragraphs, sent_ix for sentences.
      indexByTarget[getKey(item)] = r;
    }
    await cacheEmbeddings(cacheEntries);
  }
  return indexByTarget;
}

/**
 * Run REBEL over every latin-script clause in batches, emitting one SEG event
 * per extracted triple and one EVA event per per-triple predicate
 * classification. Non-latin clauses were already filtered inside
 * `extractTriples`, so no additional guard is needed here.
 */
async function ingestTriples(
  doc: SegmentedDocument,
  progress: IngestProgress,
  agent: string,
  notify: (patch: Partial<IngestProgress>) => void,
): Promise<void> {
  const store = useEoStore.getState();
  const clauses: LinkedClause[] = doc.linkedClauses;
  for (let start = 0; start < clauses.length; start += SPO_BATCH_SIZE) {
    const slice = clauses.slice(start, start + SPO_BATCH_SIZE);
    let triples: ExtractedTriple[];
    try {
      triples = await extractTriples(slice);
    } catch {
      continue;
    }
    if (triples.length === 0) continue;

    const byClause: Record<number, ExtractedTriple[]> = {};
    for (const t of triples) {
      (byClause[t.clause_ix] ??= []).push(t);
    }

    for (const t of triples) {
      const tripleId = tripleTarget(doc.doc_id, t.clause_ix, t.triple_ix);
      await store.dispatch(
        event('SEG' as Operator, tripleId, {
          kind: 'nl_triple',
          doc_id: doc.doc_id,
          clause_ix: t.clause_ix,
          triple_ix: t.triple_ix,
          subject: t.subject,
          predicate: t.predicate,
          object: t.object,
          subj_span: t.subj_span,
          obj_span: t.obj_span,
          confidence: t.confidence,
          flags: t.flags,
          model_version: 'rebel-large',
        }, agent),
      );
    }

    for (const [ixStr, list] of Object.entries(byClause)) {
      const ix = Number(ixStr);
      progress.triplesByIx[ix] = [...(progress.triplesByIx[ix] ?? []), ...list];
    }

    // Classify each triple's predicate via the existing 27-cell classifier.
    try {
      const predicateTexts = triples.map((t) => t.predicate);
      const predBatch = await classifyBatchWithEmbeddings(predicateTexts, 'latin');
      for (let i = 0; i < triples.length; i++) {
        const t = triples[i];
        const r = predBatch.classifications[i];
        if (!r) continue;
        const key = `${t.clause_ix}:${t.triple_ix}`;
        progress.tripleClassifications[key] = r;
        const tripleId = tripleTarget(doc.doc_id, t.clause_ix, t.triple_ix);
        await store.dispatch(
          event('EVA' as Operator, tripleId, {
            eva_type: 'embedding_classification',
            scope: 'triple_predicate',
            mode_of_givenness: 'derived' as ModeOfGivenness,
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
            clause_ix: t.clause_ix,
            triple_ix: t.triple_ix,
            text_preview: t.predicate.slice(0, 160),
          }, agent),
        );
      }
    } catch {
      /* best-effort */
    }

    notify({
      triplesByIx: { ...progress.triplesByIx },
      tripleClassifications: { ...progress.tripleClassifications },
    });
  }

  const finalStatus = getSpoExtractorStatus();
  if (finalStatus.state !== 'ready') {
    notify({ tripleExtractionSkipped: true });
  }
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
      mode_of_givenness: 'received' as ModeOfGivenness,
    }, params.agent),
  );
}
