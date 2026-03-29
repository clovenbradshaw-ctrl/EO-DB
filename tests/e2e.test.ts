import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, type EoDb } from '../src/db/level.js';
import { Feed } from '../src/db/feed.js';
import { registerHealthRoute, registerQueryRoutes } from '../src/api/query.js';
import { registerWebhookRoutes } from '../src/api/webhook.js';
import { registerOpsRoutes } from '../src/api/ops.js';
import { registerSyncRoute, resetPresence } from '../src/api/sync.js';
import { authMiddleware, setAuthConfig, clearTokenCache } from '../src/auth/matrix.js';
import { setMatrixAuthConfig } from '../src/auth/matrix-auth-config.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';

let app: FastifyInstance;
let db: EoDb;
let dbPath: string;
let feed: Feed;
let baseUrl: string;
let wsUrl: string;

const VALID_TOKEN = 'e2e-test-token';
const WEBHOOK_SECRET = 'e2e-webhook-secret';

function auth() {
  return { authorization: `Bearer ${VALID_TOKEN}` };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok: true,
    json: async () => ({ user_id: '@e2e:app.aminoimmigration.com' }),
  } as any));
  setAuthConfig({ webhookSecret: WEBHOOK_SECRET });
  clearTokenCache();
  resetPresence();

  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-e2e-'));
  db = createDb(dbPath);
  await db.open();

  // Allow the e2e test user through auth config
  await setMatrixAuthConfig(db, {
    enabled: true,
    allowed_accounts: [{ user_id: '@e2e:app.aminoimmigration.com', access: 'read_write' }],
    blacklisted_accounts: [],
    allowed_homeservers: [],
    server_rules: [],
    user_rules_buckets: [],
  });

  feed = new Feed();

  app = Fastify();

  registerHealthRoute(app, db);
  registerSyncRoute(app, db, feed);

  app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', authMiddleware);
    registerWebhookRoutes(protectedApp, db, feed);
    registerOpsRoutes(protectedApp, db, feed);
    registerQueryRoutes(protectedApp, db);
  });

  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = address;
  wsUrl = address.replace('http', 'ws');
});

