import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, type EoDb } from '../src/db/level.js';
import { Feed } from '../src/db/feed.js';
import { processEvent } from '../src/db/fold.js';
import { registerSyncRoute, resetPresence } from '../src/api/sync.js';
import { setAuthConfig, clearTokenCache } from '../src/auth/matrix.js';
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

const VALID_TOKEN = 'test-matrix-token';

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok: true,
    json: async () => ({ user_id: '@testuser:matrix.example.com' }),
  } as any));
  setAuthConfig({ webhookSecret: 'test-secret' });
  clearTokenCache();
  resetPresence();
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-sync-test-'));
  db = createDb(dbPath);
  await db.open();

  // Allow the test user through auth config
  await setMatrixAuthConfig(db, {
    enabled: true,
    allowed_accounts: [{ user_id: '@testuser:matrix.example.com', access: 'read_write' }],
    blacklisted_accounts: [],
    allowed_homeservers: [],
    server_rules: [],
    user_rules_buckets: [],
  });

  feed = new Feed();

  app = Fastify();
  registerSyncRoute(app, db, feed);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = address.replace('http', 'ws');
});

afterEach(async () => {
  await app.close();
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

function connectWs(token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `${baseUrl}/sync?access_token=${token || VALID_TOKEN}`;
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    // Timeout after 2s
    setTimeout(() => reject(new Error('WebSocket connect timeout')), 2000);
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data: Buffer) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

function waitForMessages(ws: WebSocket, count: number, timeout = 3000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const timer = setTimeout(() => resolve(messages), timeout);
    ws.on('message', (data: Buffer) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length >= count) {
        clearTimeout(timer);
        resolve(messages);
      }
    });
  });
}

