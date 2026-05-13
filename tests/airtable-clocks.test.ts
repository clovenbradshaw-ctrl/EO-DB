import { describe, it, expect, beforeEach } from 'vitest';
import {
  LOCAL_REPLICA_ID,
  airtableReplicaId,
  airtableClock,
  compareFieldClocks,
  tickLocalReplica,
  readFieldClocksFromState,
  mergeFieldClocks,
  pickIncomingWinners,
  _resetLocalHlcForTests,
  type FieldClock,
} from '../src/ingestion/airtable-clocks.js';

beforeEach(() => {
  _resetLocalHlcForTests();
});

describe('airtableReplicaId / airtableClock', () => {
  it('uses base id in the replica string', () => {
    expect(airtableReplicaId('appXYZ')).toBe('airtable:appXYZ');
  });

  it('parses lastModifiedTime into wall_ms', () => {
    const clock = airtableClock('appXYZ', '2024-01-15T12:00:00.000Z');
    expect(clock.replica).toBe('airtable:appXYZ');
    expect(clock.hlc.wall_ms).toBe(Date.parse('2024-01-15T12:00:00.000Z'));
    expect(clock.hlc.logical).toBe(0);
  });

  it('falls back to createdTime when lastModified is missing', () => {
    const clock = airtableClock('appXYZ', undefined, '2024-01-10T00:00:00.000Z');
    expect(clock.hlc.wall_ms).toBe(Date.parse('2024-01-10T00:00:00.000Z'));
  });

  it('uses zero wall_ms when both timestamps are absent', () => {
    const clock = airtableClock('appXYZ', undefined, undefined);
    expect(clock.hlc.wall_ms).toBe(0);
  });
});

describe('compareFieldClocks', () => {
  const baseA: FieldClock = { hlc: { wall_ms: 100, logical: 0 }, replica: 'a' };
  const baseB: FieldClock = { hlc: { wall_ms: 200, logical: 0 }, replica: 'b' };

  it('orders by wall_ms first', () => {
    expect(compareFieldClocks(baseB, baseA)).toBeGreaterThan(0);
    expect(compareFieldClocks(baseA, baseB)).toBeLessThan(0);
  });

  it('orders by logical when wall_ms ties', () => {
    const a: FieldClock = { hlc: { wall_ms: 100, logical: 5 }, replica: 'x' };
    const b: FieldClock = { hlc: { wall_ms: 100, logical: 3 }, replica: 'x' };
    expect(compareFieldClocks(a, b)).toBeGreaterThan(0);
  });

  it('breaks full ties on replica id', () => {
    const a: FieldClock = { hlc: { wall_ms: 100, logical: 1 }, replica: 'b' };
    const b: FieldClock = { hlc: { wall_ms: 100, logical: 1 }, replica: 'a' };
    expect(compareFieldClocks(a, b)).toBeGreaterThan(0);
  });
});

describe('tickLocalReplica', () => {
  it('produces strictly-monotonic clocks within the same wall ms', () => {
    const a = tickLocalReplica(1_000);
    const b = tickLocalReplica(1_000);
    const c = tickLocalReplica(1_000);
    expect(compareFieldClocks(b, a)).toBeGreaterThan(0);
    expect(compareFieldClocks(c, b)).toBeGreaterThan(0);
    expect(a.replica).toBe(LOCAL_REPLICA_ID);
  });

  it('advances wall_ms when real time moves forward', () => {
    const a = tickLocalReplica(1_000);
    const b = tickLocalReplica(2_000);
    expect(b.hlc.wall_ms).toBe(2_000);
    expect(b.hlc.logical).toBe(0);
    expect(compareFieldClocks(b, a)).toBeGreaterThan(0);
  });

  it('never goes backwards even if wall clock does', () => {
    const a = tickLocalReplica(5_000);
    const b = tickLocalReplica(3_000); // simulated clock skew backward
    expect(b.hlc.wall_ms).toBe(5_000);
    expect(compareFieldClocks(b, a)).toBeGreaterThan(0);
  });
});

