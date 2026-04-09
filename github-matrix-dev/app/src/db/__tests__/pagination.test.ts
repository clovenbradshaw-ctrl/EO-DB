/**
 * Tests for cursor-paginated iterator + getStateByPrefixPage.
 *
 * Uses the in-memory MemoryStore to exercise the iterator cursor path
 * (afterKey semantics, limit cut-off) now that the IDB layer has been removed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryStore } from '../memory-store';
import { getStateByPrefix, getStateByPrefixPage } from '../state';
import type { EoState } from '../types';

function makeState(target: string): EoState {
  return {
    target,
    value: { name: target },
    hash: 'h',
    level: 1,
    last_seq: 1,
    last_op: 'INS',
    last_ts: '2025-01-01T00:00:00Z',
  } as EoState;
}

describe('MemoryStore iterator pagination', () => {
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(async () => {
    store = createMemoryStore();
    for (let i = 0; i < 10; i++) {
      const key = `state:app.t.rec${String(i).padStart(3, '0')}`;
      await store.put(key, `v${i}`);
    }
    // One out-of-prefix key to confirm the range bound still holds.
    await store.put('state:other.x', 'x');
  });

  it('returns all entries when no opts passed (back-compat)', async () => {
    const rows = await store.iterator('state:app.t.');
    expect(rows).toHaveLength(10);
    expect(rows[0][0]).toBe('state:app.t.rec000');
    expect(rows[9][0]).toBe('state:app.t.rec009');
  });

  it('respects limit', async () => {
    const rows = await store.iterator('state:app.t.', { limit: 3 });
    expect(rows).toHaveLength(3);
    expect(rows[0][0]).toBe('state:app.t.rec000');
    expect(rows[2][0]).toBe('state:app.t.rec002');
  });

  it('afterKey is exclusive — continues from the next key', async () => {
    const first = await store.iterator('state:app.t.', { limit: 3 });
    const last = first[first.length - 1][0];
    const second = await store.iterator('state:app.t.', { limit: 3, afterKey: last });
    expect(second).toHaveLength(3);
    expect(second[0][0]).toBe('state:app.t.rec003');
    expect(second[2][0]).toBe('state:app.t.rec005');
  });

  it('full walk via repeated pages produces every entry exactly once', async () => {
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await store.iterator('state:app.t.', { limit: 4, afterKey: after });
      if (page.length === 0) break;
      for (const [k] of page) seen.push(k);
      if (page.length < 4) break;
      after = page[page.length - 1][0];
    }
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
  });

  it('does not leak entries from outside the prefix', async () => {
    const rows = await store.iterator('state:app.t.', { limit: 100 });
    expect(rows.every(([k]) => k.startsWith('state:app.t.'))).toBe(true);
  });
});

describe('getStateByPrefixPage', () => {
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(async () => {
    store = createMemoryStore();
    for (let i = 0; i < 7; i++) {
      await store.put(`state:app.t.rec${String(i).padStart(3, '0')}`, makeState(`app.t.rec${String(i).padStart(3, '0')}`));
    }
  });

  it('returns a page plus a nextCursor when more rows remain', async () => {
    const { rows, nextCursor } = await getStateByPrefixPage(store, 'app.t.', 3);
    expect(rows).toHaveLength(3);
    expect(rows[0].target).toBe('app.t.rec000');
    expect(nextCursor).toBe('app.t.rec002');
  });

  it('returns nextCursor=null on the final (short) page', async () => {
    const { rows: p1, nextCursor: c1 } = await getStateByPrefixPage(store, 'app.t.', 5);
    expect(c1).toBe('app.t.rec004');
    const { rows: p2, nextCursor: c2 } = await getStateByPrefixPage(store, 'app.t.', 5, c1!);
    expect(p2).toHaveLength(2);
    expect(p2[0].target).toBe('app.t.rec005');
    expect(c2).toBeNull();
    expect([...p1, ...p2].map((r) => r.target)).toEqual([
      'app.t.rec000', 'app.t.rec001', 'app.t.rec002', 'app.t.rec003', 'app.t.rec004',
      'app.t.rec005', 'app.t.rec006',
    ]);
  });

  it('unbounded getStateByPrefix still returns the full set', async () => {
    const all = await getStateByPrefix(store, 'app.t.');
    expect(all).toHaveLength(7);
  });
});
