/**
 * .eodb v2 streaming binary format — frame-based, forward-compatible.
 *
 * Layout:
 *   ┌ Magic "EODB" (4) + version (uint16) + flags (uint16)  ── 8 bytes
 *   ├ Collection header (msgpack)                            ── variable
 *   ├ Frame: Prototype Table (0x04)                          ── variable
 *   ├ Frame: Diff Chunk 0..N (0x01)                          ── variable
 *   ├ Frame: Graph Snapshot (0x08)                           ── variable
 *   ├ Frame: Body Block 0..M (0x02)                          ── variable
 *   ├ Frame: Log Segment 0..K (0x03)                         ── variable
 *   └ Trailer (0xFE) + EOF (0xFF)                            ── variable
 *
 * Frame envelope: type(1) + flags(1) + length(4) + payload(length)
 * Unknown frame types are skipped by length (forward compatible).
 */

import { pack, unpack } from 'msgpackr';
import type { EoEvent } from './types';
import type { DiffChunk, PrototypeRegistry } from './card-encoder';

// ─── Constants ──────────────────────────────────────────────────────────

const EODB_MAGIC = new Uint8Array([0x45, 0x4F, 0x44, 0x42]); // "EODB"
const EODB_VERSION = 2;
const FRAME_HEADER_SIZE = 6; // type(1) + flags(1) + length(4)

export const FRAME_TYPES = {
  DIFF_CHUNK:       0x01,
  BODY_BLOCK:       0x02,
  LOG_SEGMENT:      0x03,
  PROTO_UPDATE:     0x04,
  INTERP_SNAPSHOT:  0x05,
  PROTO_SPLIT:      0x06,
  PROTO_MERGE:      0x07,
  GRAPH_SNAPSHOT:   0x08,
  TRAILER:          0xFE,
  EOF:              0xFF,
} as const;

export type FrameType = typeof FRAME_TYPES[keyof typeof FRAME_TYPES];

// ─── Types ──────────────────────────────────────────────────────────────

export interface CollectionHeader {
  collectionId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  encodedThrough: number;
  fileVersion: number;
  encryptionParams?: { algorithm: string; keyId: string };
  /**
   * Optional Airtable cursor state embedded in the snapshot. Present on
   * `.eodb` files produced by {@link ../ingestion/airtable-snapshot}; consumers
   * that don't care about Airtable MUST ignore this field (msgpack round-trip
   * preserves it but unknown header fields are already ignored by the reader).
   *
   * Shape: `{ [baseId]: { [tableId]: { lastModified?: string, webhookCursor?: number } } }`.
   * Bootstrapping a fresh device seeds its `meta:at_cursor:*` keys from this
   * map so the first live `updateSync()` picks up only post-snapshot deltas
   * instead of re-scanning the whole base.
   */
  airtable_cursor?: Record<string, Record<string, { lastModified?: string; webhookCursor?: number }>>;
  /**
   * Block-chain metadata for `.eodb` payloads sealed as Matrix blocks.
   * Absent on standalone snapshots / pre-block files; reader treats absence
   * as "not a block" (index 0 with null prior is genesis).
   */
  blockIndex?: number;
  priorBlockEventId?: string | null;
  /** Schema version under which the block was sealed (for hydration dispatch). */
  schemaVersion?: string;
}

export interface FrameHeader {
  type: number;
  flags: number;
  length: number;
}

export interface EodbTrailer {
  /** frame type → list of byte offsets where each frame of that type starts. */
  frameOffsets: Record<number, number[]>;
  /** FNV-1a hash of all bytes before the trailer frame. */
  checksum: number;
  totalBytes: number;
}

// ─── FNV-1a (32-bit) for checksum ──────────────────────────────────────
// Reuse the same algorithm as card-encoder for consistency.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1aBytes(data: Uint8Array, seed: number = FNV_OFFSET): number {
  let h = seed;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

// ─── EodbWriter ─────────────────────────────────────────────────────────

