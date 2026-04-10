/**
 * In-memory EoStore — replaces the IDB-backed encrypted-store for the
 * live session.
 *
 * All data lives in a plain Map. On page load the fold worker's OPFS log
 * is replayed into this store via replayFromLog() (fold.ts). On every
 * subsequent event write, the "persistence hook" forwards the event to
 * the fold worker so it is durably appended to the OPFS log.
 *
 * The store is intentionally NOT encrypted because the OPFS binary log
 * (fold worker) is the source of truth for durability. Encryption of the
 * OPFS layer can be added as a separate concern.
 */

import type { EoStore, IteratorOpts } from './encrypted-store';
import type { EoEvent } from './types';

export interface MemoryStore extends EoStore {
  /**
   * Call once after replay is complete. All future log: writes will be
   * forwarded to `fn` so the fold worker can persist them to OPFS.
   */
  enablePersistence(fn: (event: EoEvent) => void): void;
  /**
   * Return all kv entries as an array for snapshotting.
   * Used by eo-store to save kv-snapshot.bin to OPFS after init.
   */
  getKvEntries(): [string, unknown][];
}

export function createMemoryStore(opts?: {
  initialKv?: [string, unknown][];
  initialSeq?: number;
}): MemoryStore {
  const kv = new Map<string, unknown>(opts?.initialKv);
  let currentSeq = opts?.initialSeq ?? 0;
  let persistFn: ((e: EoEvent) => void) | null = null;

  function rangeKeys(prefix: string, opts?: IteratorOpts): string[] {
    const all = [...kv.keys()].filter((k) => k.startsWith(prefix));
    all.sort();

    let result = all;
    if (opts?.afterKey) {
      const idx = all.findIndex((k) => k > opts.afterKey!);
      result = idx < 0 ? [] : all.slice(idx);
    }
    if (opts?.limit !== undefined) {
      result = result.slice(0, opts.limit);
    }
    return result;
  }

  const store: MemoryStore = {
    async get(key: string): Promise<unknown> {
      return (kv.get(key) as unknown) ?? null;
    },

    async put(key: string, value: unknown): Promise<void> {
      kv.set(key, value);
      // Forward event writes to the OPFS fold worker for durability.
      if (persistFn && key.startsWith('log:')) {
        persistFn(value as EoEvent);
      }
    },

    async del(key: string): Promise<void> {
      kv.delete(key);
    },

    async iterator(prefix: string, opts?: IteratorOpts): Promise<[string, unknown][]> {
      return rangeKeys(prefix, opts).map((k) => [k, kv.get(k)] as [string, unknown]);
    },

    async nextSeq(): Promise<number> {
      currentSeq++;
      kv.set('meta:seq', currentSeq);
      return currentSeq;
    },

    async getCurrentSeq(): Promise<number> {
      return currentSeq;
    },

    close(): void {
      // No-op — in-memory store has no resources to release.
      // The fold worker (if any) is managed externally.
    },

    enablePersistence(fn: (event: EoEvent) => void): void {
      persistFn = fn;
    },

    getKvEntries(): [string, unknown][] {
      return [...kv.entries()];
    },
  };

  return store;
}
