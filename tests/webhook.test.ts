import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, type EoDb } from '../src/db/level.js';
import { Feed } from '../src/db/feed.js';
import { registerWebhookRoutes } from '../src/api/webhook.js';
import { authMiddleware, setAuthConfig, clearTokenCache } from '../src/auth/matrix.js';
import { configureMatrixDomain } from '../src/config/matrix-domain.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let app: FastifyInstance;
let db: EoDb;
let dbPath: string;
let feed: Feed;

const VALID_TOKEN = 'test-token';

beforeAll(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok: true,
    json: async () => ({ user_id: '@webhook-test:matrix.example.com' }),
  } as any));

  configureMatrixDomain({ webhookUser: '@webhook:matrix.example.com' });
  setAuthConfig({ webhookSecret: 'test-secret' });
});

beforeEach(async () => {
  clearTokenCache();
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-webhook-test-'));
  db = createDb(dbPath);
  await db.open();
  feed = new Feed();

  app = Fastify();
  app.addHook('preHandler', async (request, reply) => {
    await authMiddleware(request as any, reply);
  });
  registerWebhookRoutes(app, db, feed);
  await app.ready();
});

afterAll(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  await app.close();
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

function authHeaders() {
  return { authorization: `Bearer ${VALID_TOKEN}` };
}

describe('POST /webhook', () => {
  it('processes a single event and returns { seq }', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: authHeaders(),
      payload: { op: 'INS', target: 'app.tbl.rec001', operand: { name: 'Test' } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.seq).toBeGreaterThan(0);
  });

  it('processes an array of events and returns { sequences }', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: authHeaders(),
      payload: [
        { op: 'INS', target: 'app.tbl.rec001', operand: {} },
        { op: 'INS', target: 'app.tbl.rec002', operand: {} },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sequences).toHaveLength(2);
    expect(body.sequences[0]).toBeGreaterThan(0);
    expect(body.sequences[1]).toBeGreaterThan(body.sequences[0]);
  });

  it('sets agent from authenticated user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: authHeaders(),
      payload: { op: 'INS', target: 'app.tbl.rec001', operand: {} },
    });
    expect(res.statusCode).toBe(200);
  });

  it('auto-fills timestamps when not provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: authHeaders(),
      payload: { op: 'INS', target: 'app.tbl.rec001', operand: {} },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      payload: { op: 'INS', target: 'app.tbl.rec001', operand: {} },
    });
    expect(res.statusCode).toBe(401);
  });
});
