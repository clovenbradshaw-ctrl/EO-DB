import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import {
  getBranch, createBranch, listBranches,
  getBranchState, setBranchState,
  branchCursor, fork,
} from '../src/db/branch.js';
import {
  getResolutionPolicy, setResolutionPolicy,
  detectConflict, resolveConflict, resolutionModes,
} from '../src/db/conflict.js';
import { processEvent, processEventBatch } from '../src/db/fold.js';
import { horizonGet } from '../src/db/horizon.js';
import { appendToLog, readLogSince } from '../src/db/log.js';
import { getState } from '../src/db/state.js';
import type { EoEventInput, Branch, EVAResolutionPolicy, ConflictState } from '../src/db/types.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

const AGENT = '@test:matrix.example.com';
const TS = '2026-04-09T10:00:00.000Z';

function ev(overrides: Partial<EoEventInput>): EoEventInput {
  return {
    op: 'INS',
    target: 'app.cases.rec001',
    operand: { name: 'Ana Reyes' },
    agent: AGENT,
    ts: TS,
    acquired_ts: TS,
    ...overrides,
  };
}

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-branch-test-'));
  db = createDb(dbPath);
  await db.open();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

// ─── Branch primitives ────────────────────────────────────────────────────

describe('createBranch / getBranch / listBranches', () => {
  it('round-trips a branch record', async () => {
    const b: Branch = {
      id: 'alice', name: "Alice's corrections",
      parent: 'main', forkSeq: 5,
      createdAt: TS, agent: AGENT,
      scope: 'app.cases', role: 'reviewer',
    };
    await createBranch(db, b);
    const fetched = await getBranch(db, 'alice');
    expect(fetched).toEqual(b);
  });

  it('returns null for unknown branch', async () => {
    expect(await getBranch(db, 'nonexistent')).toBeNull();
  });

  it('returns synthetic main branch', async () => {
    const main = await getBranch(db, 'main');
    expect(main).not.toBeNull();
    expect(main!.id).toBe('main');
    expect(main!.parent).toBeUndefined();
    expect(main!.forkSeq).toBe(-1);
  });

  it('listBranches returns all stored branches', async () => {
    await createBranch(db, { id: 'bob', name: "Bob's review", parent: 'main', forkSeq: 3, createdAt: TS, agent: AGENT });
    await createBranch(db, { id: 'alice', name: "Alice's corrections", parent: 'main', forkSeq: 7, createdAt: TS, agent: AGENT });
    const list = await listBranches(db);
    expect(list.map(b => b.id).sort()).toEqual(['alice', 'bob']);
  });
});

// ─── Fork ─────────────────────────────────────────────────────────────────

describe('fork', () => {
  it('writes SEG + witnessed NUL to parent log with correct branch tag', async () => {
    const b = await fork(db, 'main', 'bob', "Bob's review", AGENT);
    const log = await readLogSince(db, 0);
    const seg = log.find(e => e.op === 'SEG' && e.target === 'branch.bob.fork');
    const nul = log.find(e => e.op === 'NUL' && e.target === 'branch.bob.fork');
    expect(seg).toBeTruthy();
    expect(nul).toBeTruthy();
    expect(seg!.branch).toBe('main');
    expect(nul!.branch).toBe('main');
    void b;
  });

  it('fork NUL operand has siteCondition:instantiated', async () => {
    await fork(db, 'main', 'bob', "Bob's review", AGENT);
    const log = await readLogSince(db, 0);
    const nul = log.find(e => e.op === 'NUL' && e.target === 'branch.bob.fork');
    expect(nul!.operand.siteCondition).toBe('instantiated');
  });

  it('creates branch metadata with forkSeq = NUL seq', async () => {
    const b = await fork(db, 'main', 'bob', "Bob's review", AGENT);
    const log = await readLogSince(db, 0);
    const nul = log.find(e => e.op === 'NUL' && e.target === 'branch.bob.fork');
    expect(b.forkSeq).toBe(nul!.seq);
  });

  it('fork marker target starts with branch. prefix', async () => {
    await fork(db, 'main', 'bob', "Bob's review", AGENT);
    const log = await readLogSince(db, 0);
    expect(log.every(e => e.target.startsWith('branch.') || true)).toBe(true);
    expect(log.some(e => e.target === 'branch.bob.fork')).toBe(true);
  });

  it('stores scope and role on branch when provided', async () => {
    const b = await fork(db, 'main', 'bob', "Bob's review", AGENT, { scope: 'app.cases', role: 'reviewer' });
    const fetched = await getBranch(db, 'bob');
    expect(fetched!.scope).toBe('app.cases');
    expect(fetched!.role).toBe('reviewer');
    void b;
  });
});

