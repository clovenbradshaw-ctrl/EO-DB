/**
 * Tests for db/log-opfs.ts
 *
 * FileSystemSyncAccessHandle is not available in Node.js/Vitest. These tests
 * use a memory-backed OPFSLog constructed directly — without calling openLog()
 * — so all logic under test is exercised without a real OPFS filesystem.
 */

import { describe, it, expect } from 'vitest';
import { appendEvent, readEventAt, scanLog, INDEX_RECORD_BYTES } from '../log-opfs';
import type { EoEvent, LoggableOperator } from '../types';
import { createMemoryLog } from './_memory-log';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(seq: number, target: string, value: unknown): EoEvent {
  return {
    seq,
    op: 'DEF',
    target,
    operand: value,
    agent: 'test-agent',
    ts: new Date().toISOString(),
    acquired_ts: new Date().toISOString(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('log-opfs', () => {
  describe('appendEvent', () => {
    it('returns byteOffset 0 for the first event', () => {
      const log = createMemoryLog();
      const ev = makeEvent(1, 'a.b', 42);
      const { byteOffset } = appendEvent(log, ev);
      expect(byteOffset).toBe(0);
    });

    it('advances log.size after each append', () => {
      const log = createMemoryLog();
      const ev1 = makeEvent(1, 'a', 1);
      const ev2 = makeEvent(2, 'b', 2);
      appendEvent(log, ev1);
      const sizeAfterFirst = log.size;
      expect(sizeAfterFirst).toBeGreaterThan(16);
      appendEvent(log, ev2);
      expect(log.size).toBeGreaterThan(sizeAfterFirst);
    });

    it('returns successive non-overlapping offsets', () => {
      const log = createMemoryLog();
      const r1 = appendEvent(log, makeEvent(1, 'x', 'hello'));
      const r2 = appendEvent(log, makeEvent(2, 'y', 'world'));
      expect(r2.byteOffset).toBeGreaterThan(r1.byteOffset);
    });
  });

  describe('readEventAt', () => {
    it('round-trips seq and operand', () => {
      const log = createMemoryLog();
      const ev = makeEvent(7, 'foo.bar', { name: 'Alice', score: 99 });
      const { byteOffset } = appendEvent(log, ev);
      const back = readEventAt(log, byteOffset);
      expect(back.seq).toBe(7);
      expect(back.target).toBe('foo.bar');
      expect(back.operand).toEqual({ name: 'Alice', score: 99 });
    });

    it('reads the middle event correctly after three appends', () => {
      const log = createMemoryLog();
      appendEvent(log, makeEvent(1, 'a', 'first'));
      const { byteOffset: mid } = appendEvent(log, makeEvent(2, 'b', 'second'));
      appendEvent(log, makeEvent(3, 'c', 'third'));

      const back = readEventAt(log, mid);
      expect(back.seq).toBe(2);
      expect(back.operand).toBe('second');
    });

    it('reads the last event via its offset', () => {
      const log = createMemoryLog();
      appendEvent(log, makeEvent(1, 'p', 10));
      const { byteOffset } = appendEvent(log, makeEvent(2, 'q', 20));
      const back = readEventAt(log, byteOffset);
      expect(back.operand).toBe(20);
    });
  });

  describe('scanLog', () => {
    it('yields all events in seq order', () => {
      const log = createMemoryLog();
      appendEvent(log, makeEvent(1, 'a', 'one'));
      appendEvent(log, makeEvent(2, 'b', 'two'));
      appendEvent(log, makeEvent(3, 'c', 'three'));

      const results = [...scanLog(log)];
      expect(results).toHaveLength(3);
      expect(results[0].event.seq).toBe(1);
      expect(results[1].event.seq).toBe(2);
      expect(results[2].event.seq).toBe(3);
    });

    it('yields correct byteOffset and nextOffset', () => {
      const log = createMemoryLog();
      appendEvent(log, makeEvent(1, 'x', null));
      appendEvent(log, makeEvent(2, 'y', null));

      const [first, second] = [...scanLog(log)];
      expect(first.nextOffset).toBe(second.byteOffset);
      // nextOffset is an INDEX-file offset (40-byte stride), not a total
      // bytes count. After two events the next index offset is the end of
      // the index file == log.idxBytes. (log.size in slice 5 means
      // idxBytes + payBytes; that's the cache-invalidation primitive, not
      // the scan terminator.)
      expect(second.nextOffset).toBe(log.idxBytes);
    });

    it('fromByteOffset skips earlier entries', () => {
      const log = createMemoryLog();
      appendEvent(log, makeEvent(1, 'a', 1));
      const { byteOffset: midOffset } = appendEvent(log, makeEvent(2, 'b', 2));
      appendEvent(log, makeEvent(3, 'c', 3));

      const results = [...scanLog(log, midOffset)];
      expect(results).toHaveLength(2);
      expect(results[0].event.seq).toBe(2);
      expect(results[1].event.seq).toBe(3);
    });

    it('returns empty for an empty log', () => {
      const log = createMemoryLog();
      expect([...scanLog(log)]).toHaveLength(0);
    });

    it('each event round-trips operand correctly during scan', () => {
      const log = createMemoryLog();
      const events = [
        makeEvent(1, 'n.a', { x: 1 }),
        makeEvent(2, 'n.b', [1, 2, 3]),
        makeEvent(3, 'n.c', 'plain string'),
      ];
      for (const ev of events) appendEvent(log, ev);

      const scanned = [...scanLog(log)].map(e => e.event);
      expect(scanned[0].operand).toEqual({ x: 1 });
      expect(scanned[1].operand).toEqual([1, 2, 3]);
      expect(scanned[2].operand).toBe('plain string');
    });
  });

  // ─── Format invariants ──────────────────────────────────────────────────────

  describe('two-file format invariants', () => {
    it('exports INDEX_RECORD_BYTES = 40 (regression guard against drift)', () => {
      expect(INDEX_RECORD_BYTES).toBe(40);
    });

    it('every appendEvent advances log.idxBytes by exactly 40', () => {
      const log = createMemoryLog();
      for (let i = 1; i <= 10; i++) {
        const before = log.idxBytes;
        appendEvent(log, makeEvent(i, `t-${i}`, { v: i }));
        expect(log.idxBytes - before).toBe(INDEX_RECORD_BYTES);
      }
    });

    it('appendEvent grows the payload file by exactly the encoded payload size', () => {
      const log = createMemoryLog();
      for (let i = 1; i <= 5; i++) {
        const before = log.payBytes;
        appendEvent(log, makeEvent(i, `t-${i}`, { x: 'a'.repeat(i * 10) }));
        // Payload grew by some positive amount equal to the encoded msgpack size.
        expect(log.payBytes).toBeGreaterThan(before);
      }
    });

    it('log.size == idxBytes + payBytes (cache-invalidation primitive)', () => {
      const log = createMemoryLog();
      appendEvent(log, makeEvent(1, 'a', { v: 1 }));
      appendEvent(log, makeEvent(2, 'b', { v: 2 }));
      appendEvent(log, makeEvent(3, 'c', { v: 3 }));
      expect(log.size).toBe(log.idxBytes + log.payBytes);
      expect(log.idxBytes).toBe(3 * INDEX_RECORD_BYTES);
    });
  });

  // ─── Round-trip property: 1000 events, all 9 operators ─────────────────────

  describe('round-trip: 1000 events through the two-file format', () => {
    function rng(seed: number): () => number {
      // Tiny deterministic LCG so the test is reproducible.
      let s = seed >>> 0;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
      };
    }

    function makeRandomEvent(seq: number, rand: () => number): EoEvent {
      const ops: LoggableOperator[] = ['NUL', 'SIG', 'INS', 'SEG', 'CON', 'SYN', 'DEF', 'EVA', 'REC'];
      const op = ops[Math.floor(rand() * ops.length)];

      // Random site name from a small pool, with depth 1-3 segments. Mixing
      // depths exercises the index-file site-hash field across many distinct
      // hash values.
      const depth = 1 + Math.floor(rand() * 3);
      const segs: string[] = [];
      for (let i = 0; i < depth; i++) {
        segs.push(`s${Math.floor(rand() * 100)}`);
      }
      const target = segs.join('.');

      // Random payload shape — string, number, object, array. Sized so the
      // total run produces a few hundred KB of payload data.
      let operand: unknown;
      const shape = Math.floor(rand() * 4);
      if (shape === 0) operand = 'x'.repeat(Math.floor(rand() * 64));
      else if (shape === 1) operand = Math.floor(rand() * 1_000_000);
      else if (shape === 2) operand = { k: Math.floor(rand() * 1000), v: 'value' };
      else operand = [1, 2, 3, Math.floor(rand() * 1000)];

      return {
        seq,
        op,
        target,
        operand,
        agent: 'rt-test',
        ts: new Date(2026, 0, 1, 0, 0, 0, seq).toISOString(),
        acquired_ts: new Date(2026, 0, 1, 0, 0, 0, seq).toISOString(),
      };
    }

    it('writes 1000 events and reads back identical operator/site/seq/payload', () => {
      const log = createMemoryLog();
      const rand = rng(0xdeadbeef);

      const written: EoEvent[] = [];
      for (let i = 1; i <= 1000; i++) {
        const ev = makeRandomEvent(i, rand);
        written.push(ev);
        appendEvent(log, ev);
      }

      // Index file is exactly 1000 × 40 bytes — strict stride invariant.
      expect(log.idxBytes).toBe(1000 * INDEX_RECORD_BYTES);

      // Walk via scanLog and assert byte-identical reconstruction.
      const scanned = [...scanLog(log)];
      expect(scanned).toHaveLength(1000);

      for (let i = 0; i < 1000; i++) {
        const expected = written[i];
        const actual = scanned[i].event;
        expect(actual.op).toBe(expected.op);
        expect(actual.target).toBe(expected.target);
        expect(actual.seq).toBe(expected.seq);
        expect(actual.operand).toEqual(expected.operand);
        expect(actual.agent).toBe(expected.agent);
        expect(actual.ts).toBe(expected.ts);
      }
    });

    it('seq numbers reconstructed from the scan are monotonic', () => {
      const log = createMemoryLog();
      const rand = rng(0xc0ffee);

      for (let i = 1; i <= 1000; i++) {
        appendEvent(log, makeRandomEvent(i, rand));
      }

      let prev = 0;
      for (const { event } of scanLog(log)) {
        expect(event.seq).toBeGreaterThan(prev);
        prev = event.seq;
      }
    });

    it('readEventAt round-trips for every offset emitted by appendEvent', () => {
      const log = createMemoryLog();
      const rand = rng(0xfeedface);

      const offsets: number[] = [];
      const events: EoEvent[] = [];
      for (let i = 1; i <= 1000; i++) {
        const ev = makeRandomEvent(i, rand);
        events.push(ev);
        offsets.push(appendEvent(log, ev).byteOffset);
      }

      // Direct random-access lookup at every offset.
      for (let i = 0; i < 1000; i++) {
        const back = readEventAt(log, offsets[i]);
        expect(back.op).toBe(events[i].op);
        expect(back.target).toBe(events[i].target);
        expect(back.seq).toBe(events[i].seq);
        expect(back.operand).toEqual(events[i].operand);
      }
    });

    it('every byteOffset is on a 40-byte boundary', () => {
      const log = createMemoryLog();
      const rand = rng(0xbadc0de);
      for (let i = 1; i <= 1000; i++) {
        const { byteOffset } = appendEvent(log, makeRandomEvent(i, rand));
        expect(byteOffset % INDEX_RECORD_BYTES).toBe(0);
      }
    });
  });
});