/**
 * Streaming .eodb writer. Accepts a WritableStream sink and writes frames
 * sequentially. Call finalize() to write the trailer and EOF.
 *
 * For in-memory use (tests, small files), pass a BufferSink.
 */
export class EodbWriter {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private bytesWritten: number = 0;
  private checksum: number = FNV_OFFSET;
  private frameOffsets: Record<number, number[]> = {};
  private finalized = false;

  constructor(sink: WritableStreamDefaultWriter<Uint8Array>) {
    this.writer = sink;
  }

  private async write(data: Uint8Array): Promise<void> {
    this.checksum = fnv1aBytes(data, this.checksum);
    this.bytesWritten += data.length;
    await this.writer.write(data);
  }

  private recordFrame(type: number): void {
    if (!this.frameOffsets[type]) this.frameOffsets[type] = [];
    this.frameOffsets[type].push(this.bytesWritten);
  }

  private async writeFrame(type: number, flags: number, payload: Uint8Array): Promise<void> {
    this.recordFrame(type);
    const header = new Uint8Array(FRAME_HEADER_SIZE);
    const dv = new DataView(header.buffer);
    header[0] = type;
    header[1] = flags;
    dv.setUint32(2, payload.length, true);
    await this.write(header);
    await this.write(payload);
  }

  /** Write the file header: magic + version + flags + msgpack(collectionHeader). */
  async writeHeader(header: CollectionHeader): Promise<void> {
    const fileHeader = new Uint8Array(8);
    fileHeader.set(EODB_MAGIC, 0);
    const dv = new DataView(fileHeader.buffer);
    dv.setUint16(4, EODB_VERSION, true);
    dv.setUint16(6, 0, true); // flags reserved
    await this.write(fileHeader);

    const headerPayload = pack(header);
    const headerBytes = new Uint8Array(headerPayload.buffer, headerPayload.byteOffset, headerPayload.byteLength);
    // Write header length + header data (not framed — it's the file preamble)
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setUint32(0, headerBytes.length, true);
    await this.write(lenBuf);
    await this.write(headerBytes);
  }

  /** Write prototype table as a PROTO_UPDATE frame. */
  async writePrototypeTable(registry: PrototypeRegistry): Promise<void> {
    const data = serializeRegistryForEodb(registry);
    const payload = pack(data);
    await this.writeFrame(
      FRAME_TYPES.PROTO_UPDATE,
      0,
      new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
    );
  }

  /** Write a diff chunk as a DIFF_CHUNK frame. */
  async writeDiffChunk(chunk: DiffChunk): Promise<void> {
    const payload = pack(chunkToSerializable(chunk));
    await this.writeFrame(
      FRAME_TYPES.DIFF_CHUNK,
      0,
      new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
    );
  }

  /** Write CSR graph as a GRAPH_SNAPSHOT frame. */
  async writeGraphSnapshot(serializedCSR: Uint8Array): Promise<void> {
    await this.writeFrame(FRAME_TYPES.GRAPH_SNAPSHOT, 0, serializedCSR);
  }

  /** Write an encrypted full entity state as a BODY_BLOCK frame. */
  async writeBodyBlock(targetHash: number, encryptedState: Uint8Array): Promise<void> {
    // Prefix with targetHash (4 bytes)
    const payload = new Uint8Array(4 + encryptedState.length);
    new DataView(payload.buffer).setUint32(0, targetHash, true);
    payload.set(encryptedState, 4);
    await this.writeFrame(FRAME_TYPES.BODY_BLOCK, 0x01, payload); // flag 0x01 = encrypted
  }

  /** Write a batch of events as a LOG_SEGMENT frame. */
  async writeLogSegment(events: EoEvent[]): Promise<void> {
    const payload = pack(events);
    await this.writeFrame(
      FRAME_TYPES.LOG_SEGMENT,
      0,
      new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
    );
  }

