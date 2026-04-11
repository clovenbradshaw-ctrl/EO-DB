/**
 * Phase A.6/3 — cell-events: interactive cell-clearing NUL emission.
 *
 * `buildNulClearingEvent` is the pure-data builder that TableView's
 * `handleCellClear` uses to record deliberate erasures in the NulHorizon.
 * TableView dispatches (a) the existing DEF with the empty-value sentinel,
 * then (b) the NUL × Clearing this builder produces. These tests pin down:
 *
 *   1. The event shape is exactly what the `handleCellClear` handler in
 *      TableView.tsx promises — NUL op, Clearing resolution, operand
 *      carries the fieldKey, agent is stamped verbatim.
 *   2. When the built event is dispatched through the real fold path, it
 *      lands in the NulHorizon at the correct site with resolution
 *      'Clearing'. This is the regression bar: if any future refactor of
 *      the fold drops the NulHorizon wire for NUL events, this test
 *      fails first.
 *   3. Multiple clearings on the same site accumulate in the NulHorizon
 *      observation log (they don't overwrite each other), and `getLatest`
 *      returns the most recent observation's seq.
 */

import { describe, it, expect } from 'vitest';
import { buildNulClearingEvent, buildMakingDefEvent } from '../cell-events';
import { processEvent } from '../../db/fold';
import { StoreNulHorizon } from '../../db/addressing-horizon';
import { RESOLUTION_NIBBLE } from '../../db/types';
import type { EoEvent } from '../../db/types';
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

// ─── A.6/5 — buildMakingDefEvent pure-shape tests ──────────────────────────

describe('A.6/5 — buildMakingDefEvent (pure shape)', () => {
  it('produces a DEF × Making event (resolution: Making)', () => {
    const ev = buildMakingDefEvent(
      'at.appTEST.tblClients.recA',
      'fldEmail',
      'alice@example.com',
      'user:@alice:example.com',
      /* useFieldsSub */ true,
      '2026-04-11T10:00:00.000Z',
    );
    expect(ev.op).toBe('DEF');
    expect(ev.resolution).toBe('Making');
    expect(ev.target).toBe('at.appTEST.tblClients.recA');
    expect(ev.agent).toBe('user:@alice:example.com');
    expect(ev.ts).toBe('2026-04-11T10:00:00.000Z');
    expect(ev.acquired_ts).toBe('2026-04-11T10:00:00.000Z');
  });

  it('wraps the operand in { fields: { ... } } when useFieldsSub = true', () => {
    const ev = buildMakingDefEvent(
      'at.appTEST.tblClients.recA',
      'fldEmail',
      'alice@example.com',
      'user:@alice:example.com',
      true,
    );
    expect(ev.operand).toEqual({ fields: { fldEmail: 'alice@example.com' } });
  });

  it('uses a flat { [fieldKey]: parsed } operand when useFieldsSub = false', () => {
    const ev = buildMakingDefEvent(
      'ns.rec1',
      'title',
      'Hello',
      'user:@alice:example.com',
      false,
    );
    expect(ev.operand).toEqual({ title: 'Hello' });
  });

  it('preserves array and object parsed values (multi-select, nested structures)', () => {
    const arrEv = buildMakingDefEvent(
      'ns.rec1',
      'tags',
      ['a', 'b', 'c'],
      'user:@alice:example.com',
      true,
    );
    expect(arrEv.operand).toEqual({ fields: { tags: ['a', 'b', 'c'] } });

    const objEv = buildMakingDefEvent(
      'ns.rec1',
      'meta',
      { k: 'v' },
      'user:@alice:example.com',
      false,
    );
    expect(objEv.operand).toEqual({ meta: { k: 'v' } });
  });

  it('defaults ts to the current time when not provided', () => {
    const before = Date.now();
    const ev = buildMakingDefEvent('t', 'fldA', 'x', 'user:x', true);
    const after = Date.now();
    const parsed = Date.parse(ev.ts);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
    expect(ev.acquired_ts).toBe(ev.ts);
  });

  it('passes the agent string through unchanged', () => {
    const ev = buildMakingDefEvent(
      't', 'fldA', 'x',
      'user:@weird+characters:example.com',
      true,
    );
    expect(ev.agent).toBe('user:@weird+characters:example.com');
  });

  it('does not leak meta / level / nul_state / triggered_by onto the event', () => {
    // The resolution nibble is the only depth-coordinate we intend to stamp;
    // extra fields would muddy the compound glyph written to eodb.idx byte 0.
    const ev = buildMakingDefEvent('t', 'fldA', 'x', 'user:x', true);
    expect(ev.nul_state).toBeUndefined();
    expect(ev.meta).toBeUndefined();
    expect(ev.level).toBeUndefined();
    expect(ev.triggered_by).toBeUndefined();
  });
});

