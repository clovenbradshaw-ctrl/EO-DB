/**
 * seed-uploader tests — round-trip parsing, idempotent diff.
 *
 * The Matrix-touching paths (hot-start genesis) are exercised by manual
 * e2e checks documented in the plan. Here we verify the parser handles
 * .eodb and NDJSON forms, and that the diff path skips events the store
 * already knows about.
 */

import { describe, it, expect } from 'vitest';
import { parseSeedFile, seedSpaceFromFile } from '../seed-uploader';
import { buildBlockBytes, BLOCK_SCHEMA_VERSION } from '../block-sealer';
import type { EoEventInput } from '../../db/types';
import type { EoStore } from '../../db/encrypted-store';

function makeEvent(i: number): EoEventInput {
  return {
    op: 'INS',
    target: `t.r${i}`,
    operand: i,
    agent: '@u:t',
    ts: '2026-01-01T00:00:00Z',
    acquired_ts: '2026-01-01T00:00:00Z',
    client_event_id: `ev:${i.toString(16).padStart(8, '0')}`,
  };
}

function makeFakeStore(): EoStore & { __knownIds: Set<string> } {
  const data = new Map<string, any>();
  const idem = new Set<string>();
  let seq = 0;
  return {
    __knownIds: idem,
    async get(key: string) {
      if (key.startsWith('idem:')) {
        return idem.has(key.slice('idem:'.length)) ? true : null;
      }
      return data.has(key) ? data.get(key) : null;
    },
    async put(key: string, value: any) { data.set(key, value); },
    async del(key: string) { data.delete(key); },
    async iterator(_prefix: string) { return []; },
    async nextSeq() { seq++; return seq; },
    async getCurrentSeq() { return seq; },
    close() {},
  } as any;
}

describe('seed-uploader', () => {
  describe('parseSeedFile', () => {
    it('decodes a .eodb seed', async () => {
      const events = [makeEvent(1), makeEvent(2), makeEvent(3)];
      const bytes = await buildBlockBytes({
        collectionId: 'c',
        blockIndex: 0,
        priorBlockEventId: null,
        schemaVersion: BLOCK_SCHEMA_VERSION,
        events,
      });
      const parsed = await parseSeedFile(bytes, 'seed.eodb');
      expect(parsed.format).toBe('eodb');
      expect(parsed.events.length).toBe(3);
      expect(parsed.events[1].target).toBe('t.r2');
    });

    it('decodes an NDJSON seed', async () => {
      const events = [makeEvent(1), makeEvent(2)];
      const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      const bytes = new TextEncoder().encode(text);
      const parsed = await parseSeedFile(bytes, 'seed.ndjson');
      expect(parsed.format).toBe('ndjson');
      expect(parsed.events.length).toBe(2);
    });

    it('rejects garbage with non-NDJSON extension', async () => {
      const bytes = new TextEncoder().encode('garbage bytes here, not json');
      await expect(parseSeedFile(bytes, 'random.bin')).rejects.toThrow();
    });
  });

  describe('seedSpaceFromFile diff path', () => {
    // Stub the matrix client so the hot-start branch is bypassed (we set
    // currentSeq > 0 so the room is not "empty") and we exercise the diff.
    const fakeClient = {
      getUserId: () => '@u:t',
      getDeviceId: () => 'd',
      getRoom: () => null, // no room means readHeadState returns empty,
                           // but currentSeq > 0 forces the diff path anyway.
    } as any;

    it('first apply adds every event; second apply skips them all', async () => {
      const events = [makeEvent(1), makeEvent(2), makeEvent(3)];
      const seed = { format: 'eodb' as const, events };

      const store = makeFakeStore();
      // Bump current seq so seedSpaceFromFile takes the diff branch.
      await store.put('idem:initial-tick', true);
      // Override nextSeq to look non-zero.
      (store as any).getCurrentSeq = async () => 1;

      // First apply: nothing in idem set yet, every event should land
      // (and we manually mark idem on each processEvent call via a hook).
      // Patch processEvent indirectly: we know fold.processEvent stores
      // idem:<id> as a side effect. To keep this test pure, we drive
      // the diff loop ourselves through `forceDiffPath: true` and use a
      // store whose `get` reads from our injected set.

      // Apply 1 — none known.
      const r1 = await seedSpaceFromFile(
        fakeClient, '!room', 'col', store, seed,
        { forceDiffPath: true },
      );
      // Each processEvent should have written an idem key for the event.
      // We can't observe processEvent's writes through the fake store
      // directly (it writes via `put`), but `added` is what the diff
      // accounting reports.
      expect(r1.total).toBe(3);
      // First pass: no ids in `idem` initially, so all 3 went through
      // the "added" branch.
      expect(r1.added).toBe(3);
      expect(r1.skipped).toBe(0);

      // Manually mark them as known to simulate what a real processEvent
      // does, then re-apply — the diff should report all skipped.
      for (const e of events) store.__knownIds.add(e.client_event_id!);

      const r2 = await seedSpaceFromFile(
        fakeClient, '!room', 'col', store, seed,
        { forceDiffPath: true },
      );
      expect(r2.total).toBe(3);
      expect(r2.added).toBe(0);
      expect(r2.skipped).toBe(3);
    });

    it('reports progress per event', async () => {
      const events = [makeEvent(1), makeEvent(2)];
      const seed = { format: 'eodb' as const, events };
      const store = makeFakeStore();
      (store as any).getCurrentSeq = async () => 1;

      const ticks: Array<[number, number]> = [];
      await seedSpaceFromFile(
        fakeClient, '!room', 'col', store, seed,
        { forceDiffPath: true, onProgress: (c, t) => ticks.push([c, t]) },
      );
      expect(ticks).toEqual([[1, 2], [2, 2]]);
    });
  });
});