  /** Write trailer + EOF and close. Must be called exactly once. */
  async finalize(): Promise<void> {
    if (this.finalized) throw new Error('EodbWriter already finalized');
    this.finalized = true;

    const trailerData: EodbTrailer = {
      frameOffsets: this.frameOffsets,
      checksum: this.checksum,
      totalBytes: this.bytesWritten,
    };
    const trailerPayload = pack(trailerData);
    // Trailer frame (checksum covers everything before it)
    await this.writeFrame(
      FRAME_TYPES.TRAILER,
      0,
      new Uint8Array(trailerPayload.buffer, trailerPayload.byteOffset, trailerPayload.byteLength),
    );

    // EOF frame (empty payload)
    await this.writeFrame(FRAME_TYPES.EOF, 0, new Uint8Array(0));

    await this.writer.close();
  }
}

// ─── EodbStreamReader ───────────────────────────────────────────────────

/**
 * Streaming .eodb reader. Wraps a ReadableStream and provides typed
 * frame-by-frame access. Unknown frame types are skipped.
 */
export class EodbStreamReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array(0);
  private done = false;

  constructor(source: ReadableStream<Uint8Array>) {
    this.reader = source.getReader();
  }

  /** Ensure at least `needed` bytes are in the buffer. */
  private async fill(needed: number): Promise<void> {
    while (this.buffer.length < needed && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) { this.done = true; break; }
      const merged = new Uint8Array(this.buffer.length + value.length);
      merged.set(this.buffer, 0);
      merged.set(value, this.buffer.length);
      this.buffer = merged;
    }
  }

  /** Consume `n` bytes from the front of the buffer. */
  private consume(n: number): Uint8Array {
    const chunk = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return chunk;
  }

  /** Read and validate the file header. Returns the CollectionHeader. */
  async readHeader(): Promise<CollectionHeader> {
    // Magic (4) + version (2) + flags (2) = 8 bytes
    await this.fill(8);
    const header = this.consume(8);
    for (let i = 0; i < 4; i++) {
      if (header[i] !== EODB_MAGIC[i]) {
        throw new Error('Not a valid .eodb v2 file (bad magic bytes)');
      }
    }
    const dv = new DataView(header.buffer, header.byteOffset);
    const version = dv.getUint16(4, true);
    if (version < 2) {
      throw new Error(`Unsupported .eodb version ${version} (expected ≥2)`);
    }

    // Header length (4 bytes) + header payload
    await this.fill(4);
    const lenBuf = this.consume(4);
    const headerLen = new DataView(lenBuf.buffer, lenBuf.byteOffset).getUint32(0, true);
    await this.fill(headerLen);
    const headerPayload = this.consume(headerLen);
    return unpack(headerPayload) as CollectionHeader;
  }

  /** Read the next frame header without consuming the payload. */
  async peekFrameType(): Promise<number | null> {
    await this.fill(1);
    if (this.buffer.length === 0) return null;
    return this.buffer[0];
  }

  /** Read a full frame header. */
  private async readFrameHeader(): Promise<FrameHeader> {
    await this.fill(FRAME_HEADER_SIZE);
    const raw = this.consume(FRAME_HEADER_SIZE);
    const dv = new DataView(raw.buffer, raw.byteOffset);
    return {
      type: raw[0],
      flags: raw[1],
      length: dv.getUint32(2, true),
    };
  }

  /** Read raw payload of a frame given its header. */
  private async readPayload(length: number): Promise<Uint8Array> {
    await this.fill(length);
    return this.consume(length);
  }

  /** Read a prototype table from a PROTO_UPDATE frame. */
  async readPrototypeTable(): Promise<PrototypeRegistry> {
    const fh = await this.readFrameHeader();
    if (fh.type !== FRAME_TYPES.PROTO_UPDATE) {
      throw new Error(`Expected PROTO_UPDATE frame (0x04), got 0x${fh.type.toString(16)}`);
    }
    const payload = await this.readPayload(fh.length);
    const data = unpack(payload);
    return deserializeRegistryFromEodb(data);
  }

  /** Read a DIFF_CHUNK frame. */
  async readDiffChunk(): Promise<DiffChunk> {
    const fh = await this.readFrameHeader();
    if (fh.type !== FRAME_TYPES.DIFF_CHUNK) {
      throw new Error(`Expected DIFF_CHUNK frame (0x01), got 0x${fh.type.toString(16)}`);
    }
    const payload = await this.readPayload(fh.length);
    return chunkFromSerializable(unpack(payload));
  }

  /** Read a GRAPH_SNAPSHOT frame. Returns raw CSR bytes. */
  async readGraphSnapshot(): Promise<Uint8Array> {
    const fh = await this.readFrameHeader();
    if (fh.type !== FRAME_TYPES.GRAPH_SNAPSHOT) {
      throw new Error(`Expected GRAPH_SNAPSHOT frame (0x08), got 0x${fh.type.toString(16)}`);
    }
    return this.readPayload(fh.length);
  }

  /** Read a BODY_BLOCK frame. */
  async readBodyBlock(): Promise<{ targetHash: number; encryptedState: Uint8Array }> {
    const fh = await this.readFrameHeader();
    if (fh.type !== FRAME_TYPES.BODY_BLOCK) {
      throw new Error(`Expected BODY_BLOCK frame (0x02), got 0x${fh.type.toString(16)}`);
    }
    const payload = await this.readPayload(fh.length);
    const targetHash = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
    return { targetHash, encryptedState: payload.slice(4) };
  }

  /** Read a LOG_SEGMENT frame. */
  async readLogSegment(): Promise<EoEvent[]> {
    const fh = await this.readFrameHeader();
    if (fh.type !== FRAME_TYPES.LOG_SEGMENT) {
      throw new Error(`Expected LOG_SEGMENT frame (0x03), got 0x${fh.type.toString(16)}`);
    }
    const payload = await this.readPayload(fh.length);
    return unpack(payload) as EoEvent[];
  }

  /** Read the TRAILER frame. */
  async readTrailer(): Promise<EodbTrailer> {
    const fh = await this.readFrameHeader();
    if (fh.type !== FRAME_TYPES.TRAILER) {
      throw new Error(`Expected TRAILER frame (0xFE), got 0x${fh.type.toString(16)}`);
    }
    const payload = await this.readPayload(fh.length);
    return unpack(payload) as EodbTrailer;
  }

  /** Skip a single frame (unknown type — forward compatible). */
  async skipFrame(): Promise<void> {
    const fh = await this.readFrameHeader();
    await this.readPayload(fh.length); // consume and discard
  }

  /**
   * Read the next frame, dispatching by type. Skips unknown types.
   * Returns null on EOF.
   */
  async readNextFrame(): Promise<{
    type: number;
    flags: number;
    payload: Uint8Array;
  } | null> {
    const fh = await this.readFrameHeader();
    if (fh.type === FRAME_TYPES.EOF) return null;
    const payload = await this.readPayload(fh.length);
    return { type: fh.type, flags: fh.flags, payload };
  }

  /** Release the reader lock. */
  cancel(): void {
    this.reader.releaseLock();
  }
}

