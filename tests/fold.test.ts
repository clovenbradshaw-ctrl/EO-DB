import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb, decode } from '../src/db/level.js';
import { processEvent, setRecConfig, nearEqual } from '../src/db/fold.js';
import { getState, getStateByPrefix } from '../src/db/state.js';
import { getEdgesFrom, getEdgesTo } from '../src/db/graph.js';
import { getDepEdgesFrom, getDepEdgesTo } from '../src/db/dep-graph.js';
import { readLogSince } from '../src/db/log.js';
import { resolveAlias } from '../src/db/helpers.js';
import type { EoEventInput } from '../src/db/types.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

const AGENT = '@intake:matrix.example.com';
const TS = '2025-06-01T00:00:00.000Z';

function ev(overrides: Partial<EoEventInput>): EoEventInput {
  return {
    op: 'INS',
    target: 'app.tblClients.rec001',
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

// --- INS Tests ---

describe('INS', () => {
  it('creates state at target with operand as value', async () => {
    await processEvent(db, ev({ operand: { name: 'Maria Garcia' } }));
    const state = await getState(db, 'app.tblClients.rec001');
    expect(state?.value).toEqual({ name: 'Maria Garcia' });
  });

  it('sets last_op, last_agent, last_ts on state', async () => {
    await processEvent(db, ev({}));
    const state = await getState(db, 'app.tblClients.rec001');
    expect(state?.last_op).toBe('INS');
    expect(state?.last_agent).toBe(AGENT);
    expect(state?.last_ts).toBe(TS);
  });

  it('rejects duplicate target with different content', async () => {
    await processEvent(db, ev({}));
    await expect(processEvent(db, ev({ operand: { different: true } }))).rejects.toThrow('already instantiated');
  });

  it('deduplicates identical INS events via deterministic hash', async () => {
    const seq1 = await processEvent(db, ev({}));
    const seq2 = await processEvent(db, ev({}));
    expect(seq1).toBe(seq2); // Same event returns cached seq
  });

  it('assigns sequential seq numbers', async () => {
    const seq1 = await processEvent(db, ev({ target: 'a' }));
    const seq2 = await processEvent(db, ev({ target: 'b' }));
    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
  });
});

// --- DEF Tests ---

describe('DEF', () => {
  it('merges operand into existing state value', async () => {
    await processEvent(db, ev({ operand: { name: 'Maria', status: 'active' } }));
    await processEvent(db, ev({ op: 'DEF', target: 'app.tblClients.rec001', operand: { email: 'maria@test.com' } }));
    const state = await getState(db, 'app.tblClients.rec001');
    expect(state?.value).toEqual({ name: 'Maria', status: 'active', email: 'maria@test.com' });
  });

  it('auto-instantiates non-existent target (helix: INS capacity)', async () => {
    await processEvent(db, ev({ op: 'DEF', target: 'app.tblClients.rec999', operand: 'hello' }));
    const state = await getState(db, 'app.tblClients.rec999');
    expect(state).not.toBeNull();
    expect(state?.value).toBe('hello');
  });

  it('resolves SYN aliases when writing', async () => {
    // Create two targets
    await processEvent(db, ev({ target: 'target.A', operand: { x: 1 } }));
    await processEvent(db, ev({ target: 'target.B', operand: { y: 2 } }));
    // Merge A and B into C
    await processEvent(db, ev({
      op: 'SYN',
      target: 'target.C',
      operand: { merge: ['target.A', 'target.B'], into: 'target.C' },
    }));
    // DEF on old target A should write to C
    await processEvent(db, ev({ op: 'DEF', target: 'target.A', operand: { z: 3 } }));
    const stateC = await getState(db, 'target.C');
    expect(stateC?.value).toHaveProperty('z', 3);
  });

  it('registers EVA-active target for formula operand', async () => {
    await processEvent(db, ev({ target: 'app.fld1' }));
    await processEvent(db, ev({
      op: 'DEF',
      target: 'app.fld1',
      operand: { formula: 'SUM(a, b)' },
    }));
    const buf = await db.get('eva:app.fld1');
    const reg = decode(buf);
    expect(reg.target).toBe('app.fld1');
    expect(reg.mode).toBe('fold');
  });

  it('classifies formula with time functions as horizon-computed', async () => {
    await processEvent(db, ev({ target: 'app.fld2' }));
    await processEvent(db, ev({
      op: 'DEF',
      target: 'app.fld2',
      operand: { formula: 'DAYS_UNTIL(filed + 180)' },
    }));
    const buf = await db.get('eva:app.fld2');
    const reg = decode(buf);
    expect(reg.mode).toBe('horizon');
  });

  it('classifies formula with only internal refs as fold-computed', async () => {
    await processEvent(db, ev({ target: 'app.fld3' }));
    await processEvent(db, ev({
      op: 'DEF',
      target: 'app.fld3',
      operand: { formula: 'SUM(fieldA, fieldB)' },
    }));
    const buf = await db.get('eva:app.fld3');
    const reg = decode(buf);
    expect(reg.mode).toBe('fold');
  });

  it('scalar operand replaces existing value', async () => {
    await processEvent(db, ev({ target: 'app.field', operand: { initial: true } }));
    await processEvent(db, ev({ op: 'DEF', target: 'app.field', operand: 'overwritten' }));
    const state = await getState(db, 'app.field');
    expect(state?.value).toBe('overwritten');
  });
});

// --- CON Tests ---

describe('CON', () => {
  beforeEach(async () => {
    await processEvent(db, ev({ target: 'app.clients.rec001' }));
    await processEvent(db, ev({ target: 'app.cases.rec101' }));
  });

  it('creates edges with { added: [...] }', async () => {
    await processEvent(db, ev({
      op: 'CON',
      target: 'app.clients.rec001',
      operand: { added: ['app.cases.rec101'] },
    }));
    const edges = await getEdgesFrom(db, 'app.clients.rec001');
    expect(edges).toHaveLength(1);
    expect(edges[0].dest).toBe('app.cases.rec101');
  });

  it('removes edges with { removed: [...] }', async () => {
    await processEvent(db, ev({
      op: 'CON',
      target: 'app.clients.rec001',
      operand: { added: ['app.cases.rec101'] },
    }));
    await processEvent(db, ev({
      op: 'CON',
      target: 'app.clients.rec001',
      operand: { removed: ['app.cases.rec101'] },
    }));
    const edges = await getEdgesFrom(db, 'app.clients.rec001');
    expect(edges).toHaveLength(0);
  });

  it('rejects if destination does not exist (helix: INS check)', async () => {
    await expect(
      processEvent(db, ev({
        op: 'CON',
        target: 'app.clients.rec001',
        operand: { added: ['nonexistent.target'] },
      }))
    ).rejects.toThrow('CON target does not exist');
  });

  it('creates bidirectional graph entries', async () => {
    await processEvent(db, ev({
      op: 'CON',
      target: 'app.clients.rec001',
      operand: { added: ['app.cases.rec101'] },
    }));
    const fwd = await getEdgesFrom(db, 'app.clients.rec001');
    const rev = await getEdgesTo(db, 'app.cases.rec101');
    expect(fwd).toHaveLength(1);
    expect(rev).toHaveLength(1);
  });

  it('updates state with current link set', async () => {
    await processEvent(db, ev({
      op: 'CON',
      target: 'app.clients.rec001',
      operand: { added: ['app.cases.rec101'] },
    }));
    const state = await getState(db, 'app.clients.rec001');
    expect(state?.value?.linked).toContain('app.cases.rec101');
    expect(state?.last_op).toBe('CON');
  });
});

// --- SEG Tests ---

describe('SEG', () => {
  it('writes boundary metadata to state', async () => {
    await processEvent(db, ev({ target: 'app.tblClients.rec001' }));
    await processEvent(db, ev({
      op: 'SEG',
      target: 'app.tblClients.rec001',
      operand: { boundary: 'exclude', reason: 'archived' },
    }));
    const state = await getState(db, 'app.tblClients.rec001');
    expect(state?.value).toEqual({ boundary: 'exclude', reason: 'archived' });
    expect(state?.last_op).toBe('SEG');
  });

  it('rejects if target does not exist (helix: INS check)', async () => {
    await expect(
      processEvent(db, ev({
        op: 'SEG',
        target: 'nonexistent.target',
        operand: { boundary: 'exclude' },
      }))
    ).rejects.toThrow('SEG target does not exist');
  });
});

// --- SYN Tests ---

describe('SYN', () => {
  beforeEach(async () => {
    await processEvent(db, ev({ target: 'person.A', operand: { name: 'Alice', age: 30 } }));
    await processEvent(db, ev({ target: 'person.B', operand: { name: 'Bob', email: 'bob@test.com' } }));
  });

  it('merges two targets — old targets get aliases', async () => {
    await processEvent(db, ev({
      op: 'SYN',
      target: 'person.merged',
      operand: { merge: ['person.A', 'person.B'], into: 'person.merged' },
    }));
    const merged = await getState(db, 'person.merged');
    expect(merged?.value).toHaveProperty('name');
    expect(merged?.value).toHaveProperty('email', 'bob@test.com');
    expect(merged?.last_op).toBe('SYN');
  });

  it('creates aliases for merged-away targets', async () => {
    await processEvent(db, ev({
      op: 'SYN',
      target: 'person.merged',
      operand: { merge: ['person.A', 'person.B'], into: 'person.merged' },
    }));
    const aliasA = await getState(db, 'person.A');
    const aliasB = await getState(db, 'person.B');
    expect(aliasA?.value?._alias).toBe('person.merged');
    expect(aliasB?.value?._alias).toBe('person.merged');
  });

  it('alias resolution works after merge', async () => {
    await processEvent(db, ev({
      op: 'SYN',
      target: 'person.merged',
      operand: { merge: ['person.A', 'person.B'], into: 'person.merged' },
    }));
    const resolved = await resolveAlias(db, 'person.A');
    expect(resolved).toBe('person.merged');
  });

  it('merges edges from old targets', async () => {
    // Create a third target and connect A to it
    await processEvent(db, ev({ target: 'org.X' }));
    await processEvent(db, ev({
      op: 'CON',
      target: 'person.A',
      operand: { added: ['org.X'] },
    }));

    // Merge A and B
    await processEvent(db, ev({
      op: 'SYN',
      target: 'person.merged',
      operand: { merge: ['person.A', 'person.B'], into: 'person.merged' },
    }));

    // The merged target should have the edge to org.X
    const edges = await getEdgesFrom(db, 'person.merged');
    expect(edges.some(e => e.dest === 'org.X')).toBe(true);
  });

  it('rejects merge when targets do not exist', async () => {
    await expect(
      processEvent(db, ev({
        op: 'SYN',
        target: 'person.merged',
        operand: { merge: ['person.A', 'nonexistent'], into: 'person.merged' },
      }))
    ).rejects.toThrow('SYN merge targets must both exist');
  });
});

// --- EVA Tests ---

describe('EVA', () => {
  it('writes evaluation policy to state', async () => {
    await processEvent(db, ev({ target: 'app.field' }));
    await processEvent(db, ev({
      op: 'EVA',
      target: 'app.field',
      operand: { strategy: 'latest' },
    }));
    const state = await getState(db, 'app.field');
    expect(state?.value).toEqual({ strategy: 'latest' });
    expect(state?.last_op).toBe('EVA');
  });
});

// --- REC Tests ---

describe('REC', () => {
  it('rejects external REC submissions', async () => {
    await expect(processEvent(db, ev({
      op: 'REC',
      target: 'schema.tblCases',
      operand: {
        contains: [
          { op: 'DEF', target: 'schema.tblCases.fldUrgency', operand: { type: 'select' } },
        ],
      },
    }))).rejects.toThrow('REC is system-generated and cannot be submitted externally');
  });

  it('emits system-generated REC when dependency cycle exists', async () => {
    // Create two formula targets that depend on each other (cycle: A depends on B, B depends on A)
    await processEvent(db, ev({ target: 'cycle.A', operand: { val: 1 } }));
    await processEvent(db, ev({ target: 'cycle.B', operand: { val: 2 } }));

    // CON: A depends on B
    await processEvent(db, ev({
      op: 'CON', target: 'cycle.A', operand: { added: ['cycle.B'] },
    }));
    // CON: B depends on A
    await processEvent(db, ev({
      op: 'CON', target: 'cycle.B', operand: { added: ['cycle.A'] },
    }));

    // Register fold-mode formula on A first (no cycle yet — B has no formula)
    await processEvent(db, ev({
      op: 'DEF', target: 'cycle.A', operand: { formula: 'F(B)' },
    }));

    // Register fold-mode formula on B — this completes the cycle.
    // The fold detects the circular dependency and emits a system-generated REC.
    const completingSeq = await processEvent(db, ev({
      op: 'DEF', target: 'cycle.B', operand: { formula: 'G(A)' },
    }));

    // Check that a REC event was logged with agent: "system"
    const allEvents = await readLogSince(db, 0);
    const recEvents = allEvents.filter(e => e.op === 'REC');
    expect(recEvents.length).toBeGreaterThanOrEqual(1);

    const rec = recEvents[0];
    expect(rec.agent).toBe('system');
    expect(rec.triggered_by).toBe(completingSeq);

    // The REC result should be stored in state
    const state = await getState(db, 'cycle.B');
    expect(state?.value?._rec).toBeDefined();
    expect(state?.value?._rec?.recursion).toBe(true);
    expect(state?.value?._rec?.triggered_by).toBe(completingSeq);
  });

  it('system-generated REC records result with iteration count', async () => {
    // Set up a cycle where formulas reference each other
    await processEvent(db, ev({ target: 'stable.A', operand: { val: 1 } }));
    await processEvent(db, ev({ target: 'stable.B', operand: { val: 2 } }));

    await processEvent(db, ev({
      op: 'CON', target: 'stable.A', operand: { added: ['stable.B'] },
    }));
    await processEvent(db, ev({
      op: 'CON', target: 'stable.B', operand: { added: ['stable.A'] },
    }));

    // Register first formula (no cycle yet)
    await processEvent(db, ev({
      op: 'DEF', target: 'stable.A', operand: { formula: 'SUM(B)' },
    }));

    // Register second formula — completes the cycle, triggers REC
    await processEvent(db, ev({
      op: 'DEF', target: 'stable.B', operand: { formula: 'SUM(A)' },
    }));

    // The system-generated REC should record a result with iteration tracking
    // (The placeholder formula engine embeds inputs in outputs, so convergence
    // depends on the real formula engine. The structure is what matters here.)
    const state = await getState(db, 'stable.B');
    expect(state?.value?._rec).toBeDefined();
    expect(state?.value?._rec?.recursion).toBe(true);
    expect(state?.value?._rec?.result).toBeDefined();
    expect(state?.value?._rec?.result?.iterations).toBeGreaterThanOrEqual(1);
    // Result contains either converged state or oscillation data
    expect(typeof state?.value?._rec?.result?.converged).toBe('boolean');
  });

  it('no REC emitted when no dependency cycle exists', async () => {
    // Linear dependency: A depends on B (no cycle)
    await processEvent(db, ev({ target: 'linear.A', operand: { val: 1 } }));
    await processEvent(db, ev({ target: 'linear.B', operand: { val: 2 } }));

    await processEvent(db, ev({
      op: 'CON', target: 'linear.A', operand: { added: ['linear.B'] },
    }));

    await processEvent(db, ev({
      op: 'DEF', target: 'linear.A', operand: { formula: 'SUM(B)' },
    }));

    // Trigger — no cycle, so no REC
    await processEvent(db, ev({
      op: 'DEF', target: 'linear.B', operand: { val: 20 },
    }));

    const allEvents = await readLogSince(db, 0);
    const recEvents = allEvents.filter(e => e.op === 'REC');
    expect(recEvents).toHaveLength(0);
  });

  it('distinguishes human events from system discoveries in the log', async () => {
    // Set up cycle
    await processEvent(db, ev({ target: 'log.A', operand: { val: 1 } }));
    await processEvent(db, ev({ target: 'log.B', operand: { val: 2 } }));

    await processEvent(db, ev({
      op: 'CON', target: 'log.A', operand: { added: ['log.B'] },
    }));
    await processEvent(db, ev({
      op: 'CON', target: 'log.B', operand: { added: ['log.A'] },
    }));

    await processEvent(db, ev({
      op: 'DEF', target: 'log.A', operand: { formula: 'F(B)' },
    }));
    // This DEF completes the cycle, triggering a system-generated REC
    await processEvent(db, ev({
      op: 'DEF', target: 'log.B', operand: { formula: 'G(A)' },
    }));

    const allEvents = await readLogSince(db, 0);

    // The log now contains two kinds of entries:
    // Observations (human-initiated) and Discoveries (system-generated REC + INS2+)
    const humanEvents = allEvents.filter(e => e.agent !== 'system');
    for (const e of humanEvents) {
      expect(e.agent).toBe(AGENT);
    }

    const sysEvents = allEvents.filter(e => e.agent === 'system');
    expect(sysEvents.length).toBeGreaterThanOrEqual(1);
    for (const e of sysEvents) {
      expect(e.agent).toBe('system');
      expect(e.triggered_by).toBeDefined();
    }
  });
});

// --- INS Levels Tests ---

describe('INS Levels', () => {
  it('all externally created entities are level 1', async () => {
    await processEvent(db, ev({ target: 'lvl.test', operand: { x: 1 } }));
    const state = await getState(db, 'lvl.test');
    expect(state?.level).toBe(1);
  });

  it('DEF auto-instantiated entities are level 1', async () => {
    await processEvent(db, ev({ op: 'DEF', target: 'lvl.auto', operand: { y: 2 } }));
    const state = await getState(db, 'lvl.auto');
    expect(state?.level).toBe(1);
  });

  it('system-generated REC produces INS2 derived entity', async () => {
    // Set up cycle
    await processEvent(db, ev({ target: 'ins2.A', operand: { val: 1 } }));
    await processEvent(db, ev({ target: 'ins2.B', operand: { val: 2 } }));
    await processEvent(db, ev({ op: 'CON', target: 'ins2.A', operand: { added: ['ins2.B'] } }));
    await processEvent(db, ev({ op: 'CON', target: 'ins2.B', operand: { added: ['ins2.A'] } }));
    await processEvent(db, ev({ op: 'DEF', target: 'ins2.A', operand: { formula: 'F(B)' } }));
    await processEvent(db, ev({ op: 'DEF', target: 'ins2.B', operand: { formula: 'G(A)' } }));

    // Check that a system.rec.* derived entity was created at level 2
    const allEvents = await readLogSince(db, 0);
    const insEvents = allEvents.filter(e => e.op === 'INS' && e.agent === 'system');
    expect(insEvents.length).toBeGreaterThanOrEqual(1);

    const derivedIns = insEvents[0];
    expect(derivedIns.level).toBe(2);
    expect(derivedIns.target).toMatch(/^system\.rec\./);

    const derivedState = await getState(db, derivedIns.target);
    expect(derivedState?.level).toBe(2);
    expect(derivedState?.value?.constituents).toBeDefined();
    expect(derivedState?.value?.topology).toBe('cycle');
  });

  it('rejects DEF on core content of derived entity', async () => {
    // Set up cycle to create INS2 entity
    await processEvent(db, ev({ target: 'guard.A', operand: { val: 1 } }));
    await processEvent(db, ev({ target: 'guard.B', operand: { val: 2 } }));
    await processEvent(db, ev({ op: 'CON', target: 'guard.A', operand: { added: ['guard.B'] } }));
    await processEvent(db, ev({ op: 'CON', target: 'guard.B', operand: { added: ['guard.A'] } }));
    await processEvent(db, ev({ op: 'DEF', target: 'guard.A', operand: { formula: 'F(B)' } }));
    await processEvent(db, ev({ op: 'DEF', target: 'guard.B', operand: { formula: 'G(A)' } }));

    // Find the derived entity
    const allEvents = await readLogSince(db, 0);
    const derivedIns = allEvents.find(e => e.op === 'INS' && e.agent === 'system');
    expect(derivedIns).toBeDefined();

    // Attempting to DEF the derived entity's core content should fail
    await expect(processEvent(db, ev({
      op: 'DEF',
      target: derivedIns!.target,
      operand: { hacked: true },
    }))).rejects.toThrow('Cannot DEF core content of derived entity');
  });

  it('allows DEF on annotation sub-paths of derived entities', async () => {
    // Set up cycle
    await processEvent(db, ev({ target: 'annot.A', operand: { val: 1 } }));
    await processEvent(db, ev({ target: 'annot.B', operand: { val: 2 } }));
    await processEvent(db, ev({ op: 'CON', target: 'annot.A', operand: { added: ['annot.B'] } }));
    await processEvent(db, ev({ op: 'CON', target: 'annot.B', operand: { added: ['annot.A'] } }));
    await processEvent(db, ev({ op: 'DEF', target: 'annot.A', operand: { formula: 'F(B)' } }));
    await processEvent(db, ev({ op: 'DEF', target: 'annot.B', operand: { formula: 'G(A)' } }));

    // Find the derived entity
    const allEvents = await readLogSince(db, 0);
    const derivedIns = allEvents.find(e => e.op === 'INS' && e.agent === 'system');
    expect(derivedIns).toBeDefined();

    // DEF on a sub-path (annotation) should succeed — it auto-instantiates at level 1
    await processEvent(db, ev({
      op: 'DEF',
      target: `${derivedIns!.target}.severity`,
      operand: 'high',
    }));

    const annotState = await getState(db, `${derivedIns!.target}.severity`);
    expect(annotState?.value).toBe('high');
    expect(annotState?.level).toBe(1); // annotation is level 1
  });

  it('level is preserved through operations', async () => {
    await processEvent(db, ev({ target: 'pres.test', operand: { a: 1 } }));
    await processEvent(db, ev({ op: 'DEF', target: 'pres.test', operand: { b: 2 } }));
    const state = await getState(db, 'pres.test');
    expect(state?.level).toBe(1);
    expect(state?.last_op).toBe('DEF');
  });
});

// --- Duplicate Update Prevention Tests ---

describe('Duplicate Update Prevention', () => {
  it('DEF with identical object operand is a no-op', async () => {
    await processEvent(db, ev({ target: 'app.rec1', operand: { name: 'Alice', age: 30 } }));
    const logBefore = await readLogSince(db, 0);

    // Submit DEF with same values already in state
    const seq = await processEvent(db, ev({
      op: 'DEF',
      target: 'app.rec1',
      operand: { name: 'Alice', age: 30 },
    }));

    const logAfter = await readLogSince(db, 0);
    // No new log entry — the update was skipped
    expect(logAfter.length).toBe(logBefore.length);
    // Returns the existing last_seq
    expect(seq).toBe(1);
  });

  it('DEF with different operand still processes', async () => {
    await processEvent(db, ev({ target: 'app.rec1', operand: { name: 'Alice' } }));
    const logBefore = await readLogSince(db, 0);

    await processEvent(db, ev({
      op: 'DEF',
      target: 'app.rec1',
      operand: { name: 'Bob' },
    }));

    const logAfter = await readLogSince(db, 0);
    expect(logAfter.length).toBe(logBefore.length + 1);
    const state = await getState(db, 'app.rec1');
    expect(state?.value?.name).toBe('Bob');
  });

  it('DEF with subset of existing fields is a no-op', async () => {
    await processEvent(db, ev({ target: 'app.rec1', operand: { name: 'Alice', age: 30 } }));
    const logBefore = await readLogSince(db, 0);

    // Submitting { name: 'Alice' } merges into { name: 'Alice', age: 30 } — same result
    const seq = await processEvent(db, ev({
      op: 'DEF',
      target: 'app.rec1',
      operand: { name: 'Alice' },
    }));

    const logAfter = await readLogSince(db, 0);
    expect(logAfter.length).toBe(logBefore.length);
  });

  it('DEF with identical scalar operand is a no-op', async () => {
    await processEvent(db, ev({ target: 'app.field', operand: { x: 1 } }));
    await processEvent(db, ev({ op: 'DEF', target: 'app.field', operand: 'hello' }));
    const logBefore = await readLogSince(db, 0);

    const seq = await processEvent(db, ev({
      op: 'DEF',
      target: 'app.field',
      operand: 'hello',
    }));

    const logAfter = await readLogSince(db, 0);
    expect(logAfter.length).toBe(logBefore.length);
  });

  it('DEF on non-existent target still auto-instantiates', async () => {
    await processEvent(db, ev({ op: 'DEF', target: 'app.new', operand: { x: 1 } }));
    const state = await getState(db, 'app.new');
    expect(state).not.toBeNull();
    expect(state?.value).toEqual({ x: 1 });
  });

  it('DEF with new field added to existing object is not a no-op', async () => {
    await processEvent(db, ev({ target: 'app.rec1', operand: { name: 'Alice' } }));
    const logBefore = await readLogSince(db, 0);

    await processEvent(db, ev({
      op: 'DEF',
      target: 'app.rec1',
      operand: { email: 'alice@test.com' },
    }));

    const logAfter = await readLogSince(db, 0);
    expect(logAfter.length).toBe(logBefore.length + 1);
  });

  it('repeated identical DEFs do not spam the log', async () => {
    await processEvent(db, ev({ target: 'app.rec1', operand: { status: 'active' } }));

    // Spam 5 identical DEFs
    for (let i = 0; i < 5; i++) {
      await processEvent(db, ev({
        op: 'DEF',
        target: 'app.rec1',
        operand: { status: 'active' },
      }));
    }

    const log = await readLogSince(db, 0);
    // Only the original INS — all DEFs were no-ops
    expect(log.length).toBe(1);
  });

  it('no-op DEF resolves aliases before comparing', async () => {
    await processEvent(db, ev({ target: 'target.A', operand: { x: 1 } }));
    await processEvent(db, ev({ target: 'target.B', operand: { y: 2 } }));
    await processEvent(db, ev({
      op: 'SYN',
      target: 'target.C',
      operand: { merge: ['target.A', 'target.B'], into: 'target.C' },
    }));
    const logBefore = await readLogSince(db, 0);

    // DEF on alias target.A with value already in target.C
    const stateC = await getState(db, 'target.C');
    await processEvent(db, ev({
      op: 'DEF',
      target: 'target.A',
      operand: stateC!.value,
    }));

    const logAfter = await readLogSince(db, 0);
    expect(logAfter.length).toBe(logBefore.length);
  });
});

// --- Idempotency Tests ---

describe('Idempotency', () => {
  it('same client_event_id returns same seq without re-processing', async () => {
    const seq1 = await processEvent(db, ev({
      target: 'app.test',
      client_event_id: 'idem-001',
    }));
    const seq2 = await processEvent(db, ev({
      target: 'app.test',
      client_event_id: 'idem-001',
    }));
    expect(seq1).toBe(seq2);

    // Only one log entry
    const events = await readLogSince(db, 0);
    expect(events).toHaveLength(1);
  });

  it('different client_event_id processes normally', async () => {
    const seq1 = await processEvent(db, ev({
      target: 'app.test1',
      client_event_id: 'idem-001',
    }));
    const seq2 = await processEvent(db, ev({
      target: 'app.test2',
      client_event_id: 'idem-002',
    }));
    expect(seq1).not.toBe(seq2);
  });

  it('missing client_event_id always processes', async () => {
    const seq1 = await processEvent(db, ev({ target: 'app.a' }));
    const seq2 = await processEvent(db, ev({ target: 'app.b' }));
    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
  });
});

// --- Dependent Recomputation Tests ---

describe('Dependent Recomputation', () => {
  it('after DEF changes value, EVA-active dependents recompute', async () => {
    // Create source target and formula target
    await processEvent(db, ev({ target: 'data.source', operand: { val: 10 } }));
    await processEvent(db, ev({ target: 'data.formula', operand: {} }));

    // Create CON from formula to source (formula depends on source)
    await processEvent(db, ev({
      op: 'CON',
      target: 'data.formula',
      operand: { added: ['data.source'] },
    }));

    // Register formula (fold-computed)
    await processEvent(db, ev({
      op: 'DEF',
      target: 'data.formula',
      operand: { formula: 'SUM(source)' },
    }));

    // Change source value — should trigger recomputation
    await processEvent(db, ev({
      op: 'DEF',
      target: 'data.source',
      operand: { val: 20 },
    }));

    // The formula target should have _computed with the new input
    const formulaState = await getState(db, 'data.formula');
    expect(formulaState?.value?._computed).toBeDefined();
    expect(formulaState?.value?._computed?.inputs?.['data.source']).toEqual({ val: 20 });
  });

  it('recomputation writes to state only, not log', async () => {
    await processEvent(db, ev({ target: 'src', operand: { v: 1 } }));
    await processEvent(db, ev({ target: 'calc' }));
    await processEvent(db, ev({ op: 'CON', target: 'calc', operand: { added: ['src'] } }));
    await processEvent(db, ev({ op: 'DEF', target: 'calc', operand: { formula: 'F(x)' } }));

    const logBefore = await readLogSince(db, 0);
    const countBefore = logBefore.length;

    // Change source — triggers recomputation
    await processEvent(db, ev({ op: 'DEF', target: 'src', operand: { v: 2 } }));

    const logAfter = await readLogSince(db, 0);
    // Only one new log entry (the DEF on src), NOT the recomputation
    expect(logAfter.length).toBe(countBefore + 1);
  });

  it('recomputation respects fold vs horizon classification', async () => {
    await processEvent(db, ev({ target: 'time.src', operand: { filed: '2025-01-01' } }));
    await processEvent(db, ev({ target: 'time.deadline' }));
    await processEvent(db, ev({ op: 'CON', target: 'time.deadline', operand: { added: ['time.src'] } }));

    // Register horizon-computed formula (uses DAYS_UNTIL which is time-dependent)
    await processEvent(db, ev({
      op: 'DEF',
      target: 'time.deadline',
      operand: { formula: 'DAYS_UNTIL(filed + 180)' },
    }));

    // Change source — should NOT trigger write-time recomputation for horizon formulas
    const stateBefore = await getState(db, 'time.deadline');
    await processEvent(db, ev({
      op: 'DEF',
      target: 'time.src',
      operand: { filed: '2025-06-01' },
    }));
    const stateAfter = await getState(db, 'time.deadline');

    // Horizon-computed formulas don't get _computed at write time
    // (they're evaluated at read time in horizon.ts)
    // The state should have the formula definition but no _computed from recomputation
    expect(stateAfter?.value?.formula).toBe('DAYS_UNTIL(filed + 180)');
  });
});

// --- Full Fixture Sequence ---

// --- Dependency Graph (dep:fwd/rev) Tests ---

describe('Dependency Graph', () => {
  it('formula with explicit references creates dep edges, not CON edges', async () => {
    await processEvent(db, ev({ target: 'dep.A', operand: { val: 10 } }));
    await processEvent(db, ev({ target: 'dep.B', operand: { val: 20 } }));

    // DEF with formula that declares references — no CON needed
    await processEvent(db, ev({
      op: 'DEF', target: 'dep.A',
      operand: { formula: 'B * 2', references: ['dep.B'] },
    }));

    // Dep graph should have an edge: dep.A → dep.B
    const depsFrom = await getDepEdgesFrom(db, 'dep.A');
    expect(depsFrom).toHaveLength(1);
    expect(depsFrom[0].dest).toBe('dep.B');

    // Reverse: dep.B is referenced by dep.A
    const depsTo = await getDepEdgesTo(db, 'dep.B');
    expect(depsTo).toHaveLength(1);
    expect(depsTo[0].source).toBe('dep.A');

    // CON graph should NOT have these edges (no CON event was issued)
    const conEdges = await getEdgesFrom(db, 'dep.A');
    expect(conEdges).toHaveLength(0);
  });

  it('redefining formula updates dep edges (clears old, adds new)', async () => {
    await processEvent(db, ev({ target: 'redef.A', operand: { val: 1 } }));
    await processEvent(db, ev({ target: 'redef.B', operand: { val: 2 } }));
    await processEvent(db, ev({ target: 'redef.C', operand: { val: 3 } }));

    // First formula: A depends on B
    await processEvent(db, ev({
      op: 'DEF', target: 'redef.A',
      operand: { formula: 'B + 1', references: ['redef.B'] },
    }));
    let deps = await getDepEdgesFrom(db, 'redef.A');
    expect(deps.map(d => d.dest)).toEqual(['redef.B']);

    // Redefine: A now depends on C instead
    await processEvent(db, ev({
      op: 'DEF', target: 'redef.A',
      operand: { formula: 'C + 1', references: ['redef.C'] },
    }));
    deps = await getDepEdgesFrom(db, 'redef.A');
    expect(deps.map(d => d.dest)).toEqual(['redef.C']);

    // Old dep edge to B should be gone
    const depsToB = await getDepEdgesTo(db, 'redef.B');
    expect(depsToB).toHaveLength(0);
  });

  it('cycle detection uses dep graph, not CON graph', async () => {
    // Create two targets with formulas referencing each other via references field
    await processEvent(db, ev({ target: 'dcycle.A', operand: { val: 1 } }));
    await processEvent(db, ev({ target: 'dcycle.B', operand: { val: 2 } }));

    // No CON events. Only DEF with references.
    await processEvent(db, ev({
      op: 'DEF', target: 'dcycle.A',
      operand: { formula: 'F(B)', references: ['dcycle.B'] },
    }));
    await processEvent(db, ev({
      op: 'DEF', target: 'dcycle.B',
      operand: { formula: 'G(A)', references: ['dcycle.A'] },
    }));

    // Cycle should be detected via dep graph — REC event should be emitted
    const allEvents = await readLogSince(db, 0);
    const recEvents = allEvents.filter(e => e.op === 'REC');
    expect(recEvents.length).toBeGreaterThanOrEqual(1);
    expect(recEvents[0].agent).toBe('system');
  });

  it('fallback to CON edges when formula has no references field', async () => {
    await processEvent(db, ev({ target: 'compat.A', operand: { val: 1 } }));
    await processEvent(db, ev({ target: 'compat.B', operand: { val: 2 } }));

    // Set up CON edge (old behavior)
    await processEvent(db, ev({
      op: 'CON', target: 'compat.A', operand: { added: ['compat.B'] },
    }));

    // Formula without references field — should fall back to CON edges
    await processEvent(db, ev({
      op: 'DEF', target: 'compat.A',
      operand: { formula: 'SUM(B)' },
    }));

    // Dep graph should be populated from CON fallback
    const deps = await getDepEdgesFrom(db, 'compat.A');
    expect(deps).toHaveLength(1);
    expect(deps[0].dest).toBe('compat.B');
  });
});

// --- Near-Equality and Convergence Tests ---

describe('Convergence Detection', () => {
  it('nearEqual treats close floating-point values as equal', () => {
    expect(nearEqual(1.0, 1.0 + 1e-12)).toBe(true);
    expect(nearEqual(1.0, 1.1)).toBe(false);
    expect(nearEqual(0.0, 1e-12)).toBe(true);
    expect(nearEqual(0.0, 0.01)).toBe(false);
  });

  it('nearEqual handles nested objects with floats', () => {
    const a = { val: 3.14159265358, nested: { x: 1.000000000001 } };
    const b = { val: 3.14159265358, nested: { x: 1.0 } };
    expect(nearEqual(a, b)).toBe(true);
  });

  it('nearEqual handles NaN', () => {
    expect(nearEqual(NaN, NaN)).toBe(true);
    expect(nearEqual(NaN, 0)).toBe(false);
  });

  it('nearEqual handles arrays', () => {
    expect(nearEqual([1.0, 2.0], [1.0 + 1e-12, 2.0])).toBe(true);
    expect(nearEqual([1.0], [1.0, 2.0])).toBe(false);
  });
});

// --- REC Configuration Tests ---

describe('REC Configuration', () => {
  afterEach(() => {
    // Reset to defaults after each test
    setRecConfig({});
  });

  it('respects configurable max iterations (safety net)', async () => {
    setRecConfig({ maxIterations: 3 });

    await processEvent(db, ev({ target: 'cfg.A', operand: { val: 1 } }));
    await processEvent(db, ev({ target: 'cfg.B', operand: { val: 2 } }));

    await processEvent(db, ev({
      op: 'DEF', target: 'cfg.A',
      operand: { formula: 'F(B)', references: ['cfg.B'] },
    }));
    await processEvent(db, ev({
      op: 'DEF', target: 'cfg.B',
      operand: { formula: 'G(A)', references: ['cfg.A'] },
    }));

    const state = await getState(db, 'cfg.B');
    expect(state?.value?._rec?.result?.iterations).toBeLessThanOrEqual(3);
  });

  it('finds 3-hop cycles via standard DFS (no depth limit needed)', async () => {
    // A→B→C→A is a 3-hop cycle. DFS with visited set finds it.
    await processEvent(db, ev({ target: 'tri.A', operand: { val: 1 } }));
    await processEvent(db, ev({ target: 'tri.B', operand: { val: 2 } }));
    await processEvent(db, ev({ target: 'tri.C', operand: { val: 3 } }));

    await processEvent(db, ev({
      op: 'DEF', target: 'tri.A',
      operand: { formula: 'F(C)', references: ['tri.C'] },
    }));
    await processEvent(db, ev({
      op: 'DEF', target: 'tri.B',
      operand: { formula: 'G(A)', references: ['tri.A'] },
    }));
    await processEvent(db, ev({
      op: 'DEF', target: 'tri.C',
      operand: { formula: 'H(B)', references: ['tri.B'] },
    }));

    const allEvents = await readLogSince(db, 0);
    const recEvents = allEvents.filter(e => e.op === 'REC');
    expect(recEvents.length).toBeGreaterThanOrEqual(1);
    expect(recEvents[0].agent).toBe('system');
  });
});

// --- Critical REC (Phase Transition) Tests ---

describe('Critical REC', () => {
  it('fires critical REC when a new formula bridges two separate components', async () => {
    // Component 1: A↔B (separate cycle)
    await processEvent(db, ev({ target: 'cr.A', operand: { val: 1 } }));
    await processEvent(db, ev({ target: 'cr.B', operand: { val: 2 } }));
    await processEvent(db, ev({
      op: 'DEF', target: 'cr.A',
      operand: { formula: 'F(B)', references: ['cr.B'] },
    }));
    await processEvent(db, ev({
      op: 'DEF', target: 'cr.B',
      operand: { formula: 'G(A)', references: ['cr.A'] },
    }));

    // Component 2: C↔D (separate cycle)
    await processEvent(db, ev({ target: 'cr.C', operand: { val: 3 } }));
    await processEvent(db, ev({ target: 'cr.D', operand: { val: 4 } }));
    await processEvent(db, ev({
      op: 'DEF', target: 'cr.C',
      operand: { formula: 'H(D)', references: ['cr.D'] },
    }));
    await processEvent(db, ev({
      op: 'DEF', target: 'cr.D',
      operand: { formula: 'J(C)', references: ['cr.C'] },
    }));

    // Bridge: redefine B to also reference C — merges the two components
    const bridgeSeq = await processEvent(db, ev({
      op: 'DEF', target: 'cr.B',
      operand: { formula: 'G(A, C)', references: ['cr.A', 'cr.C'] },
    }));

    // Should produce a critical REC
    const allEvents = await readLogSince(db, 0);
    const recEvents = allEvents.filter(e => e.op === 'REC');
    const criticalRecs = recEvents.filter(e => e.operand?.critical === true);
    expect(criticalRecs.length).toBeGreaterThanOrEqual(1);

    const crit = criticalRecs[criticalRecs.length - 1];
    expect(crit.agent).toBe('system');
    expect(crit.operand.component_size).toBeGreaterThanOrEqual(4); // A, B, C, D

    // The pivot should have _rec with critical: true
    const pivotState = await getState(db, 'cr.B');
    expect(pivotState?.value?._rec?.critical).toBe(true);
    expect(pivotState?.value?._rec?.result?.iterations).toBe(1); // single pass — snap
  });

  it('critical REC produces derived entity with topology "critical"', async () => {
    // Two separate single-formula targets (no pre-existing cycles to cascade)
    await processEvent(db, ev({ target: 'ct.X', operand: { val: 10 } }));
    await processEvent(db, ev({ target: 'ct.Y', operand: { val: 20 } }));
    await processEvent(db, ev({ target: 'ct.Z', operand: { val: 30 } }));

    // Component 1: X references Y
    await processEvent(db, ev({
      op: 'DEF', target: 'ct.X',
      operand: { formula: 'F(Y)', references: ['ct.Y'] },
    }));

    // Component 2: Z references nothing yet — it's isolated
    await processEvent(db, ev({
      op: 'DEF', target: 'ct.Z',
      operand: { formula: 'H()', references: [] },
    }));

    // Now Y gets a formula referencing both X and Z — bridges components
    await processEvent(db, ev({
      op: 'DEF', target: 'ct.Y',
      operand: { formula: 'G(X, Z)', references: ['ct.X', 'ct.Z'] },
    }));

    // Find the derived entity with critical topology
    const allEvents = await readLogSince(db, 0);
    const sysIns = allEvents.filter(e => e.op === 'INS' && e.agent === 'system');
    const criticalIns = sysIns.filter(e => e.operand?.topology === 'critical');
    expect(criticalIns.length).toBeGreaterThanOrEqual(1);

    const derived = criticalIns[criticalIns.length - 1];
    expect(derived.operand.topology).toBe('critical');
    expect(derived.operand.constituents.length).toBeGreaterThanOrEqual(3);
  });

  it('iterative REC still fires for simple cycles (no component merge)', async () => {
    // Simple A↔B cycle — no merge, should be iterative
    await processEvent(db, ev({ target: 'iter.A', operand: { val: 1 } }));
    await processEvent(db, ev({ target: 'iter.B', operand: { val: 2 } }));
    await processEvent(db, ev({
      op: 'DEF', target: 'iter.A',
      operand: { formula: 'F(B)', references: ['iter.B'] },
    }));
    await processEvent(db, ev({
      op: 'DEF', target: 'iter.B',
      operand: { formula: 'G(A)', references: ['iter.A'] },
    }));

    const allEvents = await readLogSince(db, 0);
    const recEvents = allEvents.filter(e => e.op === 'REC');
    expect(recEvents.length).toBeGreaterThanOrEqual(1);

    // Should NOT be critical — it's a simple cycle, not a merge
    const criticalRecs = recEvents.filter(e => e.operand?.critical === true);
    expect(criticalRecs).toHaveLength(0);
  });
});

describe('Full Fixture Sequence', () => {
  it('processes all 10 fixture events correctly (REC no longer externally submitted)', async () => {
    const fixtures: EoEventInput[] = [
      { op: 'INS', target: 'app.tblClients.rec001', operand: { name: 'Maria Garcia', status: 'active' }, client_event_id: 'fix-001', agent: '@intake:matrix.example.com', ts: TS },
      { op: 'INS', target: 'app.tblCases.rec101', operand: { type: 'H1B', filed: '2025-06-01' }, client_event_id: 'fix-002', agent: '@intake:matrix.example.com', ts: TS },
      { op: 'CON', target: 'app.tblClients.rec001', operand: { added: ['app.tblCases.rec101'] }, client_event_id: 'fix-003', agent: '@intake:matrix.example.com', ts: TS },
      { op: 'DEF', target: 'app.tblCases.rec101.fldStatus', operand: 'pending', client_event_id: 'fix-004', agent: '@caseworker:matrix.example.com', ts: TS },
      { op: 'DEF', target: 'app.tblCases.rec101.fldStatus', operand: 'approved', client_event_id: 'fix-005', agent: '@caseworker:matrix.example.com', ts: TS },
      { op: 'DEF', target: 'app.tblClients.rec001.fldEmail', operand: 'maria@old.com', client_event_id: 'fix-006', agent: '@intake:matrix.example.com', ts: TS },
      { op: 'DEF', target: 'app.tblClients.rec001.fldEmail', operand: 'maria@new.com', client_event_id: 'fix-007', agent: '@caseworker:matrix.example.com', ts: TS },
      { op: 'EVA', target: 'app.tblClients.rec001.fldEmail', operand: { strategy: 'latest' }, client_event_id: 'fix-008', agent: '@admin:matrix.example.com', ts: TS },
      { op: 'SEG', target: 'app.tblClients.rec001', operand: { boundary: 'exclude', reason: 'archived' }, client_event_id: 'fix-009', agent: '@admin:matrix.example.com', ts: TS },
      { op: 'DEF', target: 'app.tblCases.rec101.fldDeadline', operand: { formula: 'DAYS_UNTIL(filed + 180)' }, client_event_id: 'fix-010', agent: '@admin:matrix.example.com', ts: TS },
    ];

    const seqs: number[] = [];
    for (const fixture of fixtures) {
      seqs.push(await processEvent(db, fixture));
    }

    // 10 sequential seq numbers (REC removed — it is system-generated only)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Verify key states
    const client = await getState(db, 'app.tblClients.rec001');
    expect(client?.last_op).toBe('SEG'); // Last event was SEG (archive)
    expect(client?.value?.boundary).toBe('exclude');

    const caseStatus = await getState(db, 'app.tblCases.rec101.fldStatus');
    expect(caseStatus?.value).toBe('approved'); // Overwritten from pending

    const email = await getState(db, 'app.tblClients.rec001.fldEmail');
    expect(email?.value).toEqual({ strategy: 'latest' }); // EVA overwrote the DEF value

    const deadline = await getState(db, 'app.tblCases.rec101.fldDeadline');
    expect(deadline?.value).toHaveProperty('formula');

    // Verify CON graph
    const clientEdges = await getEdgesFrom(db, 'app.tblClients.rec001');
    expect(clientEdges.some(e => e.dest === 'app.tblCases.rec101')).toBe(true);

    // Verify log has exactly 10 entries (no external REC)
    const allEvents = await readLogSince(db, 0);
    expect(allEvents).toHaveLength(10);
  });
});

// --- SIG Tests ---

describe('SIG', () => {
  it('returns -1 (no seq assigned)', async () => {
    const seq = await processEvent(db, ev({ op: 'SIG' as any, target: 'app.tblClients.rec001', operand: { cursor: true } }));
    expect(seq).toBe(-1);
  });

  it('does not write to the log', async () => {
    await processEvent(db, ev({ op: 'SIG' as any, target: 'app.tblClients.rec001', operand: { gaze: 'active' } }));
    const allEvents = await readLogSince(db, 0);
    expect(allEvents).toHaveLength(0);
  });

  it('does not create state', async () => {
    await processEvent(db, ev({ op: 'SIG' as any, target: 'app.tblClients.rec001', operand: {} }));
    const state = await getState(db, 'app.tblClients.rec001');
    expect(state).toBeNull();
  });

  it('tracks SIG events in the SigTracker', async () => {
    const { getSigTracker } = await import('../src/db/fold.js');
    const tracker = getSigTracker();
    tracker.clear();

    await processEvent(db, ev({ op: 'SIG' as any, target: 'app.tblClients.rec001', operand: { cursor: [10, 20] } }));
    await processEvent(db, ev({ op: 'SIG' as any, target: 'app.tblClients.rec002', operand: { cursor: [30, 40] } }));

    expect(tracker.size).toBe(2);
    expect(tracker.getEvents()).toHaveLength(2);
    expect(tracker.getLatest('app.tblClients.rec001')?.operand).toEqual({ cursor: [10, 20] });
  });

  it('does not consume a seq number', async () => {
    await processEvent(db, ev({ op: 'SIG' as any, target: 'app.tblClients.rec001', operand: {} }));
    // Next real event should get seq 1, not 2
    const seq = await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001', operand: { name: 'Test' } }));
    expect(seq).toBe(1);
  });

  it('notifies changefeed subscribers', async () => {
    const { Feed } = await import('../src/db/feed.js');
    const feed = new Feed();
    const received: any[] = [];
    feed.subscribe('**', (event) => received.push(event));

    await processEvent(db, ev({ op: 'SIG' as any, target: 'app.tblClients.rec001', operand: { focus: true } }), feed);
    expect(received).toHaveLength(1);
    expect(received[0].op).toBe('SIG');
    expect(received[0].target).toBe('app.tblClients.rec001');
  });
});
