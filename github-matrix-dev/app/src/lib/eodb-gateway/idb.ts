/**
 * Tiny key/value store on top of `idb` for the gateway's client-side caches:
 * `eodb:schema` (full schema response, refreshed hourly) and
 * `eodb:cursor:{tableId}` (last successful highWaterMark per table).
 *
 * The Given-Log lives in its own DB; this one is intentionally small,
 * recoverable, and safe to nuke (delete it, re-sync).
 */
import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'eo-db-gateway';
const DB_VERSION = 1;
const STORE_NAME = 'kv';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      },
    });
  }
  return dbPromise;
}

export const idb = {
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const db = await getDb();
    return (await db.get(STORE_NAME, key)) as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    const db = await getDb();
    await db.put(STORE_NAME, value, key);
  },
  async del(key: string): Promise<void> {
    const db = await getDb();
    await db.delete(STORE_NAME, key);
  },
};