// ─── Chunk Serialization Helpers ────────────────────────────────────────

function chunkToSerializable(chunk: DiffChunk): any {
  return {
    chunkId: chunk.chunkId,
    prototypeCount: chunk.prototypeCount,
    prototypeIds: chunk.prototypeIds,
    prototypeSnapshot: chunk.prototypeSnapshot,
    baseTimestamp: chunk.baseTimestamp,
    diffs: chunk.diffs, // msgpackr handles Uint8Array natively
    count: chunk.count,
    byteLength: chunk.byteLength,
  };
}

function chunkFromSerializable(data: any): DiffChunk {
  return {
    chunkId: data.chunkId,
    prototypeCount: data.prototypeCount,
    prototypeIds: data.prototypeIds,
    prototypeSnapshot: data.prototypeSnapshot,
    baseTimestamp: data.baseTimestamp,
    diffs: data.diffs instanceof Uint8Array ? data.diffs : new Uint8Array(data.diffs),
    count: data.count,
    byteLength: data.byteLength,
  };
}

// ─── Registry Serialization for .eodb ───────────────────────────────────

function serializeRegistryForEodb(reg: PrototypeRegistry): any {
  const protos: any[] = [];
  for (const proto of reg.prototypes.values()) {
    protos.push({
      id: proto.id,
      card: proto.card,
      count: proto.count,
      seqSum: proto.seqSum,
      tsSum: proto.tsSum,
      eventCountSum: proto.eventCountSum,
      graphDegreeSum: proto.graphDegreeSum,
      dominantCellCounts: proto.dominantCellCounts,
      recentCellCounts: proto.recentCellCounts,
      helixReachCounts: proto.helixReachCounts,
      cellSpreadSum: proto.cellSpreadSum,
      diffSizeSum: proto.diffSizeSum,
      diffSizeSqSum: proto.diffSizeSqSum,
      meanDiffSize: proto.meanDiffSize,
      diffSizeVariance: proto.diffSizeVariance,
    });
  }
  return { prototypes: protos, nextId: reg.nextId };
}