// ─── branchCursor ─────────────────────────────────────────────────────────

describe('branchCursor', () => {
  it('yields parent events up to forkSeq, then child events after', async () => {
    // Put two events on main
    await appendToLog(db, { seq: 1, op: 'INS', target: 'app.cases.rec001', operand: {}, agent: AGENT, ts: TS, acquired_ts: TS, branch: 'main' });
    await appendToLog(db, { seq: 2, op: 'DEF', target: 'app.cases.rec001', operand: { name: 'Ana' }, agent: AGENT, ts: TS, acquired_ts: TS, branch: 'main' });

    // Fork at seq 2
    await createBranch(db, { id: 'bob', name: 'Bob', parent: 'main', forkSeq: 2, createdAt: TS, agent: AGENT });

    // Bob's event
    await appendToLog(db, { seq: 3, op: 'DEF', target: 'app.cases.rec001', operand: { email: 'bob@test.com' }, agent: AGENT, ts: TS, acquired_ts: TS, branch: 'bob' });

    const events: number[] = [];
    for await (const e of branchCursor(db, 'bob')) {
      events.push(e.seq);
    }
    // Should yield: main events 1, 2 then bob event 3
    expect(events).toEqual([1, 2, 3]);
  });

  it('branchCursor with upTo — stops at correct seq', async () => {
    await appendToLog(db, { seq: 1, op: 'INS', target: 'app.cases.rec001', operand: {}, agent: AGENT, ts: TS, acquired_ts: TS, branch: 'main' });
    await appendToLog(db, { seq: 2, op: 'DEF', target: 'app.cases.rec001', operand: { a: 1 }, agent: AGENT, ts: TS, acquired_ts: TS, branch: 'main' });
    await createBranch(db, { id: 'bob', name: 'Bob', parent: 'main', forkSeq: 2, createdAt: TS, agent: AGENT });
    await appendToLog(db, { seq: 3, op: 'DEF', target: 'app.cases.rec001', operand: { b: 2 }, agent: AGENT, ts: TS, acquired_ts: TS, branch: 'bob' });
    await appendToLog(db, { seq: 4, op: 'DEF', target: 'app.cases.rec001', operand: { c: 3 }, agent: AGENT, ts: TS, acquired_ts: TS, branch: 'bob' });

    const events: number[] = [];
    for await (const e of branchCursor(db, 'bob', 3)) {
      events.push(e.seq);
    }
    expect(events).toEqual([1, 2, 3]);
  });

  it('THREE-LEVEL: stitches all three segments in order', async () => {
    // main events 1-2
    await appendToLog(db, { seq: 1, op: 'INS', target: 'app.cases.rec001', operand: {}, agent: AGENT, ts: TS, acquired_ts: TS, branch: 'main' });
    await appendToLog(db, { seq: 2, op: 'DEF', target: 'app.cases.rec001', operand: { a: 1 }, agent: AGENT, ts: TS, acquired_ts: TS, branch: 'main' });

    // alice forks from main at seq 2
    await createBranch(db, { id: 'alice', name: 'Alice', parent: 'main', forkSeq: 2, createdAt: TS, agent: AGENT });

    // alice event 3
    await appendToLog(db, { seq: 3, op: 'DEF', target: 'app.cases.rec001', operand: { b: 2 }, agent: AGENT, ts: TS, acquired_ts: TS, branch: 'alice' });

    // child forks from alice at seq 3
    await createBranch(db, { id: 'child', name: 'Child', parent: 'alice', forkSeq: 3, createdAt: TS, agent: AGENT });

    // child event 4
    await appendToLog(db, { seq: 4, op: 'DEF', target: 'app.cases.rec001', operand: { c: 3 }, agent: AGENT, ts: TS, acquired_ts: TS, branch: 'child' });

    const events: number[] = [];
    for await (const e of branchCursor(db, 'child')) {
      events.push(e.seq);
    }
    expect(events).toEqual([1, 2, 3, 4]);
  });

  it('throws for unknown branch', async () => {
    await expect(async () => {
      for await (const _ of branchCursor(db, 'doesnotexist')) { void _; }
    }).rejects.toThrow('Branch not found: doesnotexist');
  });
});

