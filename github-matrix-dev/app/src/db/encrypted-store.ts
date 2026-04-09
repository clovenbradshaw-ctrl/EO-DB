/**
 * EoStore interface — the contract that all store implementations satisfy.
 *
 * The IDB-backed encrypted implementation has been replaced by MemoryStore
 * (memory-store.ts) backed by OPFS persistence via the fold worker.
 */

/**
 * Options for a range scan. Both fields are optional.
 *
 * - `limit`: stop after this many entries. Undefined = unbounded.
 * - `afterKey`: exclusive lower bound — start walking *after* this key.
 *   Used for cursor pagination: pass the last key from the previous page.
 */
export interface IteratorOpts {
  limit?: number;
  afterKey?: string;
}

export interface EoStore {
  get(key: string): Promise<any | null>;
  put(key: string, value: any): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Range scan over a prefix. Pass `opts.limit` and/or `opts.afterKey` for
   * cursor-based pagination — callers should avoid unbounded scans at scale.
   */
  iterator(prefix: string, opts?: IteratorOpts): Promise<[string, any][]>;
  nextSeq(): Promise<number>;
  getCurrentSeq(): Promise<number>;
  close(): void;
}

/** Zero-pad a sequence number to 12 digits for lexicographic ordering. */
export function padSeq(seq: number): string {
  return String(seq).padStart(12, '0');
}
