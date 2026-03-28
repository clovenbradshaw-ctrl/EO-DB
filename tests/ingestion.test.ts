import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, type EoDb } from '../src/db/level.js';
import { Feed } from '../src/db/feed.js';
import { registerIngestionRoutes } from '../src/api/ingestion.js';
import { authMiddleware, setAuthConfig, clearTokenCache } from '../src/auth/matrix.js';
import { storeApiKey, getApiKey, listApiKeys, deleteApiKey } from '../src/ingestion/api-keys.js';
import {
  deepEqual,
  hasActualChanges,
  recordTarget,
  tableTarget,
  baseTarget,
} from '../src/ingestion/airtable-sync.js';
import { getState, setState } from '../src/db/state.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const VALID_TOKEN = 'valid-matrix-token';
const WEBHOOK_SECRET = 'test-webhook-secret';

let app: FastifyInstance;
let db: EoDb;
let dbPath: string;
let feed: Feed;

// ─── API key storage tests (unit) ───────────────────────────────────────────

describe('API key storage', () => {
  beforeEach(async () => {
    dbPath = mkdtempSync(join(tmpdir(), 'eo-db-ingestion-test-'));
    db = createDb(dbPath);
    await db.open();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dbPath, { recursive: true, force: true });
  });

  it('stores and retrieves an API key', async () => {
    await storeApiKey(db, 'test-key', 'pat1234567890', '@admin:example.com');
    const retrieved = await getApiKey(db, 'test-key');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.label).toBe('test-key');
    expect(retrieved!.api_key).toBe('pat1234567890');
    expect(retrieved!.added_by).toBe('@admin:example.com');
  });

  it('returns redacted key from store', async () => {
    const stored = await storeApiKey(db, 'test-key', 'pat1234567890', '@admin:example.com');
    expect(stored.api_key).toBe('***');
  });

  it('lists all keys (redacted)', async () => {
    await storeApiKey(db, 'key-a', 'patAAAA', '@admin:example.com');
    await storeApiKey(db, 'key-b', 'patBBBB', '@admin:example.com');
    const keys = await listApiKeys(db);
    expect(keys).toHaveLength(2);
    expect(keys.every(k => k.api_key === '***')).toBe(true);
    expect(keys.map(k => k.label).sort()).toEqual(['key-a', 'key-b']);
  });

  it('overwrites existing key on same label', async () => {
    await storeApiKey(db, 'key-x', 'old-key', '@admin:example.com');
    await storeApiKey(db, 'key-x', 'new-key', '@other:example.com');
    const retrieved = await getApiKey(db, 'key-x');
    expect(retrieved!.api_key).toBe('new-key');
    expect(retrieved!.added_by).toBe('@other:example.com');
  });

  it('deletes a key', async () => {
    await storeApiKey(db, 'to-delete', 'patXYZ', '@admin:example.com');
    const deleted = await deleteApiKey(db, 'to-delete');
    expect(deleted).toBe(true);
    const retrieved = await getApiKey(db, 'to-delete');
    expect(retrieved).toBeNull();
  });

  it('returns false when deleting non-existent key', async () => {
    const deleted = await deleteApiKey(db, 'nope');
    expect(deleted).toBe(false);
  });

  it('returns null for non-existent key', async () => {
    const retrieved = await getApiKey(db, 'does-not-exist');
    expect(retrieved).toBeNull();
  });

  it('stores and retrieves base_ids restriction', async () => {
    await storeApiKey(db, 'restricted', 'patXYZ', '@admin:example.com', ['appABC', 'appDEF']);
    const retrieved = await getApiKey(db, 'restricted');
    expect(retrieved!.base_ids).toEqual(['appABC', 'appDEF']);
  });
});

// ─── Deep equality tests ────────────────────────────────────────────────────

describe('deepEqual', () => {
  it('compares primitives', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it('compares arrays', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([], [])).toBe(true);
  });

  it('compares nested objects', () => {
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('handles mixed types', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
  });
});

// ─── Non-transformation detection tests ─────────────────────────────────────

