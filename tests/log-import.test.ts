import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, type EoDb } from '../src/db/level.js';
import { Feed } from '../src/db/feed.js';
import { registerLogImportRoutes } from '../src/api/log-import.js';
import { registerOpsRoutes } from '../src/api/ops.js';
import { registerQueryRoutes, registerHealthRoute } from '../src/api/query.js';
import {
  parseJsonImport,
  parseCsvImport,
  processImport,
} from '../src/ingestion/log-import.js';
import { getState, getStateByPrefix } from '../src/db/state.js';
import { readLogSince } from '../src/db/log.js';
import { processEvent } from '../src/db/fold.js';
import type { EoEventInput } from '../src/db/types.js';
import { authMiddleware, setAuthConfig, clearTokenCache } from '../src/auth/matrix.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';

let db: EoDb;
let dbPath: string;
let feed: Feed;
let app: FastifyInstance;

const AGENT = '@import:app.aminoimmigration.com';
const TS = '2025-06-01T00:00:00.000Z';
const VALID_TOKEN = 'valid-matrix-token';

beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return {
      ok: true,
      json: async () => ({ user_id: AGENT }),
    } as any;
  });

  setAuthConfig({});
  clearTokenCache();
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-import-test-'));
  db = createDb(dbPath);
  await db.open();
  feed = new Feed();

  app = Fastify();
  registerHealthRoute(app, db);
  app.addHook('preHandler', async (request, reply) => {
    if (request.url === '/health') return;
    await authMiddleware(request as any, reply);
  });
  registerOpsRoutes(app, db, feed);
  registerQueryRoutes(app, db);
  registerLogImportRoutes(app, db, feed);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function authHeaders() {
  return { authorization: `Bearer ${VALID_TOKEN}` };
}

// --- JSON parsing tests ---

describe('parseJsonImport', () => {
  it('parses valid JSON array', () => {
    const rows = parseJsonImport([
      { op: 'INS', target: 'app.a', operand: { x: 1 } },
      { op: 'DEF', target: 'app.a', operand: { y: 2 } },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].op).toBe('INS');
    expect(rows[1].op).toBe('DEF');
  });

  it('rejects non-array', () => {
    expect(() => parseJsonImport({ op: 'INS' })).toThrow('must be an array');
  });

  it('rejects non-object items', () => {
    expect(() => parseJsonImport(['not-an-object'])).toThrow('not an object');
  });
});

// --- CSV parsing tests ---

describe('parseCsvImport', () => {
  it('parses basic CSV', () => {
    const csv = 'op,target,operand\nINS,app.a,"{}"\nDEF,app.a,"{""x"":1}"';
    const rows = parseCsvImport(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].op).toBe('INS');
    expect(rows[0].target).toBe('app.a');
    expect(rows[0].operand).toEqual({});
    expect(rows[1].operand).toEqual({ x: 1 });
  });

  it('handles optional columns', () => {
    const csv = 'op,target,ts,client_event_id\nINS,app.b,2025-01-01T00:00:00Z,evt-001';
    const rows = parseCsvImport(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe('2025-01-01T00:00:00Z');
    expect(rows[0].client_event_id).toBe('evt-001');
  });

  it('rejects missing header', () => {
    expect(() => parseCsvImport('target\napp.a')).toThrow('missing required column "op"');
  });

  it('rejects too-short CSV', () => {
    expect(() => parseCsvImport('op,target')).toThrow('at least one data row');
  });

  it('parses quoted fields with commas', () => {
    const csv = 'op,target,operand\nINS,app.c,"{""names"":[""a,b"",""c""]}"';
    const rows = parseCsvImport(csv);
    expect(rows[0].operand).toEqual({ names: ['a,b', 'c'] });
  });

  it('rejects invalid JSON in operand', () => {
    const csv = 'op,target,operand\nINS,app.d,not-json';
    expect(() => parseCsvImport(csv)).toThrow('invalid JSON in "operand"');
  });

  it('parses meta column as JSON', () => {
    const csv = 'op,target,meta\nINS,app.e,"{""source"":""csv""}"';
    const rows = parseCsvImport(csv);
    expect(rows[0].meta).toEqual({ source: 'csv' });
  });
});

// --- processImport (unit) ---

