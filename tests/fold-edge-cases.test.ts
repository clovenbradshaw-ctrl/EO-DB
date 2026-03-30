import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import { processEvent } from '../src/db/fold.js';
import { getState } from '../src/db/state.js';
import { readLogSince } from '../src/db/log.js';
import { getEdgesFrom } from '../src/db/graph.js';
import type { EoEventInput } from '../src/db/types.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

const AGENT = '@test:matrix.example.com';
const TS = '2025-06-01T00:00:00.000Z';

function ev(overrides: Partial<EoEventInput>): EoEventInput {
  return {
    op: 'INS',
    target: 'app.tbl.rec001',
    operand: {},
    agent: AGENT,
    ts: TS,
    acquired_ts: TS,
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

// --- NUL operator ---

describe('NUL', () => {
  it('logs the event but does not create state', async () => {
    const seq = await processEvent(db, ev({ op: 'NUL', target: 'app.observe.target' }));
    expect(seq).toBeGreaterThan(0);
    // NUL should not create state for the target
    const state = await getState(db, 'app.observe.target');
    expect(state).toBeNull();
  });

  it('is logged in the event log', async () => {
    await processEvent(db, ev({ op: 'NUL', target: 'app.observe.x' }));
    const log = await readLogSince(db, 0);
    expect(log.length).toBeGreaterThanOrEqual(1);
    const nulEvent = log.find(e => e.op === 'NUL');
    expect(nulEvent).toBeDefined();
    expect(nulEvent!.target).toBe('app.observe.x');
  });

  it('does not affect existing state', async () => {
    await processEvent(db, ev({ target: 'app.tbl.rec001', operand: { name: 'Alice' } }));
    await processEvent(db, ev({ op: 'NUL', target: 'app.tbl.rec001' }));
    const state = await getState(db, 'app.tbl.rec001');
    expect(state?.value).toEqual({ name: 'Alice' });
    expect(state?.last_op).toBe('INS'); // NUL should not update state
  });
});

// --- SEG error path ---

describe('SEG errors', () => {
  it('throws when target does not exist', async () => {
    await expect(
      processEvent(db, ev({ op: 'SEG', target: 'nonexistent.target', operand: { boundary: 'standard' } }))
    ).rejects.toThrow('SEG target does not exist');
  });

  it('succeeds when target exists', async () => {
    await processEvent(db, ev({ target: 'app.tbl' }));
    const seq = await processEvent(db, ev({ op: 'SEG', target: 'app.tbl', operand: { boundary: 'standard' } }));
    expect(seq).toBeGreaterThan(0);
    const state = await getState(db, 'app.tbl');
    expect(state?.last_op).toBe('SEG');
  });
});

// --- CON error path ---

describe('CON errors', () => {
  it('throws when destination does not exist', async () => {
    await processEvent(db, ev({ target: 'app.tbl.rec001' }));
    await expect(
      processEvent(db, ev({
        op: 'CON',
        target: 'app.tbl.rec001',
        operand: { added: ['nonexistent.dest'] },
      }))
    ).rejects.toThrow('CON target does not exist');
  });

  it('succeeds when both endpoints exist', async () => {
    await processEvent(db, ev({ target: 'app.tbl.rec001' }));
    await processEvent(db, ev({ target: 'app.tbl.rec002' }));
    const seq = await processEvent(db, ev({
      op: 'CON',
      target: 'app.tbl.rec001',
      operand: { added: ['app.tbl.rec002'] },
    }));
    expect(seq).toBeGreaterThan(0);
    const edges = await getEdgesFrom(db, 'app.tbl.rec001');
    expect(edges.map(e => e.dest)).toContain('app.tbl.rec002');
  });

  it('handles operand with only removed (no added)', async () => {
    await processEvent(db, ev({ target: 'app.tbl.rec001' }));
    await processEvent(db, ev({ target: 'app.tbl.rec002' }));
    await processEvent(db, ev({
      op: 'CON',
      target: 'app.tbl.rec001',
      operand: { added: ['app.tbl.rec002'] },
    }));
    const seq = await processEvent(db, ev({
      op: 'CON',
      target: 'app.tbl.rec001',
      operand: { removed: ['app.tbl.rec002'] },
    }));
    expect(seq).toBeGreaterThan(0);
    const edges = await getEdgesFrom(db, 'app.tbl.rec001');
    expect(edges).toHaveLength(0);
  });
});

// --- SYN error path ---

describe('SYN errors', () => {
  it('throws when first merge target does not exist', async () => {
    await processEvent(db, ev({ target: 'app.tbl.rec002' }));
    await expect(
      processEvent(db, ev({
        op: 'SYN',
        target: 'app.tbl.merged',
        operand: { merge: ['nonexistent', 'app.tbl.rec002'] },
      }))
    ).rejects.toThrow('SYN merge targets must both exist');
  });

  it('throws when second merge target does not exist', async () => {
    await processEvent(db, ev({ target: 'app.tbl.rec001' }));
    await expect(
      processEvent(db, ev({
        op: 'SYN',
        target: 'app.tbl.merged',
        operand: { merge: ['app.tbl.rec001', 'nonexistent'] },
      }))
    ).rejects.toThrow('SYN merge targets must both exist');
  });
});

// --- DEF level guard ---

describe('DEF level guard', () => {
  it('rejects DEF on derived entity (level > 1) by non-system agent', async () => {
    // Create a level-2 entity (system-generated)
    await processEvent(db, ev({
      target: 'app.tbl.derived001',
      operand: { name: 'Derived' },
      agent: 'system',
      level: 2,
    }));
    // Non-system agent tries to DEF the core
    await expect(
      processEvent(db, ev({
        op: 'DEF',
        target: 'app.tbl.derived001',
        operand: { name: 'Hacked' },
        agent: AGENT,
      }))
    ).rejects.toThrow('Cannot DEF core content of derived entity');
  });

  it('allows DEF on derived entity by system agent', async () => {
    await processEvent(db, ev({
      target: 'app.tbl.derived001',
      operand: {},
      agent: 'system',
      level: 2,
    }));
    const seq = await processEvent(db, ev({
      op: 'DEF',
      target: 'app.tbl.derived001',
      operand: { computed: true },
      agent: 'system',
    }));
    expect(seq).toBeGreaterThan(0);
    const state = await getState(db, 'app.tbl.derived001');
    expect(state?.value.computed).toBe(true);
  });

  it('allows DEF on level-1 entity by any agent', async () => {
    await processEvent(db, ev({ target: 'app.tbl.rec001', operand: { name: 'Original' } }));
    const seq = await processEvent(db, ev({
      op: 'DEF',
      target: 'app.tbl.rec001',
      operand: { name: 'Updated' },
    }));
    expect(seq).toBeGreaterThan(0);
    const state = await getState(db, 'app.tbl.rec001');
    expect(state?.value.name).toBe('Updated');
  });
});

// --- Idempotency ---

describe('idempotency', () => {
  it('returns same seq for duplicate client_event_id', async () => {
    const input = ev({ client_event_id: 'unique-hash-123', operand: { name: 'Test' } });
    const seq1 = await processEvent(db, input);
    const seq2 = await processEvent(db, input);
    expect(seq1).toBe(seq2);
  });

  it('assigns different seqs for different events', async () => {
    const seq1 = await processEvent(db, ev({ target: 'app.tbl.rec001' }));
    const seq2 = await processEvent(db, ev({ target: 'app.tbl.rec002' }));
    expect(seq1).not.toBe(seq2);
  });
});

// --- REC rejection ---

describe('REC rejection', () => {
  it('rejects externally submitted REC events', async () => {
    await expect(
      processEvent(db, ev({ op: 'REC' as any, target: 'app.tbl.rec001' }))
    ).rejects.toThrow('REC is system-generated');
  });
});
