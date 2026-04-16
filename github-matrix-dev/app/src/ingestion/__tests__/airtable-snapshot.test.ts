/**
 * Round-trip tests for the Airtable hydration snapshot format.
 *
 * These lock in the invariant that a snapshot produced by
 * `encodeAirtableSnapshot()` can be re-read byte-identically in terms of
 * logical content (events + cursors) — which is the foundation the
 * bootstrap path relies on when a fresh device replays a baked snapshot
 * instead of re-pulling the whole base from Airtable.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeAirtableSnapshot,
  decodeAirtableSnapshot,
  replayAirtableSnapshot,
  airtableSnapshotFilename,
  type AirtableCursorMap,
} from '../airtable-snapshot';
import type { EoEvent } from '../../db/types';
import type { EoStore, IteratorOpts } from '../../db/encrypted-store';

// ─── In-memory test store ────────────────────────────────────────────────────

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

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeEvents(): EoEvent[] {
  // Events look roughly like what processHydrationBundle emits: a mix of
  // DEF (schema) and INS (records), tagged with a base id in _airtable.
  return [
    {
      seq: 1,
      op: 'DEF',
      target: 'at.base.appABC',
      operand: { name: 'Marketing', _airtable: { type: 'base', base_id: 'appABC' } },
      agent: '@alice:example.com',
      ts: '2026-04-11T09:00:00.000Z',
      acquired_ts: '2026-04-11T09:00:00.000Z',
      client_event_id: 'at-base-def:appABC',
    } as EoEvent,
    {
      seq: 2,
      op: 'INS',
      target: 'at.rec.appABC:tblClients:rec01',
      operand: {
        id: 'rec01',
        fields: { Name: 'Alice' },
        _airtable: { type: 'record', base_id: 'appABC', table_id: 'tblClients' },
      },
      agent: '@alice:example.com',
      ts: '2026-04-11T10:00:00.000Z',
      acquired_ts: '2026-04-11T10:00:00.000Z',
      client_event_id: 'at-rec-ins:appABC:tblClients:rec01',
    } as EoEvent,
    {
      seq: 3,
      op: 'DEF',
      target: 'at.rec.appABC:tblClients:rec01',
      operand: {
        Name: 'Alice',
        _airtable: { type: 'record', base_id: 'appABC', table_id: 'tblClients' },
      },
      agent: '@alice:example.com',
      ts: '2026-04-11T10:00:00.000Z',
      acquired_ts: '2026-04-11T10:00:00.000Z',
      client_event_id: 'at-rec-def:appABC:tblClients:rec01',
    } as EoEvent,
  ];
}

function makeCursors(): AirtableCursorMap {
  return {
    appABC: {
      tblClients: { lastModified: '2026-04-11T10:00:00.000Z' },
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('airtable-snapshot', () => {
  it('round-trips events and cursors through encode/decode', async () => {
    const events = makeEvents();
    const cursors = makeCursors();

    const bytes = await encodeAirtableSnapshot(events, cursors, {
      collectionId: 'airtable-hydration-appABC',
      name: 'Marketing snapshot',
      capturedAt: '2026-04-11T10:05:00.000Z',
    });

    expect(bytes.length).toBeGreaterThan(0);
    // Magic: "EODB"
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe('EODB');

    const decoded = await decodeAirtableSnapshot(bytes);
    expect(decoded.header.collectionId).toBe('airtable-hydration-appABC');
    expect(decoded.header.name).toBe('Marketing snapshot');
    expect(decoded.header.createdAt).toBe('2026-04-11T10:05:00.000Z');
    expect(decoded.events).toHaveLength(events.length);
    expect(decoded.events[0].op).toBe('DEF');
    expect(decoded.events[1].op).toBe('INS');
    expect(decoded.events[2].client_event_id).toBe('at-rec-def:appABC:tblClients:rec01');
    expect(decoded.cursors).toEqual(cursors);
  });

  it('tolerates an empty event list', async () => {
    const bytes = await encodeAirtableSnapshot([], {}, {
      collectionId: 'empty',
      name: 'Empty',
    });
    const decoded = await decodeAirtableSnapshot(bytes);
    expect(decoded.events).toHaveLength(0);
    expect(decoded.cursors).toEqual({});
  });

  it('rejects non-eodb input', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(decodeAirtableSnapshot(garbage)).rejects.toThrow(/not a valid .eodb/);
  });

  it('produces a deterministic per-base filename', () => {
    expect(airtableSnapshotFilename('appABC123')).toBe('airtable-hydration-appABC123.eodb');
    // Sanitises weird chars so the filename is always safe for Drive.
    expect(airtableSnapshotFilename('app/with/slashes')).toBe('airtable-hydration-app_with_slashes.eodb');
  });

  it('seeds per-table cursors when replayed', async () => {
    const store = createTestStore();
    const events = makeEvents();
    const cursors = makeCursors();
    const bytes = await encodeAirtableSnapshot(events, cursors, {
      collectionId: 'airtable-hydration-appABC',
      name: 'Marketing snapshot',
    });
    const decoded = await decodeAirtableSnapshot(bytes);

    // Collect events that processEvent saw, so the test doesn't depend on
    // the full fold graph (which needs seq reservoirs + target resolvers).
    // We still exercise `processEvent` — just don't assert on its side
    // effects beyond cursor seeding, which is the snapshot-specific part.
    const seen: EoEvent[] = [];
    const result = await replayAirtableSnapshot(store, decoded, (ev) => { seen.push(ev); });

    expect(result.eventsReplayed).toBe(events.length);
    expect(result.tablesSeeded).toBe(1);
    expect(result.lastSeq).toBeGreaterThan(0);
    // processEvent may emit supplemental events (e.g. auto-inferred INS
    // before a DEF on an unseen target) — we only assert that every
    // snapshot event made it through the fold by checking the callback
    // saw at least as many events as the snapshot carried.
    expect(seen.length).toBeGreaterThanOrEqual(events.length);

    // Cursor was seeded on the exact key updateSync() will read.
    const seeded = await store.get('meta:at_cursor:appABC:tblClients');
    expect(seeded).toBe('2026-04-11T10:00:00.000Z');
  });

  it('tolerates duplicate INS when the target is already instantiated', async () => {
    // Real-world trigger for "Target already instantiated": a prior
    // hydration / cross-device sync / partial import has already folded
    // some of the snapshot's targets under *different* client_event_ids,
    // so idempotency does not fire, but the target's state row exists.
    // Replaying the snapshot INS on that target used to abort the whole
    // import — now it must be skipped and DEF events on the same target
    // must still land so new content is folded in.
    const store = createTestStore();

    // Pre-seed state for the INS target the snapshot will try to instantiate.
    // This simulates a store that already knows the record from another path.
    await store.put('state:at.rec.appABC:tblClients:rec01', {
      target: 'at.rec.appABC:tblClients:rec01',
      value: { id: 'rec01', fields: { Name: 'Alice (pre-existing)' } },
      level: 1,
      last_seq: 0,
      last_op: 'INS',
      last_agent: '@other:example.com',
      last_ts: '2026-04-10T00:00:00.000Z',
      last_acquired_ts: '2026-04-10T00:00:00.000Z',
    });

    const bytes = await encodeAirtableSnapshot(makeEvents(), makeCursors(), {
      collectionId: 'airtable-hydration-appABC',
      name: 'Re-import',
    });
    const decoded = await decodeAirtableSnapshot(bytes);

    // Replay must succeed instead of throwing. The duplicate INS is skipped
    // and counted; surrounding DEF events still fold through processEvent.
    const result = await replayAirtableSnapshot(store, decoded);
    expect(result.eventsReplayed).toBe(decoded.events.length);
    // At least the explicit INS (event 2) is skipped; helix-promoted
    // synthetic INS from subsequent DEFs on the same target may also be
    // counted here, so assert >= 1 rather than an exact count.
    expect(result.insSkippedExisting).toBeGreaterThanOrEqual(1);
    expect(result.tablesSeeded).toBe(1);
  });
});
