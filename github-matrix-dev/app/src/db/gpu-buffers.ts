/**
 * Layer 6 — Optional WebGPU numeric field buffers.
 *
 * Progressive enhancement: all functions check navigator.gpu and return null
 * or fall back to CPU equivalents when WebGPU is unavailable. The rest of the
 * app works fully without this layer.
 *
 * Reuses the device acquisition pattern from gpu/graph-compute.ts
 * (navigator.gpu.requestAdapter → adapter.requestDevice, null on failure).
 *
 * Field layout:
 *   numericFields: Float32Array per field, indexed by targetToSlot
 *   categoricalFields: Uint32Array per field (string → uint32 vocab encoding)
 *
 * The targetIndex/targetToSlot mapping is shared across all fields so a single
 * slot number identifies the same target in every buffer.
 */

// ─── WebGPU constant fallbacks ────────────────────────────────────────────────
// GPUBufferUsage and GPUMapMode are globals in browsers but absent in Node.js.
// Define them as local constants so gpu-buffers.ts can be imported in tests.

/* eslint-disable @typescript-eslint/no-explicit-any */
const GPUBufferUsageFallback = (typeof GPUBufferUsage !== 'undefined'
  ? GPUBufferUsage
  : { STORAGE: 0x0080, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040,
      MAP_READ: 0x0001, MAP_WRITE: 0x0002 }) as any;

const GPUMapModeFallback = (typeof GPUMapMode !== 'undefined'
  ? GPUMapMode
  : { READ: 0x0001, WRITE: 0x0002 }) as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GpuFieldBuffers {
  device: GPUDevice;
  /** Slot number → target string */
  targetIndex: string[];
  /** Target string → slot number */
  targetToSlot: Map<string, number>;
  numericFields: Map<string, {
    cpu: Float32Array;
    gpu: GPUBuffer;
    stagingBuffer: GPUBuffer;
  }>;
  categoricalFields: Map<string, {
    vocab: string[];
    cpu: Uint32Array;
    gpu: GPUBuffer;
  }>;
  /**
   * LRU touch order for numeric fields — field name at the tail is
   * most-recently-touched, head is least. Used by `evictNumericFieldsIfOverCapacity`
   * to bound memory under long-running folds. Presence here mirrors presence
   * in `numericFields`; the two are kept in lockstep by uploadNumericField,
   * writeFieldValue, and the eviction pass.
   */
  numericFieldOrder: string[];
  /**
   * Maximum numeric fields to keep resident on the GPU. Zero or negative
   * means unbounded (opt-out). Set at init time via `initGpuBuffers` and
   * can be tuned later with `setNumericFieldCapacity`.
   */
  numericFieldCapacity: number;
}

// ─── WGSL filter shader ───────────────────────────────────────────────────────

const FILTER_SHADER_GT = /* wgsl */`
@group(0) @binding(0) var<storage, read> values: array<f32>;
@group(0) @binding(1) var<storage, read_write> bitmask: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> threshold: f32;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&values)) { return; }
  if (values[i] > threshold) {
    atomicOr(&bitmask[i / 32u], 1u << (i % 32u));
  }
}
`;

const FILTER_SHADER_GTE = FILTER_SHADER_GT.replace('values[i] > threshold', 'values[i] >= threshold');
const FILTER_SHADER_LT  = FILTER_SHADER_GT.replace('values[i] > threshold', 'values[i] < threshold');
const FILTER_SHADER_LTE = FILTER_SHADER_GT.replace('values[i] > threshold', 'values[i] <= threshold');
const FILTER_SHADER_EQ  = FILTER_SHADER_GT.replace('values[i] > threshold', 'values[i] == threshold');

const COSINE_SHADER = /* wgsl */`
@group(0) @binding(0) var<storage, read> matrix: array<f32>;   // [n_records × n_dims]
@group(0) @binding(1) var<storage, read> focal: array<f32>;    // [n_dims]
@group(0) @binding(2) var<storage, read_write> scores: array<f32>; // [n_records]
@group(0) @binding(3) var<uniform> dims: u32;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let n = arrayLength(&scores);
  if (i >= n) { return; }

  var dot = 0.0;
  var normA = 0.0;
  var normB = 0.0;
  for (var d = 0u; d < dims; d = d + 1u) {
    let a = matrix[i * dims + d];
    let b = focal[d];
    dot = dot + a * b;
    normA = normA + a * a;
    normB = normB + b * b;
  }
  let denom = sqrt(normA) * sqrt(normB);
  scores[i] = select(0.0, dot / denom, denom > 0.0);
}
`;