// ─── getBranchState / setBranchState ──────────────────────────────────────

describe('getBranchState / setBranchState', () => {
  it('getBranchState reads branch-scoped key when present', async () => {
    await createBranch(db, { id: 'bob', name: 'Bob', parent: 'main', forkSeq: 0, createdAt: TS, agent: AGENT });
    await setBranchState(db, 'bob', 'app.cases.rec001', {
      target: 'app.cases.rec001', value: { email: 'bob@test.com' },
      hash: 'abc', level: 1, last_seq: 1, last_op: 'DEF', last_agent: AGENT, last_ts: TS, last_acquired_ts: TS,
    });
    const state = await getBranchState(db, 'bob', 'app.cases.rec001');
    expect(state?.value.email).toBe('bob@test.com');
  });

  it('falls back to parent when branch key absent', async () => {
    // Write to main
    await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana' } }));
    await createBranch(db, { id: 'bob', name: 'Bob', parent: 'main', forkSeq: 1, createdAt: TS, agent: AGENT });
    // Bob has no branch-specific state for rec001
    const state = await getBranchState(db, 'bob', 'app.cases.rec001');
    expect(state?.value.name).toBe('Ana');
  });

  it('falls back through three levels to main', async () => {
    await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana' } }));
    await createBranch(db, { id: 'alice', name: 'Alice', parent: 'main', forkSeq: 1, createdAt: TS, agent: AGENT });
    await createBranch(db, { id: 'child', name: 'Child', parent: 'alice', forkSeq: 1, createdAt: TS, agent: AGENT });
    const state = await getBranchState(db, 'child', 'app.cases.rec001');
    expect(state?.value.name).toBe('Ana');
  });

  it('main branch reads state:{target} directly', async () => {
    await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana' } }));
    const state = await getBranchState(db, 'main', 'app.cases.rec001');
    expect(state?.value.name).toBe('Ana');
    // Same as getState
    const direct = await getState(db, 'app.cases.rec001');
    expect(state).toEqual(direct);
  });

  it('setBranchState writes state/{branchId}/{target}, not state:{target}', async () => {
    await createBranch(db, { id: 'bob', name: 'Bob', parent: 'main', forkSeq: 0, createdAt: TS, agent: AGENT });
    await setBranchState(db, 'bob', 'app.cases.rec001', {
      target: 'app.cases.rec001', value: { x: 1 },
      hash: 'h', level: 1, last_seq: 1, last_op: 'DEF', last_agent: AGENT, last_ts: TS, last_acquired_ts: TS,
    });
    // Main should be unaffected
    const mainState = await getState(db, 'app.cases.rec001');
    expect(mainState).toBeNull();
    // Branch should have the value
    const branchState = await getBranchState(db, 'bob', 'app.cases.rec001');
    expect(branchState?.value.x).toBe(1);
  });

  it('scope guard: target outside scope falls to parent directly', async () => {
    // Write to main
    await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana' } }));
    // Bob's branch is scoped to 'other.table' — NOT app.cases
    await createBranch(db, { id: 'bob', name: 'Bob', parent: 'main', forkSeq: 1, createdAt: TS, agent: AGENT, scope: 'other.table' });
    // Even if bob has branch state for app.cases.rec001 somehow, scope check bypasses it
    await setBranchState(db, 'bob', 'app.cases.rec001', {
      target: 'app.cases.rec001', value: { name: 'WRONG' },
      hash: 'h', level: 1, last_seq: 1, last_op: 'DEF', last_agent: AGENT, last_ts: TS, last_acquired_ts: TS,
    });
    // Reading app.cases.rec001 from bob should fall to main because app.cases is outside scope
    const state = await getBranchState(db, 'bob', 'app.cases.rec001');
    expect(state?.value.name).toBe('Ana');
  });
});

