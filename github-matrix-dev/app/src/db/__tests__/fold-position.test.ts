/**
 * Tests for db/fold-position.ts
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createFoldPosition,
  applyEvent,
  saveCheckpoint,
  loadCheckpoint,
} from '../fold-position';
import type { EoEvent } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ev(
  seq: number,
  op: EoEvent['op'],
  target: string,
  operand: unknown = null,
): EoEvent {
  return {
    seq,
    op,
    target,
    operand,
    agent: 'test',
    ts: new Date().toISOString(),
    acquired_ts: new Date().toISOString(),
  };
}

// ─── applyEvent ───────────────────────────────────────────────────────────────

describe('applyEvent', () => {
  it('INS adds target to existenceIndex', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'INS', 'attorneys.alice'));
    expect(pos.existenceIndex.has('attorneys.alice')).toBe(true);
  });

  it('CON adds forward and reverse edges', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'CON', 'A', 'B'));
    expect(pos.conAdjacency.get('A')?.has('B')).toBe(true);
    expect(pos.conReverse.get('B')?.has('A')).toBe(true);
  });

  it('SEG adds target to segment membership', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'SEG', 'attorneys.alice', { segmentId: 'seg-1' }));
    expect(pos.segMembership.get('seg-1')?.has('attorneys.alice')).toBe(true);
  });

  it('SEG falls back to event.target as segmentId when operand has none', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'SEG', 'seg-2'));
    expect(pos.segMembership.get('seg-2')?.has('seg-2')).toBe(true);
  });

  it('SYN stores alias from operand._alias', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'SYN', 'attorneys.alice', { _alias: 'alice' }));
    expect(pos.aliasMap.get('attorneys.alice')).toBe('alice');
  });

  it('SYN with no _alias does not add aliasMap entry', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'SYN', 'x', {}));
    expect(pos.aliasMap.has('x')).toBe(false);
  });

  it('DEF with hash stores in hashChain', () => {
    const pos = createFoldPosition();
    const event = { ...ev(1, 'DEF', 'x', 99), hash: 'abc123' };
    applyEvent(pos, event as EoEvent);
    expect(pos.hashChain.get('x')).toBe('abc123');
  });

  it('DEF without hash does not modify hashChain', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'DEF', 'x', 99));
    expect(pos.hashChain.has('x')).toBe(false);
  });

  it('EVA writes a stub to evaRegistrations', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'EVA', 'derived', { expr: 'x + y' }));
    const reg = pos.evaRegistrations.get('derived');
    expect(reg).toBeDefined();
    expect(reg!.target).toBe('derived');
    expect(reg!.mode).toBe('fold'); // placeholder
  });

  it('EVA preserves lastConverged from existing registration', () => {
    const pos = createFoldPosition();
    // First EVA
    applyEvent(pos, ev(1, 'EVA', 'target', { expr: 'a' }));
    pos.evaRegistrations.get('target')!.lastConverged = true;
    // Second EVA update (formula changed)
    applyEvent(pos, ev(2, 'EVA', 'target', { expr: 'b' }));
    expect(pos.evaRegistrations.get('target')!.lastConverged).toBe(true);
  });

  it('REC updates lastConverged and lastRecSeq', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'EVA', 'derived', {}));
    applyEvent(pos, ev(2, 'REC', 'derived', { converged: true }));
    const reg = pos.evaRegistrations.get('derived')!;
    expect(reg.lastConverged).toBe(true);
    expect(reg.lastRecSeq).toBe(2);
  });

  it('REC with converged:false marks oscillation', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'EVA', 'x', {}));
    applyEvent(pos, ev(2, 'REC', 'x', { converged: false }));
    expect(pos.evaRegistrations.get('x')!.lastConverged).toBe(false);
  });

  it('NUL does not change existenceIndex', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'NUL', 'ghost'));
    expect(pos.existenceIndex.has('ghost')).toBe(false);
  });

  it('SIG does not mutate position', () => {
    const pos = createFoldPosition();
    const before = pos.seq;
    applyEvent(pos, ev(1, 'SIG', 'x', { fieldKey: 'f', draft: 'v' }));
    // seq is updated but structural state unchanged
    expect(pos.seq).toBe(1);
    expect(pos.existenceIndex.size).toBe(0);
    void before;
  });

  it('always updates pos.seq', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(5, 'INS', 'a'));
    expect(pos.seq).toBe(5);
    applyEvent(pos, ev(9, 'NUL', 'b'));
    expect(pos.seq).toBe(9);
  });
});

// ─── whereEvaUnresolved — pure fold position scan ─────────────────────────────

describe('whereEvaUnresolved', () => {
  it('returns targets where lastConverged !== true without log reads', () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'EVA', 'target-a', {}));
    applyEvent(pos, ev(2, 'EVA', 'target-b', {}));
    applyEvent(pos, ev(3, 'REC', 'target-a', { converged: true }));

    // target-a converged; target-b has never run
    const unresolved = [...pos.evaRegistrations.entries()]
      .filter(([, r]) => r.lastConverged !== true)
      .map(([k]) => k);

    expect(unresolved).toContain('target-b');
    expect(unresolved).not.toContain('target-a');
  });
});

// ─── saveCheckpoint / loadCheckpoint ─────────────────────────────────────────

describe('saveCheckpoint / loadCheckpoint', () => {
  it('round-trips all Maps and Sets', async () => {
    const pos = createFoldPosition();
    applyEvent(pos, ev(1, 'INS', 'attorneys.alice'));
    applyEvent(pos, ev(2, 'CON', 'A', 'B'));
    applyEvent(pos, ev(3, 'SEG', 'attorneys.alice', { segmentId: 'seg-1' }));
    applyEvent(pos, ev(4, 'SYN', 'attorneys.alice', { _alias: 'alice' }));
    applyEvent(pos, ev(5, 'EVA', 'derived', { expr: 'x' }));
    applyEvent(pos, ev(6, 'REC', 'derived', { converged: true }));

    // Mock OPFS directory
    const fileStore = new Map<string, Uint8Array>();
    const opfsDir = {
      getFileHandle(name: string, opts?: { create?: boolean }) {
        return Promise.resolve({
          createSyncAccessHandle: () => Promise.reject(new Error('sync not available')),
          createWritable: () =>
            Promise.resolve({
              write(blob: Blob) {
                return blob.arrayBuffer().then(ab => {
                  fileStore.set(name, new Uint8Array(ab));
                });
              },
              close: () => Promise.resolve(),
            }),
          getFile: () =>
            Promise.resolve({
              arrayBuffer: () =>
                Promise.resolve(
                  fileStore.get('fold-position.bin')?.buffer ??
                  new ArrayBuffer(0),
                ),
            }),
          move(dir: unknown, newName: string) {
            const data = fileStore.get(name);
            if (data) fileStore.set(newName, data);
            return Promise.resolve();
          },
        } as unknown as FileSystemFileHandle);
      },
    } as unknown as FileSystemDirectoryHandle;

    await saveCheckpoint(pos, opfsDir);
    const loaded = await loadCheckpoint(opfsDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.seq).toBe(6);
    expect(loaded!.existenceIndex.has('attorneys.alice')).toBe(true);
    expect(loaded!.conAdjacency.get('A')?.has('B')).toBe(true);
    expect(loaded!.conReverse.get('B')?.has('A')).toBe(true);
    expect(loaded!.segMembership.get('seg-1')?.has('attorneys.alice')).toBe(true);
    expect(loaded!.aliasMap.get('attorneys.alice')).toBe('alice');
    const reg = loaded!.evaRegistrations.get('derived');
    expect(reg).toBeDefined();
    expect(reg!.lastConverged).toBe(true);
    expect(reg!.lastRecSeq).toBe(6);
  });

  it('returns null when file does not exist', async () => {
    const opfsDir = {
      getFileHandle() {
        return Promise.reject(new DOMException('Not found', 'NotFoundError'));
      },
    } as unknown as FileSystemDirectoryHandle;

    const result = await loadCheckpoint(opfsDir);
    expect(result).toBeNull();
  });
});