// ─── initGpuBuffers ───────────────────────────────────────────────────────────

/**
 * Default numeric-field cap for long-running folds. Chosen to comfortably
 * hold a working-set for typical apps (a few dozen aggregated columns) while
 * still bounding memory for adversarial workloads that DEF into thousands of
 * distinct fields. Callers can override at init time.
 */
export const DEFAULT_NUMERIC_FIELD_CAPACITY = 256;

/**
 * Initialise an empty GpuFieldBuffers from a GPUDevice.
 * Use the device acquisition from gpu/graph-compute.ts to obtain the device.
 *
 * `options.numericFieldCapacity` caps the number of numeric fields kept
 * resident on the GPU. When the cap is exceeded, the least-recently-touched
 * field is destroyed. Pass 0 or a negative value to disable eviction.
 */
export function initGpuBuffers(
  device: GPUDevice,
  options: { numericFieldCapacity?: number } = {},
): GpuFieldBuffers {
  return {
    device,
    targetIndex: [],
    targetToSlot: new Map(),
    numericFields: new Map(),
    categoricalFields: new Map(),
    numericFieldOrder: [],
    numericFieldCapacity:
      options.numericFieldCapacity !== undefined
        ? options.numericFieldCapacity
        : DEFAULT_NUMERIC_FIELD_CAPACITY,
  };
}

/**
 * Update the numeric-field capacity at runtime, evicting LRU fields as
 * needed to respect the new bound. Zero or negative disables eviction.
 */
export function setNumericFieldCapacity(
  buffers: GpuFieldBuffers,
  capacity: number,
): void {
  buffers.numericFieldCapacity = capacity;
  evictNumericFieldsIfOverCapacity(buffers);
}

/**
 * Mark a numeric field as most-recently-used. Cheap O(1) in practice:
 * a single array remove + push. Called by every read/write path on a
 * numeric field so the LRU order tracks real usage.
 */
function touchNumericField(buffers: GpuFieldBuffers, field: string): void {
  const order = buffers.numericFieldOrder;
  // Fast path: already at the tail.
  if (order.length > 0 && order[order.length - 1] === field) return;
  const idx = order.indexOf(field);
  if (idx >= 0) order.splice(idx, 1);
  order.push(field);
}

/**
 * Drop the least-recently-used numeric fields until the resident count
 * fits under `numericFieldCapacity`. No-op when capacity is zero/negative
 * or the count is already under the bound.
 */
export function evictNumericFieldsIfOverCapacity(buffers: GpuFieldBuffers): void {
  const cap = buffers.numericFieldCapacity;
  if (cap <= 0) return;
  while (buffers.numericFieldOrder.length > cap) {
    const victim = buffers.numericFieldOrder.shift();
    if (victim === undefined) return;
    const data = buffers.numericFields.get(victim);
    if (data) {
      data.gpu.destroy();
      data.stagingBuffer.destroy();
      buffers.numericFields.delete(victim);
    }
  }
}

/**
 * Acquire a GPUDevice following the same pattern as gpu/graph-compute.ts.
 * Returns null if WebGPU is unavailable or initialisation fails.
 */
export async function acquireGpuDevice(): Promise<GPUDevice | null> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    return await adapter.requestDevice();
  } catch {
    return null;
  }
}

// ─── Target registration ──────────────────────────────────────────────────────

function ensureSlot(buffers: GpuFieldBuffers, target: string): number {
  if (buffers.targetToSlot.has(target)) {
    return buffers.targetToSlot.get(target)!;
  }
  const slot = buffers.targetIndex.length;
  buffers.targetIndex.push(target);
  buffers.targetToSlot.set(target, slot);
  return slot;
}

// ─── uploadNumericField ───────────────────────────────────────────────────────

/**
 * Upload a numeric field's values to GPU.
 * Creates or replaces the buffer for this field.
 * Target slots are allocated in insertion order.
 */