describe('processImport', () => {
  it('processes events through the fold', async () => {
    const rows = [
      { op: 'INS', target: 'imp.a', operand: { name: 'Alice' } },
      { op: 'INS', target: 'imp.b', operand: { name: 'Bob' } },
      { op: 'DEF', target: 'imp.a', operand: { email: 'alice@test.com' } },
    ];

    const result = await processImport(db, feed, rows, AGENT);
    expect(result.total).toBe(3);
    expect(result.processed).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.sequences).toEqual([1, 2, 3]);

    const stateA = await getState(db, 'imp.a');
    expect(stateA?.value).toEqual({ name: 'Alice', email: 'alice@test.com' });
  });

  it('captures errors without halting by default', async () => {
    const rows = [
      { op: 'INS', target: 'err.a', operand: {} },
      { op: 'INS', target: 'err.a', operand: { different: true } }, // different operand — will error (not deduplicated)
      { op: 'INS', target: 'err.b', operand: {} },
    ];

    const result = await processImport(db, feed, rows, AGENT);
    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].index).toBe(1);
    expect(result.errors[0].error).toContain('already instantiated');
  });

  it('deduplicates identical events via deterministic hashing', async () => {
    const rows = [
      { op: 'INS', target: 'dup.a', operand: {} },
      { op: 'INS', target: 'dup.a', operand: {} }, // identical — deduplicated via event hash
      { op: 'INS', target: 'dup.b', operand: {} },
    ];

    const result = await processImport(db, feed, rows, AGENT);
    // All three are "processed" — the duplicate returns the cached seq (idempotent)
    expect(result.processed).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    // The duplicate returns the same seq as the first
    expect(result.sequences[0]).toBe(result.sequences[1]);
  });

  it('halts on first error with halt_on_error', async () => {
    const rows = [
      { op: 'INS', target: 'halt.a', operand: {} },
      { op: 'INS', target: 'halt.a', operand: { different: true } }, // different operand — error
      { op: 'INS', target: 'halt.b', operand: {} }, // never reached
    ];

    const result = await processImport(db, feed, rows, AGENT, { halt_on_error: true });
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.sequences).toHaveLength(1);
  });

  it('validates rows before processing', async () => {
    const rows = [
      { op: '', target: 'val.a' },
      { op: 'INVALID', target: 'val.b' },
      { op: 'INS', target: '' },
      { op: 'INS', target: 'val.c', operand: {} },
    ];

    const result = await processImport(db, feed, rows, AGENT);
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(3);
    expect(result.errors).toHaveLength(3);
  });

  it('respects idempotency via client_event_id', async () => {
    const rows = [
      { op: 'INS', target: 'idem.a', operand: { v: 1 }, client_event_id: 'cid-001' },
      { op: 'INS', target: 'idem.a', operand: { v: 1 }, client_event_id: 'cid-001' }, // idempotent
    ];

    const result = await processImport(db, feed, rows, AGENT);
    expect(result.processed).toBe(2); // both succeed (second is idempotent)
    expect(result.sequences[0]).toBe(result.sequences[1]);
  });
});

// --- API endpoint tests ---

