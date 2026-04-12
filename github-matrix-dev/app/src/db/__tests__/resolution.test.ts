/**
 * Phase A slice 6 — Resolution axis (depth coordinate in the operator ×
 * site × resolution lattice).
 *
 * Covers:
 *   - EoEvent.resolution defaults and encoder round-trip into eodb.idx byte 0
 *   - NulState ↔ Resolution migration helpers
 *   - NulHorizon observation recording
 *   - NUL handler dispatch honors resolution (with NulState fallback)
 *   - HELIX_ORDINAL / TRIAD_BOUNDARY / triadOf invariants
 */

import { describe, it, expect } from 'vitest';
import { appendEvent, scanLog, INDEX_RECORD_BYTES } from '../log-opfs';
import { createMemoryLog } from './_memory-log';
import type { EoEvent, EoEventInput, LoggableOperator, Resolution } from '../types';
import {
  RESOLUTION_NIBBLE,
  NIBBLE_TO_RESOLUTION,
  nulStateToResolution,
  resolutionToNulState,
} from '../types';
import {
  HELIX_ORDINAL,
  TRIAD_BOUNDARY,
  triadOf,
  HELIX_LEVEL,
} from '../fold-core';
import { StoreNulHorizon } from '../addressing-horizon';
import { processEvent } from '../fold';
import { getRecordsByResolution } from '../horizon';
import type { EoStore, IteratorOpts } from '../encrypted-store';

// ─── Test store (shared shape with addressing-horizon.test.ts) ──────────────

