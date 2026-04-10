/**
 * Fold engine test — verifies the browser port produces identical results
 * to the server version using the spec's test fixtures.
 *
 * Uses a plain (unencrypted) in-memory store to test fold logic in isolation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { processEvent } from '../fold';
import { getState, getStateByPrefix } from '../state';
import { getEdgesFrom } from '../graph';
import { readLogSince } from '../log';
import { horizonGet } from '../horizon';
import type { EoStore } from '../encrypted-store';
import type { EoEventInput } from '../types';

/**
 * In-memory store for testing — no IndexedDB or encryption needed.
 * Same interface as EoStore but backed by a plain Map.
 */
function createTestStore(): EoStore {
  const data = new Map<string, any>();
  let seq = 0;

  return {
    async get(key: string) {
      return data.has(key) ? data.get(key) : null;
    },
    async put(key: string, value: any) {
      data.set(key, value);
    },
    async del(key: string) {
      data.delete(key);
    },
    async iterator(prefix: string) {
      const results: [string, any][] = [];
      for (const [key, value] of data.entries()) {
        if (key >= prefix && key <= prefix + '\uffff') {
          results.push([key, value]);
        }
      }
      results.sort((a, b) => a[0].localeCompare(b[0]));
      return results;
    },
    async nextSeq() {
      seq += 1;
      data.set('meta:seq', seq);
      return seq;
    },
    async getCurrentSeq() {
      return seq;
    },
    close() {},
  };
}

// Spec fixtures
const FIXTURES: EoEventInput[] = [
  { op: 'INS', target: 'app.tblClients.rec001', operand: { name: 'Maria Garcia', status: 'active' }, agent: '@test:matrix.example.com', ts: '2025-01-01T00:00:00Z', acquired_ts: '2025-01-01T00:00:00Z', client_event_id: 'fix-001' },
  { op: 'INS', target: 'app.tblCases.rec101', operand: { type: 'H1B', filed: '2025-06-01' }, agent: '@test:matrix.example.com', ts: '2025-01-01T00:01:00Z', acquired_ts: '2025-01-01T00:01:00Z', client_event_id: 'fix-002' },
  { op: 'CON', target: 'app.tblClients.rec001.fldCases', operand: { added: ['app.tblCases.rec101'] }, agent: '@test:matrix.example.com', ts: '2025-01-01T00:02:00Z', acquired_ts: '2025-01-01T00:02:00Z', client_event_id: 'fix-003' },
  { op: 'DEF', target: 'app.tblCases.rec101.fldStatus', operand: 'pending', agent: '@test:matrix.example.com', ts: '2025-01-01T00:03:00Z', acquired_ts: '2025-01-01T00:03:00Z', client_event_id: 'fix-004' },
  { op: 'DEF', target: 'app.tblCases.rec101.fldStatus', operand: 'approved', agent: '@test:matrix.example.com', ts: '2025-01-01T00:04:00Z', acquired_ts: '2025-01-01T00:04:00Z', client_event_id: 'fix-005' },
  { op: 'DEF', target: 'app.tblClients.rec001.fldEmail', operand: 'maria@old.com', agent: '@test:matrix.example.com', ts: '2025-01-01T00:05:00Z', acquired_ts: '2025-01-01T00:05:00Z', client_event_id: 'fix-006' },
  { op: 'DEF', target: 'app.tblClients.rec001.fldEmail', operand: 'maria@new.com', agent: '@test:matrix.example.com', ts: '2025-01-01T00:06:00Z', acquired_ts: '2025-01-01T00:06:00Z', client_event_id: 'fix-007' },
  { op: 'EVA', target: 'app.tblClients.rec001.fldEmail', operand: { strategy: 'latest' }, agent: '@test:matrix.example.com', ts: '2025-01-01T00:07:00Z', acquired_ts: '2025-01-01T00:07:00Z', client_event_id: 'fix-008' },
  { op: 'DEF', target: 'app.tblClients', operand: { regulatoryHold: true, defaultRegion: 'Nashville' }, agent: '@test:matrix.example.com', ts: '2025-01-01T00:08:00Z', acquired_ts: '2025-01-01T00:08:00Z', client_event_id: 'fix-020' },
  { op: 'DEF', target: 'app', operand: { timezone: 'America/Chicago', firm: 'Amino Immigration' }, agent: '@test:matrix.example.com', ts: '2025-01-01T00:09:00Z', acquired_ts: '2025-01-01T00:09:00Z', client_event_id: 'fix-021' },
];

