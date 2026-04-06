/**
 * GPU-accelerated graph operations via WebGPU compute shaders.
 *
 * Falls back to CPU equivalents in graph-store.ts when WebGPU is unavailable.
 * The unified API (graphBFS, graphComponents, graphCentrality) transparently
 * picks the best backend.
 *
 * Strategy:
 *   BFS — Two-buffer ping-pong frontier expansion. Each invocation processes
 *          one depth level in parallel.
 *   Components — Iterative label propagation until convergence.
 *   Centrality — Degree centrality from CSR offsets (O(n), trivial).
 */

import type { CSRGraph } from '../db/graph-store';
import { bfs, bfsIndices, connectedComponents } from '../db/graph-store';

// ─── Types ──────────────────────────────────────────────────────────────

export interface GPUGraphContext {
  device: GPUDevice;
  offsetsBuffer: GPUBuffer;
  edgesBuffer: GPUBuffer;
  nodeCount: number;
  edgeCount: number;
  /** Pipeline caches — created lazily. */
  bfsPipeline?: GPUComputePipeline;
  componentsPipeline?: GPUComputePipeline;
}

// ─── Shader Sources ─────────────────────────────────────────────────────

const BFS_SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read> offsets: array<u32>;
@group(0) @binding(1) var<storage, read> edges: array<u32>;
@group(0) @binding(2) var<storage, read> frontier_in: array<u32>;
@group(0) @binding(3) var<storage, read_write> frontier_out: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> visited: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> out_count: array<atomic<u32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let frontier_size = atomicLoad(&out_count[1]);
  if (idx >= frontier_size) { return; }

  let node = frontier_in[idx];
  let start = offsets[node];
  let end = offsets[node + 1u];

  for (var e = start; e < end; e = e + 1u) {
    let neighbor = edges[e];
    let word = neighbor / 32u;
    let bit = 1u << (neighbor % 32u);

    let prev = atomicOr(&visited[word], bit);
    if ((prev & bit) == 0u) {
      let pos = atomicAdd(&out_count[0], 1u);
      frontier_out[pos] = neighbor;
    }
  }
}
`;

const COMPONENTS_SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read> offsets: array<u32>;
@group(0) @binding(1) var<storage, read> edges: array<u32>;
@group(0) @binding(2) var<storage, read_write> labels: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> changed: array<atomic<u32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let node = gid.x;
  if (node >= arrayLength(&offsets) - 1u) { return; }

  let my_label = atomicLoad(&labels[node]);
  let start = offsets[node];
  let end = offsets[node + 1u];

  for (var e = start; e < end; e = e + 1u) {
    let neighbor = edges[e];
    let neighbor_label = atomicLoad(&labels[neighbor]);

    if (neighbor_label < my_label) {
      atomicMin(&labels[node], neighbor_label);
      atomicStore(&changed[0], 1u);
    }
  }
}
`;

// ─── GPU Context Management ────────────────────────────────────────────

/**
 * Initialize a GPU graph context from a CSR graph.
 * Returns null if WebGPU is not available or initialization fails.
 */