describe('readFieldClocksFromState', () => {
  it('returns empty map when state is null or has no clocks', () => {
    expect(readFieldClocksFromState(null)).toEqual({});
    expect(readFieldClocksFromState({})).toEqual({});
    expect(readFieldClocksFromState({ value: {} })).toEqual({});
    expect(readFieldClocksFromState({ value: { _airtable: {} } })).toEqual({});
  });

  it('parses well-formed clocks from operand sidecar', () => {
    const state = {
      value: {
        _airtable: {
          fieldClocks: {
            fldA: { hlc: { wall_ms: 100, logical: 2 }, replica: 'x' },
            fldB: { hlc: { wall_ms: 200, logical: 0 }, replica: 'y' },
          },
        },
      },
    };
    const clocks = readFieldClocksFromState(state);
    expect(clocks.fldA).toEqual({ hlc: { wall_ms: 100, logical: 2 }, replica: 'x' });
    expect(clocks.fldB.replica).toBe('y');
  });

  it('drops malformed entries', () => {
    const state = {
      value: {
        _airtable: {
          fieldClocks: {
            good: { hlc: { wall_ms: 1, logical: 0 }, replica: 'r' },
            noReplica: { hlc: { wall_ms: 1, logical: 0 } },
            noHlc: { replica: 'r' },
            nope: 'just a string',
          },
        },
      },
    };
    const clocks = readFieldClocksFromState(state);
    expect(Object.keys(clocks)).toEqual(['good']);
  });
});

describe('mergeFieldClocks', () => {
  it('keeps the winner per field', () => {
    const existing = {
      fldA: { hlc: { wall_ms: 100, logical: 0 }, replica: 'x' },
      fldB: { hlc: { wall_ms: 200, logical: 0 }, replica: 'x' },
    };
    const updates = {
      fldA: { hlc: { wall_ms: 300, logical: 0 }, replica: 'y' }, // newer
      fldB: { hlc: { wall_ms: 50, logical: 0 }, replica: 'y' },  // older
      fldC: { hlc: { wall_ms: 10, logical: 0 }, replica: 'y' },  // new
    };
    const merged = mergeFieldClocks(existing, updates);
    expect(merged.fldA.hlc.wall_ms).toBe(300);
    expect(merged.fldB.hlc.wall_ms).toBe(200);
    expect(merged.fldC.hlc.wall_ms).toBe(10);
  });

  it('does not mutate inputs', () => {
    const existing = { fldA: { hlc: { wall_ms: 1, logical: 0 }, replica: 'x' } };
    const updates = { fldA: { hlc: { wall_ms: 2, logical: 0 }, replica: 'y' } };
    mergeFieldClocks(existing, updates);
    expect(existing.fldA.hlc.wall_ms).toBe(1);
  });
});

describe('pickIncomingWinners', () => {
  const incomingClock: FieldClock = {
    hlc: { wall_ms: 500, logical: 0 },
    replica: 'airtable:appXYZ',
  };

  it('accepts incoming when no existing clock', () => {
    const r = pickIncomingWinners({}, { fldA: 'newVal' }, incomingClock);
    expect(r.winners).toEqual({ fldA: 'newVal' });
    expect(r.newClocks.fldA).toEqual(incomingClock);
  });

  it('drops fields where local clock beats incoming', () => {
    const existing = {
      fldA: { hlc: { wall_ms: 1000, logical: 0 }, replica: 'eo-db-local' },
    };
    const r = pickIncomingWinners(existing, { fldA: 'remote' }, incomingClock);
    expect(r.winners).toEqual({});
    expect(r.newClocks).toEqual({});
  });

  it('accepts incoming when older field is undefined and rejects when newer', () => {
    const existing = {
      fldA: { hlc: { wall_ms: 100, logical: 0 }, replica: 'eo-db-local' },
      fldB: { hlc: { wall_ms: 1000, logical: 0 }, replica: 'eo-db-local' },
    };
    const r = pickIncomingWinners(existing, { fldA: 'a', fldB: 'b' }, incomingClock);
    expect(r.winners).toEqual({ fldA: 'a' });
    expect(r.newClocks.fldA).toEqual(incomingClock);
    expect(r.newClocks.fldB).toBeUndefined();
  });
});
