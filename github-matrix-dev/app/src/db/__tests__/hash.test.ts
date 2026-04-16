/**
 * Piece hash + verification tests.
 *
 * The sync layer depends on `pieceHash` being a pure, structure-dependent
 * function: two devices building the same piece from the same events must
 * produce byte-identical hashes regardless of key-insertion order or
 * msgpackr internal state.
 */

import { describe, it, expect } from 'vitest';
import { pieceHash, verifyPieceBytes, canonicalize, canonicalMsgpack } from '../hash';

// ─── Same structure, different key order → same hash ────────────────────

describe('pieceHash — canonicalization', () => {
  it('identical events in different key orders hash the same', async () => {
    const a = [
      { seq: 1, op: 'INS', target: 't', operand: { x: 1, y: 2 } },
      { seq: 2, op: 'CON', target: 't', operand: { added: ['a', 'b'] } },
    ];
    const b = [
      { operand: { y: 2, x: 1 }, target: 't', op: 'INS', seq: 1 },
      { operand: { added: ['a', 'b'] }, target: 't', op: 'CON', seq: 2 },
    ];
    const ha = await pieceHash(a);
    const hb = await pieceHash(b);
    expect(ha).toBe(hb);
  });

  it('deeply nested object keys are sorted', async () => {
    const a = [{ op: 'INS', operand: { nested: { z: 1, a: 2, m: { b: 1, a: 2 } } } }];
    const b = [{ operand: { nested: { m: { a: 2, b: 1 }, a: 2, z: 1 } }, op: 'INS' }];
    expect(await pieceHash(a)).toBe(await pieceHash(b));
  });

  it('canonicalize drops undefined keys (no effect on hash)', async () => {
    const a = [{ op: 'INS', x: 1, y: undefined }];
    const b = [{ op: 'INS', x: 1 }];
    expect(await pieceHash(a)).toBe(await pieceHash(b));
  });

  it('null is preserved (distinct from undefined)', async () => {
    const a = [{ op: 'INS', x: null }];
    const b = [{ op: 'INS' }]; // missing x entirely
    expect(await pieceHash(a)).not.toBe(await pieceHash(b));
  });

  it('Uint8Array values are preserved', async () => {
    const a = [{ bytes: new Uint8Array([1, 2, 3]) }];
    const b = [{ bytes: new Uint8Array([1, 2, 3]) }];
    const c = [{ bytes: new Uint8Array([1, 2, 4]) }];
    expect(await pieceHash(a)).toBe(await pieceHash(b));
    expect(await pieceHash(a)).not.toBe(await pieceHash(c));
  });
});

// ─── Different events → different hash ──────────────────────────────────

describe('pieceHash — sensitivity', () => {
  it('distinct operand value → different hash', async () => {
    const a = [{ seq: 1, op: 'INS', operand: { x: 1 } }];
    const b = [{ seq: 1, op: 'INS', operand: { x: 2 } }];
    expect(await pieceHash(a)).not.toBe(await pieceHash(b));
  });

  it('distinct op → different hash', async () => {
    const a = [{ seq: 1, op: 'INS', operand: {} }];
    const b = [{ seq: 1, op: 'CON', operand: {} }];
    expect(await pieceHash(a)).not.toBe(await pieceHash(b));
  });

  it('event order matters (not commutative)', async () => {
    const e1 = { seq: 1, op: 'INS', target: 't' };
    const e2 = { seq: 2, op: 'CON', target: 't' };
    expect(await pieceHash([e1, e2])).not.toBe(await pieceHash([e2, e1]));
  });

  it('extra key → different hash', async () => {
    const a = [{ op: 'INS', x: 1 }];
    const b = [{ op: 'INS', x: 1, y: 1 }];
    expect(await pieceHash(a)).not.toBe(await pieceHash(b));
  });

  it('empty piece is still hashable and deterministic', async () => {
    const h1 = await pieceHash([]);
    const h2 = await pieceHash([]);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── Verification ───────────────────────────────────────────────────────

describe('verifyPieceBytes', () => {
  it('accepts matching hash', async () => {
    const events = [{ seq: 1, op: 'INS', target: 't', operand: { x: 1 } }];
    const h = await pieceHash(events);
    expect(await verifyPieceBytes(events, h)).toBe(true);
  });

  it('rejects modified events', async () => {
    const original = [{ seq: 1, op: 'INS', target: 't', operand: { x: 1 } }];
    const tampered = [{ seq: 1, op: 'INS', target: 't', operand: { x: 2 } }];
    const h = await pieceHash(original);
    expect(await verifyPieceBytes(tampered, h)).toBe(false);
  });

  it('rejects truncated piece', async () => {
    const full = [
      { seq: 1, op: 'INS', target: 't', operand: {} },
      { seq: 2, op: 'CON', target: 't', operand: {} },
    ];
    const h = await pieceHash(full);
    expect(await verifyPieceBytes(full.slice(0, 1), h)).toBe(false);
  });

  it('rejects wrong-length hash', async () => {
    const events = [{ seq: 1, op: 'INS' }];
    expect(await verifyPieceBytes(events, 'deadbeef')).toBe(false);
  });
});

// ─── Cross-device reproducibility (msgpackr state independence) ─────────

describe('canonical msgpack — reproducibility', () => {
  it('multiple calls on the same value yield identical bytes', () => {
    const v = { op: 'INS', target: 't', operand: { x: 1, y: 2 } };
    const b1 = canonicalMsgpack(v);
    const b2 = canonicalMsgpack(v);
    const b3 = canonicalMsgpack(v);
    expect(Array.from(b1)).toEqual(Array.from(b2));
    expect(Array.from(b2)).toEqual(Array.from(b3));
  });

  it('repeated calls across structurally different inputs do not leak state', () => {
    // msgpackr's record extension caches structures; with useRecords: false,
    // this must not happen. Encode a varied stream and confirm idempotence.
    const variants = [
      { a: 1 },
      { b: 2 },
      { a: 1, b: 2 },
      { a: 1 }, // same as variants[0] — must produce identical bytes
    ];
    const first = variants.map((v) => Array.from(canonicalMsgpack(v)));
    const second = variants.map((v) => Array.from(canonicalMsgpack(v)));
    expect(second).toEqual(first);
    // variants[0] and variants[3] are equal structurally.
    expect(first[0]).toEqual(first[3]);
  });

  it('canonicalize is deterministic', () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
    expect(canonicalize(a)).toEqual({ a: 2, b: 1, c: { x: 2, y: 1 } });
  });
});
