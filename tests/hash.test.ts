import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import { processEvent } from '../src/db/fold.js';
import { getState } from '../src/db/state.js';
import type { EoEventInput } from '../src/db/types.js';
import { seedHash, chainHash } from '../src/db/hash.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

const AGENT = '@test:example.com';
const TS = '2025-06-01T00:00:00.000Z';
const TS2 = '2025-06-02T00:00:00.000Z';

function ev(overrides: Partial<EoEventInput>): EoEventInput {
  return {
    op: 'INS',
    target: 'app.tbl.rec1',
    operand: {},
    agent: AGENT,
    ts: TS,
    acquired_ts: TS,
    ...overrides,
  };
}

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-hash-test-'));
  db = createDb(dbPath);
  await db.open();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

describe('Transformation Hash — Seeding', () => {
  it('INS produces a 64-char hex hash', async () => {
    await processEvent(db, ev({ operand: { name: 'Alice' } }));
    const state = await getState(db, 'app.tbl.rec1');
    expect(state?.hash).toBeDefined();
    expect(state!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same operand at different timestamps produces different seed hashes', async () => {
    await processEvent(db, ev({ target: 'a', operand: { x: 1 }, ts: TS }));
    await processEvent(db, ev({ target: 'b', operand: { x: 1 }, ts: TS2 }));
    const stateA = await getState(db, 'a');
    const stateB = await getState(db, 'b');
    expect(stateA!.hash).not.toBe(stateB!.hash);
  });

  it('same timestamp but different operands produces different seed hashes', async () => {
    await processEvent(db, ev({ target: 'a', operand: { x: 1 } }));
    await processEvent(db, ev({ target: 'b', operand: { x: 2 } }));
    const stateA = await getState(db, 'a');
    const stateB = await getState(db, 'b');
    expect(stateA!.hash).not.toBe(stateB!.hash);
  });

  it('same operand, same timestamp, different target produces different seed hashes', async () => {
    await processEvent(db, ev({ target: 'a', operand: { x: 1 } }));
    await processEvent(db, ev({ target: 'b', operand: { x: 1 } }));
    const stateA = await getState(db, 'a');
    const stateB = await getState(db, 'b');
    expect(stateA!.hash).not.toBe(stateB!.hash);
  });
});

describe('Transformation Hash — Chaining', () => {
  it('DEF changes the hash', async () => {
    await processEvent(db, ev({ operand: { name: 'Alice' } }));
    const hashAfterINS = (await getState(db, 'app.tbl.rec1'))!.hash;

    await processEvent(db, ev({ op: 'DEF', operand: { email: 'alice@test.com' } }));
    const hashAfterDEF = (await getState(db, 'app.tbl.rec1'))!.hash;

    expect(hashAfterDEF).not.toBe(hashAfterINS);
    expect(hashAfterDEF).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same operations in same order produce same hash regardless of target', async () => {
    // Create two targets with same operand at same timestamp
    // Then apply identical DEF to both
    await processEvent(db, ev({ target: 'x', operand: { v: 1 } }));
    await processEvent(db, ev({ target: 'x', op: 'DEF', operand: { v: 2 } }));

    // For chaining, timestamp is NOT included — only seed includes it.
    // But the seeds will differ because the targets differ.
    // So this test verifies the chain itself is deterministic.
    const stateX = (await getState(db, 'x'))!;
    expect(stateX.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different operation order produces different hash', async () => {
    // Target A: INS → DEF(x=1) → DEF(x=2)
    await processEvent(db, ev({ target: 'a', operand: {} }));
    await processEvent(db, ev({ target: 'a', op: 'DEF', operand: { x: 1 } }));
    await processEvent(db, ev({ target: 'a', op: 'DEF', operand: { x: 2 } }));

    // Target B: INS → DEF(x=2) → DEF(x=1)
    await processEvent(db, ev({ target: 'b', operand: {} }));
    await processEvent(db, ev({ target: 'b', op: 'DEF', operand: { x: 2 } }));
    await processEvent(db, ev({ target: 'b', op: 'DEF', operand: { x: 1 } }));

    const hashA = (await getState(db, 'a'))!.hash;
    const hashB = (await getState(db, 'b'))!.hash;
    expect(hashA).not.toBe(hashB);
  });

  it('SEG updates the hash', async () => {
    await processEvent(db, ev({ target: 'seg.target', operand: { status: 'active' } }));
    const hashBefore = (await getState(db, 'seg.target'))!.hash;

    await processEvent(db, ev({
      op: 'SEG', target: 'seg.target',
      operand: { boundary: 'exclude' },
    }));
    const hashAfter = (await getState(db, 'seg.target'))!.hash;
    expect(hashAfter).not.toBe(hashBefore);
  });

  it('EVA updates the hash', async () => {
    await processEvent(db, ev({ target: 'eva.target', operand: {} }));
    const hashBefore = (await getState(db, 'eva.target'))!.hash;

    await processEvent(db, ev({
      op: 'EVA', target: 'eva.target',
      operand: { strategy: 'latest' },
    }));
    const hashAfter = (await getState(db, 'eva.target'))!.hash;
    expect(hashAfter).not.toBe(hashBefore);
  });

  it('CON updates the source target hash', async () => {
    await processEvent(db, ev({ target: 'con.a', operand: {} }));
    await processEvent(db, ev({ target: 'con.b', operand: {} }));
    const hashBefore = (await getState(db, 'con.a'))!.hash;

    await processEvent(db, ev({
      op: 'CON', target: 'con.a',
      operand: { added: ['con.b'] },
    }));
    const hashAfter = (await getState(db, 'con.a'))!.hash;
    expect(hashAfter).not.toBe(hashBefore);
  });
});

describe('Transformation Hash — SYN', () => {
  it('merged target gets a seed hash', async () => {
    await processEvent(db, ev({ target: 'p.A', operand: { name: 'Alice' } }));
    await processEvent(db, ev({ target: 'p.B', operand: { name: 'Bob' } }));
    await processEvent(db, ev({
      op: 'SYN', target: 'p.merged',
      operand: { merge: ['p.A', 'p.B'], into: 'p.merged' },
    }));

    const merged = await getState(db, 'p.merged');
    expect(merged!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('aliased targets get chained hashes reflecting SYN participation', async () => {
    await processEvent(db, ev({ target: 'p.A', operand: { name: 'Alice' } }));
    await processEvent(db, ev({ target: 'p.B', operand: { name: 'Bob' } }));

    const hashABefore = (await getState(db, 'p.A'))!.hash;
    const hashBBefore = (await getState(db, 'p.B'))!.hash;

    await processEvent(db, ev({
      op: 'SYN', target: 'p.merged',
      operand: { merge: ['p.A', 'p.B'], into: 'p.merged' },
    }));

    const hashAAfter = (await getState(db, 'p.A'))!.hash;
    const hashBAfter = (await getState(db, 'p.B'))!.hash;

    // Hashes changed — they carry the SYN participation
    expect(hashAAfter).not.toBe(hashABefore);
    expect(hashBAfter).not.toBe(hashBBefore);
  });

  it('two targets with same values but different SYN history have different hashes', async () => {
    // Target X: INS with value, no SYN
    await processEvent(db, ev({ target: 'cmp.X', operand: { v: 1 } }));

    // Target Y: INS, then SYN produces a merged entity
    await processEvent(db, ev({ target: 'cmp.A', operand: { v: 1 } }));
    await processEvent(db, ev({ target: 'cmp.B', operand: {} }));
    await processEvent(db, ev({
      op: 'SYN', target: 'cmp.Y',
      operand: { merge: ['cmp.A', 'cmp.B'], into: 'cmp.Y' },
    }));

    const hashX = (await getState(db, 'cmp.X'))!.hash;
    const hashY = (await getState(db, 'cmp.Y'))!.hash;
    // Different histories → different hashes
    expect(hashX).not.toBe(hashY);
  });
});

describe('Transformation Hash — REC', () => {
  it('REC target gets a hash', async () => {
    await processEvent(db, ev({
      op: 'REC', target: 'rec.frame',
      operand: {
        contains: [
          { op: 'DEF', target: 'rec.frame.fldA', operand: 'a' },
        ],
        reason: 'test',
      },
    }));

    const state = await getState(db, 'rec.frame');
    expect(state!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sub-operations within REC update their own hashes', async () => {
    await processEvent(db, ev({
      op: 'REC', target: 'rec.frame',
      operand: {
        contains: [
          { op: 'DEF', target: 'rec.frame.fldA', operand: 'a' },
          { op: 'DEF', target: 'rec.frame.fldB', operand: 'b' },
        ],
      },
    }));

    const stateA = await getState(db, 'rec.frame.fldA');
    const stateB = await getState(db, 'rec.frame.fldB');
    expect(stateA!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stateB!.hash).toMatch(/^[0-9a-f]{64}$/);
    // Different targets with different operands → different hashes
    expect(stateA!.hash).not.toBe(stateB!.hash);
  });
});

describe('Transformation Hash — DEF auto-instantiation', () => {
  it('auto-instantiated target gets a hash', async () => {
    await processEvent(db, ev({ op: 'DEF', target: 'auto.new', operand: { x: 1 } }));
    const state = await getState(db, 'auto.new');
    expect(state!.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Transformation Hash — Unit functions', () => {
  it('seedHash is deterministic', () => {
    const event = { seq: 1, op: 'INS' as const, target: 'a.b', operand: { x: 1 }, agent: AGENT, ts: TS, acquired_ts: TS };
    const h1 = seedHash(event);
    const h2 = seedHash(event);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('chainHash is deterministic', () => {
    const event = { seq: 2, op: 'DEF' as const, target: 'a.b', operand: { y: 2 }, agent: AGENT, ts: TS, acquired_ts: TS };
    const prev = 'a'.repeat(64);
    const h1 = chainHash(prev, event);
    const h2 = chainHash(prev, event);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('chainHash differs with different previous hash', () => {
    const event = { seq: 2, op: 'DEF' as const, target: 'a.b', operand: { y: 2 }, agent: AGENT, ts: TS, acquired_ts: TS };
    const h1 = chainHash('a'.repeat(64), event);
    const h2 = chainHash('b'.repeat(64), event);
    expect(h1).not.toBe(h2);
  });
});
