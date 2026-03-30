import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, type EoDb } from '../src/db/level.js';
import { registerAdminRoutes } from '../src/api/admin.js';
import { authMiddleware, setAuthConfig, clearTokenCache } from '../src/auth/matrix.js';
import { configureMatrixDomain } from '../src/config/matrix-domain.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let app: FastifyInstance;
let db: EoDb;
let dbPath: string;

const VALID_TOKEN = 'admin-test-token';

beforeAll(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok: true,
    json: async () => ({ user_id: '@admin:matrix.example.com' }),
  } as any));

  configureMatrixDomain({ webhookUser: '@webhook:matrix.example.com' });
  setAuthConfig({ webhookSecret: 'test-secret' });
});

beforeEach(async () => {
  clearTokenCache();
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-admin-test-'));
  db = createDb(dbPath);
  await db.open();

  app = Fastify();
  app.addHook('preHandler', async (request, reply) => {
    await authMiddleware(request as any, reply);
  });
  registerAdminRoutes(app, db);
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

describe('GET /admin/matrix-auth', () => {
  it('returns the current auth config', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/matrix-auth',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('enabled');
    expect(body).toHaveProperty('allowed_accounts');
    expect(body).toHaveProperty('allowed_homeservers');
  });
});

describe('PUT /admin/matrix-auth/enabled', () => {
  it('enables auth when set to true', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/matrix-auth/enabled',
      headers: authHeaders(),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.enabled).toBe(true);
  });

  it('returns 400 for non-boolean enabled', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/matrix-auth/enabled',
      headers: authHeaders(),
      payload: { enabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /admin/matrix-auth/accounts', () => {
  it('adds an allowed account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/accounts',
      headers: authHeaders(),
      payload: { user_id: '@newuser:matrix.example.com', label: 'Test User' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const found = body.allowed_accounts.find((a: any) => a.user_id === '@newuser:matrix.example.com');
    expect(found).toBeDefined();
  });

  it('returns 400 for invalid user_id format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/accounts',
      headers: authHeaders(),
      payload: { user_id: 'invalid-format' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for missing user_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/accounts',
      headers: authHeaders(),
      payload: { label: 'No ID' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('validates access level when provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/accounts',
      headers: authHeaders(),
      payload: { user_id: '@user:example.com', access: 'invalid_level' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /admin/matrix-auth/blacklist', () => {
  it('adds a blacklisted account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/blacklist',
      headers: authHeaders(),
      payload: { user_id: '@baduser:evil.com', reason: 'Spam' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.blacklisted_accounts.some((a: any) => a.user_id === '@baduser:evil.com')).toBe(true);
  });

  it('returns 400 for invalid user_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/blacklist',
      headers: authHeaders(),
      payload: { user_id: 'not-a-matrix-id' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /admin/matrix-auth/server-rules', () => {
  it('sets a server rule', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/matrix-auth/server-rules',
      headers: authHeaders(),
      payload: {
        homeserver: 'matrix.example.com',
        mode: 'accept_all',
        default_access: 'read_write',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const rule = body.server_rules.find((r: any) => r.homeserver === 'matrix.example.com');
    expect(rule).toBeDefined();
    expect(rule.mode).toBe('accept_all');
  });

  it('returns 400 for invalid mode', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/matrix-auth/server-rules',
      headers: authHeaders(),
      payload: {
        homeserver: 'matrix.example.com',
        mode: 'invalid_mode',
        default_access: 'read',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid default_access', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/matrix-auth/server-rules',
      headers: authHeaders(),
      payload: {
        homeserver: 'matrix.example.com',
        mode: 'accept_all',
        default_access: 'admin',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for missing homeserver', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/matrix-auth/server-rules',
      headers: authHeaders(),
      payload: { mode: 'accept_all', default_access: 'read' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /admin/matrix-auth/buckets', () => {
  it('creates a new bucket', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/buckets',
      headers: authHeaders(),
      payload: { name: 'editors', access: 'read_write', description: 'Editor group' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const bucket = body.user_rules_buckets.find((b: any) => b.name === 'editors');
    expect(bucket).toBeDefined();
    expect(bucket.access).toBe('read_write');
  });

  it('returns 409 for duplicate bucket name', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/buckets',
      headers: authHeaders(),
      payload: { name: 'editors', access: 'read' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/buckets',
      headers: authHeaders(),
      payload: { name: 'editors', access: 'write' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 400 for missing name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/buckets',
      headers: authHeaders(),
      payload: { access: 'read' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid access level', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/buckets',
      headers: authHeaders(),
      payload: { name: 'bad', access: 'superadmin' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /admin/matrix-auth/buckets/:name/members', () => {
  it('adds a member to a bucket', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/buckets',
      headers: authHeaders(),
      payload: { name: 'team', access: 'read_write' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/buckets/team/members',
      headers: authHeaders(),
      payload: { user_id: '@member:example.com' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 for invalid user_id', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/buckets',
      headers: authHeaders(),
      payload: { name: 'team', access: 'read' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/buckets/team/members',
      headers: authHeaders(),
      payload: { user_id: 'bad-id' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for non-existent bucket', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/matrix-auth/buckets/nonexistent/members',
      headers: authHeaders(),
      payload: { user_id: '@user:example.com' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /admin/reset', () => {
  it('clears all database keys', async () => {
    // Add some data first
    await app.inject({
      method: 'PUT',
      url: '/admin/matrix-auth/enabled',
      headers: authHeaders(),
      payload: { enabled: true },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/reset',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.deleted).toBeGreaterThanOrEqual(0);
  });
});
