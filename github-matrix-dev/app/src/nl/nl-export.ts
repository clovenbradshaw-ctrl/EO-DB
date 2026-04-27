/**
 * Export the current NL corpus for commit into `/nl/` where
 * `generate_centroids.py` consumes it.
 *
 * Two outputs:
 *
 *   classified_clauses.json  — every clause + its latest classification.
 *   user_corrections.json    — every REC correction the user emitted.
 *
 * Both are assembled by scanning recent events from the eo-store. This is
 * a best-effort export: for huge corpora we rely on the user running the
 * export before the fold's event window has rolled over.
 */

import { useEoStore } from '../store/eo-store';

export interface ClassifiedClauseExport {
  text: string;
  cell_id: string;
  cell_key: string;
  operator: string;
  confidence_gap: number;
  doc_id: string;
  clause_ix: number;
  script: string;
  timestamp: string;
  model_version: string;
  centroid_version: string;
}

export interface ExtractedTripleExport {
  subject: string;
  predicate: string;
  object: string;
  subj_span: [number, number];
  obj_span: [number, number];
  confidence: number;
  flags: string[];
  doc_id: string;
  clause_ix: number;
  triple_ix: number;
  /** Per-predicate 27-cell classification, if the predicate was classified. */
  predicate_cell_id?: string;
  predicate_cell_key?: string;
  predicate_confidence_gap?: number;
  timestamp: string;
  model_version: string;
}

export interface UserCorrectionExport {
  text: string;
  from_cell_id: string;
  to_cell_id: string;
  reason: string | null;
  doc_id: string;
  clause_ix: number;
  timestamp: string;
  agent: string;
}

/**
 * Scan the in-memory recent-events window to collect the latest classification
 * per clause. Caller can call before the window rolls past 100 — for a
 * comprehensive export we would need to walk the OPFS log, which is a future
 * refinement once this export proves useful in practice.
 */
export function collectClassifiedClauses(): ClassifiedClauseExport[] {
  const recent = useEoStore.getState().recentEvents;
  const latestByTarget = new Map<string, ClassifiedClauseExport>();
  for (const e of recent) {
    const op = e.op;
    if (op !== 'EVA') continue;
    const body = e.operand as any;
    if (body?.eva_type !== 'embedding_classification') continue;
    // Skip triple-scoped classifications — those are exported separately via
    // collectExtractedTriples() so the clause export stays clause-only.
    if (body?.scope === 'triple_predicate') continue;
    latestByTarget.set(e.target, {
      text: body.text_preview ?? '',
      cell_id: body.cell_id,
      cell_key: body.cell_key,
      operator: body.operator,
      confidence_gap: body.confidence_gap,
      doc_id: body.doc_id,
      clause_ix: body.clause_ix,
      script: body.script ?? 'unknown',
      timestamp: e.ts,
      model_version: body.model_version ?? 'all-MiniLM-L6-v2',
      centroid_version: body.centroid_version ?? 'v1.0',
    });
  }
  return Array.from(latestByTarget.values());
}

/**
 * Scan the recent-events window for SPO triple segments and their optional
 * per-predicate classifications. Triples are keyed by target (a single SEG
 * per triple); the matching predicate EVA is merged in by triple target.
 */
export function collectExtractedTriples(): ExtractedTripleExport[] {
  const recent = useEoStore.getState().recentEvents;
  const tripleByTarget = new Map<string, ExtractedTripleExport>();
  const predClsByTarget = new Map<
    string,
    { cell_id: string; cell_key: string; confidence_gap: number }
  >();
  for (const e of recent) {
    const body = e.operand as any;
    if (e.op === 'SEG' && body?.kind === 'nl_triple') {
      tripleByTarget.set(e.target, {
        subject: body.subject ?? '',
        predicate: body.predicate ?? '',
        object: body.object ?? '',
        subj_span: body.subj_span ?? [-1, -1],
        obj_span: body.obj_span ?? [-1, -1],
        confidence: body.confidence ?? 0,
        flags: body.flags ?? [],
        doc_id: body.doc_id,
        clause_ix: body.clause_ix,
        triple_ix: body.triple_ix,
        timestamp: e.ts,
        model_version: body.model_version ?? 'rebel-large',
      });
    } else if (
      e.op === 'EVA' &&
      body?.eva_type === 'embedding_classification' &&
      body?.scope === 'triple_predicate'
    ) {
      predClsByTarget.set(e.target, {
        cell_id: body.cell_id,
        cell_key: body.cell_key,
        confidence_gap: body.confidence_gap,
      });
    }
  }
  for (const [target, pred] of predClsByTarget) {
    const triple = tripleByTarget.get(target);
    if (!triple) continue;
    triple.predicate_cell_id = pred.cell_id;
    triple.predicate_cell_key = pred.cell_key;
    triple.predicate_confidence_gap = pred.confidence_gap;
  }
  return Array.from(tripleByTarget.values());
}

export function collectUserCorrections(): UserCorrectionExport[] {
  const recent = useEoStore.getState().recentEvents;
  const out: UserCorrectionExport[] = [];
  for (const e of recent) {
    if (e.op !== 'REC') continue;
    const body = e.operand as any;
    if (body?.eva_type !== 'embedding_classification_correction') continue;
    out.push({
      text: body.text_preview ?? '',
      from_cell_id: body.from_cell_id,
      to_cell_id: body.to_cell_id,
      reason: body.reason ?? null,
      doc_id: body.doc_id,
      clause_ix: body.clause_ix,
      timestamp: e.ts,
      agent: e.agent,
    });
  }
  return out;
}

function triggerDownload(filename: string, body: string, mime = 'application/json'): void {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadClassifiedClauses(): number {
  const rows = collectClassifiedClauses();
  triggerDownload(
    `classified_clauses_${Date.now()}.json`,
    JSON.stringify(rows, null, 2),
  );
  return rows.length;
}

export function downloadUserCorrections(): number {
  const rows = collectUserCorrections();
  triggerDownload(
    `user_corrections_${Date.now()}.json`,
    JSON.stringify(rows, null, 2),
  );
  return rows.length;
}

export function downloadExtractedTriples(): number {
  const rows = collectExtractedTriples();
  triggerDownload(
    `extracted_triples_${Date.now()}.json`,
    JSON.stringify(rows, null, 2),
  );
  return rows.length;
}

export function downloadBundle(): {
  clauses: number;
  corrections: number;
  triples: number;
} {
  const clauses = collectClassifiedClauses();
  const corrections = collectUserCorrections();
  const triples = collectExtractedTriples();
  const body = JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      classified_clauses: clauses,
      user_corrections: corrections,
      extracted_triples: triples,
    },
    null,
    2,
  );
  triggerDownload(`nl_corpus_${Date.now()}.json`, body);
  return {
    clauses: clauses.length,
    corrections: corrections.length,
    triples: triples.length,
  };
}