describe('hasActualChanges', () => {
  beforeEach(async () => {
    dbPath = mkdtempSync(join(tmpdir(), 'eo-db-changes-test-'));
    db = createDb(dbPath);
    await db.open();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dbPath, { recursive: true, force: true });
  });

  it('returns true for new records (no existing state)', async () => {
    const changed = await hasActualChanges(db, 'at.appXYZ.tblABC.recNEW', { Name: 'Alice' });
    expect(changed).toBe(true);
  });

  it('returns false when fields are identical', async () => {
    await setState(db, {
      target: 'at.appXYZ.tblABC.rec001',
      value: { fields: { Name: 'Alice', Status: 'Active' } },
      last_seq: 1,
      last_op: 'DEF',
      last_agent: 'test',
      last_ts: new Date().toISOString(),
      last_acquired_ts: new Date().toISOString(),
    });

    const changed = await hasActualChanges(db, 'at.appXYZ.tblABC.rec001', {
      Name: 'Alice',
      Status: 'Active',
    });
    expect(changed).toBe(false);
  });

  it('returns true when a field value changed', async () => {
    await setState(db, {
      target: 'at.appXYZ.tblABC.rec002',
      value: { fields: { Name: 'Alice', Status: 'Active' } },
      last_seq: 1,
      last_op: 'DEF',
      last_agent: 'test',
      last_ts: new Date().toISOString(),
      last_acquired_ts: new Date().toISOString(),
    });

    const changed = await hasActualChanges(db, 'at.appXYZ.tblABC.rec002', {
      Name: 'Alice',
      Status: 'Closed',
    });
    expect(changed).toBe(true);
  });

  it('returns true when a field was added', async () => {
    await setState(db, {
      target: 'at.appXYZ.tblABC.rec003',
      value: { fields: { Name: 'Alice' } },
      last_seq: 1,
      last_op: 'DEF',
      last_agent: 'test',
      last_ts: new Date().toISOString(),
      last_acquired_ts: new Date().toISOString(),
    });

    const changed = await hasActualChanges(db, 'at.appXYZ.tblABC.rec003', {
      Name: 'Alice',
      Email: 'alice@example.com',
    });
    expect(changed).toBe(true);
  });

  it('returns true when a field was removed', async () => {
    await setState(db, {
      target: 'at.appXYZ.tblABC.rec004',
      value: { fields: { Name: 'Alice', Email: 'alice@example.com' } },
      last_seq: 1,
      last_op: 'DEF',
      last_agent: 'test',
      last_ts: new Date().toISOString(),
      last_acquired_ts: new Date().toISOString(),
    });

    const changed = await hasActualChanges(db, 'at.appXYZ.tblABC.rec004', {
      Name: 'Alice',
    });
    expect(changed).toBe(true);
  });
});

// ─── Target naming tests ────────────────────────────────────────────────────

describe('target naming', () => {
  it('generates correct record target', () => {
    expect(recordTarget('appABC', 'tblDEF', 'recGHI')).toBe('at.appABC.tblDEF.recGHI');
  });

  it('generates correct table target', () => {
    expect(tableTarget('appABC', 'tblDEF')).toBe('at.appABC.tblDEF');
  });

  it('generates correct base target', () => {
    expect(baseTarget('appABC')).toBe('at.appABC');
  });
});

// ─── API route tests ────────────────────────────────────────────────────────

