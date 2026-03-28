import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import { getState, setState, getStateByPrefix, removeState } from '../src/db/state.js';
import type { EoState } from '../src/db/types.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

function makeState(overrides: Partial<EoState> = {}): EoState {
  return {
    target: 'app.tblClients.rec001',
    value: { name: 'Maria Garcia', status: 'active' },
    last_seq: 1,
    last_op: 'INS',
    last_agent: '@intake:app.aminoimmigration.com',
    last_ts: '2025-06-01T00:00:00.000Z',
    last_acquired_ts: '2025-06-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-test-'));
  db = createDb(dbPath);
  await db.open();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

describe('setState + getState', () => {
  it('round-trips correctly', async () => {
    const state = makeState();
    await setState(db, state);
    const result = await getState(db, state.target);
    expect(result).toEqual(state);
  });

  it('returns null for nonexistent target', async () => {
    const result = await getState(db, 'nonexistent.target');
    expect(result).toBeNull();
  });

  it('overwrites existing state', async () => {
    await setState(db, makeState({ value: { name: 'Old' } }));
    await setState(db, makeState({ value: { name: 'New' }, last_seq: 2 }));
    const result = await getState(db, 'app.tblClients.rec001');
    expect(result?.value).toEqual({ name: 'New' });
    expect(result?.last_seq).toBe(2);
  });

  it('handles complex nested operands', async () => {
    const complexValue = {
      name: 'Maria Garcia',
      addresses: [{ type: 'home', city: 'Miami' }],
      metadata: { tags: ['vip', 'urgent'], nested: { deep: true } },
    };
    await setState(db, makeState({ value: complexValue }));
    const result = await getState(db, 'app.tblClients.rec001');
    expect(result?.value).toEqual(complexValue);
  });
});

describe('getStateByPrefix', () => {
  beforeEach(async () => {
    await setState(db, makeState({ target: 'app.tblClients.rec001' }));
    await setState(db, makeState({ target: 'app.tblClients.rec002', value: { name: 'John' } }));
    await setState(db, makeState({ target: 'app.tblCases.rec101', value: { type: 'H1B' } }));
  });

  it('returns all matching states', async () => {
    const states = await getStateByPrefix(db, 'app.tblClients');
    expect(states).toHaveLength(2);
    expect(states.map(s => s.target).sort()).toEqual([
      'app.tblClients.rec001',
      'app.tblClients.rec002',
    ]);
  });

  it('returns empty for no matches', async () => {
    const states = await getStateByPrefix(db, 'app.tblNonexistent');
    expect(states).toHaveLength(0);
  });
});

describe('removeState', () => {
  it('deletes target, subsequent getState returns null', async () => {
    await setState(db, makeState());
    await removeState(db, 'app.tblClients.rec001');
    const result = await getState(db, 'app.tblClients.rec001');
    expect(result).toBeNull();
  });
});
