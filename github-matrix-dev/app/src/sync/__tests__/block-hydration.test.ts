/**
 * block-hydration tests — block-payload decode + chain walk.
 *
 * Full hydrate path (with mxc:// download) is exercised by manual e2e
 * checks in the plan. Here we cover the pure pieces: readBlockEvents
 * decodes what buildBlockBytes wrote, and walkBlockChain assembles
 * a chain in chronological order via prior_block_event_id.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  readBlockEvents,
  walkBlockChain,
  clearAllHydratedHeadMarkers,
  getPersistedHydratedHead,
  setPersistedHydratedHead,
} from '../block-hydration';
import { buildBlockBytes, BLOCK_SCHEMA_VERSION } from '../block-sealer';
import type { EoEventInput } from '../../db/types';

function makeLocalStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    get length() { return map.size; },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  } as Storage;
}

function makeEvent(i: number): EoEventInput {
  return {
    op: 'INS',
    target: `t.r${i}`,
    operand: i,
    agent: '@u:t',
    ts: '2026-01-01T00:00:00Z',
    acquired_ts: '2026-01-01T00:00:00Z',
    client_event_id: `ev:${i}`,
  };
}

describe('block-hydration', () => {
  describe('readBlockEvents', () => {
    it('decodes events from a block built by buildBlockBytes', async () => {
      const events = [makeEvent(1), makeEvent(2), makeEvent(3)];
      const bytes = await buildBlockBytes({
        collectionId: 'c',
        blockIndex: 0,
        priorBlockEventId: null,
        schemaVersion: BLOCK_SCHEMA_VERSION,
        events,
      });
      const decoded = await readBlockEvents(bytes);
      expect(decoded.length).toBe(3);
      expect(decoded.map(e => e.target)).toEqual(['t.r1', 't.r2', 't.r3']);
    });

    it('returns empty for a block with no events', async () => {
      const bytes = await buildBlockBytes({
        collectionId: 'c',
        blockIndex: 0,
        priorBlockEventId: null,
        schemaVersion: BLOCK_SCHEMA_VERSION,
        events: [],
      });
      const decoded = await readBlockEvents(bytes);
      expect(decoded.length).toBe(0);
    });
  });

  describe('walkBlockChain', () => {
    function makeMockClient(chain: Array<{ id: string; prior: string | null; index: number }>) {
      // Build a map of event_id -> MatrixEvent-like with parsable content.
      const byId = new Map(chain.map((b) => [b.id, {
        getId: () => b.id,
        getType: () => 'm.eo.block',
        getContent: () => ({
          block_index: b.index,
          event_count: 0,
          first_event_id: null,
          last_event_id: null,
          prior_block_event_id: b.prior,
          schema_version: BLOCK_SCHEMA_VERSION,
          file: { url: 'mxc://x', key: {}, iv: '', hashes: { sha256: '' }, v: 'v2' },
          sealed_by: { user_id: '@u', device_id: 'd' },
          sealed_at: '2026',
        }),
      }]));
      return {
        getRoom: () => ({
          findEventById: (id: string) => byId.get(id) as any,
        }),
      } as any;
    }

    it('walks the chain in reverse and returns chronological order', async () => {
      // Genesis ← block1 ← block2 (latest)
      const client = makeMockClient([
        { id: '$genesis', prior: null, index: 0 },
        { id: '$b1', prior: '$genesis', index: 1 },
        { id: '$b2', prior: '$b1', index: 2 },
      ]);
      const chain = await walkBlockChain(client, '!room', '$b2');
      expect(chain.map((c) => c.eventId)).toEqual(['$genesis', '$b1', '$b2']);
      expect(chain[0].content.block_index).toBe(0);
      expect(chain[2].content.block_index).toBe(2);
    });

    it('throws on a chain cycle', async () => {
      const client = makeMockClient([
        { id: '$a', prior: '$b', index: 0 },
        { id: '$b', prior: '$a', index: 1 },
      ]);
      await expect(walkBlockChain(client, '!room', '$b')).rejects.toThrow(/cycle/i);
    });

    it('stops at stopAtBlockEventId (incremental hydration)', async () => {
      // Genesis ← block1 ← block2 ← block3 (latest); stop at $b1 (exclusive).
      // Expected return: blocks newer than $b1, i.e. [$b2, $b3] in chrono order.
      const client = makeMockClient([
        { id: '$genesis', prior: null, index: 0 },
        { id: '$b1', prior: '$genesis', index: 1 },
        { id: '$b2', prior: '$b1', index: 2 },
        { id: '$b3', prior: '$b2', index: 3 },
      ]);
      const chain = await walkBlockChain(client, '!room', '$b3', '$b1');
      expect(chain.map((c) => c.eventId)).toEqual(['$b2', '$b3']);
    });

    it('returns empty when latest equals stopAtBlockEventId (nothing new)', async () => {
      const client = makeMockClient([
        { id: '$genesis', prior: null, index: 0 },
        { id: '$b1', prior: '$genesis', index: 1 },
      ]);
      const chain = await walkBlockChain(client, '!room', '$b1', '$b1');
      expect(chain).toEqual([]);
    });
  });

  // V5 / V9 — hydration cursor lifecycle. The cursor was historically only
  // in localStorage; on logout the same keys are scrubbed so a new account
  // doesn't inherit a "we already hydrated up to X" marker. The same
  // helpers are also called by the boot path to reconcile the snapshot's
  // `hydratedHead` against localStorage.
  describe('hydration cursor helpers', () => {
    beforeEach(() => {
      (globalThis as { localStorage?: Storage }).localStorage = makeLocalStorage();
    });

    it('round-trips a single room cursor through get/set', () => {
      setPersistedHydratedHead('!a:t', '$blockA');
      expect(getPersistedHydratedHead('!a:t')).toBe('$blockA');
    });

    it('returns null when the cursor has not been set', () => {
      expect(getPersistedHydratedHead('!nope:t')).toBeNull();
    });

    it('setPersistedHydratedHead(null) clears the cursor', () => {
      setPersistedHydratedHead('!a:t', '$blockA');
      setPersistedHydratedHead('!a:t', null);
      expect(getPersistedHydratedHead('!a:t')).toBeNull();
    });

    it('clearAllHydratedHeadMarkers wipes every per-room cursor', () => {
      setPersistedHydratedHead('!a:t', '$blockA');
      setPersistedHydratedHead('!b:t', '$blockB');
      setPersistedHydratedHead('!c:t', '$blockC');
      // Set an unrelated localStorage key — must NOT be removed.
      localStorage.setItem('unrelated', 'keep me');

      clearAllHydratedHeadMarkers();

      expect(getPersistedHydratedHead('!a:t')).toBeNull();
      expect(getPersistedHydratedHead('!b:t')).toBeNull();
      expect(getPersistedHydratedHead('!c:t')).toBeNull();
      expect(localStorage.getItem('unrelated')).toBe('keep me');
    });

    it('clearAllHydratedHeadMarkers is a no-op when there are no cursors', () => {
      localStorage.setItem('something-else', 'x');
      clearAllHydratedHeadMarkers();
      expect(localStorage.getItem('something-else')).toBe('x');
    });
  });
});
