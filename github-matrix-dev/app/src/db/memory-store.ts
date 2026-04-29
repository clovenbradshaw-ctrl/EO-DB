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
   * forwarded to `fn` so the fold worker can persist them to OPFS. If `fn`
   * returns a Promise it is tracked internally and awaited by
   * `awaitPersistence`, so callers can use a fire-and-forget callback for
   * latency but still know when the queue has drained for durability
   * barriers (e.g. before writing a kv-snapshot).
   */
  enablePersistence(fn: (event: EoEvent) => void | Promise<void>): void;
  /**
   * Resolve once every outstanding persistFn promise has settled. Safe to
   * call repeatedly; resolves immediately when nothing is in flight.
   *
   * Use this before taking a kv-snapshot or surfacing "saved" to the user —
   * without it, `flushToOpfs` can capture a kv-map whose log: entries
   * haven't yet been written to OPFS, breaking reload survival for bursts.
   */
  awaitPersistence(): Promise<void>;
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
  let persistFn: ((e: EoEvent) => void | Promise<void>) | null = null;
  // Tracks every persistFn promise still in flight. Each entry removes
  // itself on settle, so the set is a live view of outstanding writes.
  const pendingPersistence = new Set<Promise<void>>();

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
      // The forward is fire-and-forget for latency, but if persistFn
      // returns a promise we track it so awaitPersistence() can drain
      // the queue before a kv-snapshot is written.
      if (persistFn && key.startsWith('log:')) {
        const r = persistFn(value as EoEvent);
        if (r && typeof (r as Promise<void>).then === 'function') {
          const p = r as Promise<void>;
          pendingPersistence.add(p);
          // Always settle: never let a rejection bubble out of put().
          p.catch(() => {}).finally(() => pendingPersistence.delete(p));
        }
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

    enablePersistence(fn: (event: EoEvent) => void | Promise<void>): void {
      persistFn = fn;
    },

    async awaitPersistence(): Promise<void> {
      // Re-check after each settle: a draining promise may have spawned
      // its own follow-on write (it doesn't today, but the loop costs
      // nothing and protects future implementations).
      while (pendingPersistence.size > 0) {
        await Promise.allSettled([...pendingPersistence]);
      }
    },

    getKvEntries(): [string, unknown][] {
      return [...kv.entries()];
    },
  };

  return store;
}
