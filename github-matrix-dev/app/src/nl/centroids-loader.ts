/**
 * Load precomputed centroids + Procrustes alignment matrix produced by
 * `/nl/generate_centroids.py`. Both are optional: if missing, the UI shows
 * an inline banner explaining how to generate them.
 *
 * Centroids are stored as a flat `Float32Array(N * dim)` (not one array per
 * cell) so the cosine-similarity hot loop is a single contiguous pass with
 * no allocations per clause.
 */

import { EO_CELLS, type EOCell } from './eo-cells';

export const EMBEDDING_DIM = 384;

export interface CentroidsBundle {
  /** Flat row-major matrix: cells × EMBEDDING_DIM. */
  matrix: Float32Array;
  /** Ordered list of cells aligned with rows of `matrix`. */
  cells: EOCell[];
  /** Model id the centroids were generated against. */
  model_version: string;
  /** Version tag; bumped each time centroids are regenerated. */
  centroid_version: string;
}

export interface AlignmentMatrix {
  /** Row-major DIM × DIM orthogonal rotation. */
  R: Float32Array;
  residual: number;
}

/** Raw record from `centroids.json`. */
interface RawCentroid {
  cell_id: string;
  cell_key: string;
  operator: string;
  vector: number[];
  [k: string]: unknown;
}

/**
 * Fetch centroids. Returns null if the file is missing — caller renders a
 * "centroids missing" banner rather than crashing.
 */
export async function loadCentroids(
  url = './nl/centroids.json',
): Promise<CentroidsBundle | null> {
  let raw: RawCentroid[];
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    raw = (await res.json()) as RawCentroid[];
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const dim = raw[0].vector?.length ?? EMBEDDING_DIM;
  if (dim !== EMBEDDING_DIM) {
    console.warn(`[nl] centroids dimension ${dim} ≠ expected ${EMBEDDING_DIM}`);
  }

  // Order rows by the canonical EO_CELLS order where we can; fall back to
  // the raw order for any record whose cell_id we do not recognize.
  const byId = new Map<string, RawCentroid>(raw.map((r) => [r.cell_id, r]));
  const orderedCells: EOCell[] = [];
  const orderedRaw: RawCentroid[] = [];
  for (const cell of EO_CELLS) {
    const r = byId.get(cell.cell_id);
    if (r) {
      orderedCells.push(cell);
      orderedRaw.push(r);
      byId.delete(cell.cell_id);
    }
  }
  // Any leftover raw records (new cells the frontend doesn't know yet) are
  // appended with a synthetic EOCell — classification still works by cell_id.
  for (const r of byId.values()) {
    orderedCells.push({
      cell_id: r.cell_id,
      cell_key: r.cell_key,
      operator: r.operator as EOCell['operator'],
      resolution: '',
      site: '',
      mode: 'Differentiating',
      domain: 'Existence',
      object: 'Condition',
    });
    orderedRaw.push(r);
  }

  const matrix = new Float32Array(orderedRaw.length * dim);
  for (let i = 0; i < orderedRaw.length; i++) {
    const v = orderedRaw[i].vector;
    matrix.set(v, i * dim);
  }
  return {
    matrix,
    cells: orderedCells,
    model_version: 'all-MiniLM-L6-v2',
    centroid_version: 'v1.0',
  };
}

export async function loadAlignment(
  url = './nl/alignment_matrix.json',
): Promise<AlignmentMatrix | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { R: number[][]; residual?: number };
    if (!Array.isArray(data.R) || data.R.length !== EMBEDDING_DIM) return null;
    const R = new Float32Array(EMBEDDING_DIM * EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      for (let j = 0; j < EMBEDDING_DIM; j++) {
        R[i * EMBEDDING_DIM + j] = data.R[i][j];
      }
    }
    return { R, residual: data.residual ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Apply the alignment rotation to a vector, in place (output allocated).
 * Returns a new Float32Array.
 */
export function applyAlignment(v: Float32Array, align: AlignmentMatrix): Float32Array {
  const dim = EMBEDDING_DIM;
  const out = new Float32Array(dim);
  const R = align.R;
  for (let j = 0; j < dim; j++) {
    let s = 0;
    for (let i = 0; i < dim; i++) s += v[i] * R[i * dim + j];
    out[j] = s;
  }
  // Renormalize.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) out[i] /= norm;
  return out;
}

/**
 * Cosine similarity between a query embedding and every centroid row.
 * Assumes both are L2-normalized (centroids from generate_centroids.py are).
 * Returns indices and scores sorted DESCENDING by score.
 */
export function rankAgainstCentroids(
  query: Float32Array,
  bundle: CentroidsBundle,
): Array<{ cell: EOCell; score: number }> {
  const dim = EMBEDDING_DIM;
  const n = bundle.cells.length;
  const scores = new Array<{ cell: EOCell; score: number }>(n);
  for (let i = 0; i < n; i++) {
    let dot = 0;
    const off = i * dim;
    for (let k = 0; k < dim; k++) dot += query[k] * bundle.matrix[off + k];
    scores[i] = { cell: bundle.cells[i], score: dot };
  }
  scores.sort((a, b) => b.score - a.score);
  return scores;
}
