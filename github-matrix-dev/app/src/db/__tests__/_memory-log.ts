/**
 * Shared in-memory OPFSLog fixture for log-opfs / log-index / fold-worker tests.
 *
 * FileSystemSyncAccessHandle is unavailable in Node/Vitest, so this helper
 * builds an OPFSLog struct backed by two in-memory Uint8Array buffers (one
 * per file in the slice-5 two-file format). Every method on the synthetic
 * sync handle implements the subset of the SyncAccessHandle API that
 * log-opfs.ts uses: read, write, flush, getSize, close, truncate.
 *
 * This is a test helper. Do not import from production code.
 */

import type { OPFSLog } from '../log-opfs';

interface MemoryHandle extends FileSystemSyncAccessHandle {
  /** Direct buffer access for tests that want to inspect raw bytes. */
  _bytes(): Uint8Array;
}

function createMemoryHandle(): MemoryHandle {
  let buf = new Uint8Array(0);

  const handle = {
    read(dest: Uint8Array, opts: { at: number }): number {
      const start = opts.at;
      const end = Math.min(start + dest.length, buf.length);
      const count = Math.max(0, end - start);
      dest.set(buf.subarray(start, end));
      return count;
    },
    write(src: Uint8Array, opts: { at: number }): number {
      const needed = opts.at + src.length;
      if (needed > buf.length) {
        const next = new Uint8Array(needed);
        next.set(buf);
        buf = next;
      }
      buf.set(src, opts.at);
      return src.length;
    },
    flush(): void { /* no-op */ },
    getSize(): number { return buf.length; },
    close(): void { /* no-op */ },
    truncate(size: number): void {
      const next = new Uint8Array(size);
      next.set(buf.subarray(0, Math.min(size, buf.length)));
      buf = next;
    },
    _bytes(): Uint8Array {
      return buf;
    },
  };

  return handle as unknown as MemoryHandle;
}

/**
 * Build a two-file in-memory OPFSLog. Both eodb.idx and eodb.pay start
 * empty; appendEvent() / scanLog() will populate and walk them as if they
 * were real OPFS files.
 */
export function createMemoryLog(): OPFSLog {
  const idxHandle = createMemoryHandle();
  const payHandle = createMemoryHandle();

  return {
    idxFileHandle: {} as FileSystemFileHandle,
    payFileHandle: {} as FileSystemFileHandle,
    idxHandle,
    payHandle,
    idxBytes: 0,
    payBytes: 0,
    size: 0,
    syncHandle: {
      close() {
        try { idxHandle.close(); } catch { /* no-op */ }
        try { payHandle.close(); } catch { /* no-op */ }
      },
    },
  };
}
