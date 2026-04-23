/**
 * Phase A.6/3 — cell-events: interactive cell-clearing NUL emission.
 * Phase A.6/5 — cell-events: interactive first-fill DEF × Making emission.
 *
 * `buildNulClearingEvent` is the pure-data builder that TableView's
 * `handleCellClear` uses to record deliberate erasures in the NulHorizon.
 * `buildMakingDefEvent` is the symmetric builder that `handleCellSave`
 * uses to stamp first-fill DEFs with resolution 'Making'. Together they
 * turn interactive cell mutations from unspecified state-ops into narrated
 * state transitions on the resolution axis.
 *
 * Tests pin down:
 *   1. Event shape correctness — operator, resolution, operand, agent.
 *   2. End-to-end fold dispatch — the resolution nibble survives the fold.
 *   3. First-fill predicate (`isFieldEmpty`) — empty/absent → true, non-empty → false.
 */

import { describe, it, expect } from 'vitest';
import { buildNulClearingEvent, buildMakingDefEvent, isFieldEmpty } from '../cell-events';
import { processEvent } from '../../db/fold';
import { StoreNulHorizon } from '../../db/addressing-horizon';
import type { EoStore, IteratorOpts } from '../../db/encrypted-store';

// ─── In-memory store (mirrors the shape used in db/__tests__) ───────────────

function createTestStore(): EoStore {
  const data = new Map<string, unknown>();
  let seq = 0;

  return {
    async get(key: string) {
      return data.has(key) ? data.get(key) : null;
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
    },
    async del(key: string) {
      data.delete(key);
    },
    async iterator(prefix: string, opts?: IteratorOpts) {
      const results: [string, unknown][] = [];
      for (const [key, value] of data.entries()) {
        if (key >= prefix && key <= prefix + '\uffff') {
          if (opts?.afterKey && key <= opts.afterKey) continue;
          results.push([key, value]);
        }
      }
      results.sort((a, b) => a[0].localeCompare(b[0]));
      if (opts?.limit !== undefined && results.length > opts.limit) {
        results.length = opts.limit;
      }
      return results;
    },
    async nextSeq() {
      seq += 1;
      data.set('meta:seq', seq);
      return seq;
    },
    async getCurrentSeq() {
      return seq;
    },
    close() {},
  };
}

// ─── Pure-shape tests ───────────────────────────────────────────────────────

describe('A.6/3 — buildNulClearingEvent (pure shape)', () => {
  it('produces a NUL × Clearing event with the fieldKey in the operand', () => {
    const ev = buildNulClearingEvent(
      'at.appTEST.tblClients.recA',
      'fldEmail',
      'user:@alice:example.com',
      '2026-04-11T10:00:00.000Z',
    );
    expect(ev.op).toBe('NUL');
    expect(ev.resolution).toBe('Clearing');
    expect(ev.target).toBe('at.appTEST.tblClients.recA');
    expect(ev.operand).toEqual({ fieldKey: 'fldEmail' });
    expect(ev.agent).toBe('user:@alice:example.com');
    expect(ev.ts).toBe('2026-04-11T10:00:00.000Z');
    expect(ev.acquired_ts).toBe('2026-04-11T10:00:00.000Z');
  });

  it('defaults ts to the current time when not provided', () => {
    const before = Date.now();
    const ev = buildNulClearingEvent('t', 'fldA', 'user:x');
    const after = Date.now();
    const parsed = Date.parse(ev.ts);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
    expect(ev.acquired_ts).toBe(ev.ts);
  });

  it('does not leak any other fields that would shift the compound glyph', () => {
    // The resolution nibble is the only depth-coordinate we intend to stamp;
    // nul_state, meta, and level must stay unset so the index record encoder
    // writes Clearing-resolution exactly and nothing else.
    const ev = buildNulClearingEvent('t', 'fldA', 'user:x');
    expect(ev.nul_state).toBeUndefined();
    expect(ev.meta).toBeUndefined();
    expect(ev.level).toBeUndefined();
    expect(ev.triggered_by).toBeUndefined();
  });
});

// ─── End-to-end through the fold ───────────────────────────────────────────

