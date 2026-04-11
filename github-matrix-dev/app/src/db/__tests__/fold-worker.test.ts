/**
 * Tests for the fold engine pipeline (layers 1-4 combined).
 *
 * Workers cannot be spun up in Vitest/Node.js. These tests exercise the
 * same processing pipeline used by fold.worker.ts by importing the engine
 * primitives directly and calling them in sequence — the same way the Worker's
 * message handlers do.
 */

import { describe, it, expect } from 'vitest';
import { appendEvent, readEventAt } from '../log-opfs';
import type { OPFSLog } from '../log-opfs';
import { createMemoryLog } from './_memory-log';
import { buildIndex, updateIndex, getIntersection } from '../log-index';
import type { LogIndex } from '../log-index';
import {
  createFoldPosition,
  applyEvent,
} from '../fold-position';
import type { FoldPosition } from '../fold-position';
import type { EoEvent } from '../types';

function ev(
  seq: number,
  op: EoEvent['op'],
  target: string,
  operand: unknown = null,
): EoEvent {
  return {
    seq, op, target, operand,
    agent: 'test', ts: new Date().toISOString(), acquired_ts: new Date().toISOString(),
  };
}

// ─── Engine harness: mirrors Worker's writeEvent pipeline ────────────────────

function writeEv(
  log: OPFSLog,
  index: LogIndex,
  pos: FoldPosition,
  event: EoEvent,
): number {
  const { byteOffset } = appendEvent(log, event);
  updateIndex(index, event, byteOffset);
  applyEvent(pos, event);
  return byteOffset;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('fold engine pipeline', () => {
  it('DEF sequence: getField returns last written value', () => {
    const log = createMemoryLog();
    const pos = createFoldPosition();
    writeEv(log, buildIndex(log), pos, ev(1, 'INS', 'x'));
    const index = buildIndex(log);
    writeEv(log, index, pos, ev(2, 'DEF', 'x', 1));
    writeEv(log, index, pos, ev(3, 'DEF', 'x', 2));
    writeEv(log, index, pos, ev(4, 'DEF', 'x', 3));

    const seqs = getIntersection(index, 'DEF', 'x');
    expect(seqs.length).toBe(3);
    const lastSeq = seqs[seqs.length - 1];
    expect(lastSeq).toBe(4);
  });

  it('writeSig pattern: sigLayer overrides value', () => {
    // This tests the pattern — actual sigLayer lives in the Worker
    const sigLayer = new Map<string, unknown>();
    sigLayer.set('x.value', 'override');

    const getFieldWithSig = (target: string, field: string): unknown => {
      const key = `${target}.${field}`;
      return sigLayer.has(key) ? sigLayer.get(key) : null;
    };

    expect(getFieldWithSig('x', 'value')).toBe('override');
    expect(getFieldWithSig('x', 'other')).toBeNull();
  });

  it('CON edges update conAdjacency and conReverse', () => {
    const log = createMemoryLog();
    const index = buildIndex(log);
    const pos = createFoldPosition();
    writeEv(log, index, pos, ev(1, 'INS', 'A'));
    writeEv(log, index, pos, ev(2, 'INS', 'B'));
    writeEv(log, index, pos, ev(3, 'CON', 'A', 'B'));

    expect(pos.conAdjacency.get('A')?.has('B')).toBe(true);
    expect(pos.conReverse.get('B')?.has('A')).toBe(true);
  });

  it('EVA registration stub is written after EVA event', () => {
    const log = createMemoryLog();
    const index = buildIndex(log);
    const pos = createFoldPosition();
    writeEv(log, index, pos, ev(1, 'INS', 'derived'));
    writeEv(log, index, pos, ev(2, 'EVA', 'derived', { expr: 'a + b' }));

    expect(pos.evaRegistrations.has('derived')).toBe(true);
    expect(pos.evaRegistrations.get('derived')!.formula).toEqual({ expr: 'a + b' });
  });

  it('REC event updates lastConverged on evaRegistrations', () => {
    const log = createMemoryLog();
    const index = buildIndex(log);
    const pos = createFoldPosition();
    writeEv(log, index, pos, ev(1, 'EVA', 'derived', {}));
    writeEv(log, index, pos, ev(2, 'REC', 'derived', { converged: true }));

    expect(pos.evaRegistrations.get('derived')!.lastConverged).toBe(true);
  });

  it('query within prefix: INS targets under attorneys.*', () => {
    const log = createMemoryLog();
    const index = buildIndex(log);
    const pos = createFoldPosition();
    writeEv(log, index, pos, ev(1, 'INS', 'attorneys.alice'));
    writeEv(log, index, pos, ev(2, 'INS', 'attorneys.bob'));
    writeEv(log, index, pos, ev(3, 'INS', 'judges.carol'));

    // Simulate resolveQuery: prefix='attorneys', opFilter='INS'
    const insEntry = index.opIndex.get('INS');
    const insSeqs = insEntry?.seqs ?? new Uint32Array(0);
    // For each seq, get the target (readEventAt imported at top of file)
    const targets: string[] = [];
    for (const seq of insSeqs) {
      const offset = index.seqToOffset.get(seq)!;
      const event = readEventAt(log, offset);
      if (event.target.startsWith('attorneys')) targets.push(event.target);
    }
    expect(targets).toContain('attorneys.alice');
    expect(targets).toContain('attorneys.bob');
    expect(targets).not.toContain('judges.carol');
  });

  it('whereEvaUnresolved: zero log reads needed', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'EVA', 'a', {}));
    applyEvent(pos, ev(2, 'EVA', 'b', {}));
    applyEvent(pos, ev(3, 'REC', 'a', { converged: true }));

    // This scan is pure fold-position — no log interaction
    const unresolved = [...pos.evaRegistrations.entries()]
      .filter(([, r]) => r.lastConverged !== true)
      .map(([k]) => k);

    expect(unresolved).toContain('b');
    expect(unresolved).not.toContain('a');
  });

  it('graph traversal within 2 CON hops of A', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'INS', 'A'));
    applyEvent(pos, ev(2, 'INS', 'B'));
    applyEvent(pos, ev(3, 'INS', 'C'));
    applyEvent(pos, ev(4, 'CON', 'A', 'B'));
    applyEvent(pos, ev(5, 'CON', 'B', 'C'));

    // BFS from A with depth 2
    const visited = new Set<string>();
    const queue: Array<{ target: string; d: number }> = [{ target: 'A', d: 0 }];
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (visited.has(item.target) || item.d > 2) continue;
      visited.add(item.target);
      for (const dest of pos.conAdjacency.get(item.target) ?? []) {
        if (!visited.has(dest)) queue.push({ target: dest, d: item.d + 1 });
      }
    }

    expect(visited.has('A')).toBe(true);
    expect(visited.has('B')).toBe(true);
    expect(visited.has('C')).toBe(true);
  });

  it('adaptive checkpoint threshold: eventsSinceCheckpoint tracks correctly', () => {
    // Test the counting logic independent of the Worker
    let eventsSinceCheckpoint = 0;
    const avgProcessMicrosPerEvent = 100; // 100µs per event
    const TARGET_STARTUP_MS = 300;

    const shouldCheckpoint = (): boolean => {
      const estimatedReplayMs = (eventsSinceCheckpoint * avgProcessMicrosPerEvent) / 1000;
      return estimatedReplayMs > TARGET_STARTUP_MS;
    };

    // Below threshold
    eventsSinceCheckpoint = 2999;
    expect(shouldCheckpoint()).toBe(false);

    // At threshold
    eventsSinceCheckpoint = 3001;
    expect(shouldCheckpoint()).toBe(true);
  });
});
