/**
 * xxHash64 — small pure-TypeScript implementation.
 *
 * Used by log-opfs.ts to compute 64-bit site identifiers for the index file.
 * Deliberately written as a single 100ish-line module so the project doesn't
 * pull in a runtime dep for ~80 lines of well-known hash code.
 *
 * Reference: https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md
 *
 * Uses BigInt for the 64-bit lanes. BigInt is about 5–10× slower than
 * typed-array math, but at the call rate the log path needs (one hash per
 * appended event) the wall-clock cost is dominated by msgpack encoding and
 * OPFS syscalls, not the hash itself. If profiling later shows xxHash on the
 * hot path, swap to a Uint32Array two-lane implementation; the API on this
 * module won't change.
 */

const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;
const MASK64 = 0xffffffffffffffffn;

function rotl64(x: bigint, r: number): bigint {
  return ((x << BigInt(r)) | (x >> BigInt(64 - r))) & MASK64;
}

function round(acc: bigint, input: bigint): bigint {
  acc = (acc + ((input * PRIME64_2) & MASK64)) & MASK64;
  acc = rotl64(acc, 31);
  acc = (acc * PRIME64_1) & MASK64;
  return acc;
}

function mergeRound(acc: bigint, val: bigint): bigint {
  val = round(0n, val);
  acc = (acc ^ val) & MASK64;
  acc = ((acc * PRIME64_1) & MASK64) + PRIME64_4;
  return acc & MASK64;
}

function readU64LE(view: DataView, offset: number): bigint {
  // DataView.getBigUint64 exists in modern runtimes (Node 12+, all browsers).
  return view.getBigUint64(offset, true);
}

function readU32LE(view: DataView, offset: number): bigint {
  return BigInt(view.getUint32(offset, true));
}

/**
 * Compute the xxHash64 of `data` with the given seed.
 *
 * The `data` parameter may be a Uint8Array or a string. Strings are encoded
 * as UTF-8 before hashing — call sites that hash site identifiers can pass
 * the string directly without separately TextEncoder'ing.
 */
export function xxhash64(data: Uint8Array | string, seed: bigint = 0n): bigint {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data;
  const len = bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  let h64: bigint;

  if (len >= 32) {
    let v1 = (seed + PRIME64_1 + PRIME64_2) & MASK64;
    let v2 = (seed + PRIME64_2) & MASK64;
    let v3 = seed & MASK64;
    let v4 = (seed - PRIME64_1) & MASK64;

    while (p + 32 <= len) {
      v1 = round(v1, readU64LE(view, p));      p += 8;
      v2 = round(v2, readU64LE(view, p));      p += 8;
      v3 = round(v3, readU64LE(view, p));      p += 8;
      v4 = round(v4, readU64LE(view, p));      p += 8;
    }

    h64 = (rotl64(v1, 1) + rotl64(v2, 7) + rotl64(v3, 12) + rotl64(v4, 18)) & MASK64;
    h64 = mergeRound(h64, v1);
    h64 = mergeRound(h64, v2);
    h64 = mergeRound(h64, v3);
    h64 = mergeRound(h64, v4);
  } else {
    h64 = (seed + PRIME64_5) & MASK64;
  }

  h64 = (h64 + BigInt(len)) & MASK64;

  while (p + 8 <= len) {
    const k1 = round(0n, readU64LE(view, p));
    h64 = (h64 ^ k1) & MASK64;
    h64 = (rotl64(h64, 27) * PRIME64_1 + PRIME64_4) & MASK64;
    p += 8;
  }

  if (p + 4 <= len) {
    h64 = (h64 ^ ((readU32LE(view, p) * PRIME64_1) & MASK64)) & MASK64;
    h64 = (rotl64(h64, 23) * PRIME64_2 + PRIME64_3) & MASK64;
    p += 4;
  }

  while (p < len) {
    h64 = (h64 ^ ((BigInt(bytes[p]) * PRIME64_5) & MASK64)) & MASK64;
    h64 = (rotl64(h64, 11) * PRIME64_1) & MASK64;
    p += 1;
  }

  // Final avalanche
  h64 = (h64 ^ (h64 >> 33n)) & MASK64;
  h64 = (h64 * PRIME64_2) & MASK64;
  h64 = (h64 ^ (h64 >> 29n)) & MASK64;
  h64 = (h64 * PRIME64_3) & MASK64;
  h64 = (h64 ^ (h64 >> 32n)) & MASK64;

  return h64;
}

/**
 * Write the 64-bit xxHash of `input` into a destination Uint8Array as 8
 * big-endian bytes. Used by log-opfs.ts to populate the site-hash field of
 * the 40-byte index record without allocating intermediate buffers.
 */
export function writeXxhash64BE(
  input: string,
  dest: Uint8Array,
  offset: number,
  seed: bigint = 0n,
): void {
  let h = xxhash64(input, seed);
  for (let i = 7; i >= 0; i--) {
    dest[offset + i] = Number(h & 0xffn);
    h >>= 8n;
  }
}
