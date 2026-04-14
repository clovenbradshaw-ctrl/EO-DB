/**
 * Document Explorer query path.
 *
 * Resolution levels are lattice positions, not UI filters. A query run at
 * paragraph level asks "where does this topic live in this document"; at
 * sentence level, "what does this document assert about this"; at clause
 * level, "what functional unit establishes this relationship". The three
 * return genuinely different things (Rule 4 — perspectivality).
 *
 * Under the hood it's a cosine scan:
 *   1. Embed the query via the same MiniLM worker the ingest uses.
 *   2. Pull every pre-cached chunk embedding for the requested tier + doc.
 *   3. Cosine-score, sort, truncate to top_k.
 *   4. Look up the latest EVA state at each hit's target to attach the
 *      cell_id / operator without re-classifying.
 *
 * Operator-targeted mode filters hits post-scoring by the top-cell's
 * operator. Contrastive mode is reserved for a later PR (cross-doc diff);
 * calling it returns `not_implemented`.
 */

import { embedQuery, initClassifier } from './eo-classifier';
import { iterByPrefix, VECTOR_DIM } from './embedding-cache';
import { useEoStore } from '../store/eo-store';
import type { EoState } from '../db/types';
import type { ResolutionTier } from './eo-classifier';
import type { SegmentedDocument } from './segment';

export type QueryMode = 'semantic' | 'operator_targeted' | 'contrastive';

export interface QueryRequest {
  doc: SegmentedDocument;
  query_text: string;
  resolution: ResolutionTier;
  mode: QueryMode;
  /** Filter to hits whose top cell has this operator. Required for mode='operator_targeted'. */
  operator_filter?: string;
  /** Top-k; default 20. */
  top_k?: number;
}

export interface QueryHit {
  target: string;
  resolution: ResolutionTier;
  char_span: [number, number];
  text: string;
  /** Cosine similarity of this chunk's embedding against the query embedding. */
  similarity: number;
  /** Top EVA cell at this target (from store state, not recomputed). */
  cell_id?: string;
  cell_key?: string;
  operator?: string;
  confidence_gap?: number;
  /** Divergence signal: for sentence/clause hits, the containing paragraph's top cell, if different. */
  parent_cell_id?: string;
}

export interface QueryResponse {
  hits: QueryHit[];
  /** Set when the request couldn't run as asked — e.g. contrastive mode. */
  not_implemented?: string;
}