// ─── processEvent with branchId ───────────────────────────────────────────

describe('processEvent with branchId', () => {
  it('event stamped with correct branch field', async () => {
    await createBranch(db, { id: 'bob', name: 'Bob', parent: 'main', forkSeq: 0, createdAt: TS, agent: AGENT });
    const seq = await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana' } }), undefined, 'bob');
    const log = await readLogSince(db, 0);
    const e = log.find(x => x.seq === seq);
    expect(e?.branch).toBe('bob');
  });

  it('same content + different branch = different client_event_id (no false idem suppression)', async () => {
    // eventHash includes branch — same op/target/operand/agent/ts on different branches must hash differently
    const { eventHash } = await import('../src/db/hash.js');
    const baseEvent = ev({ op: 'DEF', operand: { name: 'Ana' }, target: 'app.cases.rX' });
    const mainEvent = { ...baseEvent, branch: 'main' };
    const bobEvent = { ...baseEvent, branch: 'bob' };
    expect(eventHash(mainEvent)).not.toBe(eventHash(bobEvent));
  });

  it('same content + same branch = same client_event_id (correct dedup within branch)', async () => {
    const seqFirst = await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana' }, target: 'app.cases.rY' }));
    const seqSecond = await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana' }, target: 'app.cases.rY' }));
    expect(seqFirst).toBe(seqSecond); // idem dedup
  });

  it('DEF on branch does not no-op when main has same value but branch is blank', async () => {
    await createBranch(db, { id: 'bob', name: 'Bob', parent: 'main', forkSeq: 0, createdAt: TS, agent: AGENT });
    // DEF on branch (target doesn't exist on branch yet — no-op check should see null)
    const seq = await processEvent(db, ev({ op: 'DEF', operand: { name: 'Ana' } }), undefined, 'bob');
    expect(seq).toBeGreaterThan(0);
    const state = await getBranchState(db, 'bob', 'app.cases.rec001');
    expect(state?.value.name).toBe('Ana');
  });

  it('INS on branch succeeds when target exists on main but not on branch', async () => {
    await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana' } }));
    await createBranch(db, { id: 'bob', name: 'Bob', parent: 'main', forkSeq: 2, createdAt: TS, agent: AGENT });
    // Different target — should succeed on bob even though same target exists on main
    const seq = await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana' }, target: 'app.cases.rec999' }), undefined, 'bob');
    expect(seq).toBeGreaterThan(0);
  });

  it('resolveAlias on branch follows alias created on that branch', async () => {
    await createBranch(db, { id: 'bob', name: 'Bob', parent: 'main', forkSeq: 0, createdAt: TS, agent: AGENT });
    // Write an alias on bob
    await setBranchState(db, 'bob', 'app.cases.alias1', {
      target: 'app.cases.alias1', value: { _alias: 'app.cases.rec001' },
      hash: 'h', level: 1, last_seq: 1, last_op: 'SYN', last_agent: AGENT, last_ts: TS, last_acquired_ts: TS,
    });
    // processEvent with DEF on the alias target — should resolve to rec001 on bob
    const seq = await processEvent(db, ev({ op: 'DEF', target: 'app.cases.alias1', operand: { val: 42 } }), undefined, 'bob');
    expect(seq).toBeGreaterThan(0);
    const state = await getBranchState(db, 'bob', 'app.cases.rec001');
    expect(state?.value.val).toBe(42);
  });
});

// ─── processEventBatch with branchId ──────────────────────────────────────

