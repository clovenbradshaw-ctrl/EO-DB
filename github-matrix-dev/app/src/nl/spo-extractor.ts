/**
 * Main-thread facade for the SPO extractor worker.
 *
 * Shape mirrors eo-classifier.ts:
 *   - initSpoExtractor() lazily boots the worker; subsequent calls no-op.
 *   - extractTriples(clauses) runs REBEL over latin-script clauses and
 *     returns structured triples with char-spans re-located against the
 *     original clause text.
 *
 * Non-latin clauses are skipped with a flag rather than routed through the
 * model — REBEL (English variant) produces noise on other scripts, and a
 * multilingual upgrade (mrebel-large) is a drop-in future swap.
 */

import type { RawClause } from './clause-extractor';

export type SpoBackendKind = 'webgpu' | 'wasm-threads' | 'wasm' | 'none';

export interface SpoExtractorStatus {
  state: 'idle' | 'loading' | 'ready' | 'error' | 'disabled';
  backend: SpoBackendKind;
  progress: number; // 0-1 during model download
  message?: string;
}

/** Raw triple as decoded from the REBEL worker, before span resolution. */
export interface RawTriple {
  subject: string;
  predicate: string;
  object: string;
}

/** Triple with char-spans resolved against the source clause text. */
export interface ExtractedTriple {
  clause_ix: number;
  triple_ix: number;
  subject: string;
  predicate: string;
  object: string;
  /** [start, end) char offsets within the clause text. -1 when not found. */
  subj_span: [number, number];
  obj_span: [number, number];
  /** Heuristic confidence: 1 if both subj and obj are located inside the clause, 0.5 if one, 0 if neither. */
  confidence: number;
  /** Flags raised during extraction (e.g. 'subject_not_found'). */
  flags: string[];
}

let _worker: Worker | null = null;
let _status: SpoExtractorStatus = {
  state: 'idle',
  backend: 'none',
  progress: 0,
};
let _initPromise: Promise<SpoExtractorStatus> | null = null;
const _statusListeners = new Set<(s: SpoExtractorStatus) => void>();

function updateStatus(patch: Partial<SpoExtractorStatus>): void {
  _status = { ..._status, ...patch };
  for (const cb of _statusListeners) cb(_status);
}

export function getSpoExtractorStatus(): SpoExtractorStatus {
  return _status;
}

export function subscribeSpoExtractorStatus(
  cb: (s: SpoExtractorStatus) => void,
): () => void {
  _statusListeners.add(cb);
  return () => _statusListeners.delete(cb);
}

async function probeBackend(): Promise<SpoBackendKind> {
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
  if (typeof crossOriginIsolated === 'boolean' && crossOriginIsolated) {
    return 'wasm-threads';
  }
  return 'wasm';
}

/**
 * Lazy-boot the SPO extractor. Safe to call multiple times; only the first
 * call does real work. If the caller has disabled SPO via preferences, call
 * `setSpoExtractorDisabled(true)` before init to avoid the model download.
 */
export function initSpoExtractor(): Promise<SpoExtractorStatus> {
  if (_initPromise) return _initPromise;
  if (_status.state === 'disabled') return Promise.resolve(_status);
  _initPromise = (async () => {
    const backend = await probeBackend();
    updateStatus({
      state: 'loading',
      backend,
      progress: 0.05,
      message: `booting SPO worker (${backend})`,
    });

    try {
      _worker = new Worker(
        new URL('./spo.worker.ts', import.meta.url),
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

    if (!ready) return _status;
    updateStatus({ state: 'ready', progress: 1, message: `ready (${backend})` });
    return _status;
  })();
  return _initPromise;
}

/** Opt-out: mark the extractor disabled so we never spawn the worker. */
export function setSpoExtractorDisabled(disabled: boolean): void {
  if (disabled) {
    updateStatus({ state: 'disabled', progress: 0, message: 'disabled' });
  } else if (_status.state === 'disabled') {
    updateStatus({ state: 'idle', progress: 0, message: undefined });
  }
}

/**
 * Locate a surface string inside the clause text. Case-insensitive on first
 * pass, falling back to a token-containment heuristic so that light normalization
 * differences between REBEL output and source text don't destroy spans.
 *
 * Returns [-1, -1] when no reasonable match is found.
 */
function locateSpan(clause: string, needle: string): [number, number] {
  if (!needle) return [-1, -1];
  const direct = clause.indexOf(needle);
  if (direct >= 0) return [direct, direct + needle.length];
  const ci = clause.toLowerCase().indexOf(needle.toLowerCase());
  if (ci >= 0) return [ci, ci + needle.length];
  // Token fallback: find the first token of the needle in the clause.
  const firstTok = needle.split(/\s+/)[0];
  if (firstTok && firstTok.length >= 3) {
    const tokIdx = clause.toLowerCase().indexOf(firstTok.toLowerCase());
    if (tokIdx >= 0) {
      const end = Math.min(clause.length, tokIdx + needle.length);
      return [tokIdx, end];
    }
  }
  return [-1, -1];
}

/** Round-trip to the worker for triples. Returns one RawTriple[] per input clause. */
function extractBatch(texts: string[]): Promise<RawTriple[][]> {
  return new Promise((resolve, reject) => {
    if (!_worker) return reject(new Error('No SPO worker'));
    const requestId = Math.random().toString(36).slice(2);
    const onMsg = (ev: MessageEvent<any>) => {
      const d = ev.data;
      if (d?.type !== 'extract:result' || d.requestId !== requestId) return;
      _worker?.removeEventListener('message', onMsg);
      if (d.error) return reject(new Error(d.error));
      resolve((d.triples ?? []) as RawTriple[][]);
    };
    _worker.addEventListener('message', onMsg);
    _worker.postMessage({ type: 'extract', requestId, texts });
  });
}

/**
 * Extract triples from a set of clauses. Non-latin-script clauses are skipped
 * and contribute an empty triple list to the output (aligned by clause_ix).
 *
 * Output is a flat array of triples tagged with clause_ix — the caller can
 * group by clause_ix to reassemble per-clause lists.
 */
export async function extractTriples(
  clauses: RawClause[],
): Promise<ExtractedTriple[]> {
  if (!_worker || _status.state !== 'ready') {
    throw new Error('SPO extractor not ready; call initSpoExtractor() first');
  }
  const eligible: RawClause[] = clauses.filter((c) => c.script === 'latin');
  if (eligible.length === 0) return [];
  const rawPerClause = await extractBatch(eligible.map((c) => c.text));
  const out: ExtractedTriple[] = [];
  for (let i = 0; i < eligible.length; i++) {
    const clause = eligible[i];
    const raws = rawPerClause[i] ?? [];
    for (let j = 0; j < raws.length; j++) {
      const r = raws[j];
      const subj_span = locateSpan(clause.text, r.subject);
      const obj_span = locateSpan(clause.text, r.object);
      const subjFound = subj_span[0] >= 0;
      const objFound = obj_span[0] >= 0;
      const flags: string[] = [];
      if (!subjFound) flags.push('subject_not_found');
      if (!objFound) flags.push('object_not_found');
      out.push({
        clause_ix: clause.clause_ix,
        triple_ix: j,
        subject: r.subject,
        predicate: r.predicate,
        object: r.object,
        subj_span,
        obj_span,
        confidence: (subjFound ? 0.5 : 0) + (objFound ? 0.5 : 0),
        flags,
      });
    }
  }
  return out;
}
