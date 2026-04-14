/**
 * OPFS-backed append-only cache of per-target embedding vectors.
 *
 * The query path needs to cosine-compare a query embedding against every
 * pre-embedded chunk at a given resolution tier. Without a cache we'd have
 * to re-embed the whole corpus on every query. The cache lives alongside
 * the event log in OPFS so it survives reloads.
 *
 * Record layout (little-endian):
 *
 *     u32 target_len  (bytes of utf-8 target string)
 *     u32 vec_dim     (usually 384)
 *     bytes target    (utf-8)
 *     f32 × vec_dim   (embedding)
 *
 * Append-only: newer records for the same target supersede older ones on
 * read. Garbage collection of stale records is a future concern — for now
 * the file grows until the user re-ingests a doc, at which point the doc's
 * entries dedupe to the latest in memory.
 */

import { EMBEDDING_DIM } from './centroids-loader';

const EMB_FILE = 'eodb.emb';

export interface EmbeddingEntry {
  target: string;
  vec: Float32Array;
}

let _dirHandlePromise: Promise<FileSystemDirectoryHandle | null> | null = null;
let _memCache: Map<string, Float32Array> | null = null;
let _loadPromise: Promise<Map<string, Float32Array>> | null = null;

function getOpfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (_dirHandlePromise) return _dirHandlePromise;
  _dirHandlePromise = (async () => {
    const storage = (navigator as unknown as {
      storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
    }).storage;
    if (!storage?.getDirectory) return null;
    try {
      return await storage.getDirectory();
    } catch {
      return null;
    }
  })();
  return _dirHandlePromise;
}

async function openFile(): Promise<FileSystemFileHandle | null> {
  const root = await getOpfsRoot();
  if (!root) return null;
  try {
    return await root.getFileHandle(EMB_FILE, { create: true });
  } catch {
    return null;
  }
}

/** Load the full cache into memory. Cheap: one OPFS read + one loop. */
async function loadAll(): Promise<Map<string, Float32Array>> {
  if (_memCache) return _memCache;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    const cache = new Map<string, Float32Array>();
    const handle = await openFile();
    if (!handle) {
      _memCache = cache;
      return cache;
    }
    const file = await handle.getFile();
    if (file.size === 0) {
      _memCache = cache;
      return cache;
    }
    const buf = await file.arrayBuffer();
    const view = new DataView(buf);
    let off = 0;
    const decoder = new TextDecoder();
    while (off + 8 <= buf.byteLength) {
      const tLen = view.getUint32(off, true);
      const vDim = view.getUint32(off + 4, true);
      off += 8;
      if (off + tLen + vDim * 4 > buf.byteLength) break;
      const tBytes = new Uint8Array(buf, off, tLen);
      const target = decoder.decode(tBytes);
      off += tLen;
      // Copy out into a fresh typed array so releasing the buffer is safe.
      const vec = new Float32Array(vDim);
      for (let i = 0; i < vDim; i++) {
        vec[i] = view.getFloat32(off + i * 4, true);
      }
      off += vDim * 4;
      cache.set(target, vec); // later writes win — append-only with supersession
    }
    _memCache = cache;
    return cache;
  })();
  return _loadPromise;
}

/** Append a batch of (target, vec) entries to the OPFS file + in-memory map. */
export async function putBatch(entries: EmbeddingEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const cache = await loadAll();
  const encoder = new TextEncoder();
  // Size the buffer once.
  const encoded = entries.map((e) => {
    const tBytes = encoder.encode(e.target);
    return { tBytes, vec: e.vec };
  });
  let byteLength = 0;
  for (const e of encoded) {
    byteLength += 8 + e.tBytes.length + e.vec.length * 4;
  }
  const buf = new ArrayBuffer(byteLength);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let off = 0;
  for (const e of encoded) {
    view.setUint32(off, e.tBytes.length, true);
    view.setUint32(off + 4, e.vec.length, true);
    off += 8;
    u8.set(e.tBytes, off);
    off += e.tBytes.length;
    for (let i = 0; i < e.vec.length; i++) {
      view.setFloat32(off + i * 4, e.vec[i], true);
    }
    off += e.vec.length * 4;
  }

  const handle = await openFile();
  if (handle) {
    try {
      const writable = await handle.createWritable({ keepExistingData: true });
      // Seek to current end; the File object read during loadAll has a
      // stale size, so refresh via getFile() to find where to append.
      const file = await handle.getFile();
      await writable.seek(file.size);
      // TypeScript strict: FileSystemWritableFileStream accepts BufferSource.
      await writable.write(buf as unknown as BufferSource);
      await writable.close();
    } catch {
      // If the write fails, the in-memory cache still reflects the entries
      // for this session — re-ingest recovers on next load.
    }
  }

  for (const e of entries) {
    cache.set(e.target, e.vec);
  }
}

/** Fetch a single target's vector from the in-memory cache. */
export async function get(target: string): Promise<Float32Array | null> {
  const cache = await loadAll();
  return cache.get(target) ?? null;
}

/**
 * Iterate entries whose target starts with `prefix`. Used by the query path
 * to score every chunk at a given resolution tier within a specific doc.
 */
export async function iterByPrefix(
  prefix: string,
): Promise<EmbeddingEntry[]> {
  const cache = await loadAll();
  const out: EmbeddingEntry[] = [];
  for (const [target, vec] of cache) {
    if (target.startsWith(prefix)) {
      out.push({ target, vec });
    }
  }
  return out;
}

/** Expected dimensionality — re-exported for callers that need to validate. */
export const VECTOR_DIM = EMBEDDING_DIM;

/**
 * Test-only / maintenance hook: drop the in-memory cache so the next read
 * re-loads from OPFS. Not exposed as a user-facing action.
 */
export function _resetForTests(): void {
  _memCache = null;
  _loadPromise = null;
}