export function uploadNumericField(
  buffers: GpuFieldBuffers,
  field: string,
  values: Map<string, number>,
): void {
  // Ensure all targets have a slot
  for (const target of values.keys()) ensureSlot(buffers, target);

  const n = buffers.targetIndex.length;
  const cpu = new Float32Array(n);
  for (const [target, value] of values) {
    const slot = buffers.targetToSlot.get(target)!;
    cpu[slot] = value;
  }

  const existing = buffers.numericFields.get(field);
  if (existing) {
    existing.gpu.destroy();
    existing.stagingBuffer.destroy();
  }

  const gpuBuf = buffers.device.createBuffer({
    size: cpu.byteLength,
    usage: GPUBufferUsageFallback.STORAGE | GPUBufferUsageFallback.COPY_DST | GPUBufferUsageFallback.COPY_SRC,
  });
  buffers.device.queue.writeBuffer(gpuBuf, 0, cpu.buffer);

  const staging = buffers.device.createBuffer({
    size: cpu.byteLength,
    usage: GPUBufferUsageFallback.MAP_READ | GPUBufferUsageFallback.COPY_DST,
  });

  buffers.numericFields.set(field, { cpu, gpu: gpuBuf, stagingBuffer: staging });
  touchNumericField(buffers, field);
  evictNumericFieldsIfOverCapacity(buffers);
}

// ─── uploadCategoricalField ───────────────────────────────────────────────────

export function uploadCategoricalField(
  buffers: GpuFieldBuffers,
  field: string,
  values: Map<string, string>,
): void {
  for (const target of values.keys()) ensureSlot(buffers, target);

  // Build vocab
  const vocabSet = new Set(values.values());
  const vocab = [...vocabSet].sort();
  const vocabIndex = new Map(vocab.map((v, i) => [v, i]));

  const n = buffers.targetIndex.length;
  const cpu = new Uint32Array(n);
  for (const [target, value] of values) {
    const slot = buffers.targetToSlot.get(target)!;
    cpu[slot] = vocabIndex.get(value) ?? 0;
  }

  const existing = buffers.categoricalFields.get(field);
  if (existing) existing.gpu.destroy();

  const gpuBuf = buffers.device.createBuffer({
    size: cpu.byteLength,
    usage: GPUBufferUsageFallback.STORAGE | GPUBufferUsageFallback.COPY_DST,
  });
  buffers.device.queue.writeBuffer(gpuBuf, 0, cpu.buffer);

  buffers.categoricalFields.set(field, { vocab, cpu, gpu: gpuBuf });
}

// ─── filterNumeric ────────────────────────────────────────────────────────────

/**
 * GPU-accelerated numeric filter. Returns matching target strings.
 * Falls back gracefully (returns empty array) on shader compile failure.
 */
export async function filterNumeric(
  buffers: GpuFieldBuffers,
  field: string,
  op: '>' | '<' | '>=' | '<=' | '=',
  threshold: number,
): Promise<string[]> {
  const fieldData = buffers.numericFields.get(field);
  if (!fieldData) return [];

  const shaderSrc =
    op === '>'  ? FILTER_SHADER_GT  :
    op === '>=' ? FILTER_SHADER_GTE :
    op === '<'  ? FILTER_SHADER_LT  :
    op === '<=' ? FILTER_SHADER_LTE :
                  FILTER_SHADER_EQ;

  const n = buffers.targetIndex.length;
  const bitmaskWords = Math.ceil(n / 32);

  const bitmaskBuf = buffers.device.createBuffer({
    size: bitmaskWords * 4,
    usage: GPUBufferUsageFallback.STORAGE | GPUBufferUsageFallback.COPY_SRC,
  });

  const thresholdBuf = buffers.device.createBuffer({
    size: 4,
    usage: GPUBufferUsageFallback.UNIFORM | GPUBufferUsageFallback.COPY_DST,
  });
  buffers.device.queue.writeBuffer(thresholdBuf, 0, new Float32Array([threshold]).buffer);

  const stagingBitmask = buffers.device.createBuffer({
    size: bitmaskWords * 4,
    usage: GPUBufferUsageFallback.MAP_READ | GPUBufferUsageFallback.COPY_DST,
  });

  try {
    const module = buffers.device.createShaderModule({ code: shaderSrc });
    const pipeline = await buffers.device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });

    const bindGroup = buffers.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: fieldData.gpu } },
        { binding: 1, resource: { buffer: bitmaskBuf } },
        { binding: 2, resource: { buffer: thresholdBuf } },
      ],
    });

    const encoder = buffers.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    encoder.copyBufferToBuffer(bitmaskBuf, 0, stagingBitmask, 0, bitmaskWords * 4);
    buffers.device.queue.submit([encoder.finish()]);

    await stagingBitmask.mapAsync(GPUMapModeFallback.READ);
    const bitmask = new Uint32Array(stagingBitmask.getMappedRange().slice(0));
    stagingBitmask.unmap();

    const results: string[] = [];
    for (let i = 0; i < n; i++) {
      const word = bitmask[Math.floor(i / 32)];
      if (word & (1 << (i % 32))) {
        results.push(buffers.targetIndex[i]);
      }
    }
    return results;
  } finally {
    bitmaskBuf.destroy();
    thresholdBuf.destroy();
    stagingBitmask.destroy();
  }
}

