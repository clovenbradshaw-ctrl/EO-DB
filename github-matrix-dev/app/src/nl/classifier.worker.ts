/**
 * Classifier worker — embeds batches of text via @xenova/transformers.
 *
 * Protocol:
 *   main → worker: { type: 'init', backend }
 *   worker → main: { type: 'progress', progress, message }
 *   worker → main: { type: 'ready' } | { type: 'error', message }
 *
 *   main → worker: { type: 'embed', requestId, texts }
 *   worker → main: { type: 'embed:result', requestId, embeddings: ArrayBuffer }
 *
 * The embedding matrix is sent back as a single Float32Array buffer
 * (transferred, not copied). Centroid lookup happens on the main thread.
 *
 * The @xenova/transformers dependency is dynamically imported at init time
 * so it does NOT land in the main bundle. The first init() call triggers a
 * model download (~27 MB, int8 quantized, cached in IndexedDB by the library).
 */

export {}; // treat as module for TS

declare const self: DedicatedWorkerGlobalScope;

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const BATCH_SIZE = 64;
const MAX_TOKENS = 128;

let _pipeline: any = null;
let _ready = false;

async function handleInit(backend: string): Promise<void> {
  try {
    postMessage({ type: 'progress', progress: 0.1, message: 'loading transformers.js' });
    // @ts-expect-error — optional runtime dependency; present only after
    // `npm install @xenova/transformers`. The worker reports an error
    // cleanly rather than crashing if the module is absent.
    const tfjs: any = await import('@xenova/transformers').catch(() => null);
    if (!tfjs) {
      postMessage({
        type: 'error',
        message:
          '@xenova/transformers not installed — run: npm i @xenova/transformers',
      });
      return;
    }
    // Try to force WebGPU if requested.
    if (backend === 'webgpu' && tfjs.env?.backends?.onnx) {
      try {
        tfjs.env.backends.onnx.wasm ??= {};
        // Hint transformers.js that we want WebGPU when available.
        tfjs.env.allowLocalModels = false;
      } catch {
        /* fall through to default backend selection */
      }
    }
    postMessage({
      type: 'progress',
      progress: 0.3,
      message: `downloading ${MODEL_ID} (int8)`,
    });
    const pipelineFn = tfjs.pipeline;
    if (!pipelineFn) {
      postMessage({ type: 'error', message: 'transformers.js: no pipeline export' });
      return;
    }
    _pipeline = await pipelineFn('feature-extraction', MODEL_ID, {
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

async function handleEmbed(requestId: string, texts: string[]): Promise<void> {
  if (!_ready || !_pipeline) {
    postMessage({ type: 'embed:result', requestId, error: 'classifier not ready' });
    return;
  }
  try {
    const dim = 384;
    const out = new Float32Array(texts.length * dim);
    // Batch through the pipeline. transformers.js accepts arrays and does
    // its own internal batching, but we cap at BATCH_SIZE to give progress
    // back and to keep memory bounded.
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const slice = texts.slice(i, i + BATCH_SIZE).map((t) =>
        t.length > MAX_TOKENS * 6 ? t.slice(0, MAX_TOKENS * 6) : t,
      );
      const result = await _pipeline(slice, {
        pooling: 'mean',
        normalize: true,
      });
      // result is a Tensor with .data as Float32Array of shape [n, dim].
      const data: Float32Array = result.data;
      out.set(data, i * dim);
    }
    const buf = out.buffer;
    postMessage({ type: 'embed:result', requestId, embeddings: buf }, [buf]);
  } catch (err) {
    postMessage({
      type: 'embed:result',
      requestId,
      error: `embed failed: ${(err as Error).message ?? String(err)}`,
    });
  }
}

self.addEventListener('message', (ev: MessageEvent<any>) => {
  const d = ev.data;
  if (d?.type === 'init') {
    void handleInit(d.backend ?? 'wasm');
  } else if (d?.type === 'embed') {
    void handleEmbed(d.requestId, d.texts);
  }
});

declare function postMessage(message: any, transfer?: Transferable[]): void;