afterEach(async () => {
  await app.close();
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

async function post(path: string, body: any) {
  return app.inject({ method: 'POST', url: path, headers: auth(), payload: body });
}

async function get(path: string) {
  return app.inject({ method: 'GET', url: path, headers: auth() });
}

describe('Full Lifecycle E2E', () => {
  it('processes the complete 11-fixture sequence and verifies all endpoints', async () => {
    // 1. INS client
    let res = await post('/ops/ins', { target: 'app.tblClients.rec001', operand: { name: 'Maria Garcia', status: 'active' } });
    expect(res.json().seq).toBe(1);

    // 2. INS case
    res = await post('/ops/ins', { target: 'app.tblCases.rec101', operand: { type: 'H1B', filed: '2025-06-01' } });
    expect(res.json().seq).toBe(2);

    // 3. CON link client -> case
    res = await post('/ops/con', { target: 'app.tblClients.rec001', operand: { added: ['app.tblCases.rec101'] } });
    expect(res.json().seq).toBe(3);

    // 4. DEF case status = pending
    res = await post('/ops/def', { target: 'app.tblCases.rec101.fldStatus', operand: 'pending' });
    expect(res.json().seq).toBe(4);

    // 5. DEF case status = approved (overwrites)
    res = await post('/ops/def', { target: 'app.tblCases.rec101.fldStatus', operand: 'approved' });
    expect(res.json().seq).toBe(5);

    // 6. DEF client email = old
    res = await post('/ops/def', { target: 'app.tblClients.rec001.fldEmail', operand: 'maria@old.com' });
    expect(res.json().seq).toBe(6);

    // 7. DEF client email = new (overwrites)
    res = await post('/ops/def', { target: 'app.tblClients.rec001.fldEmail', operand: 'maria@new.com' });
    expect(res.json().seq).toBe(7);

    // 8. EVA email policy
    res = await post('/ops/eva', { target: 'app.tblClients.rec001.fldEmail', operand: { strategy: 'latest' } });
    expect(res.json().seq).toBe(8);

    // 9. SEG archive client
    res = await post('/ops/seg', { target: 'app.tblClients.rec001', operand: { boundary: 'exclude', reason: 'archived' } });
    expect(res.json().seq).toBe(9);

    // 10. DEF deadline formula
    res = await post('/ops/def', { target: 'app.tblCases.rec101.fldDeadline', operand: { formula: 'DAYS_UNTIL(filed + 180)' } });
    expect(res.json().seq).toBe(10);

    // 11. REC schema migration
    res = await post('/ops/rec', {
      target: 'schema.tblCases',
      operand: {
        contains: [{ op: 'DEF', target: 'schema.tblCases.fldUrgency', operand: { type: 'select' } }],
        reason: 'Added urgency field',
      },
    });
    expect(res.json().seq).toBe(11);

    // --- Verify GET /horizon ---
    res = await get('/horizon/app.tblCases.rec101.fldStatus');
    expect(res.json().figure.value).toBe('approved');

    res = await get('/horizon/app.tblClients.rec001');
    expect(res.json().figure.last_op).toBe('SEG');
    expect(res.json().figure.value).toEqual({ boundary: 'exclude', reason: 'archived' });

    res = await get('/horizon/schema.tblCases.fldUrgency');
    expect(res.json().figure.value).toEqual({ type: 'select' });

    // --- Verify GET /log ---
    res = await get('/log?since=0');
    expect(res.json().events).toHaveLength(11);

    res = await get('/log?since=9&limit=2');
    expect(res.json().events).toHaveLength(2);
    expect(res.json().events[0].seq).toBe(10);

    // --- Verify GET /log/:target ---
    res = await get('/log/app.tblCases.rec101.fldStatus');
    const statusEvents = res.json().events;
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);

    // --- Verify GET /traverse ---
    res = await get('/traverse/app.tblClients.rec001?depth=1');
    expect(res.json().targets).toContain('app.tblClients.rec001');
    expect(res.json().targets).toContain('app.tblCases.rec101');

    // --- Verify GET /edges ---
    res = await get('/edges/app.tblClients.rec001?direction=outgoing');
    expect(res.json().edges.length).toBeGreaterThan(0);
    expect(res.json().edges[0].dest).toBe('app.tblCases.rec101');

    // --- Verify idempotency ---
    res = await post('/webhook', { op: 'INS', target: 'app.idem.test', operand: {}, client_event_id: 'idem-e2e' });
    const firstSeq = res.json().seq;
    res = await post('/webhook', { op: 'INS', target: 'app.idem.test', operand: {}, client_event_id: 'idem-e2e' });
    expect(res.json().seq).toBe(firstSeq); // Same seq, not reprocessed
  });
});

describe('Helix Ordering', () => {
  it('DEF auto-instantiates non-existent target', async () => {
    const res = await post('/ops/def', { target: 'auto.created', operand: 'hello' });
    expect(res.statusCode).toBe(200);

    const state = await get('/horizon/auto.created');
    expect(state.json().figure.value).toBe('hello');
  });

  it('CON with non-existent endpoint returns error', async () => {
    await post('/ops/ins', { target: 'con.source' });
    const res = await post('/ops/con', { target: 'con.source', operand: { added: ['nonexistent'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('does not exist');
  });

  it('SYN merge + alias resolution on subsequent DEF/GET', async () => {
    await post('/ops/ins', { target: 'syn.A', operand: { x: 1 } });
    await post('/ops/ins', { target: 'syn.B', operand: { y: 2 } });
    await post('/ops/syn', { target: 'syn.merged', operand: { merge: ['syn.A', 'syn.B'], into: 'syn.merged' } });

    // DEF on old target should write to merged
    await post('/ops/def', { target: 'syn.A', operand: { z: 3 } });

    // GET alias resolves to merged
    const res = await get('/horizon/syn.A');
    expect(res.json().target).toBe('syn.merged');
    expect(res.json().figure.value).toHaveProperty('z', 3);
  });
});

describe('WebSocket Integration', () => {
  function connectWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsUrl}/sync?access_token=${VALID_TOKEN}`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
  }

  function waitMsg(ws: WebSocket): Promise<any> {
    return new Promise(resolve => {
      ws.once('message', (data: Buffer) => resolve(JSON.parse(data.toString())));
    });
  }

  it('sync from 0 then receive real-time events', async () => {
    // Insert an event first
    await post('/ops/ins', { target: 'ws.initial' });

    const ws = await connectWs();
    const connected = await waitMsg(ws);
    expect(connected.type).toBe('connected');
    expect(connected.current_seq).toBe(1);

    // Sync from 0
    ws.send(JSON.stringify({ type: 'sync', since: 0 }));
    const event = await waitMsg(ws);
    expect(event.type).toBe('event');
    expect(event.event.target).toBe('ws.initial');

    const complete = await waitMsg(ws);
    expect(complete.type).toBe('sync_complete');

    // Post new event via HTTP — should be pushed to WS
    const realtime = waitMsg(ws);
    await post('/ops/ins', { target: 'ws.realtime' });
    const rtMsg = await realtime;
    expect(rtMsg.type).toBe('event');
    expect(rtMsg.event.target).toBe('ws.realtime');

    ws.close();
  });

  it('subscribe with pattern filter', async () => {
    const ws = await connectWs();
    await waitMsg(ws); // connected

    ws.send(JSON.stringify({ type: 'sync', since: 0 }));
    await waitMsg(ws); // sync_complete

    ws.send(JSON.stringify({ type: 'subscribe', pattern: 'filtered.**' }));
    await new Promise(r => setTimeout(r, 50));

    // Non-matching — should NOT arrive
    await post('/ops/ins', { target: 'other.noise' });

    // Matching — should arrive
    const p = waitMsg(ws);
    await post('/ops/ins', { target: 'filtered.signal' });
    const msg = await p;
    expect(msg.event.target).toBe('filtered.signal');

    ws.close();
  });
});

describe('Concurrent Access', () => {
  it('sequential POST requests get unique sequential seq numbers', async () => {
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await post('/ops/ins', { target: `concurrent.${i}` });
      expect(res.statusCode).toBe(200);
      seqs.push(res.json().seq);
    }
    // All seqs should be unique and sequential
    const unique = new Set(seqs);
    expect(unique.size).toBe(5);
    expect(seqs).toEqual(seqs.sort((a, b) => a - b));
  });
});

describe('Dependent Recomputation Integration', () => {
  it('DEF formula recomputes when upstream value changes', async () => {
    // Create source and formula targets
    await post('/ops/ins', { target: 'dep.source', operand: { val: 10 } });
    await post('/ops/ins', { target: 'dep.formula' });

    // Link formula to source
    await post('/ops/con', { target: 'dep.formula', operand: { added: ['dep.source'] } });

    // Register fold-computed formula
    await post('/ops/def', { target: 'dep.formula', operand: { formula: 'SUM(source)' } });

    // Check formula has _computed
    let res = await get('/horizon/dep.formula');
    expect(res.json().figure.value._computed).toBeDefined();

    // Change source — should trigger recomputation
    await post('/ops/def', { target: 'dep.source', operand: { val: 20 } });

    res = await get('/horizon/dep.formula');
    expect(res.json().figure.value._computed.inputs['dep.source']).toEqual({ val: 20 });

    // Verify recomputation didn't add log entries
    res = await get('/log?since=0');
    // Should be: INS source, INS formula, CON, DEF formula, DEF source = 5 events
    expect(res.json().events).toHaveLength(5);
  });
});

describe('Error Handling', () => {
  it('duplicate INS returns 400', async () => {
    await post('/ops/ins', { target: 'err.dup' });
    const res = await post('/ops/ins', { target: 'err.dup' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('already instantiated');
  });

  it('missing target returns 400', async () => {
    const res = await post('/ops/ins', { operand: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /health no auth', () => {
  it('returns 200 without authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});