// ─── A.6/5 — first-fill DEF × Making → fold integration ────────────────────

describe('A.6/5 — first-fill DEF × Making → fold integration', () => {
  /**
   * Compute the compound glyph byte that log-opfs would write for this event.
   * Mirrors the private `encodeOpResolution` helper in db/log-opfs.ts: high
   * nibble is the operator index (NUL=0, SIG=1, INS=2, SEG=3, CON=4, SYN=5,
   * DEF=6, EVA=7, REC=8); low nibble is `RESOLUTION_NIBBLE[event.resolution]`
   * (0 when resolution is absent / 'unspecified').
   */
  const OP_NIBBLE: Record<string, number> = {
    NUL: 0, SIG: 1, INS: 2, SEG: 3, CON: 4, SYN: 5, DEF: 6, EVA: 7, REC: 8,
  };
  function compoundGlyph(ev: EoEvent): number {
    const opNibble = OP_NIBBLE[ev.op] ?? 0;
    const resNibble = ev.resolution ? RESOLUTION_NIBBLE[ev.resolution] : 0;
    return ((opNibble & 0x0f) << 4) | (resNibble & 0x0f);
  }

  it('dispatched through the fold, the DEF event carries resolution Making and byte0 = 0x68', async () => {
    const store = createTestStore();

    // Site-existence floor: INS the record first so the DEF has somewhere to land.
    await processEvent(store, {
      op: 'INS',
      target: 'at.appTEST.tblClients.recA',
      operand: { _airtable: { record_id: 'recA' } },
      agent: 'user:@alice:example.com',
      ts: '2026-04-11T09:00:00.000Z',
      acquired_ts: '2026-04-11T09:00:00.000Z',
      client_event_id: 'test-ins-recA',
    });

    const captured: EoEvent[] = [];
    const onEvent = (e: EoEvent) => { captured.push(e); };

    const defEvent = buildMakingDefEvent(
      'at.appTEST.tblClients.recA',
      'fldEmail',
      'alice@example.com',
      'user:@alice:example.com',
      /* useFieldsSub */ true,
      '2026-04-11T10:00:00.000Z',
    );
    await processEvent(
      store,
      { ...defEvent, client_event_id: 'test-def-recA-fldEmail' },
      onEvent,
    );

    // The onEvent callback sees the full persisted event, including its
    // assigned seq and the resolution field that encodeIndexRecord reads.
    const persisted = captured.find((e) => e.op === 'DEF');
    expect(persisted).toBeDefined();
    expect(persisted!.resolution).toBe('Making');

    // DEF high nibble (0x6) | Making low nibble (0x8) == 0x68.
    const byte0 = compoundGlyph(persisted!);
    expect(byte0).toBe(0x68);
    expect(byte0 >> 4).toBe(0x6); // DEF
    expect(byte0 & 0x0f).toBe(0x8); // Making
  });

  it('a plain DEF (no resolution) encodes to byte0 = 0x60 — the reference point', async () => {
    // Regression bar: today's non-first-fill path still writes DEF ×
    // unspecified. If a future slice accidentally stamps Making on every
    // DEF, the two bytes converge and branch-explorer distinctions at the
    // Phase C.5 nibble-scan level would collapse.
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

    const captured: EoEvent[] = [];
    await processEvent(
      store,
      {
        op: 'DEF',
        target: 'at.appTEST.tblClients.recB',
        operand: { fields: { fldEmail: 'bob@example.com' } },
        agent: 'user:@alice:example.com',
        ts: '2026-04-11T10:00:00.000Z',
        acquired_ts: '2026-04-11T10:00:00.000Z',
        client_event_id: 'test-def-recB-plain',
      },
      (e) => captured.push(e),
    );

    const persisted = captured.find((e) => e.op === 'DEF');
    expect(persisted).toBeDefined();
    expect(persisted!.resolution).toBeUndefined();
    expect(compoundGlyph(persisted!)).toBe(0x60);
  });
});
