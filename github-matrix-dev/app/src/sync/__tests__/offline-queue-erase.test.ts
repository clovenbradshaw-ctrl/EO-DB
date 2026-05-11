/**
 * eraseOfflineQueueDb — V5 of HELIX-AUDIT-2026-05-11.md.
 *
 * On logout the offline-queue IDB has to be wiped so queued writes
 * from the prior session don't get replayed under a new account's
 * identity. Verifies the function deletes the database; subsequent
 * opens see a fresh empty DB rather than the prior session's queue.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { openDB } from 'idb';
import { eraseOfflineQueueDb } from '../../matrix/sync-manager';

const DB_NAME = 'eo-offline-queue';
const STORE = 'queue';

async function seedQueue(roomId: string, value: unknown): Promise<void> {
  const db = await openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    },
  });
  await db.put(STORE, value, roomId);
  db.close();
}

async function readQueue(roomId: string): Promise<unknown> {
  const db = await openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    },
  });
  const v = await db.get(STORE, roomId);
  db.close();
  return v ?? null;
}

async function dbExists(name: string): Promise<boolean> {
  const dbs = await (indexedDB as any).databases?.();
  if (!Array.isArray(dbs)) return false;
  return dbs.some((d: { name?: string }) => d.name === name);
}

describe('eraseOfflineQueueDb (V5)', () => {
  beforeEach(async () => {
    // Make sure each test starts with no prior state.
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  it('removes a previously-written queue entry', async () => {
    await seedQueue('!room:t', [{ event: { client_event_id: 'ev:1' }, attempts: 0 }]);
    expect(await readQueue('!room:t')).not.toBeNull();

    await eraseOfflineQueueDb();

    expect(await readQueue('!room:t')).toBeNull();
  });

  it('is a no-op when the database does not exist', async () => {
    // Should not throw even though the DB was never created.
    await expect(eraseOfflineQueueDb()).resolves.toBeUndefined();
    expect(await dbExists(DB_NAME)).toBe(false);
  });

  it('subsequent opens see a fresh empty DB', async () => {
    await seedQueue('!a:t', 'old-value');
    await eraseOfflineQueueDb();
    await seedQueue('!a:t', 'new-value');
    expect(await readQueue('!a:t')).toBe('new-value');
    // The prior session's other-room entry is gone.
    expect(await readQueue('!other:t')).toBeNull();
  });
});