describe('A.6/3 — buildNulClearingEvent → fold → NulHorizon', () => {
  it('lands in the NulHorizon with Clearing resolution after processEvent', async () => {
    const store = createTestStore();

    // Phase A site existence floor: NUL on a never-INS'd site is fine (the
    // AddressingHorizon touches it), but we INS first to mirror the path a
    // real record-clear interaction takes — the record has to exist before
    // anything can be cleared.
    await processEvent(store, {
      op: 'INS',
      target: 'at.appTEST.tblClients.recA',
      operand: { _airtable: { record_id: 'recA' } },
      agent: 'user:@alice:example.com',
      ts: '2026-04-11T09:00:00.000Z',
      acquired_ts: '2026-04-11T09:00:00.000Z',
      client_event_id: 'test-ins-recA',
    });

    const nulEvent = buildNulClearingEvent(
      'at.appTEST.tblClients.recA',
      'fldEmail',
      'user:@alice:example.com',
      '2026-04-11T10:00:00.000Z',
    );
    await processEvent(store, {
      ...nulEvent,
      client_event_id: 'test-clear-recA-fldEmail',
    });

    const horizon = new StoreNulHorizon(store);
    const latest = await horizon.getLatest('at.appTEST.tblClients.recA');
    expect(latest).toBeDefined();
    expect(latest?.resolution).toBe('Clearing');
    expect(latest?.site).toBe('at.appTEST.tblClients.recA');
  });

  it('accumulates multiple Clearing observations on the same site in seq order', async () => {
    const store = createTestStore();

    await processEvent(store, {
      op: 'INS',
      target: 'at.appTEST.tblClients.recB',
      operand: {},
      agent: 'user:@alice:example.com',
      ts: '2026-04-11T09:00:00.000Z',
      acquired_ts: '2026-04-11T09:00:00.000Z',
      client_event_id: 'test-ins-recB',
    });

    // Clear two different fields on the same record.
    await processEvent(store, {
      ...buildNulClearingEvent(
        'at.appTEST.tblClients.recB',
        'fldEmail',
        'user:@alice:example.com',
        '2026-04-11T10:00:00.000Z',
      ),
      client_event_id: 'test-clear-recB-fldEmail',
    });
    await processEvent(store, {
      ...buildNulClearingEvent(
        'at.appTEST.tblClients.recB',
        'fldPhone',
        'user:@alice:example.com',
        '2026-04-11T10:00:01.000Z',
      ),
      client_event_id: 'test-clear-recB-fldPhone',
    });

    const horizon = new StoreNulHorizon(store);
    const observations = await horizon.getObservations('at.appTEST.tblClients.recB');
    expect(observations.length).toBe(2);
    for (const obs of observations) {
      expect(obs.resolution).toBe('Clearing');
      expect(obs.site).toBe('at.appTEST.tblClients.recB');
    }
    // Seq-ascending — the two observations must be in the order they were
    // submitted, matching the NulHorizon.record() documented contract.
    expect(observations[0].seq).toBeLessThan(observations[1].seq);

    const latest = await horizon.getLatest('at.appTEST.tblClients.recB');
    expect(latest?.seq).toBe(observations[1].seq);
  });

  it('does not mutate the state map — NUL × Clearing is pure observation', async () => {
    // The fold dispatch for NUL is a state-map no-op (see fold.ts case 'NUL').
    // The A.6/3 handler in TableView dispatches a DEF before this NUL to
    // actually empty the value. Here we verify the NUL alone, absent the
    // accompanying DEF, does NOT touch the state record.
    const store = createTestStore();

    await processEvent(store, {
      op: 'INS',
      target: 'at.appTEST.tblClients.recC',
      operand: { fields: { fldEmail: 'alice@example.com' } },
      agent: 'user:@alice:example.com',
      ts: '2026-04-11T09:00:00.000Z',
      acquired_ts: '2026-04-11T09:00:00.000Z',
      client_event_id: 'test-ins-recC',
    });

    const beforeState = await store.get('state:at.appTEST.tblClients.recC');
    expect(beforeState).toBeDefined();
    const beforeValue = JSON.stringify((beforeState as { value: unknown }).value);

    await processEvent(store, {
      ...buildNulClearingEvent(
        'at.appTEST.tblClients.recC',
        'fldEmail',
        'user:@alice:example.com',
        '2026-04-11T10:00:00.000Z',
      ),
      client_event_id: 'test-clear-recC-fldEmail',
    });

    const afterState = await store.get('state:at.appTEST.tblClients.recC');
    const afterValue = JSON.stringify((afterState as { value: unknown }).value);
    expect(afterValue).toBe(beforeValue);
  });
});

// ─── A.6/5 — isFieldEmpty predicate ────────────────────────────────────────

describe('A.6/5 — isFieldEmpty (first-fill predicate)', () => {
  it('returns true for undefined', () => {
    expect(isFieldEmpty(undefined)).toBe(true);
  });

  it('returns true for null', () => {
    expect(isFieldEmpty(null)).toBe(true);
  });

  it('returns true for empty string', () => {
    expect(isFieldEmpty('')).toBe(true);
  });

  it('returns true for empty array', () => {
    expect(isFieldEmpty([])).toBe(true);
  });

  it('returns false for a non-empty string', () => {
    expect(isFieldEmpty('hello')).toBe(false);
  });

  it('returns false for a non-empty array', () => {
    expect(isFieldEmpty(['a', 'b'])).toBe(false);
  });

  it('returns false for zero (a valid scalar value)', () => {
    expect(isFieldEmpty(0)).toBe(false);
  });

  it('returns false for false (a valid boolean value)', () => {
    expect(isFieldEmpty(false)).toBe(false);
  });

  it('returns false for an object', () => {
    expect(isFieldEmpty({ name: 'Alice' })).toBe(false);
  });
});