function deserializeRegistryFromEodb(data: any): PrototypeRegistry {
  const prototypes = new Map();
  const nextId = data.nextId ?? 1;
  if (data.prototypes) {
    for (const p of data.prototypes) {
      prototypes.set(p.id, {
        id: p.id,
        card: p.card,
        count: p.count,
        seqSum: p.seqSum,
        tsSum: p.tsSum,
        eventCountSum: p.eventCountSum,
        graphDegreeSum: p.graphDegreeSum,
        dominantCellCounts: p.dominantCellCounts ?? new Array(27).fill(0),
        recentCellCounts: p.recentCellCounts ?? new Array(27).fill(0),
        helixReachCounts: p.helixReachCounts ?? new Array(9).fill(0),
        cellSpreadSum: p.cellSpreadSum,
        diffSizeSum: p.diffSizeSum,
        diffSizeSqSum: p.diffSizeSqSum,
        meanDiffSize: p.meanDiffSize,
        diffSizeVariance: p.diffSizeVariance,
      });
    }
  }
  return { prototypes, nextId };
}

// ─── In-Memory Buffer Sink (for tests and small files) ──────────────────

/**
 * Collects written bytes into a single buffer. Use toUint8Array() to get
 * the complete file, or toReadableStream() to pipe into EodbStreamReader.
 */
export class BufferSink {
  private chunks: Uint8Array[] = [];
  private _closed = false;

  /** Create a WritableStream that writes to this sink. */
  stream(): WritableStream<Uint8Array> {
    return new WritableStream<Uint8Array>({
      write: (chunk) => { this.chunks.push(new Uint8Array(chunk)); },
      close: () => { this._closed = true; },
    });
  }

  get closed(): boolean { return this._closed; }

  /** Get the complete file as a single Uint8Array. */
  toUint8Array(): Uint8Array {
    let totalLen = 0;
    for (const c of this.chunks) totalLen += c.length;
    const result = new Uint8Array(totalLen);
    let off = 0;
    for (const c of this.chunks) {
      result.set(c, off);
      off += c.length;
    }
    return result;
  }

  /** Create a ReadableStream from the collected bytes. */
  toReadableStream(): ReadableStream<Uint8Array> {
    const data = this.toUint8Array();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  }
}

// ─── Convenience: check if data is .eodb v2 ─────────────────────────────

export function isEodbV2(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 4; i++) {
    if (data[i] !== EODB_MAGIC[i]) return false;
  }
  const version = data[4] | (data[5] << 8); // little-endian uint16
  return version >= 2;
}
