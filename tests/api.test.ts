import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, type EoDb } from '../src/db/level.js';
import { Feed } from '../src/db/feed.js';
import { registerWebhookRoutes } from '../src/api/webhook.js';
import { registerOpsRoutes } from '../src/api/ops.js';
import { registerQueryRoutes, registerHealthRoute } from '../src/api/query.js';
import { authMiddleware, setAuthConfig, clearTokenCache } from '../src/auth/matrix.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let app: FastifyInstance;
let db: EoDb;
let dbPath: string;
let feed: Feed;

// Mock Matrix homeserver for all tests
const VALID_TOKEN = 'valid-matrix-token';
const WEBHOOK_SECRET = 'test-webhook-secret';

beforeAll(async () => {
  // Mock fetch for Matrix token verification
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    return {
      ok: true,
      json: async () => ({ user_id: '@testuser:app.aminoimmigration.com' }),
    } as any;
  });

  setAuthConfig({ webhookSecret: WEBHOOK_SECRET });
});

beforeEach(async () => {
  clearTokenCache();
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-api-test-'));
  db = createDb(dbPath);
  await db.open();
  feed = new Feed();

  app = Fastify();

  // Health endpoint (no auth) - direct on app
  registerHealthRoute(app, db);

  // Auth-protected routes
  app.addHook('preHandler', async (request, reply) => {
    // Skip auth for health
    if (request.routeOptions?.url === '/health' || request.url === '/health') return;
    await authMiddleware(request as any, reply);
  });

  registerWebhookRoutes(app, db, feed);
  registerOpsRoutes(app, db, feed);
  registerQueryRoutes(app, db);

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

function authHeaders(type: 'bearer' | 'webhook' = 'bearer') {
  if (type === 'webhook') {
    return { authorization: `EoWebhook ${WEBHOOK_SECRET}` };
  }
  return { authorization: `Bearer ${VALID_TOKEN}` };
}

describe('POST /webhook', () => {
  it('single event returns { seq }', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: authHeaders(),
      payload: { op: 'INS', target: 'app.test', operand: { x: 1 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().seq).toBe(1);
  });

  it('array returns { sequences }', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: authHeaders(),
      payload: [
        { op: 'INS', target: 'app.a', operand: {} },
        { op: 'INS', target: 'app.b', operand: {} },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sequences).toEqual([1, 2]);
  });

  it('without auth returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      payload: { op: 'INS', target: 'app.test', operand: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  it('webhook secret auth works', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: authHeaders('webhook'),
      payload: { op: 'INS', target: 'app.n8n', operand: { from: 'n8n' } },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /ops/*', () => {
  it('/ops/ins creates target', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ops/ins',
      headers: authHeaders(),
      payload: { target: 'app.client.001', operand: { name: 'Maria' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().seq).toBe(1);
  });

  it('/ops/def sets value', async () => {
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 'app.field' } });
    const res = await app.inject({
      method: 'POST',
      url: '/ops/def',
      headers: authHeaders(),
      payload: { target: 'app.field', operand: 'new-value' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().seq).toBe(2);
  });

  it('/ops/con creates edge', async () => {
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 'app.A' } });
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 'app.B' } });
    const res = await app.inject({
      method: 'POST',
      url: '/ops/con',
      headers: authHeaders(),
      payload: { target: 'app.A', operand: { added: ['app.B'] } },
    });
    expect(res.statusCode).toBe(200);
  });

  it('validates required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ops/ins',
      headers: authHeaders(),
      payload: { operand: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('target');
  });

  it('returns 400 for operator errors', async () => {
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 'app.dup' } });
    const res = await app.inject({
      method: 'POST',
      url: '/ops/ins',
      headers: authHeaders(),
      payload: { target: 'app.dup' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('already instantiated');
  });
});

describe('GET /horizon/:target', () => {
  beforeEach(async () => {
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 'app.rec001', operand: { name: 'Maria' } } });
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 'app.rec002', operand: { name: 'John' } } });
  });

  it('returns projected state', async () => {
    const res = await app.inject({ method: 'GET', url: '/horizon/app.rec001', headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json().state.value.name).toBe('Maria');
  });

  it('returns array with prefix=true', async () => {
    const res = await app.inject({ method: 'GET', url: '/horizon/app?prefix=true', headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    expect(res.json().length).toBe(2);
  });

  it('returns 404 for nonexistent target', async () => {
    const res = await app.inject({ method: 'GET', url: '/horizon/nonexistent', headers: authHeaders() });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /log', () => {
  beforeEach(async () => {
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 'log.a', operand: {} } });
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 'log.b', operand: {} } });
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 'log.c', operand: {} } });
  });

  it('returns events in order', async () => {
    const res = await app.inject({ method: 'GET', url: '/log?since=0', headers: authHeaders() });
    expect(res.json().events).toHaveLength(3);
    expect(res.json().events[0].seq).toBe(1);
  });

  it('respects since and limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/log?since=1&limit=1', headers: authHeaders() });
    expect(res.json().events).toHaveLength(1);
    expect(res.json().events[0].seq).toBe(2);
  });
});

describe('GET /log/:target', () => {
  it('returns events for specific target', async () => {
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 'tgt.a', operand: {} } });
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 'tgt.b', operand: {} } });
    await app.inject({ method: 'POST', url: '/ops/def', headers: authHeaders(), payload: { target: 'tgt.a', operand: 'updated' } });

    const res = await app.inject({ method: 'GET', url: '/log/tgt.a', headers: authHeaders() });
    expect(res.json().events).toHaveLength(2);
    expect(res.json().events.every((e: any) => e.target === 'tgt.a')).toBe(true);
  });
});

describe('GET /edges/:target', () => {
  beforeEach(async () => {
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 'e.A' } });
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 'e.B' } });
    await app.inject({ method: 'POST', url: '/ops/con', headers: authHeaders(), payload: { target: 'e.A', operand: { added: ['e.B'] } } });
  });

  it('returns edges', async () => {
    const res = await app.inject({ method: 'GET', url: '/edges/e.A', headers: authHeaders() });
    expect(res.json().edges.length).toBeGreaterThan(0);
  });

  it('direction=outgoing returns only outgoing', async () => {
    const res = await app.inject({ method: 'GET', url: '/edges/e.A?direction=outgoing', headers: authHeaders() });
    expect(res.json().edges).toHaveLength(1);
    expect(res.json().edges[0].source).toBe('e.A');
  });
});

describe('GET /traverse/:target', () => {
  it('returns graph neighborhood', async () => {
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 't.1' } });
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 't.2' } });
    await app.inject({ method: 'POST', url: '/ops/con', headers: authHeaders(), payload: { target: 't.1', operand: { added: ['t.2'] } } });

    const res = await app.inject({ method: 'GET', url: '/traverse/t.1?depth=1', headers: authHeaders() });
    expect(res.json().targets).toContain('t.1');
    expect(res.json().targets).toContain('t.2');
  });
});

describe('GET /health', () => {
  it('returns 200 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});

describe('GET /meta', () => {
  it('returns seq and event_count with auth', async () => {
    await app.inject({ method: 'POST', url: '/ops/ins', headers: authHeaders(), payload: { target: 'm.1' } });
    const res = await app.inject({ method: 'GET', url: '/meta', headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json().seq).toBe(1);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/meta' });
    expect(res.statusCode).toBe(401);
  });
});