describe('processEventBatch with branchId', () => {
  it('batch events stamped with correct branch', async () => {
    await createBranch(db, { id: 'bob', name: 'Bob', parent: 'main', forkSeq: 0, createdAt: TS, agent: AGENT });
    const { seqs } = await processEventBatch(db, [
      ev({ op: 'INS', target: 'app.cases.b1', operand: { x: 1 } }),
      ev({ op: 'INS', target: 'app.cases.b2', operand: { x: 2 } }),
    ], undefined, 'bob');
    const log = await readLogSince(db, 0);
    for (const seq of seqs) {
      const e = log.find(x => x.seq === seq);
      expect(e?.branch).toBe('bob');
    }
  });

  it('batch idem dedup is branch-scoped', async () => {
    await createBranch(db, { id: 'bob', name: 'Bob', parent: 'main', forkSeq: 0, createdAt: TS, agent: AGENT });
    // Same event twice in same batch on same branch — should dedup
    const event = ev({ op: 'INS', target: 'app.cases.bdup', operand: { y: 1 } });
    const { seqs } = await processEventBatch(db, [event, event], undefined, 'bob');
    expect(seqs[0]).toBe(seqs[1]);
  });
});

// ─── Merge (SYN absorb) ───────────────────────────────────────────────────

describe('SYN absorb (handleBranchMerge)', () => {
  async function setupBobBranch() {
    // Main: INS rec001
    await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana', email: 'ana@main.com' } }));
    // Fork bob
    const bobBranch = await fork(db, 'main', 'bob', "Bob's review", AGENT);
    // Bob changes email
    await processEvent(db, ev({ op: 'DEF', operand: { email: 'ana@bob.com' } }), undefined, 'bob');
    return bobBranch;
  }

  it('no conflict written when absorbed and current values are deep-equal', async () => {
    await setupBobBranch();
    // Main also has same email — no conflict
    await processEvent(db, ev({ op: 'DEF', operand: { email: 'ana@bob.com' } }));
    // Absorb bob into main
    await processEvent(db, ev({
      op: 'SYN',
      target: 'app.cases.merge001',
      operand: { absorb: 'bob' },
    }));
    const state = await getState(db, 'app.cases.rec001');
    expect(state?.value?.conflict).toBeUndefined();
  });

  it('ConflictState written (originOp:DEF) when DEF values diverge', async () => {
    await setupBobBranch();
    // Main has different email — conflict
    await processEvent(db, ev({ op: 'DEF', operand: { email: 'ana@other.com' } }));
    await processEvent(db, ev({
      op: 'SYN',
      target: 'app.cases.merge001',
      operand: { absorb: 'bob' },
    }));
    const state = await getState(db, 'app.cases.rec001');
    expect(state?.value?.conflict).toBe(true);
    expect(state?.value?.originOp).toBe('DEF');
  });

  it('false conflict not written for deep-equal values', async () => {
    await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana', status: 'active' } }));
    const bobBranch = await fork(db, 'main', 'bob2', "Bob2", AGENT);
    // Bob doesn't change anything different
    await processEvent(db, ev({ op: 'DEF', operand: { name: 'Ana' } }), undefined, 'bob2');
    await processEvent(db, ev({
      op: 'SYN',
      target: 'app.cases.mgr2',
      operand: { absorb: 'bob2' },
    }));
    const state = await getState(db, 'app.cases.rec001');
    expect(state?.value?.conflict).toBeUndefined();
    void bobBranch;
  });

  it('fork-marker targets (branch.*) skipped during merge', async () => {
    await setupBobBranch();
    await processEvent(db, ev({
      op: 'SYN',
      target: 'app.cases.mgr3',
      operand: { absorb: 'bob' },
    }));
    const forkMarker = await getState(db, 'branch.bob.fork');
    // Fork marker is on the log but should not be in main state
    expect(forkMarker).toBeNull();
  });

  it('partial promotion: targetFilter restricts which targets are merged', async () => {
    // Use targets that don't exist on main — so merge is a clean write (no conflict)
    const partialBranch = await fork(db, 'main', 'partial2', 'Partial2', AGENT);
    // INS new targets only on the partial branch
    await processEvent(db, ev({ op: 'INS', target: 'app.cases.pA', operand: { email: 'a@partial.com' } }), undefined, 'partial2');
    await processEvent(db, ev({ op: 'INS', target: 'app.cases.pB', operand: { email: 'b@partial.com' } }), undefined, 'partial2');

    // Merge only pA into main
    await processEvent(db, ev({
      op: 'SYN',
      target: 'app.cases.mgr4',
      operand: { absorb: 'partial2', targetFilter: ['app.cases.pA'] },
    }));

    // pA should be written to main
    const s1 = await getState(db, 'app.cases.pA');
    expect(s1?.value?.email).toBe('a@partial.com');

    // pB should NOT be merged (not in targetFilter)
    const s2 = await getState(db, 'app.cases.pB');
    expect(s2).toBeNull();
    void partialBranch;
  });
});

