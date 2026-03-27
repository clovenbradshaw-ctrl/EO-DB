import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import { processEvent } from '../src/db/fold.js';
import { horizonGet, type HorizonResult } from '../src/db/horizon.js';
import type { EoEventInput } from '../src/db/types.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

const AGENT = '@test:app.aminoimmigration.com';
const TS = '2025-06-01T00:00:00.000Z';

function ev(overrides: Partial<EoEventInput>): EoEventInput {
  return { op: 'INS', target: 'test', operand: {}, agent: AGENT, ts: TS, ...overrides };
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

describe('horizonGet', () => {
  it('returns EoState for existing target', async () => {
    await processEvent(db, ev({ target: 'app.rec001', operand: { name: 'Maria' } }));
    const result = await horizonGet(db, 'app.rec001') as HorizonResult;
    expect(result).not.toBeNull();
    expect(result.state.value).toEqual({ name: 'Maria' });
  });

  it('returns null for non-existent target', async () => {
    const result = await horizonGet(db, 'nonexistent');
    expect(result).toBeNull();
  });

  it('resolves SYN alias and returns merged target state', async () => {
    await processEvent(db, ev({ target: 'p.A', operand: { x: 1 } }));
    await processEvent(db, ev({ target: 'p.B', operand: { y: 2 } }));
    await processEvent(db, ev({
      op: 'SYN', target: 'p.merged',
      operand: { merge: ['p.A', 'p.B'], into: 'p.merged' },
    }));

    const result = await horizonGet(db, 'p.A') as HorizonResult;
    expect(result).not.toBeNull();
    expect(result.state.target).toBe('p.merged');
    expect(result.state.value).toHaveProperty('x');
  });

  it('returns array of states with prefix=true', async () => {
    await processEvent(db, ev({ target: 'app.tbl.rec001', operand: { a: 1 } }));
    await processEvent(db, ev({ target: 'app.tbl.rec002', operand: { b: 2 } }));
    await processEvent(db, ev({ target: 'other.rec', operand: { c: 3 } }));

    const results = await horizonGet(db, 'app.tbl', { prefix: true }) as HorizonResult[];
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(2);
  });

  it('evaluates horizon-computed formula at read time with _now and _today', async () => {
    await processEvent(db, ev({ target: 'data.src', operand: { filed: '2025-01-01' } }));
    await processEvent(db, ev({ target: 'data.deadline' }));
    await processEvent(db, ev({
      op: 'CON', target: 'data.deadline',
      operand: { added: ['data.src'] },
    }));
    await processEvent(db, ev({
      op: 'DEF', target: 'data.deadline',
      operand: { formula: 'DAYS_UNTIL(filed + 180)' },
    }));

    const result = await horizonGet(db, 'data.deadline') as HorizonResult;
    expect(result.state.value._computed).toBeDefined();
    expect(result.state.value._computed.inputs._now).toBeDefined();
    expect(result.state.value._computed.inputs._today).toBeDefined();
    expect(result.state.value._computed.inputs['data.src']).toBeDefined();
  });

  it('returns fold-computed value from state (no read-time eval)', async () => {
    await processEvent(db, ev({ target: 'data.x', operand: { val: 5 } }));
    await processEvent(db, ev({ target: 'data.calc' }));
    await processEvent(db, ev({
      op: 'CON', target: 'data.calc',
      operand: { added: ['data.x'] },
    }));
    await processEvent(db, ev({
      op: 'DEF', target: 'data.calc',
      operand: { formula: 'SUM(x)' },
    }));

    const result = await horizonGet(db, 'data.calc') as HorizonResult;
    // Fold-computed should already have _computed from write-time
    expect(result.state.value._computed).toBeDefined();
  });

  it('returns boundary info for SEG targets', async () => {
    await processEvent(db, ev({ target: 'app.archived' }));
    await processEvent(db, ev({
      op: 'SEG', target: 'app.archived',
      operand: { boundary: 'exclude', reason: 'old' },
    }));

    const result = await horizonGet(db, 'app.archived') as HorizonResult;
    expect(result.boundary).toEqual({ boundary: 'exclude', reason: 'old' });
  });
});
