/**
 * Main-thread facade over the classifier worker pool.
 *
 * Contract:
 *   - initClassifier() lazily boots one worker, probes backends, reports
 *     readiness. Subsequent calls no-op.
 *   - classifyBatch(texts) returns per-clause top-3 + confidence gap.
 *   - Centroid lookup happens on the main thread (flat Float32Array from
 *     centroids-loader), so the worker only has to embed.
 *
 * Why main-thread centroid lookup: the embedding forward pass is 3+ orders
 * of magnitude more expensive than a 27×384 dot product. Keeping the
 * centroid matrix in one place lets us swap centroid versions without
 * restarting the worker.
 */

import {
  loadCentroids,
  loadAlignment,
  rankAgainstCentroids,
  applyAlignment,
  EMBEDDING_DIM,
  type CentroidsBundle,
  type AlignmentMatrix,
} from './centroids-loader';
import type { EOCell } from './eo-cells';

export type BackendKind = 'webgpu' | 'wasm-threads' | 'wasm' | 'none';

export interface ClassifierStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  backend: BackendKind;
  progress: number; // 0-1 during model download
  message?: string;
  centroidCount: number;
}

export type ResolutionTier = 'paragraph' | 'sentence' | 'clause';

export interface Classification {
  clause_ix: number;
  cell_id: string;
  cell_key: string;
  operator: string;
  site: string;
  resolution: string;
  mode: string;
  domain: string;
  confidence_gap: number;
  similarity_profile: Array<{ cell_id: string; score: number }>;
  flags: string[];
  script: string;
  /**
   * Which lattice position this classification was made from. Added for
   * Document Explorer: the same text classified at paragraph vs clause
   * tier answers different questions (what is this about / what changed
   * what). Optional so legacy callers keep compiling.
   */
  resolution_tier?: ResolutionTier;
}

const CONFIDENCE_THRESHOLD: Record<string, number> = {
  latin: 0.08,
  cyrillic: 0.06,
  arabic: 0.04,
  devanagari: 0.04,
  cjk: 0.04,
  default: 0.05,
};

let _worker: Worker | null = null;
let _status: ClassifierStatus = {
  state: 'idle',
  backend: 'none',
  progress: 0,
  centroidCount: 0,
};
let _centroids: CentroidsBundle | null = null;
let _alignment: AlignmentMatrix | null = null;
let _initPromise: Promise<ClassifierStatus> | null = null;
const _statusListeners = new Set<(s: ClassifierStatus) => void>();

function updateStatus(patch: Partial<ClassifierStatus>): void {
  _status = { ..._status, ...patch };
  for (const cb of _statusListeners) cb(_status);
}

export function getClassifierStatus(): ClassifierStatus {
  return _status;
}

export function subscribeClassifierStatus(
  cb: (s: ClassifierStatus) => void,
): () => void {
  _statusListeners.add(cb);
  return () => _statusListeners.delete(cb);
}

/**
 * Probe WebGPU availability without touching transformers.js.
 * transformers.js's WebGPU backend still falls back to wasm on its own,
 * but we want to report the chosen backend accurately.
 */
async function probeBackend(): Promise<BackendKind> {
  // 1. WebGPU via the navigator API.
  const nav = navigator as unknown as {
    gpu?: { requestAdapter(): Promise<unknown> };
  };
  if (nav.gpu?.requestAdapter) {
    try {
      const adapter = await nav.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    } catch {
      /* fall through */
    }
  }
  // 2. wasm threads require crossOriginIsolated (COOP/COEP).
  if (typeof crossOriginIsolated === 'boolean' && crossOriginIsolated) {
    return 'wasm-threads';
  }
  return 'wasm';
}

/**
 * Lazy-boot the classifier. Safe to call multiple times; only the first call
 * does real work.
 */
export function initClassifier(): Promise<ClassifierStatus> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    updateStatus({ state: 'loading', progress: 0, message: 'loading centroids' });
    _centroids = await loadCentroids();
    _alignment = await loadAlignment();
    if (!_centroids) {
      updateStatus({
        state: 'error',
        message: 'centroids.json missing — run: python nl/generate_centroids.py',
      });
      return _status;
    }
    updateStatus({ centroidCount: _centroids.cells.length });

    const backend = await probeBackend();
    updateStatus({ backend, progress: 0.1, message: `booting worker (${backend})` });

    try {
      // Dynamic URL import — Vite resolves this at build time and emits a
      // separate chunk for the worker module.
      _worker = new Worker(
        new URL('./classifier.worker.ts', import.meta.url),
        { type: 'module' },
      );
    } catch (err) {
      updateStatus({
        state: 'error',
        message: `worker boot failed: ${(err as Error).message}`,
      });
      return _status;
    }

    const ready = await new Promise<boolean>((resolve) => {
      if (!_worker) return resolve(false);
      const onMsg = (ev: MessageEvent<any>) => {
        const d = ev.data;
        if (d?.type === 'progress') {
          updateStatus({ progress: d.progress ?? 0, message: d.message });
        } else if (d?.type === 'ready') {
          _worker?.removeEventListener('message', onMsg);
          resolve(true);
        } else if (d?.type === 'error') {
          updateStatus({ state: 'error', message: d.message });
          _worker?.removeEventListener('message', onMsg);
          resolve(false);
        }
      };
      _worker.addEventListener('message', onMsg);
      _worker.postMessage({ type: 'init', backend });
    });

    if (!ready) {
      return _status;
    }
    updateStatus({ state: 'ready', progress: 1, message: `ready (${backend})` });
    return _status;
  })();
  return _initPromise;
}

