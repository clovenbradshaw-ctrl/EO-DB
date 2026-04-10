/**
 * Tests for the invariant scanner (db/invariant-scanner.ts).
 *
 * The scanner checks structural invariants at each helix level and returns
 * a list of violations. These tests verify:
 *   1. The scanner correctly identifies known bugs (before fixes).
 *   2. A clean store has zero critical violations (after fixes).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { processEvent } from '../fold';
import { scanInvariants, criticalViolations, type Violation } from '../invariant-scanner';
import type { EoStore } from '../encrypted-store';
import type { EoEventInput } from '../types';

// ─── Shared helpers ───────────────────────────────────────────────────────────

function createTestStore(): EoStore {
  const data = new Map<string, any>();
  let seq = 0;
  return {
    async get(key: string) { return data.has(key) ? data.get(key) : null; },
    async put(key: string, value: any) { data.set(key, value); },
    async del(key: string) { data.delete(key); },
    async iterator(prefix: string) {
      const results: [string, any][] = [];
      for (const [key, value] of data.entries()) {
        if (key >= prefix && key <= prefix + '\uffff') results.push([key, value]);
      }
      results.sort((a, b) => a[0].localeCompare(b[0]));
      return results;
    },
    async nextSeq() { seq += 1; data.set('meta:seq', seq); return seq; },
    async getCurrentSeq() { return seq; },
    close() {},
  };
}

const TS = '2025-01-01T00:00:00Z';

function ev(op: EoEventInput['op'], target: string, operand: any = {}, id?: string): EoEventInput {
  return { op, target, operand, agent: '@test', ts: TS, acquired_ts: TS, ...(id ? { client_event_id: id } : {}) };
}

// ─── Scanner self-tests ───────────────────────────────────────────────────────

describe('Invariant scanner', () => {
  let store: EoStore;
  beforeEach(() => { store = createTestStore(); });

  it('returns no violations for an empty store', async () => {
    const violations = await scanInvariants(store);
    expect(violations.length).toBe(0);
  });

  it('returns no critical violations for a clean store with INS+DEF', async () => {
    await processEvent(store, ev('INS', 'scan.rec1', { name: 'Test' }, 'sc1'));
    await processEvent(store, ev('DEF', 'scan.rec1', { score: 42 }, 'sc2'));

    const violations = await scanInvariants(store);
    const crits = criticalViolations(violations);
    expect(crits.length).toBe(0);
  });

  it('finds missing_ins for a manually injected state: without INS — tests Bug A detection', async () => {
    // Manually inject a state: entry without a corresponding log: INS
    // (simulates the Bug A scenario where DEF auto-INS was NOT logged)
    await store.put('state:scan.ghost', {
      target: 'scan.ghost',
      value: { x: 1 },
      level: 1,
      last_seq: 1,
      last_op: 'DEF',
      last_agent: 'test',
      last_ts: TS,
      last_acquired_ts: TS,
    });
    // No log: entry for this target

    const violations = await scanInvariants(store);
    const missingIns = violations.find(v => v.type === 'missing_ins');
    expect(missingIns).toBeDefined();
    expect(missingIns!.target).toBe('scan.ghost');
    expect(missingIns!.severity).toBe('critical');
  });

  it('finds no missing_ins for properly INS\'d targets — confirms Bug A is fixed', async () => {
    // Normal INS path
    await processEvent(store, ev('INS', 'scan.proper', {}, 'sp1'));
    // Auto-INS path (DEF on fresh target — checkAndPromote logs the INS)
    await processEvent(store, ev('DEF', 'scan.auto', { val: 5 }, 'sa1'));

    const violations = await scanInvariants(store);
    const missingIns = violations.filter(v => v.type === 'missing_ins');
    expect(missingIns.length).toBe(0);
  });

  it('finds asymmetric_con for manually injected orphan fwd edge', async () => {
    await processEvent(store, ev('INS', 'scan.src', {}, 'ssrc'));
    await processEvent(store, ev('INS', 'scan.dst', {}, 'sdst'));

    // Manually inject a fwd edge without a rev edge
    await store.put('graph:fwd:scan.src:scan.orphan', {
      source: 'scan.src', dest: 'scan.orphan', seq: 99,
    });

    const violations = await scanInvariants(store);
    const asymm = violations.find(v => v.type === 'asymmetric_con');
    expect(asymm).toBeDefined();
    expect(asymm!.level).toBe(4);
  });

  it('finds orphan_con_dest for fwd edge pointing to non-existent target', async () => {
    await processEvent(store, ev('INS', 'scan.orphsrc', {}, 'sos'));
    // Manually inject fwd + rev edges to a non-existent destination
    await store.put('graph:fwd:scan.orphsrc:scan.nonexistent', {
      source: 'scan.orphsrc', dest: 'scan.nonexistent', seq: 99,
    });
    await store.put('graph:rev:scan.nonexistent:scan.orphsrc', {
      source: 'scan.orphsrc', dest: 'scan.nonexistent', seq: 99,
    });

    const violations = await scanInvariants(store);
    const orphanDest = violations.find(v => v.type === 'orphan_con_dest');
    expect(orphanDest).toBeDefined();
    expect(orphanDest!.level).toBe(4);
  });

  it('finds no CON violations for properly connected targets', async () => {
    await processEvent(store, ev('INS', 'scan.a', {}, 'sa'));
    await processEvent(store, ev('INS', 'scan.b', {}, 'sb'));
    await processEvent(store, ev('CON', 'scan.a', { added: ['scan.b'] }, 'sab'));

    const violations = await scanInvariants(store);
    const conViolations = violations.filter(v => [
      'asymmetric_con', 'asymmetric_con_rev', 'orphan_con_source', 'orphan_con_dest',
    ].includes(v.type));
    expect(conViolations.length).toBe(0);
  });

  it('finds missing_eva_dep for EVA formula with missing dependency', async () => {
    await processEvent(store, ev('INS', 'scan.evasrc', {}, 'sevs'));
    await processEvent(store, ev('INS', 'scan.evadst', {}, 'sevd'));
    await processEvent(store, ev('CON', 'scan.evasrc', { added: ['scan.evadst'] }, 'sevc'));
    await processEvent(store, ev('EVA', 'scan.evasrc', { formula: 'SUM' }, 'seve'));

    // Now manually corrupt: remove the dependency's state entry
    await store.del('state:scan.evadst');

    const violations = await scanInvariants(store);
    const missingDep = violations.find(v => v.type === 'missing_eva_dep');
    expect(missingDep).toBeDefined();
    expect(missingDep!.level).toBe(7);
  });

  it('finds failed_event for error: entries', async () => {
    // Manually inject an error: entry (simulating a failed operator)
    await store.put('error:000000000042', {
      seq: 42,
      client_event_id: 'fail-test',
      op: 'DEF',
      target: 'scan.failed',
      error: 'test error message',
      ts: TS,
    });

    const violations = await scanInvariants(store);
    const failedEvent = violations.find(v => v.type === 'failed_event');
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.level).toBe(8);
    expect(failedEvent!.severity).toBe('warning');
  });

  /**
   * Integration: after a full fixture sequence with correct processing,
   * the scanner should find zero critical violations.
   * This test will FAIL for Bug A (missing INS) until the fix is applied.
   * After fix, it PASSES.
   */
  it('clean store after full fixture sequence has zero critical violations', async () => {
    await processEvent(store, ev('INS', 'fix.clients.r1', { name: 'Alice' }, 'f1'));
    await processEvent(store, ev('INS', 'fix.cases.c1', { type: 'H1B' }, 'f2'));
    await processEvent(store, ev('CON', 'fix.clients.r1.fldCases', { added: ['fix.cases.c1'] }, 'f3'));
    await processEvent(store, ev('DEF', 'fix.clients.r1.fldEmail', { email: 'a@b.com' }, 'f4'));
    await processEvent(store, ev('DEF', 'fix.cases.c1.fldStatus', { status: 'approved' }, 'f5'));
    // Note: DEF on fix.cases.c1.fldStatus auto-promotes INS via checkAndPromote,
    // so fix.cases.c1.fldStatus is already properly instantiated and logged.

    const violations = await scanInvariants(store);
    const crits = criticalViolations(violations);
    // After Bug A fix (checkAndPromote logs INS): zero critical violations
    expect(crits.length).toBe(0);
  });
});