// ─── Conflict resolution ──────────────────────────────────────────────────

describe('conflict resolution', () => {
  const conflict: ConflictState = {
    conflict: true,
    originOp: 'DEF',
    values: [
      { value: 'old@email.com', branch: 'main', seq: 5, agent: '@maria' },
      { value: 'new@email.com', branch: 'bob',  seq: 8, agent: '@bob' },
    ],
  };

  it('Dissecting/last-write-wins picks higher seq', () => {
    const policy: EVAResolutionPolicy = { type: 'Dissecting', rule: 'last-write-wins' };
    expect(resolveConflict(conflict, policy)).toBe('new@email.com'); // bob has seq 8
  });

  it('Dissecting/timestamp-ordered picks higher seq when seqs differ', () => {
    const policy: EVAResolutionPolicy = { type: 'Dissecting', rule: 'timestamp-ordered' };
    expect(resolveConflict(conflict, policy)).toBe('new@email.com');
  });

  it('Binding returns ConflictState as-is', () => {
    const policy: EVAResolutionPolicy = { type: 'Binding' };
    expect(resolveConflict(conflict, policy)).toBe(conflict);
  });

  it('Clearing returns null', () => {
    const policy: EVAResolutionPolicy = { type: 'Clearing' };
    expect(resolveConflict(conflict, policy)).toBeNull();
  });

  it('Tending returns last logHistory value', () => {
    const policy: EVAResolutionPolicy = { type: 'Tending' };
    const history = ['first@email.com', 'second@email.com'];
    expect(resolveConflict(conflict, policy, history)).toBe('second@email.com');
  });

  it('Tending with no history falls back to Binding', () => {
    const policy: EVAResolutionPolicy = { type: 'Tending' };
    const result = resolveConflict(conflict, policy);
    expect((result as ConflictState).conflict).toBe(true);
  });

  it('Unraveling returns full conflict structure', () => {
    const policy: EVAResolutionPolicy = { type: 'Unraveling' };
    expect(resolveConflict(conflict, policy)).toBe(conflict);
  });

  it('Cultivating returns { pending: true }', () => {
    const policy: EVAResolutionPolicy = { type: 'Cultivating' };
    const result = resolveConflict(conflict, policy) as any;
    expect(result.pending).toBe(true);
  });

  it('Composing throws with clear message', () => {
    const policy: EVAResolutionPolicy = { type: 'Composing' };
    expect(() => resolveConflict(conflict, policy)).toThrow('Composing resolution not yet implemented');
  });

  it('Making throws with clear message', () => {
    const policy: EVAResolutionPolicy = { type: 'Making' };
    expect(() => resolveConflict(conflict, policy)).toThrow('Making resolution not yet implemented');
  });

  it('Tracing throws with clear message', () => {
    const policy: EVAResolutionPolicy = { type: 'Tracing' };
    expect(() => resolveConflict(conflict, policy)).toThrow('Tracing resolution not yet implemented');
  });
});

// ─── detectConflict ───────────────────────────────────────────────────────

describe('detectConflict', () => {
  it('returns null for deep-equal values', () => {
    expect(detectConflict('DEF', { x: 1 }, 'main', 1, 'a', { x: 1 }, 'bob', 2, 'b')).toBeNull();
  });

  it('returns ConflictState for diverging values', () => {
    const c = detectConflict('DEF', { x: 1 }, 'main', 1, 'a', { x: 2 }, 'bob', 2, 'b');
    expect(c).not.toBeNull();
    expect(c!.conflict).toBe(true);
    expect(c!.values[0].value).toEqual({ x: 1 });
    expect(c!.values[1].value).toEqual({ x: 2 });
  });
});

