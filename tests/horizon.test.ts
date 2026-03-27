import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import { processEvent } from '../src/db/fold.js';
import { horizonGet } from '../src/db/horizon.js';
import type { EoEventInput, HorizonResponse } from '../src/db/types.js';
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

// --- Layer 1: Figure ---

describe('Layer 1: Figure', () => {
  it('returns figure state for existing target', async () => {
    await processEvent(db, ev({ target: 'app.rec001', operand: { name: 'Maria' } }));
    const result = await horizonGet(db, 'app.rec001') as HorizonResponse;
    expect(result).not.toBeNull();
    expect(result.figure?.value).toEqual({ name: 'Maria' });
    expect(result.target).toBe('app.rec001');
  });

  it('returns null for non-existent target', async () => {
    const result = await horizonGet(db, 'nonexistent');
    expect(result).toBeNull();
  });

  it('resolves SYN alias and returns merged target figure', async () => {
    await processEvent(db, ev({ target: 'p.A', operand: { x: 1 } }));
    await processEvent(db, ev({ target: 'p.B', operand: { y: 2 } }));
    await processEvent(db, ev({
      op: 'SYN', target: 'p.merged',
      operand: { merge: ['p.A', 'p.B'], into: 'p.merged' },
    }));

    const result = await horizonGet(db, 'p.A') as HorizonResponse;
    expect(result).not.toBeNull();
    expect(result.target).toBe('p.merged');
  });

  it('returns array of responses with prefix=true', async () => {
    await processEvent(db, ev({ target: 'app.tbl.rec001', operand: { a: 1 } }));
    await processEvent(db, ev({ target: 'app.tbl.rec002', operand: { b: 2 } }));

    const results = await horizonGet(db, 'app.tbl', { prefix: true }) as HorizonResponse[];
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(2);
    expect(results[0].figure).toBeDefined();
    expect(results[0].grounds).toBeDefined();
  });

  it('evaluates horizon-computed formula at read time with _now and _today', async () => {
    await processEvent(db, ev({ target: 'data.src', operand: { filed: '2025-01-01' } }));
    await processEvent(db, ev({ target: 'data.deadline' }));
    await processEvent(db, ev({ op: 'CON', target: 'data.deadline', operand: { added: ['data.src'] } }));
    await processEvent(db, ev({ op: 'DEF', target: 'data.deadline', operand: { formula: 'DAYS_UNTIL(filed + 180)' } }));

    const result = await horizonGet(db, 'data.deadline') as HorizonResponse;
    expect(result.figure?.value._computed).toBeDefined();
    expect(result.figure?.value._computed.inputs._now).toBeDefined();
    expect(result.figure?.value._computed.inputs._today).toBeDefined();
  });

  it('returns boundary info for SEG targets', async () => {
    await processEvent(db, ev({ target: 'app.archived' }));
    await processEvent(db, ev({ op: 'SEG', target: 'app.archived', operand: { boundary: 'exclude', reason: 'old' } }));

    const result = await horizonGet(db, 'app.archived') as HorizonResponse;
    expect(result.figure?.value).toEqual({ boundary: 'exclude', reason: 'old' });
  });
});

// --- Layer 2: Grounds ---