/** Stable prefix for a doc's pre-embedded chunks at one resolution. */
function prefixFor(doc_id: string, tier: ResolutionTier): string {
  switch (tier) {
    case 'paragraph': return `nl_paragraph:${doc_id}:`;
    case 'sentence':  return `nl_sentence:${doc_id}:`;
    case 'clause':    return `nl_clause:${doc_id}:`;
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  // Both vectors are L2-normalized when produced by the classifier worker,
  // so dot product = cosine similarity. We still run the full dot rather
  // than asserting normalization, because alignment-matrix-transformed
  // vectors can drift slightly off the unit sphere.
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Resolve the latest EVA classification operand for a target, if any.
 * Reads from the reactive store state — last_op + value capture the most
 * recent event that updated the target.
 */
async function lookupCellAt(target: string): Promise<{
  cell_id?: string;
  cell_key?: string;
  operator?: string;
  confidence_gap?: number;
} | null> {
  const store = useEoStore.getState();
  const state: EoState | null = await store.getState(target);
  if (!state) return null;
  const value = state.value as
    | undefined
    | Record<string, unknown>;
  if (!value || typeof value !== 'object') return null;
  // EVA and INS both land in `value`; we only surface EVA bodies (which
  // carry eva_type). If the SEG was the most recent write (e.g. classifier
  // hasn't caught up), we fall back to null and the UI shows "no cell".
  if (value['eva_type'] !== 'embedding_classification') return null;
  return {
    cell_id: value['cell_id'] as string | undefined,
    cell_key: value['cell_key'] as string | undefined,
    operator: value['operator'] as string | undefined,
    confidence_gap: value['confidence_gap'] as number | undefined,
  };
}

/**
 * Map from `target → {char_span, text, para_ix?}` built off the segmented
 * document the caller is exploring. Used in lieu of a store lookup because
 * the state row for a classified chunk carries only the last EVA body (not
 * the SEG span). The UI already has the SegmentedDocument in memory, so
 * this is free.
 */
interface SegmentIndex {
  byTarget: Map<
    string,
    { char_span: [number, number]; text: string; para_ix?: number }
  >;
}

function buildIndex(doc: SegmentedDocument): SegmentIndex {
  const byTarget = new Map<
    string,
    { char_span: [number, number]; text: string; para_ix?: number }
  >();
  for (const p of doc.paragraphs) {
    byTarget.set(`nl_paragraph:${doc.doc_id}:${p.para_ix}`, {
      char_span: p.char_span,
      text: p.text,
      para_ix: p.para_ix,
    });
  }
  for (const s of doc.sentences) {
    byTarget.set(`nl_sentence:${doc.doc_id}:${s.sent_ix}`, {
      char_span: s.char_span,
      text: s.text,
      para_ix: s.para_ix,
    });
  }
  for (const c of doc.linkedClauses) {
    byTarget.set(`nl_clause:${doc.doc_id}:${c.clause_ix}`, {
      char_span: c.char_span,
      text: c.text,
      para_ix: c.para_ix,
    });
  }
  return { byTarget };
}

export async function runQuery(req: QueryRequest): Promise<QueryResponse> {
  if (req.mode === 'contrastive') {
    return {
      hits: [],
      not_implemented:
        'Contrastive (cross-doc) mode is scaffolded but not yet implemented.',
    };
  }
  await initClassifier();
  const topK = req.top_k ?? 20;

  const qvec = await embedQuery(req.query_text);
  if (qvec.length !== VECTOR_DIM) {
    return { hits: [], not_implemented: 'Query vector dimensionality mismatch.' };
  }

  const entries = await iterByPrefix(prefixFor(req.doc.doc_id, req.resolution));
  if (entries.length === 0) {
    return { hits: [] };
  }

  const index = buildIndex(req.doc);

  // Score every chunk at this tier, sort, truncate.
  const scored = entries.map((e) => ({
    target: e.target,
    similarity: cosine(qvec, e.vec),
  }));
  scored.sort((a, b) => b.similarity - a.similarity);

  // Pull top (2 × top_k) to leave room for the operator filter to trim.
  const candidates = scored.slice(0, Math.max(topK * 2, topK));

  const hits: QueryHit[] = [];
  for (const c of candidates) {
    const cell = await lookupCellAt(c.target);
    const span = index.byTarget.get(c.target);
    if (req.mode === 'operator_targeted' && req.operator_filter) {
      if (!cell || cell.operator !== req.operator_filter) continue;
    }
    hits.push({
      target: c.target,
      resolution: req.resolution,
      char_span: span?.char_span ?? [0, 0],
      text: span?.text ?? '',
      similarity: c.similarity,
      cell_id: cell?.cell_id,
      cell_key: cell?.cell_key,
      operator: cell?.operator,
      confidence_gap: cell?.confidence_gap,
    });
    if (hits.length >= topK) break;
  }

  return { hits };
}

/**
 * For the divergence indicator: given a set of hits, annotate each with its
 * containing paragraph's top cell_id. A mismatch between `cell_id` and
 * `parent_cell_id` surfaces in the UI as "structural divergence" — the
 * paragraph is thematically about X but the high-confidence clause inside
 * it talks about Y. That's itself an investigative signal.
 */
export async function annotateParents(
  hits: QueryHit[],
  doc: SegmentedDocument,
): Promise<QueryHit[]> {
  if (hits.length === 0) return hits;
  const index = buildIndex(doc);
  const out: QueryHit[] = [];
  for (const h of hits) {
    if (h.resolution === 'paragraph') {
      out.push(h);
      continue;
    }
    const row = index.byTarget.get(h.target);
    const para_ix = row?.para_ix;
    if (typeof para_ix !== 'number' || para_ix < 0) {
      out.push(h);
      continue;
    }
    const parentTarget = `nl_paragraph:${doc.doc_id}:${para_ix}`;
    const parent = await lookupCellAt(parentTarget);
    out.push({ ...h, parent_cell_id: parent?.cell_id });
  }
  return out;
}