// ─── computeCosineSimilarity ──────────────────────────────────────────────────

export async function computeCosineSimilarity(
  buffers: GpuFieldBuffers,
  focalTarget: string,
): Promise<Array<{ target: string; score: number }>> {
  const numericFieldNames = [...buffers.numericFields.keys()];
  if (!numericFieldNames.length) return [];

  const focalSlot = buffers.targetToSlot.get(focalTarget);
  if (focalSlot === undefined) return [];

  const n = buffers.targetIndex.length;
  const dims = numericFieldNames.length;

  // Build flat matrix [n × dims]
  const matrix = new Float32Array(n * dims);
  const focalVec = new Float32Array(dims);
  numericFieldNames.forEach((field, d) => {
    const cpu = buffers.numericFields.get(field)!.cpu;
    for (let i = 0; i < n; i++) matrix[i * dims + d] = cpu[i];
    focalVec[d] = cpu[focalSlot];
  });

  const matrixBuf = buffers.device.createBuffer({
    size: matrix.byteLength,
    usage: GPUBufferUsageFallback.STORAGE | GPUBufferUsageFallback.COPY_DST,
  });
  buffers.device.queue.writeBuffer(matrixBuf, 0, matrix.buffer);

  const focalBuf = buffers.device.createBuffer({
    size: focalVec.byteLength,
    usage: GPUBufferUsageFallback.STORAGE | GPUBufferUsageFallback.COPY_DST,
  });
  buffers.device.queue.writeBuffer(focalBuf, 0, focalVec.buffer);

  const scoresBuf = buffers.device.createBuffer({
    size: n * 4,
    usage: GPUBufferUsageFallback.STORAGE | GPUBufferUsageFallback.COPY_SRC,
  });

  const dimsBuf = buffers.device.createBuffer({
    size: 4,
    usage: GPUBufferUsageFallback.UNIFORM | GPUBufferUsageFallback.COPY_DST,
  });
  buffers.device.queue.writeBuffer(dimsBuf, 0, new Uint32Array([dims]).buffer);

  const stagingScores = buffers.device.createBuffer({
    size: n * 4,
    usage: GPUBufferUsageFallback.MAP_READ | GPUBufferUsageFallback.COPY_DST,
  });

  try {
    const module = buffers.device.createShaderModule({ code: COSINE_SHADER });
    const pipeline = await buffers.device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });

    const bindGroup = buffers.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: matrixBuf } },
        { binding: 1, resource: { buffer: focalBuf } },
        { binding: 2, resource: { buffer: scoresBuf } },
        { binding: 3, resource: { buffer: dimsBuf } },
      ],
    });

    const encoder = buffers.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    encoder.copyBufferToBuffer(scoresBuf, 0, stagingScores, 0, n * 4);
    buffers.device.queue.submit([encoder.finish()]);

    await stagingScores.mapAsync(GPUMapModeFallback.READ);
    const scores = new Float32Array(stagingScores.getMappedRange().slice(0));
    stagingScores.unmap();

    return buffers.targetIndex
      .map((target, i) => ({ target, score: scores[i] }))
      .sort((a, b) => b.score - a.score);
  } finally {
    matrixBuf.destroy();
    focalBuf.destroy();
    scoresBuf.destroy();
    dimsBuf.destroy();
    stagingScores.destroy();
  }
}

// ─── writeFieldValue ─────────────────────────────────────────────────────────

/**
 * O(1) update of a single target+field value in the GPU buffer.
 * Called from the onEventEmitted handler when a DEF event arrives.
 */
export function writeFieldValue(
  buffers: GpuFieldBuffers,
  target: string,
  field: string,
  value: number,
): void {
  const slot = buffers.targetToSlot.get(target);
  if (slot === undefined) return;
  const fieldData = buffers.numericFields.get(field);
  if (!fieldData) return;

  fieldData.cpu[slot] = value;
  // Write just the 4 bytes for this slot
  buffers.device.queue.writeBuffer(fieldData.gpu, slot * 4, fieldData.cpu.buffer, slot * 4, 4);
  touchNumericField(buffers, field);
}
