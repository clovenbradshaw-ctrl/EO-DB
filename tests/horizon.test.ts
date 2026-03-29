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

const AGENT = '@test:matrix.example.com';
const TS = '2025-06-01T00:00:00.000Z';

function ev(overrides: Partial<EoEventInput>): EoEventInput {
  return { op: 'INS', target: 'test', operand: {}, agent: AGENT, ts: TS, acquired_ts: TS, ...overrides };
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

// --- Layer 3: Nearby (the drawer) ---

describe('Layer 3: Nearby', () => {
  it('finds records sharing field values in same collection', async () => {
    await processEvent(db, ev({ target: 'app.cases.rec001', operand: { type: 'H1B', caseworker: '@maria' } }));
    await processEvent(db, ev({ target: 'app.cases.rec002', operand: { type: 'H1B', caseworker: '@john' } }));
    await processEvent(db, ev({ target: 'app.cases.rec003', operand: { type: 'L1A', caseworker: '@maria' } }));

    const result = await horizonGet(db, 'app.cases.rec001') as HorizonResponse;
    expect(result.nearby).toBeDefined();
    expect(result.nearby!.length).toBeGreaterThan(0);

    // rec002 shares type:H1B, rec003 shares caseworker:@maria
    const rec002 = result.nearby!.find(n => n.target === 'app.cases.rec002');
    expect(rec002).toBeDefined();
    expect(rec002!.shared).toContain('type:H1B');

    const rec003 = result.nearby!.find(n => n.target === 'app.cases.rec003');
    expect(rec003).toBeDefined();
    expect(rec003!.shared).toContain('caseworker:@maria');
  });

  it('finds records sharing CON linkage', async () => {
    // Two cases linked to the same client
    await processEvent(db, ev({ target: 'app.clients.c001', operand: { name: 'Maria' } }));
    await processEvent(db, ev({ target: 'app.cases.rec001', operand: { type: 'H1B' } }));
    await processEvent(db, ev({ target: 'app.cases.rec002', operand: { type: 'L1A' } }));
    await processEvent(db, ev({ op: 'CON', target: 'app.cases.rec001', operand: { added: ['app.clients.c001'] } }));
    await processEvent(db, ev({ op: 'CON', target: 'app.cases.rec002', operand: { added: ['app.clients.c001'] } }));

    const result = await horizonGet(db, 'app.cases.rec001') as HorizonResponse;
    const rec002 = result.nearby!.find(n => n.target === 'app.cases.rec002');
    expect(rec002).toBeDefined();
    expect(rec002!.shared.some(s => s.startsWith('linked:'))).toBe(true);
  });

  it('excludes self from nearby', async () => {
    await processEvent(db, ev({ target: 'app.tbl.self', operand: { x: 1 } }));
    const result = await horizonGet(db, 'app.tbl.self') as HorizonResponse;
    expect(result.nearby!.every(n => n.target !== 'app.tbl.self')).toBe(true);
  });

  it('returns empty when no siblings exist', async () => {
    await processEvent(db, ev({ target: 'lonely.tbl.only', operand: {} }));
    const result = await horizonGet(db, 'lonely.tbl.only') as HorizonResponse;
    expect(result.nearby).toEqual([]);
  });

  it('disabled with nearby=false', async () => {
    await processEvent(db, ev({ target: 'off.tbl.rec', operand: {} }));
    const result = await horizonGet(db, 'off.tbl.rec', { nearby: false }) as HorizonResponse;
    expect(result.nearby).toBeUndefined();
  });
});

// --- Layer 4: Governance (the policy sheet) ---

describe('Layer 4: Governance', () => {
  it('returns EVA policies on this target', async () => {
    await processEvent(db, ev({ target: 'app.clients.rec001.fldEmail' }));
    await processEvent(db, ev({
      op: 'DEF', target: 'app.clients.rec001.fldEmail',
      operand: { formula: 'VALIDATE(email)' },
    }));

    const result = await horizonGet(db, 'app.clients.rec001.fldEmail') as HorizonResponse;
    expect(result.governance).toBeDefined();
    const direct = result.governance!.find(g => g.scope === 'direct');
    expect(direct).toBeDefined();
  });

  it('returns EVA policies from same collection', async () => {
    await processEvent(db, ev({ target: 'app.cases.rec001' }));
    // Create a formula target in the same collection
    await processEvent(db, ev({ target: 'app.cases.rec099.deadline' }));
    await processEvent(db, ev({
      op: 'DEF', target: 'app.cases.rec099.deadline',
      operand: { formula: 'DAYS_UNTIL(filed + 180)' },
    }));

    const result = await horizonGet(db, 'app.cases.rec001') as HorizonResponse;
    expect(result.governance).toBeDefined();
    const collectionGov = result.governance!.filter(g => g.scope === 'collection');
    expect(collectionGov.length).toBeGreaterThan(0);
  });

  it('disabled with governance=false', async () => {
    await processEvent(db, ev({ target: 'nogov.tbl.rec' }));
    const result = await horizonGet(db, 'nogov.tbl.rec', { governance: false }) as HorizonResponse;
    expect(result.governance).toBeUndefined();
  });
});

// --- Layer 5: Trajectory (the journey) ---

describe('Layer 5: Trajectory', () => {
  it('returns compact operator sequence', async () => {
    await processEvent(db, ev({ target: 'traj.rec001', operand: { name: 'Maria' } }));
    await processEvent(db, ev({ op: 'DEF', target: 'traj.rec001', operand: { status: 'pending' } }));
    await processEvent(db, ev({ op: 'DEF', target: 'traj.rec001', operand: { status: 'approved' } }));

    const result = await horizonGet(db, 'traj.rec001') as HorizonResponse;
    expect(result.trajectory).toBeDefined();
    // INS → DEF → DEF collapses consecutive DEFs to: INS, DEF
    expect(result.trajectory).toHaveLength(2);
    expect(result.trajectory![0].op).toBe('INS');
    expect(result.trajectory![1].op).toBe('DEF');
    // Each entry carries a 64-char hex hash
    expect(result.trajectory![0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.trajectory![1].hash).toMatch(/^[0-9a-f]{64}$/);
    // Hashes should differ
    expect(result.trajectory![0].hash).not.toBe(result.trajectory![1].hash);
  });

  it('preserves operator variety in trajectory', async () => {
    await processEvent(db, ev({ target: 'traj2.rec001', operand: { name: 'Maria' } }));
    await processEvent(db, ev({ target: 'traj2.link' }));
    await processEvent(db, ev({ op: 'DEF', target: 'traj2.rec001', operand: { status: 'active' } }));
    await processEvent(db, ev({ op: 'CON', target: 'traj2.rec001', operand: { added: ['traj2.link'] } }));
    await processEvent(db, ev({ op: 'DEF', target: 'traj2.rec001', operand: { email: 'a@b.com' } }));
    await processEvent(db, ev({ op: 'SEG', target: 'traj2.rec001', operand: { boundary: 'exclude' } }));

    const result = await horizonGet(db, 'traj2.rec001') as HorizonResponse;
    // INS, DEF, CON, DEF, SEG
    const ops = result.trajectory!.map(e => e.op);
    expect(ops).toEqual(['INS', 'DEF', 'CON', 'DEF', 'SEG']);
    // All entries have valid hashes
    for (const entry of result.trajectory!) {
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('empty trajectory for unknown target', async () => {
    await processEvent(db, ev({ op: 'DEF', target: 'traj3.auto', operand: 'x' }));
    // DEF auto-instantiated this target, so there IS a log entry for the DEF
    const result = await horizonGet(db, 'traj3.auto') as HorizonResponse;
    expect(result.trajectory).toBeDefined();
    expect(result.trajectory!.length).toBeGreaterThanOrEqual(1);
  });

  it('disabled with trajectory=false', async () => {
    await processEvent(db, ev({ target: 'notraj.rec' }));
    const result = await horizonGet(db, 'notraj.rec', { trajectory: false }) as HorizonResponse;
    expect(result.trajectory).toBeUndefined();
  });
});

// --- Ancestry: The Ontology Chain ---

describe('Ancestry', () => {
  it('climbs from field to record to collection to app', async () => {
    // Build the hierarchy
    await processEvent(db, ev({ op: 'DEF', target: 'app', operand: { timezone: 'America/Chicago', firm: 'Amino' } }));
    await processEvent(db, ev({ op: 'DEF', target: 'app.tblCases', operand: { reviewCycle: 'biweekly' } }));
    await processEvent(db, ev({ target: 'app.tblCases.rec101', operand: { type: 'H1B', filed: '2025-06-01' } }));
    await processEvent(db, ev({ op: 'DEF', target: 'app.tblCases.rec101.fldStatus', operand: 'pending' }));

    const result = await horizonGet(db, 'app.tblCases.rec101.fldStatus') as HorizonResponse;
    expect(result.ancestry).toBeDefined();
    expect(result.ancestry!.length).toBe(3); // rec101, tblCases, app

    // Depth 1 = parent (rec101)
    const rec101 = result.ancestry!.find(a => a.target === 'app.tblCases.rec101');
    expect(rec101).toBeDefined();
    expect(rec101!.depth).toBe(1);
    expect(rec101!.figure?.value).toEqual({ type: 'H1B', filed: '2025-06-01' });

    // Depth 2 = grandparent (tblCases)
    const tblCases = result.ancestry!.find(a => a.target === 'app.tblCases');
    expect(tblCases).toBeDefined();
    expect(tblCases!.depth).toBe(2);
    expect(tblCases!.figure?.value).toEqual({ reviewCycle: 'biweekly' });

    // Depth 3 = root (app)
    const app = result.ancestry!.find(a => a.target === 'app');
    expect(app).toBeDefined();
    expect(app!.depth).toBe(3);
    expect(app!.figure?.value).toEqual({ timezone: 'America/Chicago', firm: 'Amino' });
  });

  it('each ancestor carries its own grounds from above', async () => {
    await processEvent(db, ev({ op: 'DEF', target: 'app', operand: { firm: 'Amino' } }));
    await processEvent(db, ev({ op: 'DEF', target: 'app.tbl', operand: { region: 'Nashville' } }));
    await processEvent(db, ev({ target: 'app.tbl.rec001', operand: { name: 'Maria' } }));

    const result = await horizonGet(db, 'app.tbl.rec001') as HorizonResponse;

    // tbl's grounds should include app's firm
    const tblAncestor = result.ancestry!.find(a => a.target === 'app.tbl');
    expect(tblAncestor!.grounds.some(g => g.key === 'firm')).toBe(true);
  });

  it('reports children_count at each ancestor', async () => {
    await processEvent(db, ev({ target: 'cnt.tbl.rec001', operand: {} }));
    await processEvent(db, ev({ target: 'cnt.tbl.rec002', operand: {} }));
    await processEvent(db, ev({ target: 'cnt.tbl.rec003', operand: {} }));
    await processEvent(db, ev({ op: 'DEF', target: 'cnt.tbl.rec001.fldX', operand: 'val' }));

    const result = await horizonGet(db, 'cnt.tbl.rec001.fldX') as HorizonResponse;
    const tbl = result.ancestry!.find(a => a.target === 'cnt.tbl');
    expect(tbl!.children_count).toBe(3); // 3 records under cnt.tbl
  });

  it('reports nearby_count (siblings at same level)', async () => {
    await processEvent(db, ev({ target: 'sib.tbl.rec001', operand: {} }));
    await processEvent(db, ev({ target: 'sib.tbl.rec002', operand: {} }));
    await processEvent(db, ev({ target: 'sib.tbl.rec003', operand: {} }));

    const result = await horizonGet(db, 'sib.tbl.rec001') as HorizonResponse;
    // tbl is the parent; its nearby_count is siblings of tbl under sib
    // rec001 is the target; ancestry[0] is tbl
    const tbl = result.ancestry!.find(a => a.target === 'sib.tbl');
    // tbl has 0 siblings (it's the only collection under sib)
    expect(tbl!.nearby_count).toBe(0);
  });

  it('returns empty ancestry for single-segment target', async () => {
    await processEvent(db, ev({ op: 'DEF', target: 'root', operand: { x: 1 } }));
    const result = await horizonGet(db, 'root') as HorizonResponse;
    expect(result.ancestry).toEqual([]);
  });

  it('disabled with ancestry=false', async () => {
    await processEvent(db, ev({ target: 'nochain.rec' }));
    const result = await horizonGet(db, 'nochain.rec', { ancestry: false }) as HorizonResponse;
    expect(result.ancestry).toBeUndefined();
  });
});