export async function initGPUGraph(graph: CSRGraph): Promise<GPUGraphContext | null> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;

    const device = await adapter.requestDevice();

    const offsetsBuffer = device.createBuffer({
      size: graph.offsets.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(offsetsBuffer, 0, graph.offsets.buffer);

    const edgesBuffer = device.createBuffer({
      size: Math.max(graph.edges.byteLength, 4), // min 4 bytes
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (graph.edges.byteLength > 0) {
      device.queue.writeBuffer(edgesBuffer, 0, graph.edges.buffer);
    }

    return {
      device,
      offsetsBuffer,
      edgesBuffer,
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount,
    };
  } catch {
    return null;
  }
}

/**
 * GPU BFS — parallel frontier expansion.
 *
 * Returns a Uint32Array of visited node indices.
 * Uses two-buffer ping-pong: frontierIn holds the current frontier,
 * frontierOut accumulates the next frontier.
 */
export async function gpuBFS(
  ctx: GPUGraphContext,
  startIdx: number,
  maxDepth: number,
): Promise<Uint32Array> {
  const { device, offsetsBuffer, edgesBuffer, nodeCount } = ctx;

  // Lazy pipeline creation
  if (!ctx.bfsPipeline) {
    const module = device.createShaderModule({ code: BFS_SHADER });
    ctx.bfsPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  // Buffers
  const visitedWords = Math.ceil(nodeCount / 32);
  const maxFrontierSize = nodeCount;

  const frontierInBuf = device.createBuffer({
    size: maxFrontierSize * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const frontierOutBuf = device.createBuffer({
    size: maxFrontierSize * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const visitedBuf = device.createBuffer({
    size: visitedWords * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  // out_count[0] = new frontier size, out_count[1] = current frontier size
  const countBuf = device.createBuffer({
    size: 8,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuf = device.createBuffer({
    size: visitedWords * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const countReadBuf = device.createBuffer({
    size: 8,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // Initialize: start node in frontier, mark visited
  const initFrontier = new Uint32Array([startIdx]);
  device.queue.writeBuffer(frontierInBuf, 0, initFrontier);

  const initVisited = new Uint32Array(visitedWords);
  initVisited[Math.floor(startIdx / 32)] |= 1 << (startIdx % 32);
  device.queue.writeBuffer(visitedBuf, 0, initVisited);

  // Initial count: out_count[0]=0 (new frontier), out_count[1]=1 (current frontier size)
  device.queue.writeBuffer(countBuf, 0, new Uint32Array([0, 1]));

  const bindGroup = device.createBindGroup({
    layout: ctx.bfsPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: offsetsBuffer } },
      { binding: 1, resource: { buffer: edgesBuffer } },
      { binding: 2, resource: { buffer: frontierInBuf } },
      { binding: 3, resource: { buffer: frontierOutBuf } },
      { binding: 4, resource: { buffer: visitedBuf } },
      { binding: 5, resource: { buffer: countBuf } },
    ],
  });

  for (let depth = 0; depth < maxDepth; depth++) {
    const encoder = device.createCommandEncoder();

    const pass = encoder.beginComputePass();
    pass.setPipeline(ctx.bfsPipeline);
    pass.setBindGroup(0, bindGroup);
    // Dispatch enough workgroups to cover the frontier
    const workgroups = Math.ceil(nodeCount / 64);
    pass.dispatchWorkgroups(workgroups);
    pass.end();

    // Read back new frontier count
    encoder.copyBufferToBuffer(countBuf, 0, countReadBuf, 0, 8);
    device.queue.submit([encoder.finish()]);

    await countReadBuf.mapAsync(GPUMapMode.READ);
    const counts = new Uint32Array(countReadBuf.getMappedRange().slice(0));
    countReadBuf.unmap();

    const newFrontierSize = counts[0];
    if (newFrontierSize === 0) break;

    // Swap frontiers: copy frontierOut → frontierIn
    const swapEncoder = device.createCommandEncoder();
    swapEncoder.copyBufferToBuffer(frontierOutBuf, 0, frontierInBuf, 0, newFrontierSize * 4);
    device.queue.submit([swapEncoder.finish()]);

    // Reset counters: out_count[0]=0, out_count[1]=newFrontierSize
    device.queue.writeBuffer(countBuf, 0, new Uint32Array([0, newFrontierSize]));
  }

  // Read back visited bitmap
  const readEncoder = device.createCommandEncoder();
  readEncoder.copyBufferToBuffer(visitedBuf, 0, readbackBuf, 0, visitedWords * 4);
  device.queue.submit([readEncoder.finish()]);

  await readbackBuf.mapAsync(GPUMapMode.READ);
  const visitedData = new Uint32Array(readbackBuf.getMappedRange().slice(0));
  readbackBuf.unmap();

  // Extract visited node indices from bitmap
  const result: number[] = [];
  for (let word = 0; word < visitedWords; word++) {
    let bits = visitedData[word];
    while (bits !== 0) {
      const bit = bits & (-bits); // lowest set bit
      const bitIdx = 31 - Math.clz32(bit);
      result.push(word * 32 + bitIdx);
      bits ^= bit;
    }
  }

  // Cleanup
  frontierInBuf.destroy();
  frontierOutBuf.destroy();
  visitedBuf.destroy();
  countBuf.destroy();
  readbackBuf.destroy();
  countReadBuf.destroy();

  return new Uint32Array(result);
}

/**
 * GPU connected components — label propagation until convergence.
 *
 * Each node starts with its own index as label. Iteratively, each node
 * adopts the minimum label of its neighbors. Converges when no labels change.
 */
export async function gpuConnectedComponents(ctx: GPUGraphContext): Promise<Uint32Array> {
  const { device, offsetsBuffer, edgesBuffer, nodeCount } = ctx;

  if (!ctx.componentsPipeline) {
    const module = device.createShaderModule({ code: COMPONENTS_SHADER });
    ctx.componentsPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  // Initialize labels: each node = its own index
  const initLabels = new Uint32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) initLabels[i] = i;

  const labelsBuf = device.createBuffer({
    size: nodeCount * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(labelsBuf, 0, initLabels);

  const changedBuf = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const changedReadBuf = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const resultReadBuf = device.createBuffer({
    size: nodeCount * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const bindGroup = device.createBindGroup({
    layout: ctx.componentsPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: offsetsBuffer } },
      { binding: 1, resource: { buffer: edgesBuffer } },
      { binding: 2, resource: { buffer: labelsBuf } },
      { binding: 3, resource: { buffer: changedBuf } },
    ],
  });

  const workgroups = Math.ceil(nodeCount / 64);
  const maxIterations = 100; // safety limit

  for (let iter = 0; iter < maxIterations; iter++) {
    // Reset changed flag
    device.queue.writeBuffer(changedBuf, 0, new Uint32Array([0]));

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(ctx.componentsPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();

    encoder.copyBufferToBuffer(changedBuf, 0, changedReadBuf, 0, 4);
    device.queue.submit([encoder.finish()]);

    await changedReadBuf.mapAsync(GPUMapMode.READ);
    const changed = new Uint32Array(changedReadBuf.getMappedRange().slice(0));
    changedReadBuf.unmap();

    if (changed[0] === 0) break; // converged
  }

  // Read back labels
  const readEncoder = device.createCommandEncoder();
  readEncoder.copyBufferToBuffer(labelsBuf, 0, resultReadBuf, 0, nodeCount * 4);
  device.queue.submit([readEncoder.finish()]);

  await resultReadBuf.mapAsync(GPUMapMode.READ);
  const labels = new Uint32Array(resultReadBuf.getMappedRange().slice(0));
  resultReadBuf.unmap();

  // Cleanup
  labelsBuf.destroy();
  changedBuf.destroy();
  changedReadBuf.destroy();
  resultReadBuf.destroy();

  return labels;
}

/**
 * Degree centrality from CSR offsets — trivial O(n), no GPU needed.
 * Returns normalized centrality: degree / (nodeCount - 1).
 */
export function degreeCentrality(graph: CSRGraph): Float32Array {
  const n = graph.nodeCount;
  const centrality = new Float32Array(n);
  const denom = Math.max(n - 1, 1);
  for (let i = 0; i < n; i++) {
    centrality[i] = (graph.offsets[i + 1] - graph.offsets[i]) / denom;
  }
  return centrality;
}

/**
 * Release GPU resources.
 */
export function destroyGPUGraph(ctx: GPUGraphContext): void {
  ctx.offsetsBuffer.destroy();
  ctx.edgesBuffer.destroy();
  ctx.device.destroy();
}

// ─── Unified API (GPU with CPU fallback) ────────────────────────────────

/**
 * BFS with automatic GPU/CPU selection.
 * Returns a Set of targetHashes reachable within maxDepth.
 */
export async function graphBFS(
  graph: CSRGraph,
  gpuCtx: GPUGraphContext | null,
  startHash: number,
  maxDepth: number,
): Promise<Set<number>> {
  if (!gpuCtx) {
    return bfs(graph, startHash, maxDepth);
  }

  const startIdx = graph.hashToIndex.get(startHash);
  if (startIdx === undefined) return new Set();

  try {
    const indices = await gpuBFS(gpuCtx, startIdx, maxDepth);
    const result = new Set<number>();
    for (const idx of indices) {
      if (idx < graph.nodeCount) {
        result.add(graph.indexToHash[idx]);
      }
    }
    return result;
  } catch {
    // Fallback to CPU on any GPU error
    return bfs(graph, startHash, maxDepth);
  }
}

/**
 * Connected components with automatic GPU/CPU selection.
 * Returns targetHash → componentId mapping.
 */
export async function graphComponents(
  graph: CSRGraph,
  gpuCtx: GPUGraphContext | null,
): Promise<Map<number, number>> {
  if (!gpuCtx) {
    return connectedComponents(graph);
  }

  try {
    const labels = await gpuConnectedComponents(gpuCtx);
    const result = new Map<number, number>();
    const canonicalIds = new Map<number, number>();
    let nextId = 0;

    for (let i = 0; i < graph.nodeCount; i++) {
      const label = labels[i];
      let cid = canonicalIds.get(label);
      if (cid === undefined) {
        cid = nextId++;
        canonicalIds.set(label, cid);
      }
      result.set(graph.indexToHash[i], cid);
    }
    return result;
  } catch {
    return connectedComponents(graph);
  }
}

/**
 * Degree centrality — always CPU (trivial O(n) computation).
 * Returns targetHash → centrality mapping.
 */
export function graphCentrality(graph: CSRGraph): Map<number, number> {
  const centrality = degreeCentrality(graph);
  const result = new Map<number, number>();
  for (let i = 0; i < graph.nodeCount; i++) {
    result.set(graph.indexToHash[i], centrality[i]);
  }
  return result;
}
