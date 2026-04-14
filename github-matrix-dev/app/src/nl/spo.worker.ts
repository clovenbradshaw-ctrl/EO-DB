/**
 * SPO (Subject–Predicate–Object) extraction worker.
 *
 * Uses the REBEL seq2seq model (`Babelscape/rebel-large`) via @xenova/transformers
 * to decompose a clause into one or more {subject, predicate, object} triples.
 * REBEL emits a flat string like:
 *
 *   <triplet> Secretary <subj> permit <obj> revokes
 *   <triplet> Secretary <subj> 30 days <obj> has deadline
 *
 * which we parse into structured triples and send back to the main thread,
 * where spo-extractor.ts re-locates subject/object surface strings inside the
 * clause to recover char spans.
 *
 * Protocol (mirrors classifier.worker.ts):
 *   main → worker: { type: 'init', backend }
 *   worker → main: { type: 'progress', progress, message }
 *   worker → main: { type: 'ready' } | { type: 'error', message }
 *
 *   main → worker: { type: 'extract', requestId, texts }
 *   worker → main: { type: 'extract:result', requestId, triples: RawTriple[][] }
 *
 * The REBEL model is large (~500MB fp32 / ~150MB quantized). First load blocks
 * on a HuggingFace CDN download — progress is forwarded up to the UI. Subsequent
 * loads hit the transformers.js IndexedDB cache.
 */

export {}; // treat as module for TS

declare const self: DedicatedWorkerGlobalScope;

const MODEL_ID = 'Xenova/rebel-large';
const BATCH_SIZE = 4;
const MAX_LENGTH = 256;

/** A single parsed triple as emitted by the REBEL decoder. Spans are resolved on the main thread. */
export interface RawTriple {
  subject: string;
  predicate: string;
  object: string;
}

let _pipeline: any = null;
let _ready = false;

async function handleInit(backend: string): Promise<void> {
  try {
    postMessage({ type: 'progress', progress: 0.1, message: 'loading transformers.js' });
    // @ts-expect-error — optional runtime dependency; present only after
    // `npm install @xenova/transformers`. The worker reports an error cleanly
    // rather than crashing if the module is absent.
    const tfjs: any = await import('@xenova/transformers').catch(() => null);
    if (!tfjs) {
      postMessage({
        type: 'error',
        message: '@xenova/transformers not installed — run: npm i @xenova/transformers',
      });
      return;
    }
    postMessage({
      type: 'progress',
      progress: 0.3,
      message: `downloading ${MODEL_ID}`,
    });
    const pipelineFn = tfjs.pipeline;
    if (!pipelineFn) {
      postMessage({ type: 'error', message: 'transformers.js: no pipeline export' });
      return;
    }
    _pipeline = await pipelineFn('text2text-generation', MODEL_ID, {
      quantized: true,
      device: backend === 'webgpu' ? 'webgpu' : 'wasm',
      progress_callback: (p: any) => {
        if (typeof p?.progress === 'number') {
          postMessage({
            type: 'progress',
            progress: 0.3 + 0.7 * (p.progress / 100),
            message: p.status ?? 'downloading',
          });
        }
      },
    });
    _ready = true;
    postMessage({ type: 'ready' });
  } catch (err) {
    postMessage({
      type: 'error',
      message: `init failed: ${(err as Error).message ?? String(err)}`,
    });
  }
}

/**
 * Parse the REBEL decoder output into structured triples.
 *
 * The REBEL token format, per the original paper's `extract_triplets` helper,
 * uses three sentinel tokens:
 *   <triplet> begins a triple — following tokens are the subject
 *   <subj>    transitions from subject accumulation to object accumulation
 *   <obj>     transitions from object accumulation to predicate (relation)
 *             accumulation; the next <triplet> (or end-of-string) commits it
 *
 * Any tokens emitted before a <triplet> sentinel are discarded. A trailing
 * triple that reaches end-of-string without a new <triplet> is still committed.
 */
function parseRebelOutput(raw: string): RawTriple[] {
  const triples: RawTriple[] = [];
  const cleaned = raw
    .replaceAll('<s>', '')
    .replaceAll('<pad>', '')
    .replaceAll('</s>', '')
    .trim();
  let subject = '';
  let object_ = '';
  let predicate = '';
  let current: 'none' | 't' | 's' | 'o' = 'none';
  const commit = () => {
    const s = subject.trim();
    const p = predicate.trim();
    const o = object_.trim();
    if (s && p && o) triples.push({ subject: s, predicate: p, object: o });
  };
  for (const token of cleaned.split(/\s+/)) {
    if (!token) continue;
    if (token === '<triplet>') {
      if (current !== 'none') commit();
      subject = '';
      object_ = '';
      predicate = '';
      current = 't';
    } else if (token === '<subj>') {
      current = 's';
    } else if (token === '<obj>') {
      current = 'o';
    } else {
      if (current === 't') subject += ' ' + token;
      else if (current === 's') object_ += ' ' + token;
      else if (current === 'o') predicate += ' ' + token;
    }
  }
  if (current !== 'none') commit();
  return triples;
}

async function handleExtract(requestId: string, texts: string[]): Promise<void> {
  if (!_ready || !_pipeline) {
    postMessage({ type: 'extract:result', requestId, error: 'extractor not ready' });
    return;
  }
  try {
    const results: RawTriple[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const slice = texts.slice(i, i + BATCH_SIZE);
      // text2text-generation returns one or more { generated_text } objects per
      // input. We call the pipeline once per clause to get deterministic
      // per-input output (batched generation in transformers.js can collapse
      // variable-length outputs awkwardly).
      for (const text of slice) {
        try {
          const out = await _pipeline(text, {
            max_length: MAX_LENGTH,
            num_beams: 3,
            length_penalty: 0,
            early_stopping: true,
          });
          const first = Array.isArray(out) ? out[0] : out;
          const decoded: string = first?.generated_text ?? '';
          results.push(parseRebelOutput(decoded));
        } catch {
          results.push([]);
        }
      }
    }
    postMessage({ type: 'extract:result', requestId, triples: results });
  } catch (err) {
    postMessage({
      type: 'extract:result',
      requestId,
      error: `extract failed: ${(err as Error).message ?? String(err)}`,
    });
  }
}

self.addEventListener('message', (ev: MessageEvent<any>) => {
  const d = ev.data;
  if (d?.type === 'init') {
    void handleInit(d.backend ?? 'wasm');
  } else if (d?.type === 'extract') {
    void handleExtract(d.requestId, d.texts);
  }
});

declare function postMessage(message: any, transfer?: Transferable[]): void;
