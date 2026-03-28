/**
 * IndexedDB wrapper — replaces LevelDB (level.ts) from the server.
 *
 * Single object store `kv` with string keys and Uint8Array values.
 * Same keyspace prefixes as LevelDB: state:, log:, graph:fwd:, graph:rev:, eva:, idem:, meta:
 *
 * This is the raw (unencrypted) layer. The encrypted-store.ts wraps this
 * with transparent AES-GCM encryption.
 */

import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'eo-db';
const DB_VERSION = 2;
const STORE_NAME = 'kv';

export type EoIdb = IDBPDatabase;

export async function createIdb(): Promise<EoIdb> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // kv store used by the modern encrypted-store layer
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      // Legacy stores used by index.html compose UI
      if (!db.objectStoreNames.contains('log')) {
        const logStore = db.createObjectStore('log', { keyPath: 'client_event_id' });
        logStore.createIndex('seq', 'seq', { unique: true });
        logStore.createIndex('target', 'target', { unique: false });
      }
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state', { keyPath: 'target' });
      if (!db.objectStoreNames.contains('graph_fwd')) db.createObjectStore('graph_fwd', { keyPath: 'source' });
      if (!db.objectStoreNames.contains('graph_rev')) db.createObjectStore('graph_rev', { keyPath: 'target' });
      if (!db.objectStoreNames.contains('eva')) db.createObjectStore('eva', { keyPath: 'target' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    },
  });
}

export async function idbGet(db: EoIdb, key: string): Promise<Uint8Array | undefined> {
  return db.get(STORE_NAME, key);
}

export async function idbPut(db: EoIdb, key: string, value: Uint8Array): Promise<void> {
  await db.put(STORE_NAME, value, key);
}

export async function idbDel(db: EoIdb, key: string): Promise<void> {
  await db.delete(STORE_NAME, key);
}

/**
 * Range scan — equivalent to LevelDB's iterator({ gte, lte }).
 * Returns all [key, value] pairs where key is in [prefix, prefix + \uffff].
 */
export async function idbIterator(
  db: EoIdb,
  prefix: string,
): Promise<[string, Uint8Array][]> {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
  const results: [string, Uint8Array][] = [];

  let cursor = await store.openCursor(range);
  while (cursor) {
    results.push([cursor.key as string, cursor.value as Uint8Array]);
    cursor = await cursor.continue();
  }

  return results;
}

// --- Sequence helpers (same semantics as level.ts) ---

export function padSeq(seq: number): string {
  return String(seq).padStart(12, '0');
}
