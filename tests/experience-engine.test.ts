/**
 * Experience Engine conformance tests.
 *
 * Tests the formal specification: E = (G, S, M, pi, gamma, sigma)
 * and the nine rules.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb, decode } from '../src/db/level.js';
import { processEvent } from '../src/db/fold.js';
import { getState } from '../src/db/state.js';
import { readLogForTarget } from '../src/db/log.js';
import { resolveAlias } from '../src/db/helpers.js';
import type { EoEventInput, EoEvent } from '../src/db/types.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Experience Engine imports
import { classifyCellType, inferNulState } from '../src/db/ee-classify.js';
import { NulState, operatorDomain, operatorTarget } from '../src/db/ee-types.js';
import type { Interpretation, Window } from '../src/db/ee-types.js';
import {
  assertInterpretation,
  getInterpretation,
  getInterpretationsForTarget,
  getActiveInterpretations,
  interpretationFromEvent,
  traceProvenance,
  supersedeInterpretation,
  retireInterpretation,
} from '../src/db/meant-graph.js';
import {
  computePosition,
  computeAvailability,
  computeSupersession,
  windowedRead,
} from '../src/db/ee-functions.js';
import {
  checkAllRules,
  checkRule1,
  checkRule2,
  checkRule3,
  checkRule4,
  checkRule7ForInterpretation,
  checkRule9,
  checkRule9ForInterpretation,
  checkInterpretationRules,
  verifyRestrictivity,
} from '../src/db/ee-rules.js';
import { RuleViolation } from '../src/db/ee-types.js';

let db: EoDb;
let dbPath: string;

const AGENT_A = '@alice:matrix.example.com';
const AGENT_B = '@bob:matrix.example.com';
const TS = '2025-06-01T00:00:00.000Z';
const TS2 = '2025-06-02T00:00:00.000Z';

function ev(overrides: Partial<EoEventInput>): EoEventInput {
  return {
    op: 'INS',
    target: 'test',
    operand: {},
    agent: AGENT_A,
    ts: TS,
    acquired_ts: TS,
    ...overrides,
  };
}

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-ee-test-'));
  db = createDb(dbPath);
  await db.open();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

// ===========================================================================
// Given-Log (G): What happened
// ===========================================================================

describe('Given-Log', () => {
  describe('cell type classification', () => {
    it('INS classifies as INS x figure', () => {
      const ct = classifyCellType('INS', { name: 'Alice' });
      expect(ct.mode).toBe('INS');
      expect(ct.object).toBe('figure');
    });

    it('NUL classifies as NUL', () => {
      const ct = classifyCellType('NUL', {});
      expect(ct.mode).toBe('NUL');
    });

    it('SIG classifies as SIG', () => {
      const ct = classifyCellType('SIG', {});
      expect(ct.mode).toBe('SIG');
    });

    it('SEG classifies as INS x ground (boundary is ambient)', () => {
      const ct = classifyCellType('SEG', { boundary: 'group' });
      expect(ct.mode).toBe('INS');
      expect(ct.object).toBe('ground');
    });

    it('CON classifies as INS x pattern (spans multiple figures)', () => {
      const ct = classifyCellType('CON', { added: ['target1'] });
      expect(ct.mode).toBe('INS');
      expect(ct.object).toBe('pattern');
    });

    it('DEF classifies as INS x figure (specific entity value)', () => {
      const ct = classifyCellType('DEF', { name: 'value' });
      expect(ct.mode).toBe('INS');
      expect(ct.object).toBe('figure');
    });
  });

  describe('three NUL states', () => {
    it('cleared: was present, now absent', () => {
      const state = { target: 'x', value: {}, hash: '', level: 1, last_seq: 1, last_op: 'INS' as const, last_agent: '', last_ts: '', last_acquired_ts: '' };
      expect(inferNulState({}, state)).toBe('cleared');
    });

    it('unknown: no prior state', () => {
      expect(inferNulState({}, null)).toBe('unknown');
    });

    it('never_set: explicit in operand', () => {
      expect(inferNulState({ nul_state: 'never_set' }, null)).toBe('never_set');
    });

    it('fold auto-classifies NUL events', async () => {
      // Create a target, then NUL it
      await processEvent(db, ev({ target: 'test.item', operand: { name: 'thing' } }));
      await processEvent(db, ev({ op: 'NUL', target: 'test.item', operand: {} }));

      // The NUL event should have nul_state: 'cleared' (was present, now absent)
      const log = await readLogForTarget(db, 'test.item');
      const nulEvent = log.find(e => e.op === 'NUL');
      expect(nulEvent?.nul_state).toBe('cleared');
    });

    it('NUL on non-existent target gets unknown state', async () => {
      await processEvent(db, ev({ op: 'NUL', target: 'test.phantom', operand: {} }));
      const log = await readLogForTarget(db, 'test.phantom');
      expect(log[0]?.nul_state).toBe('unknown');
    });
  });

  describe('cell_type auto-classification in fold', () => {
    it('INS events get cell_type on log entry', async () => {
      await processEvent(db, ev({ target: 'test.entity', operand: { name: 'X' } }));
      const log = await readLogForTarget(db, 'test.entity');
      expect(log[0]?.cell_type).toBeDefined();
      expect(log[0]?.cell_type?.mode).toBe('INS');
      expect(log[0]?.cell_type?.object).toBe('figure');
    });

    it('SEG events get ground cell_type', async () => {
      await processEvent(db, ev({ target: 'test.region' }));
      await processEvent(db, ev({
        op: 'SEG', target: 'test.region',
        operand: { boundary: 'group', membership: 'open' },
      }));
      const log = await readLogForTarget(db, 'test.region');
      const segEvent = log.find(e => e.op === 'SEG');
      expect(segEvent?.cell_type?.object).toBe('ground');
    });
  });

  describe('operator domain classification', () => {
    it('existence triad: NUL, SIG, INS', () => {
      expect(operatorDomain('NUL')).toBe('existence');
      expect(operatorDomain('SIG')).toBe('existence');
      expect(operatorDomain('INS')).toBe('existence');
    });

    it('structure triad: SEG, CON, SYN', () => {
      expect(operatorDomain('SEG')).toBe('structure');
      expect(operatorDomain('CON')).toBe('structure');
      expect(operatorDomain('SYN')).toBe('structure');
    });

    it('significance triad: DEF, EVA, REC', () => {
      expect(operatorDomain('DEF')).toBe('significance');
      expect(operatorDomain('EVA')).toBe('significance');
      expect(operatorDomain('REC')).toBe('significance');
    });
  });
});

// ===========================================================================
// Meant-Graph (M): What it means
// ===========================================================================

describe('Meant-Graph', () => {
  it('DEF events produce interpretations in meant-graph', async () => {
    await processEvent(db, ev({ target: 'data.rec1', operand: { name: 'Alice' } }));
    const seq = await processEvent(db, ev({
      op: 'DEF', target: 'data.rec1', operand: { name: 'Alice Updated' },
    }));

    const interps = await getInterpretationsForTarget(db, 'data.rec1');
    expect(interps.length).toBeGreaterThanOrEqual(1);

    const defInterp = interps.find(i => i.op === 'DEF');
    expect(defInterp).toBeDefined();
    expect(defInterp!.content).toEqual({ name: 'Alice Updated' });
    expect(defInterp!.agent).toBe(AGENT_A);
  });

  it('EVA events produce interpretations', async () => {
    await processEvent(db, ev({ target: 'policy.rule1' }));
    await processEvent(db, ev({
      op: 'EVA', target: 'policy.rule1',
      operand: { strategy: 'custody' },
    }));

    const interps = await getInterpretationsForTarget(db, 'policy.rule1');
    const evaInterp = interps.find(i => i.op === 'EVA');
    expect(evaInterp).toBeDefined();
    expect(evaInterp!.content.strategy).toBe('custody');
  });

  it('interpretations carry provenance (grounded_in)', async () => {
    const seq1 = await processEvent(db, ev({ target: 'data.rec1', operand: {} }));
    const seq2 = await processEvent(db, ev({
      op: 'DEF', target: 'data.rec1', operand: { value: 42 },
    }));

    const interps = await getInterpretationsForTarget(db, 'data.rec1');
    const defInterp = interps.find(i => i.op === 'DEF');
    expect(defInterp!.grounded_in).toContain(seq2);
  });

  it('interpretations carry window specification', async () => {
    await processEvent(db, ev({ target: 'data.rec1' }));
    await processEvent(db, ev({
      op: 'DEF', target: 'data.rec1', operand: { value: 42 },
    }));

    const interps = await getInterpretationsForTarget(db, 'data.rec1');
    const defInterp = interps.find(i => i.op === 'DEF');
    expect(defInterp!.window).toBeDefined();
    expect(defInterp!.window.position).toBe(AGENT_A);
    expect(defInterp!.window.grain).toBe('data');
  });

  it('supersession: new DEF supersedes prior DEF on same target', async () => {
    // DEF sets a value. A new DEF on the same target supersedes the prior one.
    await processEvent(db, ev({ target: 'data.rec1' }));
    await processEvent(db, ev({
      op: 'DEF', target: 'data.rec1', operand: { v: 1 },
    }));
    await processEvent(db, ev({
      op: 'DEF', target: 'data.rec1', operand: { v: 2 }, ts: TS2,
    }));

    const all = await getInterpretationsForTarget(db, 'data.rec1');
    const defs = all.filter(i => i.op === 'DEF');

    // Should have 2 DEF interpretations total
    expect(defs.length).toBe(2);

    // The first should be superseded, the second active
    const superseded = defs.filter(i => i.status === 'superseded');
    expect(superseded.length).toBe(1);
    expect(superseded[0].content).toEqual({ v: 1 });

    const activeDefs = defs.filter(i => i.status === 'active');
    expect(activeDefs.length).toBe(1);
    expect(activeDefs[0].content).toEqual({ v: 2 });
  });

  it('provenance chain traces to Given-Log entries', async () => {
    const seq1 = await processEvent(db, ev({ target: 'data.rec1' }));
    const seq2 = await processEvent(db, ev({
      op: 'DEF', target: 'data.rec1', operand: { value: 42 },
    }));

    const interps = await getInterpretationsForTarget(db, 'data.rec1');
    const defInterp = interps.find(i => i.op === 'DEF');

    const chain = await traceProvenance(db, 'data.rec1', defInterp!.id);
    expect(chain.complete).toBe(true);
    expect(chain.terminal_grounds).toContain(seq2);
  });

  it('retired interpretations remain for audit', async () => {
    await processEvent(db, ev({ target: 'data.rec1' }));
    await processEvent(db, ev({
      op: 'DEF', target: 'data.rec1', operand: { v: 1 },
    }));

    const interps = await getInterpretationsForTarget(db, 'data.rec1');
    const defInterp = interps.find(i => i.op === 'DEF');

    await retireInterpretation(db, 'data.rec1', defInterp!.id);

    // Still exists but status is retired
    const retired = await getInterpretation(db, 'data.rec1', defInterp!.id);
    expect(retired!.status).toBe('retired');

    // No longer in active list
    const active = await getActiveInterpretations(db, 'data.rec1');
    expect(active.find(i => i.id === defInterp!.id)).toBeUndefined();
  });
});

// ===========================================================================
// Structure-Lattice (S): How what happened is connected
// ===========================================================================

describe('Structure-Lattice', () => {
  it('position computation includes boundaries and connections', async () => {
    await processEvent(db, ev({ target: 'net' }));
    await processEvent(db, ev({
      op: 'SEG', target: 'net', operand: { boundary: 'group', membership: 'open' },
    }));
    await processEvent(db, ev({ target: 'net.team' }));
    await processEvent(db, ev({ target: AGENT_A, agent: AGENT_A }));
    await processEvent(db, ev({
      op: 'CON', target: 'net.team', operand: { added: [AGENT_A], edge_type: 'member' },
    }));

    const pos = await computePosition(db, AGENT_A, 'net.team');
    expect(pos.agent).toBe(AGENT_A);
    expect(pos.anchor).toBe('net.team');
    // Should include the CON connection to AGENT_A
    expect(pos.connections).toContain(AGENT_A);
  });

  it('windowed read respects temporal bounds', async () => {
    await processEvent(db, ev({ target: 'data.series', ts: '2025-01-01T00:00:00Z' }));
    await processEvent(db, ev({
      op: 'DEF', target: 'data.series', operand: { v: 1 }, ts: '2025-01-15T00:00:00Z',
    }));
    await processEvent(db, ev({
      op: 'DEF', target: 'data.series', operand: { v: 2 }, ts: '2025-02-15T00:00:00Z',
    }));

    const window: Window = {
      grain: 'data.series',
      bounds: { from: '2025-01-10T00:00:00Z', to: '2025-01-31T00:00:00Z' },
      position: AGENT_A,
    };

    const events = await windowedRead(db, window);
    // Should only see the Jan 15 event, not the Jan 1 INS or Feb 15 DEF
    expect(events.length).toBe(1);
    expect(events[0].operand).toEqual({ v: 1 });
  });
});

// ===========================================================================
// The Three Functions
// ===========================================================================

describe('Horizon functions', () => {
  describe('gamma (availability)', () => {
    it('position sees its anchor subtree', async () => {
      await processEvent(db, ev({ target: 'scope.a' }));
      await processEvent(db, ev({ target: 'scope.a.item1' }));
      await processEvent(db, ev({ target: 'scope.b' }));

      const pos = await computePosition(db, AGENT_A, 'scope.a');
      const avail = await computeAvailability(db, pos);

      // Should see scope.a and scope.a.item1
      expect(avail.visible_entries.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('pi (provenance)', () => {
    it('traces interpretation back to raw experience', async () => {
      const seqIns = await processEvent(db, ev({ target: 'data.thing' }));
      const seqDef = await processEvent(db, ev({
        op: 'DEF', target: 'data.thing', operand: { x: 1 },
      }));

      const interps = await getInterpretationsForTarget(db, 'data.thing');
      const defInterp = interps.find(i => i.op === 'DEF');

      const chain = await traceProvenance(db, 'data.thing', defInterp!.id);
      expect(chain.complete).toBe(true);
      expect(chain.direct_grounds).toContain(seqDef);
    });
  });

  describe('sigma (supersession)', () => {
    it('computes which interpretations can be superseded', async () => {
      await processEvent(db, ev({ target: 'data.thing' }));
      await processEvent(db, ev({
        op: 'DEF', target: 'data.thing', operand: { x: 1 },
      }));
      await processEvent(db, ev({ target: AGENT_A, agent: AGENT_A }));
      await processEvent(db, ev({
        op: 'CON', target: 'data.thing', operand: { added: [AGENT_A], edge_type: 'member' },
      }));

      const interps = await getActiveInterpretations(db, 'data.thing');
      const pos = await computePosition(db, AGENT_A, 'data.thing');
      const scope = await computeSupersession(db, pos, interps[0].id);

      // The interpretation exists and the position has access
      expect(scope.interpretation_id).toBe(interps[0].id);
    });
  });
});

// ===========================================================================
// The Nine Rules
// ===========================================================================

describe('Nine Rules', () => {
  describe('Rule 1 — Distinction (Given/Meant exclusive)', () => {
    it('passes for correctly categorized events', async () => {
      const insEvent = { op: 'INS', target: 'x', operand: {}, agent: AGENT_A, ts: TS, acquired_ts: TS, seq: 1 } as EoEvent;
      expect(checkRule1(insEvent).passed).toBe(true);

      const defEvent = { op: 'DEF', target: 'x', operand: {}, agent: AGENT_A, ts: TS, acquired_ts: TS, seq: 2 } as EoEvent;
      expect(checkRule1(defEvent).passed).toBe(true);
    });

    it('fails for significance event claiming to be raw experience', () => {
      const event = {
        op: 'DEF', target: 'x', operand: {},
        agent: AGENT_A, ts: TS, acquired_ts: TS, seq: 1,
        meta: { is_raw_experience: true },
      } as EoEvent;
      const result = checkRule1(event);
      expect(result.passed).toBe(false);
      expect(result.violation).toBe(RuleViolation.CATEGORICAL_CONFUSION);
    });
  });

  describe('Rule 2 — Impenetrability (Given from Given only)', () => {
    it('passes for normal events', () => {
      const event = { op: 'INS', target: 'x', operand: {}, agent: AGENT_A, ts: TS, acquired_ts: TS, seq: 1 } as EoEvent;
      expect(checkRule2(event).passed).toBe(true);
    });

    it('fails for existence event triggered by significance event', () => {
      const event = {
        op: 'INS', target: 'x', operand: {},
        agent: AGENT_A, ts: TS, acquired_ts: TS, seq: 1,
        triggered_by: 5,
        meta: { _triggered_by_domain: 'significance' },
      } as EoEvent;
      const result = checkRule2(event);
      expect(result.passed).toBe(false);
      expect(result.violation).toBe(RuleViolation.CONFABULATION);
    });
  });

  describe('Rule 3 — Ineliminability (append-only)', () => {
    it('passes for normal events', () => {
      const event = { op: 'DEF', target: 'x', operand: { v: 1 }, agent: AGENT_A, ts: TS, acquired_ts: TS, seq: 1 } as EoEvent;
      expect(checkRule3(event).passed).toBe(true);
    });

    it('fails for events attempting to delete log entries', () => {
      const event = {
        op: 'DEF', target: 'x',
        operand: { _delete_log_entry: 5 },
        agent: AGENT_A, ts: TS, acquired_ts: TS, seq: 1,
      } as EoEvent;
      const result = checkRule3(event);
      expect(result.passed).toBe(false);
      expect(result.violation).toBe(RuleViolation.GASLIGHTING);
    });
  });

  describe('Rule 4 — Perspectivality (no God-eye view)', () => {
    it('passes for events with agent', () => {
      const event = { op: 'INS', target: 'x', operand: {}, agent: AGENT_A, ts: TS, acquired_ts: TS, seq: 1 } as EoEvent;
      expect(checkRule4(event).passed).toBe(true);
    });

    it('fails for events without agent', () => {
      const event = { op: 'INS', target: 'x', operand: {}, agent: '', ts: TS, acquired_ts: TS, seq: 1 } as EoEvent;
      const result = checkRule4(event);
      expect(result.passed).toBe(false);
      expect(result.violation).toBe(RuleViolation.CONTEXT_COLLAPSE);
    });
  });

  describe('Rule 5 — Restrictivity (refinement restricts)', () => {
    it('passes when child sees subset of parent', () => {
      const result = verifyRestrictivity([1, 2, 3, 4, 5], [1, 2, 3]);
      expect(result.passed).toBe(true);
    });

    it('fails when child sees entries parent cannot', () => {
      const result = verifyRestrictivity([1, 2, 3], [1, 2, 3, 99]);
      expect(result.passed).toBe(false);
      expect(result.violation).toBe(RuleViolation.FORECLOSURE_VIOLATION);
    });
  });

  describe('Rule 7 — Groundedness (interpretation has provenance)', () => {
    it('passes for grounded interpretation', () => {
      const interp: Interpretation = {
        id: 'i1', target: 'x', op: 'DEF', content: {},
        grounded_in: [1, 2], position: AGENT_A,
        window: { grain: 'x', bounds: {}, position: AGENT_A },
        supersedes: [], superseded_by: [],
        agent: AGENT_A, ts: TS, status: 'active',
      };
      expect(checkRule7ForInterpretation(interp).passed).toBe(true);
    });

    it('fails for ungrounded interpretation', () => {
      const interp: Interpretation = {
        id: 'i1', target: 'x', op: 'DEF', content: {},
        grounded_in: [], position: AGENT_A,
        window: { grain: 'x', bounds: {}, position: AGENT_A },
        supersedes: [], superseded_by: [],
        agent: AGENT_A, ts: TS, status: 'active',
      };
      const result = checkRule7ForInterpretation(interp);
      expect(result.passed).toBe(false);
      expect(result.violation).toBe(RuleViolation.UNGROUNDED_ASSERTION);
    });
  });

  describe('Rule 9 — Defeasibility (no immune interpretation)', () => {
    it('passes for normal EVA', () => {
      const event = { op: 'EVA', target: 'x', operand: { strategy: 'custody' }, agent: AGENT_A, ts: TS, acquired_ts: TS, seq: 1 } as EoEvent;
      expect(checkRule9(event).passed).toBe(true);
    });

    it('fails for EVA claiming immunity', () => {
      const event = {
        op: 'EVA', target: 'x',
        operand: { strategy: 'custody', immune: true },
        agent: AGENT_A, ts: TS, acquired_ts: TS, seq: 1,
      } as EoEvent;
      const result = checkRule9(event);
      expect(result.passed).toBe(false);
      expect(result.violation).toBe(RuleViolation.DOGMATISM);
    });

    it('fails for interpretation claiming immunity', () => {
      const interp = {
        id: 'i1', target: 'x', op: 'DEF' as const, content: {},
        grounded_in: [1], position: AGENT_A,
        window: { grain: 'x', bounds: {}, position: AGENT_A },
        supersedes: [], superseded_by: [],
        agent: AGENT_A, ts: TS, status: 'active' as const,
        immune: true,
      };
      const result = checkRule9ForInterpretation(interp as any);
      expect(result.passed).toBe(false);
      expect(result.violation).toBe(RuleViolation.DOGMATISM);
    });
  });

  describe('full rule check', () => {
    it('all nine rules pass for a valid event', () => {
      const event = {
        op: 'INS', target: 'x', operand: { name: 'test' },
        agent: AGENT_A, ts: TS, acquired_ts: TS, seq: 1,
      } as EoEvent;
      const results = checkAllRules(event);
      expect(results).toHaveLength(9);
      expect(results.every(r => r.passed)).toBe(true);
    });
  });
});

// ===========================================================================
// Given/Meant Distinction — the structural separation
// ===========================================================================

describe('Given/Meant distinction', () => {
  it('INS events write to state but NOT to meant-graph', async () => {
    await processEvent(db, ev({ target: 'data.thing', operand: { name: 'X' } }));

    const state = await getState(db, 'data.thing');
    expect(state).not.toBeNull();

    const interps = await getInterpretationsForTarget(db, 'data.thing');
    // INS is existence triad — no interpretation produced
    expect(interps.filter(i => i.op === 'DEF' || i.op === 'EVA' || i.op === 'REC')).toHaveLength(0);
  });

  it('DEF events write to BOTH state and meant-graph', async () => {
    await processEvent(db, ev({ target: 'data.thing', operand: {} }));
    await processEvent(db, ev({
      op: 'DEF', target: 'data.thing', operand: { interpretation: 'this means X' },
    }));

    // State has the value (backwards compatible)
    const state = await getState(db, 'data.thing');
    expect(state?.value?.interpretation).toBe('this means X');

    // Meant-graph has the interpretation (new)
    const interps = await getInterpretationsForTarget(db, 'data.thing');
    expect(interps.length).toBeGreaterThanOrEqual(1);
    expect(interps[0].op).toBe('DEF');
  });

  it('SEG events write to state but NOT to meant-graph', async () => {
    await processEvent(db, ev({ target: 'data.region' }));
    await processEvent(db, ev({
      op: 'SEG', target: 'data.region',
      operand: { boundary: 'encrypt' },
    }));

    const interps = await getInterpretationsForTarget(db, 'data.region');
    // SEG is structure triad — no interpretation
    const sigInterps = interps.filter(i => i.op === 'DEF' || i.op === 'EVA' || i.op === 'REC');
    expect(sigInterps).toHaveLength(0);
  });
});

// ===========================================================================
// Integration: network model + experience engine
// ===========================================================================

describe('network model through experience engine lens', () => {
  it('group governance is an interpretation (Meant-Graph), not raw experience', async () => {
    // Create group (existence + structure)
    await processEvent(db, ev({ target: 'net.team' }));
    await processEvent(db, ev({
      op: 'SEG', target: 'net.team',
      operand: { boundary: 'group', membership: 'open' },
    }));

    // Add governance (significance — this IS an interpretation)
    await processEvent(db, ev({
      op: 'INS', target: 'net.team._governance.policy1',
    }));
    await processEvent(db, ev({
      op: 'EVA', target: 'net.team._governance.policy1',
      operand: { strategy: 'custody' },
    }));

    // The governance policy should be in the Meant-Graph
    const interps = await getInterpretationsForTarget(db, 'net.team._governance.policy1');
    expect(interps.length).toBeGreaterThanOrEqual(1);
    expect(interps[0].op).toBe('EVA');
    expect(interps[0].content.strategy).toBe('custody');

    // It should be grounded (Rule 7)
    const ruleCheck = checkRule7ForInterpretation(interps[0]);
    expect(ruleCheck.passed).toBe(true);

    // It should be defeasible (Rule 9)
    const rule9Check = checkRule9ForInterpretation(interps[0]);
    expect(rule9Check.passed).toBe(true);
  });

  it('custody claim produces a SYN (structure) not an interpretation', async () => {
    await processEvent(db, ev({ target: 'net.people.rec_alice', operand: { name: 'Alice' } }));
    await processEvent(db, ev({ target: AGENT_A, agent: AGENT_A }));
    await processEvent(db, ev({
      op: 'SYN', target: AGENT_A,
      operand: { merge: ['net.people.rec_alice', AGENT_A], into: AGENT_A, claim: true },
      agent: AGENT_A,
    }));

    // SYN is structure triad — no interpretation produced
    const interps = await getInterpretationsForTarget(db, AGENT_A);
    const synInterps = interps.filter(i => i.op === 'DEF' || i.op === 'EVA' || i.op === 'REC');
    expect(synInterps).toHaveLength(0);

    // But the structural change IS recorded in the Given-Log
    const log = await readLogForTarget(db, AGENT_A);
    const synEvent = log.find(e => e.op === 'SYN');
    expect(synEvent).toBeDefined();
    expect(synEvent!.cell_type?.object).toBe('pattern'); // SYN spans multiple figures
  });
});
