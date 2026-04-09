/**
 * .eodb binary file format — shared between Filen sync, Filen sharing,
 * and any transport that serializes EO event batches.
 *
 * Format: [4-byte magic "EODB"][msgpack body]
 */

import { pack, unpack } from 'msgpackr';
import type { EoEvent } from '../db/types';

/** Magic bytes at the start of every .eodb file: "EODB" in ASCII. */
const EODB_MAGIC = new Uint8Array([0x45, 0x4F, 0x44, 0x42]);

export interface EodbFile {
  version: 1;
  type: 'current' | 'snapshot' | 'backup';
  space_id: string;
  space_name: string;
  from_seq: number;
  to_seq: number;
  created_by: string;
  created_at: string;
  events: EoEvent[];
  prev_snapshots: string[];   // UUIDs of previous snapshot files (up to 10)
}

/** Pack an EodbFile into binary with magic header. */
export function packEodb(file: EodbFile): Uint8Array {
  const body = pack(file);
  const result = new Uint8Array(EODB_MAGIC.length + body.byteLength);
  result.set(EODB_MAGIC, 0);
  result.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), EODB_MAGIC.length);
  return result;
}

/** Unpack binary back to an EodbFile, validating magic header. */
export function unpackEodb(data: Uint8Array): EodbFile {
  for (let i = 0; i < EODB_MAGIC.length; i++) {
    if (data[i] !== EODB_MAGIC[i]) {
      throw new Error('Not a valid .eodb file (bad magic bytes)');
    }
  }
  return unpack(data.slice(EODB_MAGIC.length)) as EodbFile;
}

/** Check if a Uint8Array starts with the EODB magic bytes. */
export function isEodbFile(data: Uint8Array): boolean {
  if (data.length < EODB_MAGIC.length) return false;
  for (let i = 0; i < EODB_MAGIC.length; i++) {
    if (data[i] !== EODB_MAGIC[i]) return false;
  }
  return true;
}