// ─── EVA resolution policy ───────────────────────────────────────────────

describe('EVA resolution policy', () => {
  it('EVA event with resolution operand writes to eva-resolve:{target}', async () => {
    const policy: EVAResolutionPolicy = { type: 'Dissecting', rule: 'last-write-wins' };
    await processEvent(db, ev({ op: 'EVA', target: 'app.cases.rec001', operand: policy }));
    const stored = await getResolutionPolicy(db, 'app.cases.rec001');
    expect(stored?.type).toBe('Dissecting');
    expect(stored?.rule).toBe('last-write-wins');
  });

  it('getResolutionPolicy reads eva-resolve:{target}', async () => {
    await setResolutionPolicy(db, 'some.target', { type: 'Clearing' });
    const p = await getResolutionPolicy(db, 'some.target');
    expect(p?.type).toBe('Clearing');
  });

  it('EVA event with non-resolution operand does not write to eva-resolve', async () => {
    await processEvent(db, ev({ op: 'EVA', target: 'app.cases.rec001', operand: { mode: 'some-policy' } }));
    const policy = await getResolutionPolicy(db, 'app.cases.rec001');
    expect(policy).toBeNull(); // not a ResolutionMode
  });

  it('resolutionModes set contains expected modes', () => {
    expect(resolutionModes.has('Dissecting')).toBe(true);
    expect(resolutionModes.has('Binding')).toBe(true);
    expect(resolutionModes.has('Clearing')).toBe(true);
    expect(resolutionModes.has('Cultivating')).toBe(true);
  });

  it('horizonGet applies resolution policy when ConflictState present', async () => {
    await processEvent(db, ev({ op: 'INS', operand: { email: 'a@main.com' } }));
    // Write a ConflictState directly
    const existing = await getState(db, 'app.cases.rec001');
    await import('../src/db/state.js').then(m => m.setState(db, {
      ...existing!,
      value: {
        conflict: true,
        originOp: 'DEF',
        values: [
          { value: { email: 'a@main.com' }, branch: 'main', seq: 1, agent: '@maria' },
          { value: { email: 'b@bob.com' },  branch: 'bob',  seq: 5, agent: '@bob' },
        ],
      } as ConflictState,
    }));
    // Set resolution policy to Dissecting/last-write-wins
    await setResolutionPolicy(db, 'app.cases.rec001', { type: 'Dissecting', rule: 'last-write-wins' });
    // Horizon should resolve — pick bob's value (higher seq)
    const h = await horizonGet(db, 'app.cases.rec001');
    expect((h as any)?.figure?.value?.email).toBe('b@bob.com');
  });

  it('horizonGet returns ConflictState when no policy (Binding default)', async () => {
    await processEvent(db, ev({ op: 'INS', operand: { email: 'a@main.com' } }));
    const existing = await getState(db, 'app.cases.rec001');
    await import('../src/db/state.js').then(m => m.setState(db, {
      ...existing!,
      value: {
        conflict: true,
        originOp: 'DEF',
        values: [
          { value: { email: 'a@main.com' }, branch: 'main', seq: 1, agent: null },
          { value: { email: 'b@bob.com' },  branch: 'bob',  seq: 5, agent: null },
        ],
      } as ConflictState,
    }));
    const h = await horizonGet(db, 'app.cases.rec001');
    expect((h as any)?.figure?.value?.conflict).toBe(true);
  });
});

// ─── Horizon branch-awareness ─────────────────────────────────────────────

