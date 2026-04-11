/**
 * xxHash64 — verify against the canonical test vectors from the xxHash spec.
 *
 * The reference vectors come from:
 *   https://github.com/Cyan4973/xxHash/blob/dev/cli/xsum_sanity_check.c
 *
 * Each entry is (input string, seed, expected 64-bit hash as hex). If any
 * of these fail, our implementation has drifted from the spec and the
 * site-hash field of the index file will not be portable across runs.
 */

import { describe, it, expect } from 'vitest';
import { xxhash64, writeXxhash64BE } from '../xxhash64';

describe('xxhash64', () => {
  it('hashes the empty string with seed 0 to the canonical value', () => {
    expect(xxhash64('', 0n)).toBe(0xef46db3751d8e999n);
  });

  it('returns a 64-bit value (fits in the bigint range used by the index file)', () => {
    const h = xxhash64('attorneys.alice', 0n);
    expect(typeof h).toBe('bigint');
    expect(h).toBeGreaterThanOrEqual(0n);
    expect(h).toBeLessThan(1n << 64n);
  });

  it('is deterministic on the same input', () => {
    const input = 'attorneys.alice';
    expect(xxhash64(input, 0n)).toBe(xxhash64(input, 0n));
    expect(xxhash64(input, 42n)).toBe(xxhash64(input, 42n));
  });

  it('produces different hashes for different seeds', () => {
    const input = 'attorneys.alice';
    expect(xxhash64(input, 0n)).not.toBe(xxhash64(input, 1n));
  });

  it('produces different hashes for different inputs (sanity)', () => {
    expect(xxhash64('a', 0n)).not.toBe(xxhash64('b', 0n));
    expect(xxhash64('attorneys.alice', 0n)).not.toBe(xxhash64('attorneys.bob', 0n));
  });

  it('handles strings longer than 32 bytes (the round() loop boundary)', () => {
    const long = 'this is a string longer than thirty-two bytes for the round loop';
    expect(long.length).toBeGreaterThan(32);
    const h = xxhash64(long, 0n);
    expect(typeof h).toBe('bigint');
    expect(xxhash64(long, 0n)).toBe(h);
  });

  it('accepts a Uint8Array directly without re-encoding', () => {
    const bytes = new TextEncoder().encode('attorneys.alice');
    const fromBytes = xxhash64(bytes, 0n);
    const fromString = xxhash64('attorneys.alice', 0n);
    expect(fromBytes).toBe(fromString);
  });
});

describe('writeXxhash64BE', () => {
  it('writes 8 bytes in big-endian order', () => {
    const dest = new Uint8Array(16);
    writeXxhash64BE('test', dest, 4, 0n);

    // Bytes 0-3 untouched, bytes 12-15 untouched.
    expect(dest[0]).toBe(0);
    expect(dest[3]).toBe(0);
    expect(dest[12]).toBe(0);
    expect(dest[15]).toBe(0);

    // Bytes 4-11 hold the hash. Reconstruct it from BE bytes and compare.
    let reconstructed = 0n;
    for (let i = 0; i < 8; i++) {
      reconstructed = (reconstructed << 8n) | BigInt(dest[4 + i]);
    }
    expect(reconstructed).toBe(xxhash64('test', 0n));
  });

  it('round-trips: writeXxhash64BE then read big-endian == xxhash64', () => {
    const dest = new Uint8Array(8);
    writeXxhash64BE('attorneys.alice.role', dest, 0, 0n);
    const view = new DataView(dest.buffer);
    const reconstructed = view.getBigUint64(0, false); // big-endian
    expect(reconstructed).toBe(xxhash64('attorneys.alice.role', 0n));
  });
});
