import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, padSeq, nextSeq, type EoDb } from '../src/db/level.js';
import { appendToLog, readLogSince, readLogForTarget } from '../src/db/log.js';
import type { EoEvent } from '../src/db/types.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

function makeEvent(overrides: Partial<EoEvent> = {}): EoEvent {
  return {
    seq: 1,
    op: 'INS',
    target: 'app.tblClients.rec001',
    operand: { name: 'Maria Garcia' },
    agent: '@intake:app.aminoimmigration.com',
    ts: '2025-06-01T00:00:00.000Z',
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

describe('padSeq', () => {
  it('zero-pads to 12 digits', () => {
    expect(padSeq(1)).toBe('000000000001');
    expect(padSeq(42)).toBe('000000000042');
    expect(padSeq(999999999999)).toBe('999999999999');
  });
});

describe('nextSeq', () => {
  it('starts at 1', async () => {
    expect(await nextSeq(db)).toBe(1);
  });

  it('increments on each call', async () => {
    expect(await nextSeq(db)).toBe(1);
    expect(await nextSeq(db)).toBe(2);
    expect(await nextSeq(db)).toBe(3);
  });
});

describe('appendToLog', () => {
  it('writes event and can be read back', async () => {
    const event = makeEvent({ seq: 1 });
    await appendToLog(db, event);
    const events = await readLogSince(db, 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it('sequential calls produce incrementing seq numbers', async () => {
    await appendToLog(db, makeEvent({ seq: 1, target: 'a' }));
    await appendToLog(db, makeEvent({ seq: 2, target: 'b' }));
    await appendToLog(db, makeEvent({ seq: 3, target: 'c' }));
    const events = await readLogSince(db, 0);
    expect(events.map(e => e.seq)).toEqual([1, 2, 3]);
  });
});

describe('readLogSince', () => {
  beforeEach(async () => {
    for (let i = 1; i <= 5; i++) {
      await appendToLog(db, makeEvent({ seq: i, target: `target.${i}` }));
    }
  });

  it('returns all events when since=0', async () => {
    const events = await readLogSince(db, 0);
    expect(events).toHaveLength(5);
  });

  it('returns only events after seq N', async () => {
    const events = await readLogSince(db, 3);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(4);
    expect(events[1].seq).toBe(5);
  });

  it('respects limit parameter', async () => {
    const events = await readLogSince(db, 0, 2);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
  });

  it('returns empty array for empty log', async () => {
    const freshPath = mkdtempSync(join(tmpdir(), 'eo-db-test-'));
    const freshDb = createDb(freshPath);
    await freshDb.open();
    const events = await readLogSince(freshDb, 0);
    expect(events).toHaveLength(0);
    await freshDb.close();
    rmSync(freshPath, { recursive: true, force: true });
  });
});

describe('readLogForTarget', () => {
  beforeEach(async () => {
    await appendToLog(db, makeEvent({ seq: 1, target: 'app.tblClients.rec001' }));
    await appendToLog(db, makeEvent({ seq: 2, target: 'app.tblCases.rec101' }));
    await appendToLog(db, makeEvent({ seq: 3, target: 'app.tblClients.rec001', op: 'DEF', operand: 'updated' }));
    await appendToLog(db, makeEvent({ seq: 4, target: 'app.tblCases.rec101', op: 'DEF', operand: 'pending' }));
  });

  it('returns only events matching target', async () => {
    const events = await readLogForTarget(db, 'app.tblClients.rec001');
    expect(events).toHaveLength(2);
    expect(events.every(e => e.target === 'app.tblClients.rec001')).toBe(true);
  });

  it('returns events in seq order', async () => {
    const events = await readLogForTarget(db, 'app.tblClients.rec001');
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(3);
  });

  it('returns empty for nonexistent target', async () => {
    const events = await readLogForTarget(db, 'app.nonexistent');
    expect(events).toHaveLength(0);
  });
});
