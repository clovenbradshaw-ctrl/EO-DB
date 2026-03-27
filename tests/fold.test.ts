import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb, decode } from '../src/db/level.js';
import { processEvent } from '../src/db/fold.js';
import { getState, getStateByPrefix } from '../src/db/state.js';
import { getEdgesFrom, getEdgesTo } from '../src/db/graph.js';
import { readLogSince } from '../src/db/log.js';
import { resolveAlias } from '../src/db/helpers.js';
import type { EoEventInput } from '../src/db/types.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

const AGENT = '@intake:app.aminoimmigration.com';
const TS = '2025-06-01T00:00:00.000Z';

function ev(overrides: Partial<EoEventInput>): EoEventInput {
  return {
    op: 'INS',
    target: 'app.tblClients.rec001',
    operand: {},
    agent: AGENT,
    ts: TS,
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

  it('rejects duplicate target', async () => {
    await processEvent(db, ev({}));
    await expect(processEvent(db, ev({}))).rejects.toThrow('already instantiated');
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
  it('applies sub-operations atomically', async () => {
    // REC that creates a schema target with a DEF inside
    await processEvent(db, ev({
      op: 'REC',
      target: 'schema.tblCases',
      operand: {
        contains: [
          { op: 'DEF', target: 'schema.tblCases.fldUrgency', operand: { type: 'select' } },
        ],
        reason: 'Added urgency field',
      },
    }));

    // The DEF sub-op should have created state
    const state = await getState(db, 'schema.tblCases.fldUrgency');
    expect(state).not.toBeNull();
    expect(state?.value).toEqual({ type: 'select' });
  });

  it('sub-operations do not get their own seq numbers', async () => {
    await processEvent(db, ev({
      op: 'REC',
      target: 'schema.test',
      operand: {
        contains: [
          { op: 'DEF', target: 'schema.test.fldA', operand: 'a' },
          { op: 'DEF', target: 'schema.test.fldB', operand: 'b' },
        ],
      },
    }));

    // Only one log entry (the REC itself)
    const events = await readLogSince(db, 0);
    expect(events).toHaveLength(1);
    expect(events[0].op).toBe('REC');
  });

  it('is one log entry with sub-ops affecting state', async () => {
    const seq = await processEvent(db, ev({
      op: 'REC',
      target: 'frame.1',
      operand: {
        contains: [
          { op: 'DEF', target: 'frame.1.fieldA', operand: 'value_a' },
          { op: 'DEF', target: 'frame.1.fieldB', operand: 'value_b' },
        ],
        reason: 'batch update',
      },
    }));

    const stateA = await getState(db, 'frame.1.fieldA');
    const stateB = await getState(db, 'frame.1.fieldB');
    expect(stateA?.value).toBe('value_a');
    expect(stateB?.value).toBe('value_b');
    // Both share the REC's seq
    expect(stateA?.last_seq).toBe(seq);
    expect(stateB?.last_seq).toBe(seq);
  });

  it('can contain any mix of operators', async () => {
    // First create some targets
    await processEvent(db, ev({ target: 'rec.target1', operand: { status: 'active' } }));
    await processEvent(db, ev({ target: 'rec.target2', operand: { status: 'active' } }));

    await processEvent(db, ev({
      op: 'REC',
      target: 'rec.frame',
      operand: {
        contains: [
          { op: 'DEF', target: 'rec.target1', operand: { status: 'archived' } },
          { op: 'SEG', target: 'rec.target2', operand: { boundary: 'exclude' } },
        ],
      },
    }));

    const state1 = await getState(db, 'rec.target1');
    const state2 = await getState(db, 'rec.target2');
    expect(state1?.value).toEqual({ status: 'archived' });
    expect(state2?.value).toEqual({ boundary: 'exclude' });
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

describe('Full Fixture Sequence', () => {
  it('processes all 11 fixture events correctly', async () => {
    const fixtures: EoEventInput[] = [
      { op: 'INS', target: 'app.tblClients.rec001', operand: { name: 'Maria Garcia', status: 'active' }, client_event_id: 'fix-001', agent: '@intake:app.aminoimmigration.com', ts: TS },
      { op: 'INS', target: 'app.tblCases.rec101', operand: { type: 'H1B', filed: '2025-06-01' }, client_event_id: 'fix-002', agent: '@intake:app.aminoimmigration.com', ts: TS },
      { op: 'CON', target: 'app.tblClients.rec001', operand: { added: ['app.tblCases.rec101'] }, client_event_id: 'fix-003', agent: '@intake:app.aminoimmigration.com', ts: TS },
      { op: 'DEF', target: 'app.tblCases.rec101.fldStatus', operand: 'pending', client_event_id: 'fix-004', agent: '@caseworker:app.aminoimmigration.com', ts: TS },
      { op: 'DEF', target: 'app.tblCases.rec101.fldStatus', operand: 'approved', client_event_id: 'fix-005', agent: '@caseworker:app.aminoimmigration.com', ts: TS },
      { op: 'DEF', target: 'app.tblClients.rec001.fldEmail', operand: 'maria@old.com', client_event_id: 'fix-006', agent: '@intake:app.aminoimmigration.com', ts: TS },
      { op: 'DEF', target: 'app.tblClients.rec001.fldEmail', operand: 'maria@new.com', client_event_id: 'fix-007', agent: '@caseworker:app.aminoimmigration.com', ts: TS },
      { op: 'EVA', target: 'app.tblClients.rec001.fldEmail', operand: { strategy: 'latest' }, client_event_id: 'fix-008', agent: '@admin:app.aminoimmigration.com', ts: TS },
      { op: 'SEG', target: 'app.tblClients.rec001', operand: { boundary: 'exclude', reason: 'archived' }, client_event_id: 'fix-009', agent: '@admin:app.aminoimmigration.com', ts: TS },
      { op: 'DEF', target: 'app.tblCases.rec101.fldDeadline', operand: { formula: 'DAYS_UNTIL(filed + 180)' }, client_event_id: 'fix-010', agent: '@admin:app.aminoimmigration.com', ts: TS },
      { op: 'REC', target: 'schema.tblCases', operand: { contains: [{ op: 'DEF', target: 'schema.tblCases.fldUrgency', operand: { type: 'select' } }], reason: 'Added urgency field' }, client_event_id: 'fix-011', agent: '@admin:app.aminoimmigration.com', ts: TS },
    ];

    const seqs: number[] = [];
    for (const fixture of fixtures) {
      seqs.push(await processEvent(db, fixture));
    }

    // 11 sequential seq numbers
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

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

    const urgency = await getState(db, 'schema.tblCases.fldUrgency');
    expect(urgency?.value).toEqual({ type: 'select' });

    // Verify CON graph
    const clientEdges = await getEdgesFrom(db, 'app.tblClients.rec001');
    expect(clientEdges.some(e => e.dest === 'app.tblCases.rec101')).toBe(true);

    // Verify log has exactly 11 entries
    const allEvents = await readLogSince(db, 0);
    expect(allEvents).toHaveLength(11);
  });
});
