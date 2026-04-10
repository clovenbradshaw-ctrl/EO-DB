import { ClassicLevel } from 'classic-level';
import { pack, unpack } from 'msgpackr';

export type EoDb = ClassicLevel<string, Buffer>;

export function createDb(path: string): EoDb {
  return new ClassicLevel<string, Buffer>(path, {
    keyEncoding: 'utf8',
    valueEncoding: 'buffer',
    blockSize: 16 * 1024,           // 16 KB blocks — better fit for msgpack values
    cacheSize: 64 * 1024 * 1024,   // 64 MB read block cache
    writeBufferSize: 32 * 1024 * 1024, // 32 MB write buffer before compaction
  });
}

export function padSeq(seq: number): string {
  return String(seq).padStart(12, '0');
}

export async function nextSeq(db: EoDb): Promise<number> {
  let current = 0;
  try {
    const buf = await db.get('meta:seq');
    current = unpack(buf) as number;
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
  const next = current + 1;
  await db.put('meta:seq', pack(next));
  return next;
}

/**
 * Allocate a contiguous range of sequence numbers in one DB write.
 * Returns the first seq in the range. The range is [startSeq, startSeq + count - 1].
 */
export async function allocateSeqRange(db: EoDb, count: number): Promise<number> {
  if (count <= 0) throw new Error('allocateSeqRange: count must be > 0');
  let current = 0;
  try {
    const buf = await db.get('meta:seq');
    current = unpack(buf) as number;
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
  const startSeq = current + 1;
  await db.put('meta:seq', pack(current + count));
  return startSeq;
}

export async function getCurrentSeq(db: EoDb): Promise<number> {
  try {
    const buf = await db.get('meta:seq');
    return unpack(buf) as number;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return 0;
    throw e;
  }
}

export function encode(value: any): Buffer {
  return pack(value);
}

export function decode(buf: Buffer): any {
  return unpack(buf);
}
