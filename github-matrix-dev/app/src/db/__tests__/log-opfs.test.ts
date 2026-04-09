/**
 * Tests for db/log-opfs.ts
 *
 * FileSystemSyncAccessHandle is not available in Node.js/Vitest. These tests
 * use a memory-backed OPFSLog constructed directly — without calling openLog()
 * — so all logic under test is exercised without a real OPFS filesystem.
 */

import { describe, it, expect } from 'vitest';
import { appendEvent, readEventAt, scanLog } from '../log-opfs';
import type { OPFSLog } from '../log-opfs';
import type { EoEvent } from '../types';

// ─── Memory-backed OPFSLog ────────────────────────────────────────────────────

function createMemoryLog(): OPFSLog {
  let buf = new Uint8Array(0);

  const syncHandle = {
    read(dest: Uint8Array, opts: { at: number }): number {
      const start = opts.at;
      const end = Math.min(start + dest.length, buf.length);
      const count = Math.max(0, end - start);
      dest.set(buf.subarray(start, end));
      return count;
    },
    write(src: Uint8Array, opts: { at: number }): number {
      const needed = opts.at + src.length;
      if (needed > buf.length) {
        const next = new Uint8Array(needed);
        next.set(buf);
        buf = next;
      }
      buf.set(src, opts.at);
      return src.length;
    },
    flush(): void { /* no-op */ },
    getSize(): number { return buf.length; },
    close(): void { /* no-op */ },
    truncate(size: number): void {
      const next = new Uint8Array(size);
      next.set(buf.subarray(0, size));
      buf = next;
    },
  } as unknown as FileSystemSyncAccessHandle;

  return {
    fileHandle: {} as FileSystemFileHandle,
    syncHandle,
    size: 0,
  };
}

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
      expect(second.nextOffset).toBe(log.size);
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
});
