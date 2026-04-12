/**
 * fold-isolate.ts — Phase F: Isolated-store shard dispatch with post-merge.
 *
 * Phase E proved the shard-pool partitioning is deterministic with a shared
 * in-memory store. Phase F takes the next step: each shard operates against
 * its own **isolated store clone**, and mutations are merged back to the
 * main store after dispatch completes. This is the execution model that
 * real Web Workers will use — each worker has its own memory space, and
 * the coordinator merges results.
 *
 * The isolation protocol has three phases:
 *
 *   1. **Snapshot** — enumerate all entries from the main store into a Map.
 *      This is the shard's initial state. Full-clone is O(n) in the total
 *      store size; a future optimization can seed only the shard's targets
 *      plus cross-shard dependencies.
 *
 *   2. **Process** — create a tracked EoStore from the snapshot. All reads
 *      go to the local clone; all writes are recorded in a mutation log
 *      AND applied to the local clone (so subsequent reads within the same
 *      shard see the writes).
 *
 *   3. **Merge** — apply all recorded mutations to the main store. Since
 *      targets are partitioned across shards, most mutations are shard-
 *      local (no conflict). The exception is CON reverse edges
 *      (graph:rev:dest:source) where the destination is in another shard.
 *      These are additive (new edge inserts, not read-modify-write), so
 *      last-writer-wins merging is safe.
 *
 * Correctness guarantee. The isolated-pool runner passes all four fold-
 * determinism properties (self-determinism, projection equivalence with
 * serial baseline, DEF re-block), proving that isolation + merge produces
 * identical results to the shared-store model.
 */

import type { EoStore, IteratorOpts } from './encrypted-store';

// ─── Mutation tracking ─────────────────────────────────────────────────────

/** A single store mutation — either a put or a delete. */
export interface StoreMutation {
  op: 'put' | 'del';
  key: string;
  value?: unknown;
}

/**
 * A store backed by a local Map clone with all writes tracked in a
 * mutation log. Reads go to the local clone; writes update the clone
 * AND append to the log.
 */
export interface TrackedStore {
  store: EoStore;
  /** All writes since creation, in order. */
  mutations: StoreMutation[];
}

/**
 * Create a tracked, isolated store from a snapshot of existing data.
 *
 * The store is fully independent — no references to the source. The
 * `seq` counter starts at the provided value but is NOT incremented by
 * normal operations (shards use pre-assigned seqs from the coordinator's
 * SeqReservoir). If nextSeq is called, it throws — this is a shard
 * invariant violation.
 */
export function createTrackedStore(
  snapshot: Map<string, unknown>,
  seq: number,
): TrackedStore {
  const data = new Map(snapshot);
  const mutations: StoreMutation[] = [];

  const store: EoStore = {
    async get(key: string) {
      return data.has(key) ? data.get(key) : null;
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
      mutations.push({ op: 'put', key, value });
    },
    async del(key: string) {
      data.delete(key);
      mutations.push({ op: 'del', key });
    },
    async iterator(prefix: string, opts?: IteratorOpts) {
      const results: [string, unknown][] = [];
      for (const [key, value] of data.entries()) {
        if (key >= prefix && key <= prefix + '\uffff') {
          if (opts?.afterKey && key <= opts.afterKey) continue;
          results.push([key, value]);
        }
      }
      results.sort((a, b) => a[0].localeCompare(b[0]));
      if (opts?.limit !== undefined && results.length > opts.limit) {
        results.length = opts.limit;
      }
      return results;
    },
    async nextSeq() {
      // Shards must not allocate seqs — the coordinator pre-assigns them
      // via SeqReservoir. If this fires, a shard is calling processEvent
      // instead of processEventCoreWithSeq.
      throw new Error(
        'Isolated shard store must not call nextSeq — seqs are pre-assigned',
      );
    },
    async getCurrentSeq() {
      return seq;
    },
    close() { /* no-op */ },
  };

  return { store, mutations };
}

// ─── Store snapshot ────────────────────────────────────────────────────────

/**
 * Snapshot all entries from an EoStore into a Map. Uses an empty-prefix
 * iterator scan — O(n) in the total number of entries.
 *
 * This is the full-clone approach. A future optimization can limit the
 * snapshot to entries relevant to a specific shard (target-prefixed keys
 * plus cross-shard dependencies).
 */
export async function snapshotStore(store: EoStore): Promise<Map<string, unknown>> {
  const entries = await store.iterator('');
  const map = new Map<string, unknown>(entries);
  // Include meta:seq which may not have a prefix in range
  const seq = await store.getCurrentSeq();
  map.set('meta:seq', seq);
  return map;
}

// ─── Mutation merge ────────────────────────────────────────────────────────

/**
 * Apply a list of mutations to a store. Mutations are applied in order.
 *
 * Since targets are partitioned across shards, most mutations are shard-
 * local and don't conflict. Cross-shard mutations (CON reverse edges) are
 * additive inserts, so last-writer-wins is safe.
 */
export async function applyMutations(
  store: EoStore,
  mutations: readonly StoreMutation[],
): Promise<void> {
  for (const m of mutations) {
    if (m.op === 'put') {
      await store.put(m.key, m.value);
    } else {
      await store.del(m.key);
    }
  }
}