// ─── A.6/5 — buildMakingDefEvent pure-shape tests ─────────────────────────

describe('A.6/5 — buildMakingDefEvent (pure shape)', () => {
  it('produces a DEF × Making event with flat operand when useFieldsSub is false', () => {
    const ev = buildMakingDefEvent(
      'at.appTEST.tblClients.recA',
      'fldEmail',
      'alice@example.com',
      'user:@alice:example.com',
      false,
      '2026-04-11T10:00:00.000Z',
    );
    expect(ev.op).toBe('DEF');
    expect(ev.resolution).toBe('Making');
    expect(ev.target).toBe('at.appTEST.tblClients.recA');
    expect(ev.operand).toEqual({ fldEmail: 'alice@example.com' });
    expect(ev.agent).toBe('user:@alice:example.com');
    expect(ev.ts).toBe('2026-04-11T10:00:00.000Z');
    expect(ev.acquired_ts).toBe('2026-04-11T10:00:00.000Z');
  });

  it('produces a DEF × Making event with nested fields operand when useFieldsSub is true', () => {
    const ev = buildMakingDefEvent(
      'at.appTEST.tblClients.recA',
      'fldEmail',
      'alice@example.com',
      'user:@alice:example.com',
      true,
      '2026-04-11T10:00:00.000Z',
    );
    expect(ev.operand).toEqual({ fields: { fldEmail: 'alice@example.com' } });
  });

  it('defaults ts to the current time when not provided', () => {
    const before = Date.now();
    const ev = buildMakingDefEvent('t', 'fldA', 'v', 'user:x', false);
    const after = Date.now();
    const parsed = Date.parse(ev.ts);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
    expect(ev.acquired_ts).toBe(ev.ts);
  });

  it('does not leak fields that would shift the compound glyph', () => {
    const ev = buildMakingDefEvent('t', 'fldA', 'v', 'user:x', false);
    expect(ev.nul_state).toBeUndefined();
    expect(ev.meta).toBeUndefined();
    expect(ev.level).toBeUndefined();
    expect(ev.triggered_by).toBeUndefined();
  });

  it('handles array values (multiSelect first-fill)', () => {
    const ev = buildMakingDefEvent(
      't', 'fldTags', ['red', 'blue'], 'user:x', false,
    );
    expect(ev.operand).toEqual({ fldTags: ['red', 'blue'] });
    expect(ev.resolution).toBe('Making');
  });
});

// ─── A.6/5 — buildMakingDefEvent → fold ───────────────────────────────────

describe('A.6/5 — buildMakingDefEvent → fold → state', () => {
  it('lands the value in state with resolution Making after processEvent', async () => {
    const store = createTestStore();

    await processEvent(store, {
      op: 'INS',
      target: 'at.appTEST.tblClients.recD',
      operand: {},
      agent: 'user:@alice:example.com',
      ts: '2026-04-11T09:00:00.000Z',
      acquired_ts: '2026-04-11T09:00:00.000Z',
      client_event_id: 'test-ins-recD',
    });

    const defEvent = buildMakingDefEvent(
      'at.appTEST.tblClients.recD',
      'fldEmail',
      'alice@example.com',
      'user:@alice:example.com',
      false,
      '2026-04-11T10:00:00.000Z',
    );
    await processEvent(store, {
      ...defEvent,
      client_event_id: 'test-def-recD-fldEmail',
    });

    const state = await store.get('state:at.appTEST.tblClients.recD') as { value: Record<string, unknown> } | null;
    expect(state).toBeDefined();
    expect(state?.value?.fldEmail).toBe('alice@example.com');
  });

  it('DEF × Making followed by DEF × unspecified does not lose the value', async () => {
    const store = createTestStore();

    await processEvent(store, {
      op: 'INS',
      target: 'at.appTEST.tblClients.recE',
      operand: {},
      agent: 'user:@alice:example.com',
      ts: '2026-04-11T09:00:00.000Z',
      acquired_ts: '2026-04-11T09:00:00.000Z',
      client_event_id: 'test-ins-recE',
    });

    // First fill — Making
    await processEvent(store, {
      ...buildMakingDefEvent(
        'at.appTEST.tblClients.recE',
        'fldEmail',
        'alice@example.com',
        'user:@alice:example.com',
        false,
        '2026-04-11T10:00:00.000Z',
      ),
      client_event_id: 'test-def-recE-fldEmail-1',
    });

    // Overwrite — unspecified (no resolution)
    await processEvent(store, {
      op: 'DEF',
      target: 'at.appTEST.tblClients.recE',
      operand: { fldEmail: 'bob@example.com' },
      agent: 'user:@alice:example.com',
      ts: '2026-04-11T11:00:00.000Z',
      acquired_ts: '2026-04-11T11:00:00.000Z',
      client_event_id: 'test-def-recE-fldEmail-2',
    });

    const state = await store.get('state:at.appTEST.tblClients.recE') as { value: Record<string, unknown> } | null;
    expect(state?.value?.fldEmail).toBe('bob@example.com');
  });
});
