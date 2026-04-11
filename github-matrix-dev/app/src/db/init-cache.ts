/**
 * Worker-side init cache.
 *
 * Persists the derived state that `buildIndex()` and the EVA re-eval pass
 * would otherwise recompute from scratch on every page refresh. The cache is
 * keyed by the log's byte length: if `log.size` matches the stored
 * `logByteSize` on load, the cache is known to be complete and consistent,
 * so the worker can skip scanning the log and re-evaluating formulas.
 *
 * Layout: <space>/init-cache.bin
 *
 * On a mismatch (log grew since the cache was written) the cache is
 * discarded and the worker falls back to a full `buildIndex()` walk.
 */

import { pack, unpack } from 'msgpackr';
import type { LoggableOperator } from './types';

// ─── Serialized payload ──────────────────────────────────────────────────────

export interface InitCachePayload {
  version: 1;
  /** Must equal the log file's current byte length for the cache to be valid. */
  logByteSize: number;
  /** Convenience: position.seq at the moment the cache was written. */
  headSeq: number;
  /** Per-event metadata needed to rebuild opIndex + trie + seqToOffset. */
  entries: {
    seqs: Uint32Array;
    offsets: Uint32Array;
    ops: LoggableOperator[];
    targets: string[];
  };
  /** Worker-side computed cache for EVA formula outputs. */
  computedCache: [string, unknown][];
}

// ─── saveInitCache ───────────────────────────────────────────────────────────

/**
 * Atomically write the init-cache to `<space>/init-cache.bin`.
 * Uses a temp file + rename so a crashed write never leaves a torn cache.
 */
export async function saveInitCache(
  payload: InitCachePayload,
  opfsDir: FileSystemDirectoryHandle,
): Promise<void> {
  const packed = pack(payload) as Uint8Array;
  const exactBuf = packed.buffer.slice(
    packed.byteOffset,
    packed.byteOffset + packed.byteLength,
  ) as ArrayBuffer;

  const tmp = await opfsDir.getFileHandle('init-cache.tmp', { create: true });
  const writable = await tmp.createWritable();
  await writable.write(new Blob([exactBuf]));
  await writable.close();
  await (tmp as FileSystemFileHandle & {
    move(dest: FileSystemDirectoryHandle, name: string): Promise<void>;
  }).move(opfsDir, 'init-cache.bin');
}

// ─── loadInitCache ───────────────────────────────────────────────────────────

/**
 * Read and validate `<space>/init-cache.bin`. Returns null on:
 *   - file missing
 *   - empty file
 *   - version mismatch
 *   - unpack failure (corrupt cache)
 *   - `expectedLogByteSize` does not match the stored `logByteSize`
 *
 * A null return is the signal to fall back to a full `buildIndex()` walk.
 */
export async function loadInitCache(
  opfsDir: FileSystemDirectoryHandle,
  expectedLogByteSize: number,
): Promise<InitCachePayload | null> {
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await opfsDir.getFileHandle('init-cache.bin');
  } catch {
    return null;
  }
  try {
    const file = await fileHandle.getFile();
    if (file.size === 0) return null;
    const buf = await file.arrayBuffer();
    const data = unpack(new Uint8Array(buf)) as InitCachePayload;
    if (data.version !== 1) return null;
    if (data.logByteSize !== expectedLogByteSize) return null;
    return data;
  } catch {
    return null;
  }
}