function createTestStore(): { store: EoStore; data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  let seq = 0;

  const store: EoStore = {
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

  return { store, data };
}

function mkEvent(seq: number, op: LoggableOperator, target: string, resolution?: Resolution): EoEvent {
  const event: EoEvent = {
    seq,
    op,
    target,
    operand: {},
    agent: 'test',
    ts: new Date().toISOString(),
    acquired_ts: new Date().toISOString(),
  };
  if (resolution) event.resolution = resolution;
  return event;
}

function mkInput(op: EoEventInput['op'], target: string, operand: any = {}): EoEventInput {
  return {
    op,
    target,
    operand,
    agent: '@harness:example.com',
    ts: '2026-04-11T00:00:00.000Z',
    acquired_ts: '2026-04-11T00:00:00.000Z',
  };
}

// ─── EoEvent.resolution encoding ────────────────────────────────────────────

describe('Resolution axis — EoEvent.resolution', () => {
  it('defaults to undefined on events that do not specify it', () => {
    const event: EoEventInput = mkInput('INS', 'site:1');
    expect((event as { resolution?: Resolution }).resolution).toBeUndefined();
  });

  it('appendEvent writes resolution nibble to byte 0 for events with explicit resolution', () => {
    const log = createMemoryLog();
    const ev = mkEvent(1, 'NUL', 'site:1', 'Clearing');
    appendEvent(log, ev);

    // Read back the raw index bytes — byte 0 is operator high nibble + resolution low nibble.
    const idxBytes = (log.idxHandle as unknown as { _bytes(): Uint8Array })._bytes();
    const byte0 = idxBytes[0];
    const opNibble = (byte0 >> 4) & 0x0f;
    const resNibble = byte0 & 0x0f;

    // NUL is operator nibble 0, Clearing is resolution nibble 1.
    expect(opNibble).toBe(0);
    expect(resNibble).toBe(RESOLUTION_NIBBLE['Clearing']);
    expect(resNibble).toBe(1);
  });

  it('appendEvent writes resolution nibble 0 when resolution is unspecified', () => {
    const log = createMemoryLog();
    const ev = mkEvent(1, 'DEF', 'site:1');  // no resolution field
    appendEvent(log, ev);

    const idxBytes = (log.idxHandle as unknown as { _bytes(): Uint8Array })._bytes();
    const byte0 = idxBytes[0];
    const resNibble = byte0 & 0x0f;
    expect(resNibble).toBe(0);
  });

  it('scanLog round-trips resolution through msgpack payload', () => {
    const log = createMemoryLog();
    const resolutions: Resolution[] = [
      'unspecified', 'Clearing', 'Dissecting', 'Unraveling',
      'Tending', 'Binding', 'Tracing', 'Cultivating', 'Making', 'Composing',
    ];

    for (let i = 0; i < resolutions.length; i++) {
      appendEvent(log, mkEvent(i + 1, 'NUL', `site:${i}`, resolutions[i]));
    }

    const scanned = Array.from(scanLog(log));
    expect(scanned).toHaveLength(resolutions.length);

    for (let i = 0; i < resolutions.length; i++) {
      // For the default 'unspecified' we wrote no field, so the payload has
      // no resolution key — fall back to 'unspecified' on read.
      const expected = resolutions[i];
      const actual = scanned[i].event.resolution ?? 'unspecified';
      expect(actual).toBe(expected);
    }
  });

  it('encodes every Resolution ↔ nibble pair consistently', () => {
    for (let n = 0; n < NIBBLE_TO_RESOLUTION.length; n++) {
      const resolution = NIBBLE_TO_RESOLUTION[n];
      expect(RESOLUTION_NIBBLE[resolution]).toBe(n);
    }
  });
});

// ─── NulState ↔ Resolution migration ─────────────────────────────────────────

describe('Resolution axis — NulState migration helpers', () => {
  it('nulStateToResolution maps every NulState to its canonical Resolution', () => {
    expect(nulStateToResolution('cleared')).toBe('Clearing');
    expect(nulStateToResolution('unknown')).toBe('Tracing');
    expect(nulStateToResolution('never-set')).toBe('unspecified');
    expect(nulStateToResolution('promotion_blocked')).toBe('Unraveling');
  });

  it('resolutionToNulState inverts the mapping for named NulState values', () => {
    expect(resolutionToNulState('Clearing')).toBe('cleared');
    expect(resolutionToNulState('Tracing')).toBe('unknown');
    expect(resolutionToNulState('Unraveling')).toBe('promotion_blocked');
    expect(resolutionToNulState('unspecified')).toBe('never-set');
  });

  it('resolutionToNulState falls back to never-set for non-NulState resolutions', () => {
    // Resolutions that don't have a named NulState equivalent degrade
    // gracefully to 'never-set' so display code never crashes.
    expect(resolutionToNulState('Dissecting')).toBe('never-set');
    expect(resolutionToNulState('Tending')).toBe('never-set');
    expect(resolutionToNulState('Binding')).toBe('never-set');
    expect(resolutionToNulState('Cultivating')).toBe('never-set');
    expect(resolutionToNulState('Making')).toBe('never-set');
    expect(resolutionToNulState('Composing')).toBe('never-set');
  });
});

// ─── NulHorizon ─────────────────────────────────────────────────────────────

describe('Resolution axis — NulHorizon', () => {
  it('records observations by resolution and returns them in seq order', async () => {
    const { store } = createTestStore();
    const h = new StoreNulHorizon(store);

    await h.record('site:1', 'Tracing', 100);
    await h.record('site:1', 'Clearing', 200);

    const obs = await h.getObservations('site:1');
    expect(obs).toHaveLength(2);
    expect(obs[0].resolution).toBe('Tracing');
    expect(obs[0].seq).toBe(100);
    expect(obs[1].resolution).toBe('Clearing');
    expect(obs[1].seq).toBe(200);
  });

  it('getLatest returns the most recent observation', async () => {
    const { store } = createTestStore();
    const h = new StoreNulHorizon(store);

    await h.record('site:1', 'Tracing', 100);
    await h.record('site:1', 'Clearing', 200);

    const latest = await h.getLatest('site:1');
    expect(latest?.resolution).toBe('Clearing');
    expect(latest?.seq).toBe(200);
  });

  it('getLatest returns undefined for sites with no observations', async () => {
    const { store } = createTestStore();
    const h = new StoreNulHorizon(store);
    expect(await h.getLatest('site:never')).toBeUndefined();
  });

  it('isExplicitlyAbsent tracks whether any NUL has been observed', async () => {
    const { store } = createTestStore();
    const h = new StoreNulHorizon(store);

    expect(await h.isExplicitlyAbsent('site:1')).toBe(false);
    await h.record('site:1', 'Clearing', 1);
    expect(await h.isExplicitlyAbsent('site:1')).toBe(true);
  });

  it('snapshot returns every observation across every site', async () => {
    const { store } = createTestStore();
    const h = new StoreNulHorizon(store);

    await h.record('site:1', 'Tracing', 1);
    await h.record('site:1', 'Clearing', 2);
    await h.record('site:2', 'Unraveling', 3);

    const snap = await h.snapshot();
    expect(snap).toHaveLength(3);
  });
});

// ─── NUL handler integration ────────────────────────────────────────────────

describe('Resolution axis — NUL handler uses resolution with NulState fallback', () => {
  it('records resolution in NulHorizon when event.resolution is set', async () => {
    const { store } = createTestStore();

    // INS first so the helix has something to hang off.
    await processEvent(store, mkInput('INS', 'site:1'));
    // NUL with explicit resolution.
    const nulInput: EoEventInput = { ...mkInput('NUL', 'site:1'), resolution: 'Clearing' };
    await processEvent(store, nulInput);

    const h = new StoreNulHorizon(store);
    const latest = await h.getLatest('site:1');
    expect(latest?.resolution).toBe('Clearing');
  });

  it('falls back to nul_state when resolution is missing', async () => {
    const { store } = createTestStore();

    await processEvent(store, mkInput('INS', 'site:2'));
    const nulInput: EoEventInput = { ...mkInput('NUL', 'site:2'), nul_state: 'unknown' };
    await processEvent(store, nulInput);

    const h = new StoreNulHorizon(store);
    const latest = await h.getLatest('site:2');
    // 'unknown' → Resolution 'Tracing'
    expect(latest?.resolution).toBe('Tracing');
  });

  it('records unspecified when neither resolution nor nul_state is set', async () => {
    const { store } = createTestStore();

    await processEvent(store, mkInput('INS', 'site:3'));
    await processEvent(store, mkInput('NUL', 'site:3'));

    const h = new StoreNulHorizon(store);
    const latest = await h.getLatest('site:3');
    expect(latest?.resolution).toBe('unspecified');
  });
});

// ─── Helix ordinal / triad boundaries ───────────────────────────────────────

describe('Resolution axis — HELIX_ORDINAL and triad boundaries', () => {
  it('has nine distinct values spanning 0..8', () => {
    const ordinals = Object.values(HELIX_ORDINAL);
    expect(new Set(ordinals).size).toBe(9);
    expect(Math.min(...ordinals)).toBe(0);
    expect(Math.max(...ordinals)).toBe(8);
  });

  it('assigns NUL at 0 and REC at 8', () => {
    expect(HELIX_ORDINAL.NUL).toBe(0);
    expect(HELIX_ORDINAL.REC).toBe(8);
  });

  it('HELIX_LEVEL (wave scheduling) is distinct from HELIX_ORDINAL', () => {
    // NUL and SIG both live at HELIX_LEVEL 0 (same wave group), but at
    // different HELIX_ORDINAL positions (0 and 1 respectively).
    expect(HELIX_LEVEL.NUL).toBe(HELIX_LEVEL.SIG);
    expect(HELIX_ORDINAL.NUL).not.toBe(HELIX_ORDINAL.SIG);
  });

  it('TRIAD_BOUNDARY contains exactly INS, SYN, and REC', () => {
    expect(TRIAD_BOUNDARY.has('INS')).toBe(true);
    expect(TRIAD_BOUNDARY.has('SYN')).toBe(true);
    expect(TRIAD_BOUNDARY.has('REC')).toBe(true);
    expect(TRIAD_BOUNDARY.size).toBe(3);
  });

  it('triadOf assigns operators to the correct triad', () => {
    // Identity triad: NUL, SIG, INS
    expect(triadOf('NUL')).toBe('identity');
    expect(triadOf('SIG')).toBe('identity');
    expect(triadOf('INS')).toBe('identity');

    // Structure triad: SEG, CON, SYN
    expect(triadOf('SEG')).toBe('structure');
    expect(triadOf('CON')).toBe('structure');
    expect(triadOf('SYN')).toBe('structure');

    // Interpretation triad: DEF, EVA, REC
    expect(triadOf('DEF')).toBe('interpretation');
    expect(triadOf('EVA')).toBe('interpretation');
    expect(triadOf('REC')).toBe('interpretation');
  });
});

// ─── getRecordsByResolution (Phase C read path) ────────────────────────────

describe('Resolution axis — getRecordsByResolution', () => {
  it('returns an empty Map for a site with no NUL observations', async () => {
    const { store } = createTestStore();
    const map = await getRecordsByResolution(store, 'site:untouched');
    expect(map.size).toBe(0);
  });

  it('returns one record per distinct resolution on a site', async () => {
    const { store } = createTestStore();
    const h = new StoreNulHorizon(store);

    await h.record('site:1', 'Tracing', 10);
    await h.record('site:1', 'Clearing', 20);

    const map = await getRecordsByResolution(store, 'site:1');
    expect(map.size).toBe(2);

    const tracing = map.get('Tracing')!;
    expect(tracing.resolution).toBe('Tracing');
    expect(tracing.seq).toBe(10);
    expect(tracing.op).toBe('NUL');
    expect(tracing.site).toBe('site:1');

    const clearing = map.get('Clearing')!;
    expect(clearing.resolution).toBe('Clearing');
    expect(clearing.seq).toBe(20);
  });

  it('latest-wins: duplicate resolutions keep the highest-seq record', async () => {
    const { store } = createTestStore();
    const h = new StoreNulHorizon(store);

    // Two Tracing observations at seq 10 and 30; the map should keep seq 30.
    await h.record('site:1', 'Tracing', 10);
    await h.record('site:1', 'Clearing', 20);
    await h.record('site:1', 'Tracing', 30);

    const map = await getRecordsByResolution(store, 'site:1');
    expect(map.size).toBe(2);
    expect(map.get('Tracing')!.seq).toBe(30);
    expect(map.get('Clearing')!.seq).toBe(20);
  });

  it('does not leak observations from other sites', async () => {
    const { store } = createTestStore();
    const h = new StoreNulHorizon(store);

    await h.record('site:A', 'Clearing', 1);
    await h.record('site:B', 'Tracing', 2);

    const mapA = await getRecordsByResolution(store, 'site:A');
    expect(mapA.size).toBe(1);
    expect(mapA.has('Clearing')).toBe(true);
    expect(mapA.has('Tracing')).toBe(false);

    const mapB = await getRecordsByResolution(store, 'site:B');
    expect(mapB.size).toBe(1);
    expect(mapB.has('Tracing')).toBe(true);
  });

  it('HorizonRecord carries op, ts, and value fields', async () => {
    const { store } = createTestStore();
    const h = new StoreNulHorizon(store);

    await h.record('site:1', 'Making', 42);

    const map = await getRecordsByResolution(store, 'site:1');
    const rec = map.get('Making')!;

    // NUL observations don't carry ts or value today.
    expect(rec.op).toBe('NUL');
    expect(rec.ts).toBeUndefined();
    expect(rec.value).toBeUndefined();
    // But the fields exist on the type — verified by TypeScript at compile time.
  });

  it('integration: NUL via processEvent populates getRecordsByResolution', async () => {
    const { store } = createTestStore();

    // INS first so the helix exists.
    await processEvent(store, mkInput('INS', 'site:live'));
    // NUL with explicit resolution.
    await processEvent(store, { ...mkInput('NUL', 'site:live'), resolution: 'Binding' });

    const map = await getRecordsByResolution(store, 'site:live');
    expect(map.size).toBe(1);
    expect(map.get('Binding')!.resolution).toBe('Binding');
    expect(map.get('Binding')!.op).toBe('NUL');
  });
});

// Byte-level sanity: INDEX_RECORD_BYTES is 40 and byte 0 encoding width is
// exactly one nibble per axis — guards against accidental widening that
// would break the on-disk format.
describe('Resolution axis — index record byte layout', () => {
  it('is still 40 bytes per record', () => {
    expect(INDEX_RECORD_BYTES).toBe(40);
  });

  it('packs both nibbles into a single byte', () => {
    const log = createMemoryLog();
    appendEvent(log, mkEvent(1, 'REC', 'site:x', 'Composing'));
    const idxBytes = (log.idxHandle as unknown as { _bytes(): Uint8Array })._bytes();
    const byte0 = idxBytes[0];
    // REC is op nibble 8, Composing is resolution nibble 9.
    expect((byte0 >> 4) & 0x0f).toBe(8);
    expect(byte0 & 0x0f).toBe(9);
  });
});