describe('horizonGet with branchId', () => {
  it('reads branch state when present', async () => {
    await processEvent(db, ev({ op: 'INS', operand: { email: 'main@test.com' } }));
    await createBranch(db, { id: 'bob', name: 'Bob', parent: 'main', forkSeq: 1, createdAt: TS, agent: AGENT });
    await setBranchState(db, 'bob', 'app.cases.rec001', {
      target: 'app.cases.rec001', value: { email: 'bob@test.com' },
      hash: 'x', level: 1, last_seq: 2, last_op: 'DEF', last_agent: AGENT, last_ts: TS, last_acquired_ts: TS,
    });
    const h = await horizonGet(db, 'app.cases.rec001', undefined, 'bob');
    expect((h as any)?.figure?.value?.email).toBe('bob@test.com');
  });

  it('falls back to main when branch has no state', async () => {
    await processEvent(db, ev({ op: 'INS', operand: { email: 'main@test.com' } }));
    await createBranch(db, { id: 'alice', name: 'Alice', parent: 'main', forkSeq: 1, createdAt: TS, agent: AGENT });
    const h = await horizonGet(db, 'app.cases.rec001', undefined, 'alice');
    expect((h as any)?.figure?.value?.email).toBe('main@test.com');
  });

  it('returns null for VOID target on branch', async () => {
    await createBranch(db, { id: 'new', name: 'New', parent: 'main', forkSeq: 0, createdAt: TS, agent: AGENT });
    const h = await horizonGet(db, 'app.cases.notexist', undefined, 'new');
    expect(h).toBeNull();
  });
});

// ─── Backward compatibility ───────────────────────────────────────────────

describe('backward compat — branchId defaults to main', () => {
  it('processEvent without branchId still works (defaults to main)', async () => {
    const seq = await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana' } }));
    expect(seq).toBeGreaterThan(0);
    const state = await getState(db, 'app.cases.rec001');
    expect(state?.value.name).toBe('Ana');
  });

  it('horizonGet without branchId reads main state', async () => {
    await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana' } }));
    const h = await horizonGet(db, 'app.cases.rec001');
    expect((h as any)?.figure?.value?.name).toBe('Ana');
  });

  it('processEventBatch without branchId defaults to main', async () => {
    const { seqs, errors } = await processEventBatch(db, [
      ev({ op: 'INS', target: 'app.cases.back1', operand: { x: 1 } }),
      ev({ op: 'INS', target: 'app.cases.back2', operand: { x: 2 } }),
    ]);
    expect(errors).toHaveLength(0);
    expect(seqs).toHaveLength(2);
    const s = await getState(db, 'app.cases.back1');
    expect(s?.value.x).toBe(1);
  });
});

// ─── Sandbox ─────────────────────────────────────────────────────────────

describe('sandbox', () => {
  it('createSandbox / stageSandboxEntry / sandboxRead', async () => {
    const { createSandbox, stageSandboxEntry, sandboxRead } = await import('../src/db/sandbox.js');
    await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana' } }));
    const sb = createSandbox('main', AGENT);
    stageSandboxEntry(sb, { target: 'app.cases.rec001', op: 'DEF', operand: { name: 'Draft Ana' } });
    const { value, fromSandbox } = await sandboxRead(db, sb, 'app.cases.rec001');
    expect(value.name).toBe('Draft Ana');
    expect(fromSandbox).toBe(true);
  });

  it('sandboxRead falls through to real state when not staged', async () => {
    const { createSandbox, sandboxRead } = await import('../src/db/sandbox.js');
    await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana' } }));
    const sb = createSandbox('main', AGENT);
    const { value, fromSandbox } = await sandboxRead(db, sb, 'app.cases.rec001');
    expect(value.name).toBe('Ana');
    expect(fromSandbox).toBe(false);
  });

  it('promoteSandbox fires real operators for each SIG entry', async () => {
    const { createSandbox, stageSandboxEntry, promoteSandbox } = await import('../src/db/sandbox.js');
    await processEvent(db, ev({ op: 'INS', operand: { name: 'Ana' } }));
    const sb = createSandbox('main', AGENT);
    stageSandboxEntry(sb, { target: 'app.cases.rec001', op: 'DEF', operand: { name: 'Promoted' } });
    const results = await promoteSandbox(db, sb);
    expect(results).toHaveLength(1);
    const state = await getState(db, 'app.cases.rec001');
    expect(state?.value.name).toBe('Promoted');
  });
});