describe('Fold engine (browser port)', () => {
  let store: EoStore;

  beforeEach(() => {
    store = createTestStore();
  });

  it('processes INS — creates state at target', async () => {
    await processEvent(store, FIXTURES[0]);
    const state = await getState(store, 'app.tblClients.rec001');
    expect(state).not.toBeNull();
    expect(state!.value).toEqual({ name: 'Maria Garcia', status: 'active' });
    expect(state!.last_op).toBe('INS');
    expect(state!.last_agent).toBe('@test:matrix.example.com');
  });

  it('assigns sequential seq numbers', async () => {
    const seq1 = await processEvent(store, FIXTURES[0]);
    const seq2 = await processEvent(store, FIXTURES[1]);
    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
  });

  it('rejects duplicate INS on same target', async () => {
    await processEvent(store, FIXTURES[0]);
    await expect(processEvent(store, {
      ...FIXTURES[0],
      client_event_id: 'dup-001',
    })).rejects.toThrow('Target already instantiated');
  });

  it('idempotency — same client_event_id returns original seq', async () => {
    const seq1 = await processEvent(store, FIXTURES[0]);
    const seq2 = await processEvent(store, FIXTURES[0]);
    expect(seq1).toBe(seq2);
  });

  it('processes CON — creates graph edges', async () => {
    await processEvent(store, FIXTURES[0]); // INS rec001
    await processEvent(store, FIXTURES[1]); // INS rec101
    await processEvent(store, FIXTURES[2]); // CON rec001.fldCases -> rec101

    const edges = await getEdgesFrom(store, 'app.tblClients.rec001.fldCases');
    expect(edges.length).toBe(1);
    expect(edges[0].dest).toBe('app.tblCases.rec101');
  });

  it('processes DEF — auto-instantiates and merges', async () => {
    await processEvent(store, FIXTURES[0]); // INS rec001
    await processEvent(store, FIXTURES[1]); // INS rec101
    await processEvent(store, FIXTURES[2]); // CON
    await processEvent(store, FIXTURES[3]); // DEF fldStatus = 'pending'

    const state = await getState(store, 'app.tblCases.rec101.fldStatus');
    expect(state).not.toBeNull();
    expect(state!.last_op).toBe('DEF');
  });

  it('DEF overwrites scalar values (last write wins)', async () => {
    await processEvent(store, FIXTURES[0]);
    await processEvent(store, FIXTURES[1]);
    await processEvent(store, FIXTURES[2]);
    await processEvent(store, FIXTURES[3]); // fldStatus = 'pending'
    await processEvent(store, FIXTURES[4]); // fldStatus = 'approved'

    const state = await getState(store, 'app.tblCases.rec101.fldStatus');
    expect(state!.value).toBe('approved');
  });

  it('processes EVA — writes evaluation policy', async () => {
    await processEvent(store, FIXTURES[0]);
    await processEvent(store, FIXTURES[1]);
    await processEvent(store, FIXTURES[2]);
    await processEvent(store, FIXTURES[3]);
    await processEvent(store, FIXTURES[4]);
    await processEvent(store, FIXTURES[5]); // DEF fldEmail = 'maria@old.com'
    await processEvent(store, FIXTURES[6]); // DEF fldEmail = 'maria@new.com'
    await processEvent(store, FIXTURES[7]); // EVA fldEmail strategy:latest

    const state = await getState(store, 'app.tblClients.rec001.fldEmail');
    expect(state!.last_op).toBe('EVA');
    expect(state!.value).toEqual({ strategy: 'latest' });
  });

  it('processes full fixture sequence', async () => {
    for (const fixture of FIXTURES) {
      await processEvent(store, fixture);
    }

    // Verify all seq numbers assigned.
    // The 10 fixture events trigger 5 system INS auto-promotions via checkAndPromote
    // (for app.tblClients.rec001.fldCases, app.tblCases.rec101.fldStatus,
    //  app.tblClients.rec001.fldEmail, app.tblClients, app), giving 15 total.
    const currentSeq = await store.getCurrentSeq();
    expect(currentSeq).toBe(15);

    // Verify log has all events (10 user-submitted + 5 system INS promotions)
    const events = await readLogSince(store, 0);
    expect(events.length).toBe(15);

    // Verify key states
    const rec001 = await getState(store, 'app.tblClients.rec001');
    expect(rec001!.value.name).toBe('Maria Garcia');

    const rec101 = await getState(store, 'app.tblCases.rec101');
    expect(rec101!.value.type).toBe('H1B');

    // Verify app-level DEF
    const app = await getState(store, 'app');
    expect(app!.value.timezone).toBe('America/Chicago');
    expect(app!.value.firm).toBe('Amino Immigration');

    // Verify collection-level DEF
    const clients = await getState(store, 'app.tblClients');
    expect(clients!.value.regulatoryHold).toBe(true);
    expect(clients!.value.defaultRegion).toBe('Nashville');
  });

  it('Horizon — grounds inherit from ancestors', async () => {
    for (const fixture of FIXTURES) {
      await processEvent(store, fixture);
    }

    const response = await horizonGet(store, 'app.tblClients.rec001');
    expect(response).not.toBeNull();

    const hr = response as any;
    expect(hr.figure).not.toBeNull();
    expect(hr.figure.value.name).toBe('Maria Garcia');

    // Grounds should include ancestor values
    expect(hr.grounds.length).toBeGreaterThan(0);
    const groundKeys = hr.grounds.map((g: any) => g.key);
    expect(groundKeys).toContain('regulatoryHold');
    expect(groundKeys).toContain('timezone');
  });

  it('Horizon — trajectory shows operator history', async () => {
    // Process a subset of fixtures targeting rec001
    await processEvent(store, FIXTURES[0]); // INS rec001
    const response = await horizonGet(store, 'app.tblClients.rec001');
    const hr = response as any;

    expect(hr.trajectory).toHaveLength(1);
    expect(hr.trajectory[0].op).toBe('INS');
    expect(hr.trajectory[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
