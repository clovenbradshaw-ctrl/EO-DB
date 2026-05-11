/**
 * kv-snapshot wire shape — V9 of HELIX-AUDIT-2026-05-11.md.
 *
 * The v2 envelope now carries an optional `hydratedHead` so the boot
 * path can restore the block-chain cursor atomically with the kv map
 * (no more split persistence between localStorage and OPFS). These
 * tests pin the msgpack round-trip:
 *
 *   1. A snapshot with hydratedHead round-trips intact.
 *   2. An older snapshot without the field still decodes — backwards-
 *      compatible read path.
 *   3. `hydratedHead: null` is distinct from `undefined`/missing —
 *      "we explicitly know the chain is at genesis" vs "we don't know".
 *
 * The OPFS write side is exercised in fold.worker.ts; here we only
 * pin the in-memory serialization that ships through it.
 */

import { describe, it, expect } from 'vitest';
import { pack, unpack } from 'msgpackr';

interface KvSnapshotEnvelope {
  version: number;
  seq: number;
  entries: [string, unknown][];
  recentTail: unknown[];
  hydratedHead?: string | null;
}

describe('kv-snapshot v2 shape (V9 hydratedHead)', () => {
  it('round-trips with a non-null hydratedHead', () => {
    const original: KvSnapshotEnvelope = {
      version: 2,
      seq: 123,
      entries: [['state:a', { v: 1 }]],
      recentTail: [],
      hydratedHead: '$block:abc',
    };
    const buf = pack(original) as Uint8Array;
    const decoded = unpack(buf) as KvSnapshotEnvelope;
    expect(decoded.version).toBe(2);
    expect(decoded.seq).toBe(123);
    expect(decoded.hydratedHead).toBe('$block:abc');
    expect(decoded.entries).toEqual([['state:a', { v: 1 }]]);
  });

  it('round-trips with hydratedHead: null (explicit empty chain)', () => {
    const original: KvSnapshotEnvelope = {
      version: 2,
      seq: 7,
      entries: [],
      recentTail: [],
      hydratedHead: null,
    };
    const buf = pack(original) as Uint8Array;
    const decoded = unpack(buf) as KvSnapshotEnvelope;
    expect(decoded.hydratedHead).toBeNull();
  });

  it('decodes an older v2 snapshot without hydratedHead — backwards-compat', () => {
    // Snapshot written by pre-V9 code.
    const olderShape = {
      version: 2,
      seq: 42,
      entries: [['state:b', { v: 2 }]] as [string, unknown][],
      recentTail: [] as unknown[],
    };
    const buf = pack(olderShape) as Uint8Array;
    const decoded = unpack(buf) as KvSnapshotEnvelope;
    expect(decoded.version).toBe(2);
    expect(decoded.seq).toBe(42);
    // Field is absent — callers normalize with `?? null` so the read
    // path returns null rather than undefined.
    expect((decoded.hydratedHead ?? null)).toBeNull();
  });
});