/**
 * Embed a batch of texts via the worker; classify each against the
 * centroid matrix on the main thread.
 */
export async function classifyBatch(
  texts: string[],
  script: string,
): Promise<Classification[]> {
  const result = await classifyBatchWithEmbeddings(texts, script);
  return result.classifications;
}

/**
 * Like classifyBatch, but returns the per-text embedding alongside the
 * classification. Used by the ingest pipeline so the same forward pass
 * produces both the classification and the cached vector — no double work.
 */
export async function classifyBatchWithEmbeddings(
  texts: string[],
  script: string,
): Promise<{ classifications: Classification[]; embeddings: Float32Array[] }> {
  if (!_worker || _status.state !== 'ready' || !_centroids) {
    throw new Error('Classifier not ready; call initClassifier() first');
  }
  const flat = await embedBatchFlat(texts);
  const dim = EMBEDDING_DIM;
  const out: Classification[] = [];
  const vectors: Float32Array[] = [];
  const threshold = CONFIDENCE_THRESHOLD[script] ?? CONFIDENCE_THRESHOLD.default;
  for (let i = 0; i < texts.length; i++) {
    let query: Float32Array = new Float32Array(dim);
    for (let k = 0; k < dim; k++) query[k] = flat[i * dim + k];
    if (_alignment) {
      query = applyAlignment(query, _alignment);
    }
    vectors.push(query);
    const ranked = rankAgainstCentroids(query, _centroids);
    const top = ranked[0];
    const gap = top.score - (ranked[1]?.score ?? 0);
    const flags: string[] = [];
    if (gap < threshold) flags.push('boundary');
    if (script !== 'latin' && gap < 0.08) flags.push('low_confidence_nolatin');
    out.push({
      clause_ix: i,
      cell_id: top.cell.cell_id,
      cell_key: top.cell.cell_key,
      operator: top.cell.operator,
      site: top.cell.site,
      resolution: top.cell.resolution,
      mode: top.cell.mode,
      domain: top.cell.domain,
      confidence_gap: Number(gap.toFixed(4)),
      similarity_profile: ranked.slice(0, 5).map((r) => ({
        cell_id: r.cell.cell_id,
        score: Number(r.score.toFixed(4)),
      })),
      flags,
      script,
    });
  }
  return { classifications: out, embeddings: vectors };
}

/**
 * Public single-text embed. Used by the query path: only the query needs
 * embedding, no centroid ranking.
 */
export async function embedQuery(text: string): Promise<Float32Array> {
  if (!_worker || _status.state !== 'ready') {
    throw new Error('Classifier not ready; call initClassifier() first');
  }
  const flat = await embedBatchFlat([text]);
  const dim = EMBEDDING_DIM;
  // Typed as the loose variant so re-assignment to applyAlignment's return
  // value doesn't trip TS strict's ArrayBuffer / ArrayBufferLike split.
  let vec: Float32Array<ArrayBufferLike> = new Float32Array(dim);
  for (let k = 0; k < dim; k++) vec[k] = flat[k];
  if (_alignment) vec = applyAlignment(vec, _alignment);
  return vec as Float32Array;
}

/** Round-trip to the worker for embeddings. Returns a flat Float32Array. */
function embedBatchFlat(texts: string[]): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (!_worker) return reject(new Error('No classifier worker'));
    const requestId = Math.random().toString(36).slice(2);
    const onMsg = (ev: MessageEvent<any>) => {
      const d = ev.data;
      if (d?.type !== 'embed:result' || d.requestId !== requestId) return;
      _worker?.removeEventListener('message', onMsg);
      if (d.error) return reject(new Error(d.error));
      resolve(new Float32Array(d.embeddings as ArrayBuffer));
    };
    _worker.addEventListener('message', onMsg);
    _worker.postMessage({ type: 'embed', requestId, texts });
  });
}

export function getCentroids(): CentroidsBundle | null {
  return _centroids;
}