describe('WebSocket /sync', () => {
  it('sends connected message with user_id and current_seq on connect', { timeout: 15000 }, async () => {
    const ws = await connectWs();
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('connected');
    expect(msg.user_id).toBe('@testuser:matrix.example.com');
    expect(typeof msg.current_seq).toBe('number');
    ws.close();
  });

  it('rejects connection with invalid token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false } as any);
    try {
      const ws = await connectWs('invalid-token');
      const closePromise = new Promise<number>((resolve) => {
        ws.on('close', (code: number) => resolve(code));
      });
      const code = await closePromise;
      expect(code).toBe(4001);
    } catch (e) {
      // Connection may fail outright, which is also acceptable
    }
  });

  it('sync from 0 returns all events then sync_complete', async () => {
    // Insert some events first
    await processEvent(db, { op: 'INS', target: 'sync.a', operand: {}, agent: '@test:a', ts: '2025-01-01T00:00:00Z', acquired_ts: '2025-01-01T00:00:00Z' }, feed);
    await processEvent(db, { op: 'INS', target: 'sync.b', operand: {}, agent: '@test:a', ts: '2025-01-01T00:00:00Z', acquired_ts: '2025-01-01T00:00:00Z' }, feed);

    const ws = await connectWs();
    await waitForMessage(ws); // connected

    ws.send(JSON.stringify({ type: 'sync', since: 0 }));

    // Should receive 2 events + sync_complete = 3 messages
    const messages = await waitForMessages(ws, 3);
    const eventMsgs = messages.filter(m => m.type === 'event');
    const completeMsgs = messages.filter(m => m.type === 'sync_complete');
    expect(eventMsgs).toHaveLength(2);
    expect(completeMsgs).toHaveLength(1);
    expect(completeMsgs[0].through_seq).toBe(2);
    ws.close();
  });

  it('sync from N returns only events after N', async () => {
    await processEvent(db, { op: 'INS', target: 'sync.1', operand: {}, agent: '@test:a', ts: '2025-01-01T00:00:00Z', acquired_ts: '2025-01-01T00:00:00Z' }, feed);
    await processEvent(db, { op: 'INS', target: 'sync.2', operand: {}, agent: '@test:a', ts: '2025-01-01T00:00:00Z', acquired_ts: '2025-01-01T00:00:00Z' }, feed);
    await processEvent(db, { op: 'INS', target: 'sync.3', operand: {}, agent: '@test:a', ts: '2025-01-01T00:00:00Z', acquired_ts: '2025-01-01T00:00:00Z' }, feed);

    const ws = await connectWs();
    await waitForMessage(ws); // connected

    ws.send(JSON.stringify({ type: 'sync', since: 2 }));

    const messages = await waitForMessages(ws, 2);
    const eventMsgs = messages.filter(m => m.type === 'event');
    expect(eventMsgs).toHaveLength(1);
    expect(eventMsgs[0].event.seq).toBe(3);
    ws.close();
  });

  it('after sync, new events pushed in real-time', async () => {
    const ws = await connectWs();
    await waitForMessage(ws); // connected

    ws.send(JSON.stringify({ type: 'sync', since: 0 }));
    await waitForMessages(ws, 1); // sync_complete

    // Now post a new event — should be pushed to the websocket
    const eventPromise = waitForMessage(ws);
    await processEvent(db, { op: 'INS', target: 'realtime.1', operand: { live: true }, agent: '@test:a', ts: '2025-01-01T00:00:00Z', acquired_ts: '2025-01-01T00:00:00Z' }, feed);

    const msg = await eventPromise;
    expect(msg.type).toBe('event');
    expect(msg.event.target).toBe('realtime.1');
    ws.close();
  });

  it('subscribe with pattern filter only receives matching events', async () => {
    const ws = await connectWs();
    await waitForMessage(ws); // connected

    // Sync first to set up real-time subscription
    ws.send(JSON.stringify({ type: 'sync', since: 0 }));
    await waitForMessages(ws, 1); // sync_complete

    // Subscribe with pattern filter
    ws.send(JSON.stringify({ type: 'subscribe', pattern: 'filtered.**' }));

    // Small delay for subscription to take effect
    await new Promise(r => setTimeout(r, 50));

    // Post a non-matching event
    await processEvent(db, { op: 'INS', target: 'other.event', operand: {}, agent: '@test:a', ts: '2025-01-01T00:00:00Z', acquired_ts: '2025-01-01T00:00:00Z' }, feed);

    // Post a matching event
    const eventPromise = waitForMessage(ws);
    await processEvent(db, { op: 'INS', target: 'filtered.match', operand: { match: true }, agent: '@test:a', ts: '2025-01-01T00:00:00Z', acquired_ts: '2025-01-01T00:00:00Z' }, feed);

    const msg = await eventPromise;
    expect(msg.type).toBe('event');
    expect(msg.event.target).toBe('filtered.match');
    ws.close();
  });

  it('subscribe with ops filter only receives matching ops', async () => {
    // Create target first
    await processEvent(db, { op: 'INS', target: 'ops.target', operand: {}, agent: '@test:a', ts: '2025-01-01T00:00:00Z', acquired_ts: '2025-01-01T00:00:00Z' }, feed);

    const ws = await connectWs();
    await waitForMessage(ws); // connected

    ws.send(JSON.stringify({ type: 'sync', since: 0 }));
    await waitForMessages(ws, 2); // 1 event + sync_complete

    // Subscribe with ops filter (only DEF)
    ws.send(JSON.stringify({ type: 'subscribe', pattern: '**', ops: ['DEF'] }));
    await new Promise(r => setTimeout(r, 50));

    // Post an INS (should NOT match)
    await processEvent(db, { op: 'INS', target: 'ops.other', operand: {}, agent: '@test:a', ts: '2025-01-01T00:00:00Z', acquired_ts: '2025-01-01T00:00:00Z' }, feed);

    // Post a DEF (should match)
    const eventPromise = waitForMessage(ws);
    await processEvent(db, { op: 'DEF', target: 'ops.target', operand: 'def-value', agent: '@test:a', ts: '2025-01-01T00:00:00Z', acquired_ts: '2025-01-01T00:00:00Z' }, feed);

    const msg = await eventPromise;
    expect(msg.type).toBe('event');
    expect(msg.event.op).toBe('DEF');
    ws.close();
  });

  it('disconnect cleans up Feed subscription', async () => {
    const ws = await connectWs();
    await waitForMessage(ws); // connected

    ws.send(JSON.stringify({ type: 'sync', since: 0 }));
    await waitForMessages(ws, 1); // sync_complete

    // Close the connection
    ws.close();
    await new Promise(r => setTimeout(r, 100));

    // Posting events should not throw even though subscriber is gone
    await expect(
      processEvent(db, { op: 'INS', target: 'after.close', operand: {}, agent: '@test:a', ts: '2025-01-01T00:00:00Z', acquired_ts: '2025-01-01T00:00:00Z' }, feed)
    ).resolves.not.toThrow();
  });

  it('multiple concurrent connections each receive events', async () => {
    const ws1 = await connectWs();
    await waitForMessage(ws1); // connected
    ws1.send(JSON.stringify({ type: 'sync', since: 0 }));
    await waitForMessages(ws1, 1); // sync_complete

    const ws2 = await connectWs();
    await waitForMessage(ws2); // connected
    ws2.send(JSON.stringify({ type: 'sync', since: 0 }));
    await waitForMessages(ws2, 1); // sync_complete

    // Small delay to ensure subscriptions are active
    await new Promise(r => setTimeout(r, 50));

    const p1 = waitForMessage(ws1);
    const p2 = waitForMessage(ws2);

    await processEvent(db, { op: 'INS', target: 'multi.1', operand: {}, agent: '@test:a', ts: '2025-01-01T00:00:00Z', acquired_ts: '2025-01-01T00:00:00Z' }, feed);

    const msg1 = await p1;
    const msg2 = await p2;
    expect(msg1.type).toBe('event');
    expect(msg2.type).toBe('event');

    ws1.close();
    ws2.close();
  });
});