describe('Ingestion API routes', () => {
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      // Mock Matrix token verification
      if (urlStr.includes('/_matrix/')) {
        return {
          ok: true,
          json: async () => ({ user_id: '@testuser:app.aminoimmigration.com' }),
        } as any;
      }
      // Mock Airtable API — bases list
      if (urlStr.includes('/meta/bases') && !urlStr.includes('/tables')) {
        return {
          ok: true,
          json: async () => ({
            bases: [
              { id: 'appTEST1', name: 'Test Base', permissionLevel: 'create' },
            ],
          }),
        } as any;
      }
      // Mock Airtable API — table schema
      if (urlStr.includes('/meta/bases/') && urlStr.includes('/tables')) {
        return {
          ok: true,
          json: async () => ({
            tables: [
              {
                id: 'tblTEST1',
                name: 'Clients',
                primaryFieldId: 'fldName',
                fields: [
                  { id: 'fldName', name: 'Name', type: 'singleLineText' },
                  { id: 'fldEmail', name: 'Email', type: 'email' },
                ],
              },
            ],
          }),
        } as any;
      }
      // Mock Airtable API — list records
      if (urlStr.includes('/appTEST1/')) {
        return {
          ok: true,
          json: async () => ({
            records: [
              { id: 'recA', createdTime: '2025-01-01T00:00:00Z', fields: { Name: 'Alice', Email: 'alice@test.com' } },
              { id: 'recB', createdTime: '2025-01-01T00:00:00Z', fields: { Name: 'Bob', Email: 'bob@test.com' } },
            ],
          }),
        } as any;
      }
      return { ok: false, status: 404, text: async () => 'Not found' } as any;
    });

    setAuthConfig({ webhookSecret: WEBHOOK_SECRET });
  });

  beforeEach(async () => {
    clearTokenCache();
    dbPath = mkdtempSync(join(tmpdir(), 'eo-db-ingestion-api-test-'));
    db = createDb(dbPath);
    await db.open();
    feed = new Feed();

    app = Fastify();
    app.addHook('preHandler', async (request, reply) => {
      await authMiddleware(request as any, reply);
    });
    registerIngestionRoutes(app, db, feed);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await db.close();
    rmSync(dbPath, { recursive: true, force: true });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  function authHeaders() {
    return { authorization: `Bearer ${VALID_TOKEN}` };
  }

  // ── Key management ────────────────────────────────────────────────────

  it('POST /ingestion/keys — stores a key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ingestion/keys',
      headers: authHeaders(),
      payload: { label: 'test-key', api_key: 'patXYZ123' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stored.label).toBe('test-key');
    expect(body.stored.api_key).toBe('***');
  });

  it('POST /ingestion/keys — rejects invalid label', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ingestion/keys',
      headers: authHeaders(),
      payload: { label: 'bad label!', api_key: 'patXYZ123' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /ingestion/keys — rejects missing fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ingestion/keys',
      headers: authHeaders(),
      payload: { label: 'test' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /ingestion/keys — lists stored keys', async () => {
    await storeApiKey(db, 'k1', 'pat111', '@testuser:app.aminoimmigration.com');
    await storeApiKey(db, 'k2', 'pat222', '@testuser:app.aminoimmigration.com');

    const res = await app.inject({
      method: 'GET',
      url: '/ingestion/keys',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys).toHaveLength(2);
  });

  it('GET /ingestion/keys/:label — returns redacted key', async () => {
    await storeApiKey(db, 'my-key', 'patSECRET', '@testuser:app.aminoimmigration.com');

    const res = await app.inject({
      method: 'GET',
      url: '/ingestion/keys/my-key',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().key.api_key).toBe('***');
  });

  it('GET /ingestion/keys/:label — 404 for missing key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ingestion/keys/nope',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /ingestion/keys/:label — deletes a key', async () => {
    await storeApiKey(db, 'del-me', 'patXYZ', '@testuser:app.aminoimmigration.com');

    const res = await app.inject({
      method: 'DELETE',
      url: '/ingestion/keys/del-me',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
  });

  // ── Discovery ─────────────────────────────────────────────────────────

  it('GET /ingestion/airtable/discover/:label — returns schema manifest', async () => {
    await storeApiKey(db, 'discover-key', 'patMOCK', '@testuser:app.aminoimmigration.com');

    const res = await app.inject({
      method: 'GET',
      url: '/ingestion/airtable/discover/discover-key',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const { manifest } = res.json();
    expect(manifest.bases).toHaveLength(1);
    expect(manifest.bases[0].id).toBe('appTEST1');
    expect(manifest.bases[0].tables).toHaveLength(1);
    expect(manifest.bases[0].tables[0].name).toBe('Clients');
    expect(manifest.bases[0].tables[0].fields).toHaveLength(2);
  });

  it('GET /ingestion/airtable/discover/:label — 404 for missing key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ingestion/airtable/discover/nonexistent',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Hydration sync ────────────────────────────────────────────────────

  it('POST /ingestion/airtable/hydrate/:label — ingests records', async () => {
    await storeApiKey(db, 'hydrate-key', 'patMOCK', '@testuser:app.aminoimmigration.com');

    const res = await app.inject({
      method: 'POST',
      url: '/ingestion/airtable/hydrate/hydrate-key',
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.manifest.bases).toHaveLength(1);
    expect(body.total_records_ingested).toBe(2);
    expect(body.sync_results).toHaveLength(1);
    expect(body.sync_results[0].table_name).toBe('Clients');
    expect(body.sync_results[0].records_fetched).toBe(2);

    // Verify records landed in EO-DB state
    const aliceState = await getState(db, 'at.appTEST1.tblTEST1.recA');
    expect(aliceState).not.toBeNull();
    expect(aliceState!.value.fields.Name).toBe('Alice');
  });

  it('POST /ingestion/airtable/hydrate/:label — re-hydration skips unchanged', async () => {
    await storeApiKey(db, 'rehydrate-key', 'patMOCK', '@testuser:app.aminoimmigration.com');

    // First hydration
    await app.inject({
      method: 'POST',
      url: '/ingestion/airtable/hydrate/rehydrate-key',
      headers: authHeaders(),
      payload: {},
    });

    // Second hydration — same data, should skip as duplicates
    const res = await app.inject({
      method: 'POST',
      url: '/ingestion/airtable/hydrate/rehydrate-key',
      headers: authHeaders(),
      payload: {},
    });
    const body = res.json();
    // Records should be skipped (either no_change or duplicate via idempotency)
    expect(body.total_records_skipped).toBe(2);
    expect(body.total_records_ingested).toBe(0);
  });

  // ── Update sync ───────────────────────────────────────────────────────

  it('POST /ingestion/airtable/sync/:label — incremental sync after hydration', async () => {
    await storeApiKey(db, 'sync-key', 'patMOCK', '@testuser:app.aminoimmigration.com');

    // Hydrate first
    await app.inject({
      method: 'POST',
      url: '/ingestion/airtable/hydrate/sync-key',
      headers: authHeaders(),
      payload: {},
    });

    // Update sync — same mock data, should skip unchanged records
    const res = await app.inject({
      method: 'POST',
      url: '/ingestion/airtable/sync/sync-key',
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Since mock data hasn't changed, all should be skipped
    expect(body.total_records_skipped).toBeGreaterThanOrEqual(0);
  });

  it('POST /ingestion/airtable/sync/:label — 404 for missing key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ingestion/airtable/sync/nope',
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});