// ─── Scanner coverage tests ───────────────────────────────────────────────────

describe('Invariant scanner — coverage', () => {
  it('scans multiple violation types simultaneously', async () => {
    const store = createTestStore();

    // Inject state without INS (Bug A pattern)
    await store.put('state:multi.ghost', {
      target: 'multi.ghost', value: {}, level: 1,
      last_seq: 1, last_op: 'DEF', last_agent: 'test', last_ts: TS, last_acquired_ts: TS,
    });

    // Inject orphan fwd edge
    await store.put('graph:fwd:multi.a:multi.b', { source: 'multi.a', dest: 'multi.b', seq: 2 });
    // (no rev edge, no state entries for multi.a or multi.b)

    // Inject failed event
    await store.put('error:000000000001', {
      seq: 1, op: 'INS', target: 'multi.ghost', error: 'duplicate', ts: TS,
    });

    const violations = await scanInvariants(store);

    const types = new Set(violations.map(v => v.type));
    expect(types.has('missing_ins')).toBe(true);
    expect(types.has('asymmetric_con')).toBe(true);
    expect(types.has('failed_event')).toBe(true);
  });

  it('formatViolations returns readable output', async () => {
    const { formatViolations } = await import('../invariant-scanner');

    const vio: Violation[] = [
      { target: 'test.rec', level: 2, type: 'missing_ins', detail: 'no INS', severity: 'critical' },
    ];
    const report = formatViolations(vio);
    expect(report).toContain('missing_ins');
    expect(report).toContain('test.rec');
    expect(report).toContain('[L2]');
  });

  it('formatViolations returns clean message for zero violations', async () => {
    const { formatViolations } = await import('../invariant-scanner');
    const report = formatViolations([]);
    expect(report).toContain('No violations');
  });
});