describe('Layer 2: Grounds', () => {
  it('DEF at collection level is returned as ground for record-level reads', async () => {
    // Set collection-level ambient property
    await processEvent(db, ev({ op: 'DEF', target: 'app.tblClients', operand: { regulatoryHold: true, defaultRegion: 'Nashville' } }));
    // Create a record
    await processEvent(db, ev({ target: 'app.tblClients.rec001', operand: { name: 'Maria' } }));

    const result = await horizonGet(db, 'app.tblClients.rec001') as HorizonResponse;
    expect(result.grounds.length).toBeGreaterThan(0);
    expect(result.grounds.some(g => g.key === 'regulatoryHold' && g.value === true)).toBe(true);
    expect(result.grounds.some(g => g.key === 'defaultRegion' && g.value === 'Nashville')).toBe(true);
    expect(result.grounds[0].distance).toBe(1); // parent
  });

  it('DEF at app level is returned as ground for deeper reads', async () => {
    await processEvent(db, ev({ op: 'DEF', target: 'app', operand: { timezone: 'America/Chicago' } }));
    await processEvent(db, ev({ target: 'app.tblClients.rec001', operand: { name: 'Maria' } }));

    const result = await horizonGet(db, 'app.tblClients.rec001') as HorizonResponse;
    expect(result.grounds.some(g => g.key === 'timezone' && g.distance === 2)).toBe(true);
  });

  it('figure value overrides ancestor ground with same key', async () => {
    await processEvent(db, ev({ op: 'DEF', target: 'app.tblClients', operand: { status: 'default' } }));
    await processEvent(db, ev({ target: 'app.tblClients.rec001', operand: { status: 'custom' } }));

    const result = await horizonGet(db, 'app.tblClients.rec001') as HorizonResponse;
    // 'status' should NOT appear in grounds because figure overrides it
    expect(result.grounds.every(g => g.key !== 'status')).toBe(true);
    // Figure has the override
    expect(result.figure?.value.status).toBe('custom');
  });

  it('grounds excluded when grounds=false', async () => {
    await processEvent(db, ev({ op: 'DEF', target: 'app.tblClients', operand: { region: 'East' } }));
    await processEvent(db, ev({ target: 'app.tblClients.rec001', operand: {} }));

    const result = await horizonGet(db, 'app.tblClients.rec001', { grounds: false }) as HorizonResponse;
    expect(result.grounds).toEqual([]);
  });

  it('empty grounds when no ancestors have state', async () => {
    await processEvent(db, ev({ target: 'isolated.target', operand: { solo: true } }));

    const result = await horizonGet(db, 'isolated.target') as HorizonResponse;
    expect(result.grounds).toEqual([]);
  });
});

// --- Layer 3: Signals ---

describe('Layer 3: Signals', () => {
  it('signals only computed when requested', async () => {
    await processEvent(db, ev({ target: 'app.tbl.rec001', operand: {} }));

    const without = await horizonGet(db, 'app.tbl.rec001') as HorizonResponse;
    expect(without.signals).toBeUndefined();

    const with_ = await horizonGet(db, 'app.tbl.rec001', { signals: true }) as HorizonResponse;
    expect(with_.signals).toBeDefined();
  });

  it('returns population count signal', async () => {
    // Need at least 3 records for signals
    await processEvent(db, ev({ target: 'pop.tbl.rec001', operand: { x: 1 } }));
    await processEvent(db, ev({ target: 'pop.tbl.rec002', operand: { x: 2 } }));
    await processEvent(db, ev({ target: 'pop.tbl.rec003', operand: { x: 3 } }));

    const result = await horizonGet(db, 'pop.tbl.rec001', { signals: true }) as HorizonResponse;
    expect(result.signals).toBeDefined();
    expect(result.signals!.some(s => s.measure === 'count')).toBe(true);
    expect(result.signals!.find(s => s.measure === 'count')!.value).toBe(3);
  });

  it('empty signals when population too small', async () => {
    await processEvent(db, ev({ target: 'small.tbl.rec001', operand: {} }));
    await processEvent(db, ev({ target: 'small.tbl.rec002', operand: {} }));

    const result = await horizonGet(db, 'small.tbl.rec001', { signals: true }) as HorizonResponse;
    expect(result.signals).toEqual([]);
  });

  it('detects outlier signal for numeric fields', async () => {
    // Create records with numeric field values
    await processEvent(db, ev({ target: 'stat.tbl.rec001', operand: {} }));
    await processEvent(db, ev({ target: 'stat.tbl.rec002', operand: {} }));
    await processEvent(db, ev({ target: 'stat.tbl.rec003', operand: {} }));
    await processEvent(db, ev({ target: 'stat.tbl.rec004', operand: {} }));

    // Set numeric field values — rec001 is an outlier
    await processEvent(db, ev({ op: 'DEF', target: 'stat.tbl.rec001.score', operand: 100 }));
    await processEvent(db, ev({ op: 'DEF', target: 'stat.tbl.rec002.score', operand: 10 }));
    await processEvent(db, ev({ op: 'DEF', target: 'stat.tbl.rec003.score', operand: 12 }));
    await processEvent(db, ev({ op: 'DEF', target: 'stat.tbl.rec004.score', operand: 11 }));

    const result = await horizonGet(db, 'stat.tbl.rec001', { signals: true }) as HorizonResponse;
    expect(result.signals).toBeDefined();
    const outlier = result.signals!.find(s => s.measure === 'score');
    expect(outlier).toBeDefined();
    expect(outlier!.description).toContain('above');
    expect(outlier!.value.z_score).toBeGreaterThan(1.5);
  });
});