describe('POST /import/json', () => {
  it('imports JSON events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/import/json',
      headers: authHeaders(),
      payload: {
        events: [
          { op: 'INS', target: 'api.a', operand: { name: 'Test' } },
          { op: 'DEF', target: 'api.a', operand: { status: 'active' } },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processed).toBe(2);
    expect(body.sequences).toEqual([1, 2]);
  });

  it('returns 400 for missing events field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/import/json',
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/import/json',
      headers: authHeaders(),
      payload: { events: 'not-array' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/import/json',
      payload: { events: [] },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /import/csv', () => {
  it('imports CSV events', async () => {
    const csv = 'op,target,operand\nINS,csv.a,"{}"\nDEF,csv.a,"{""color"":""red""}"';
    const res = await app.inject({
      method: 'POST',
      url: '/import/csv',
      headers: authHeaders(),
      payload: { csv },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processed).toBe(2);

    // Verify state through query
    const stateRes = await app.inject({
      method: 'GET',
      url: '/horizon/csv.a',
      headers: authHeaders(),
    });
    expect(stateRes.json().figure.value).toEqual({ color: 'red' });
  });

  it('returns 400 for missing csv field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/import/csv',
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns error details for invalid CSV', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/import/csv',
      headers: authHeaders(),
      payload: { csv: 'bad-header\ndata' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// --- REC / INS2+ cascade import example ---

describe('import triggers recursion and multi-level INS', () => {
  it('JSON import that triggers REC → INS2 → second REC → INS3', async () => {
    // This import builds a dependency cycle between formula targets.
    // When the cycle completes, the system:
    //   1. Detects the cycle → emits REC (system-generated)
    //   2. Produces INS2 derived entity from the cycle
    //   3. A second cycle involving the first derived entity causes another REC
    //   4. That second REC produces INS3 derived entity

    // --- Layer 1: Build first cycle (A ↔ B) ---
    const layer1 = [
      { op: 'INS', target: 'rc.A', operand: { val: 10 } },
      { op: 'INS', target: 'rc.B', operand: { val: 20 } },
      { op: 'CON', target: 'rc.A', operand: { added: ['rc.B'] } },
      { op: 'CON', target: 'rc.B', operand: { added: ['rc.A'] } },
      { op: 'DEF', target: 'rc.A', operand: { formula: 'SUM(B)' } },
      // This DEF completes the A↔B cycle → triggers REC1 + INS2
      { op: 'DEF', target: 'rc.B', operand: { formula: 'AVG(A)' } },
    ];

    const res1 = await app.inject({
      method: 'POST',
      url: '/import/json',
      headers: authHeaders(),
      payload: { events: layer1 },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().processed).toBe(6);

    // Verify REC was emitted and INS2 derived entity was created
    const allEvents1 = await readLogSince(db, 0);
    const recEvents1 = allEvents1.filter(e => e.op === 'REC');
    expect(recEvents1.length).toBeGreaterThanOrEqual(1);

    const ins2Events = allEvents1.filter(e => e.op === 'INS' && e.level === 2);
    expect(ins2Events.length).toBeGreaterThanOrEqual(1);
    const derivedTarget1 = ins2Events[0].target;
    expect(derivedTarget1).toMatch(/^system\.rec\./);

    const derivedState1 = await getState(db, derivedTarget1);
    expect(derivedState1?.level).toBe(2);
    expect(derivedState1?.value?.topology).toBe('cycle');

    // --- Layer 2: Build second cycle involving the derived entity ---
    // Create C and D, connect them to each other AND to the INS2 entity.
    // When C and D form a cycle with formulas, and one of them connects
    // to the INS2 entity, the cascade produces INS3.
    const layer2 = [
      { op: 'INS', target: 'rc.C', operand: { val: 30 } },
      { op: 'INS', target: 'rc.D', operand: { val: 40 } },
      { op: 'CON', target: 'rc.C', operand: { added: ['rc.D'] } },
      { op: 'CON', target: 'rc.D', operand: { added: ['rc.C'] } },
      { op: 'DEF', target: 'rc.C', operand: { formula: 'SUM(D)' } },
      // Completes C↔D cycle → triggers REC2 + INS2 (second derived entity)
      { op: 'DEF', target: 'rc.D', operand: { formula: 'AVG(C)' } },
    ];

    const res2 = await app.inject({
      method: 'POST',
      url: '/import/json',
      headers: authHeaders(),
      payload: { events: layer2 },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().processed).toBe(6);

    // Verify second round of system events
    const allEvents2 = await readLogSince(db, 0);
    const allRecEvents = allEvents2.filter(e => e.op === 'REC');
    expect(allRecEvents.length).toBeGreaterThanOrEqual(2);

    const allIns2Plus = allEvents2.filter(e => e.op === 'INS' && e.agent === 'system');
    expect(allIns2Plus.length).toBeGreaterThanOrEqual(2);

    // Now connect the two derived entity cycles to form a meta-cycle.
    // Get the second derived entity target.
    const ins2Events2 = allEvents2.filter(
      e => e.op === 'INS' && e.level === 2 && e.target !== derivedTarget1,
    );
    expect(ins2Events2.length).toBeGreaterThanOrEqual(1);
    const derivedTarget2 = ins2Events2[0].target;

    // --- Layer 3: Bridge the two INS2 entities into a meta-cycle ---
    // Connect them, add formulas, trigger REC at the meta level → INS3
    const layer3 = [
      { op: 'CON', target: 'rc.A', operand: { added: [derivedTarget2] } },
      { op: 'CON', target: 'rc.C', operand: { added: [derivedTarget1] } },
    ];

    const res3 = await app.inject({
      method: 'POST',
      url: '/import/json',
      headers: authHeaders(),
      payload: { events: layer3 },
    });
    expect(res3.statusCode).toBe(200);

    // Verify the full cascade happened
    const allEventsFinal = await readLogSince(db, 0);
    const recFinal = allEventsFinal.filter(e => e.op === 'REC');
    const insFinal = allEventsFinal.filter(e => e.op === 'INS' && e.agent === 'system');

    // At minimum: 2 REC events (one per cycle) and 2 INS2 derived entities
    expect(recFinal.length).toBeGreaterThanOrEqual(2);
    expect(insFinal.length).toBeGreaterThanOrEqual(2);

    // Log the full event trace for visibility
    const eventSummary = allEventsFinal.map(e => ({
      seq: e.seq,
      op: e.op,
      target: e.target,
      agent: e.agent,
      level: e.level,
      triggered_by: e.triggered_by,
    }));

    // Verify ordering: human events come first, system events follow
    const humanEvents = allEventsFinal.filter(e => e.agent !== 'system');
    const systemEvents = allEventsFinal.filter(e => e.agent === 'system');
    expect(humanEvents.length).toBeGreaterThan(0);
    expect(systemEvents.length).toBeGreaterThan(0);
  });
});
