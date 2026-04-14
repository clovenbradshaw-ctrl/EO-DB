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

export function downloadBundle(): { clauses: number; corrections: number } {
  const clauses = collectClassifiedClauses();
  const corrections = collectUserCorrections();
  const body = JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      classified_clauses: clauses,
      user_corrections: corrections,
    },
    null,
    2,
  );
  triggerDownload(`nl_corpus_${Date.now()}.json`, body);
  return { clauses: clauses.length, corrections: corrections.length };
}
