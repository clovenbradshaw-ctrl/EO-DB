/**
 * Card encoder — compact 20-byte summaries of entity state.
 *
 * Phase 1: Local IDB chunks. No GPU. No sync. No .eodb.
 *
 * Card    = 20-byte struct capturing trajectory-level properties.
 * Prototype = self-generating reference record (running average).
 * Diff    = Card XOR Prototype, packed 8-14 bytes.
 * Chunk   = up to 4096 diffs, self-contained with prototype snapshot.
 */

import type { EoStore } from './encrypted-store';
import type { EoEvent, EoStateFold, LoggableOperator } from './types';

// ─── Constants ───────────────────────────────────────────────────────────

export const CARD_SIZE = 20;
const MAX_CHUNK_DIFFS = 4096;
const PROTO_PERSIST_INTERVAL = 100;
const SPLIT_DIFF_THRESHOLD = 14.4; // 1.8 * 8
const SPLIT_MIN_COUNT = 100;
const MERGE_SIMILARITY = 0.90;
const MERGE_CHECK_INTERVAL = 500;
const MAX_DIFF_FOR_NEW_PROTO = 14;
const FULL_CARD_ESCAPE = 0xFF;

// ─── Card ────────────────────────────────────────────────────────────────

export interface Card {
  targetHash:    number; // uint32 — FNV-1a of entity ID
  temporalSeq:   number; // uint32 — seq of most recent event
  lastTimestamp:  number; // uint32 — epoch seconds of most recent event
  dominantCell:  number; // uint8  — most frequent cell (0-26)
  recentCell:    number; // uint8  — cell of most recent event (0-26)
  helixReach:    number; // uint8  — highest operator achieved (0-7)
  cellSpread:    number; // uint8  — distinct cells visited (1-27)
  eventCount:    number; // uint16 — total events (capped 65535)
  graphDegree:   number; // uint16 — edge count (capped 65535)
}

// ─── FNV-1a (32-bit) ────────────────────────────────────────────────────

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a(str: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

// ─── Operator → Cell Mapping ─────────────────────────────────────────────
//
// 27-cell grid: action(0-2) * 9 + field(0-2) * 3 + target(0-2)
//
//   Action:  0=separating  1=connecting  2=producing
//   Field:   0=existence   1=organization  2=meaning
//   Target:  0=background  1=specific    2=patterns
//

const OP_CELL: Record<string, number> = {
  NUL:  0, // sep  × exist × bg
  INS: 19, // prod × exist × specific
  SEG:  4, // sep  × org   × specific
  CON: 13, // conn × org   × specific
  SYN: 14, // conn × org   × pattern
  DEF: 25, // prod × mean  × specific
  EVA: 17, // conn × mean  × pattern
  REC: 23, // prod × org   × pattern
};

const OP_HELIX: Record<string, number> = {
  NUL: 0, INS: 1, SEG: 2, CON: 3, SYN: 4, DEF: 5, EVA: 6, REC: 7,
};

// ─── extractCard ─────────────────────────────────────────────────────────

export function extractCard(
  target: string,
  event: EoEvent,
  fold: EoStateFold,
  graphDegree: number,
): Card {
  const opCounts = fold.trajectoryFingerprint.opCounts;

  // dominantCell: cell of most frequent operator
  let maxOp: string = event.op;
  let maxCount = 0;
  for (const op of Object.keys(opCounts)) {
    const c = (opCounts as Record<string, number>)[op];
    if (c > maxCount) { maxCount = c; maxOp = op; }
  }

  // helixReach: highest operator index with count > 0
  let helix = 0;
  for (const op of Object.keys(opCounts)) {
    const c = (opCounts as Record<string, number>)[op];
    if (c > 0 && (OP_HELIX[op] ?? 0) > helix) helix = OP_HELIX[op];
  }

  // cellSpread: distinct cells visited
  const seenCells = new Set<number>();
  for (const op of Object.keys(opCounts)) {
    const c = (opCounts as Record<string, number>)[op];
    if (c > 0 && OP_CELL[op] !== undefined) seenCells.add(OP_CELL[op]);
  }

  return {
    targetHash:   fnv1a(target),
    temporalSeq:  event.seq,
    lastTimestamp: Math.floor(new Date(event.ts).getTime() / 1000),
    dominantCell: OP_CELL[maxOp] ?? 0,
    recentCell:   OP_CELL[event.op] ?? 0,
    helixReach:   helix,
    cellSpread:   Math.max(1, seenCells.size),
    eventCount:   Math.min(fold.eventCount, 0xFFFF),
    graphDegree:  Math.min(graphDegree, 0xFFFF),
  };
}

// ─── Card Binary Packing (20 bytes, little-endian) ───────────────────────

export function packCard(card: Card, dv: DataView, off: number): void {
  dv.setUint32(off,      card.targetHash, true);
  dv.setUint32(off + 4,  card.temporalSeq, true);
  dv.setUint32(off + 8,  card.lastTimestamp, true);
  dv.setUint8(off + 12,  card.dominantCell);
  dv.setUint8(off + 13,  card.recentCell);
  dv.setUint8(off + 14,  card.helixReach);
  dv.setUint8(off + 15,  card.cellSpread);
  dv.setUint16(off + 16, card.eventCount, true);
  dv.setUint16(off + 18, card.graphDegree, true);
}

export function unpackCard(dv: DataView, off: number): Card {
  return {
    targetHash:   dv.getUint32(off, true),
    temporalSeq:  dv.getUint32(off + 4, true),
    lastTimestamp: dv.getUint32(off + 8, true),
    dominantCell: dv.getUint8(off + 12),
    recentCell:   dv.getUint8(off + 13),
    helixReach:   dv.getUint8(off + 14),
    cellSpread:   dv.getUint8(off + 15),
    eventCount:   dv.getUint16(off + 16, true),
    graphDegree:  dv.getUint16(off + 18, true),
  };
}

// ─── Prototype ───────────────────────────────────────────────────────────

export interface Prototype {
  id: number;
  card: Card;
  count: number;
  seqSum: number;
  tsSum: number;
  eventCountSum: number;
  graphDegreeSum: number;
  dominantCellCounts: number[];  // length 27
  recentCellCounts: number[];    // length 27
  helixReachCounts: number[];    // length 9
  cellSpreadSum: number;
  diffSizeSum: number;
  diffSizeSqSum: number;
  meanDiffSize: number;
  diffSizeVariance: number;
}

export interface PrototypeRegistry {
  prototypes: Map<number, Prototype>;
  nextId: number;
}

function createEmptyRegistry(): PrototypeRegistry {
  return { prototypes: new Map(), nextId: 1 };
}

function makePrototype(id: number, card: Card): Prototype {
  return {
    id,
    card: { ...card },
    count: 0,
    seqSum: 0,
    tsSum: 0,
    eventCountSum: 0,
    graphDegreeSum: 0,
    dominantCellCounts: new Array(27).fill(0),
    recentCellCounts: new Array(27).fill(0),
    helixReachCounts: new Array(9).fill(0),
    cellSpreadSum: 0,
    diffSizeSum: 0,
    diffSizeSqSum: 0,
    meanDiffSize: 0,
    diffSizeVariance: 0,
  };
}

function createPrototype(card: Card, registry: PrototypeRegistry): Prototype {
  const proto = makePrototype(registry.nextId++, card);
  registry.prototypes.set(proto.id, proto);
  return proto;
}

function argmax(arr: number[]): number {
  let best = 0;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > arr[best]) best = i;
  }
  return best;
}

function updatePrototype(proto: Prototype, card: Card, diffSize: number): void {
  proto.count++;
  proto.seqSum += card.temporalSeq;
  proto.tsSum += card.lastTimestamp;
  proto.eventCountSum += card.eventCount;
  proto.graphDegreeSum += card.graphDegree;
  proto.dominantCellCounts[card.dominantCell]++;
  proto.recentCellCounts[card.recentCell]++;
  proto.helixReachCounts[Math.min(card.helixReach, 8)]++;
  proto.cellSpreadSum += card.cellSpread;
  proto.diffSizeSum += diffSize;
  proto.diffSizeSqSum += diffSize * diffSize;
  proto.meanDiffSize = proto.diffSizeSum / proto.count;
  proto.diffSizeVariance = (proto.diffSizeSqSum / proto.count) - proto.meanDiffSize ** 2;

  // Recompute representative card from running statistics
  proto.card.temporalSeq  = Math.round(proto.seqSum / proto.count);
  proto.card.lastTimestamp = Math.round(proto.tsSum / proto.count);
  proto.card.dominantCell  = argmax(proto.dominantCellCounts);
  proto.card.recentCell    = argmax(proto.recentCellCounts);
  proto.card.helixReach    = argmax(proto.helixReachCounts);
  proto.card.cellSpread    = Math.round(proto.cellSpreadSum / proto.count);
  proto.card.eventCount    = Math.round(proto.eventCountSum / proto.count);
  proto.card.graphDegree   = Math.round(proto.graphDegreeSum / proto.count);
}

function estimateDiffSize(card: Card, proto: Prototype): number {
  let size = 8; // protoId(1) + mask(1) + targetHash(4) + seqOffset(2)
  if (card.dominantCell !== proto.card.dominantCell) size += 1;
  if (card.recentCell   !== proto.card.recentCell)   size += 1;
  if (card.helixReach   !== proto.card.helixReach)   size += 1;
  if (card.cellSpread   !== proto.card.cellSpread)   size += 1;
  if (card.eventCount   !== proto.card.eventCount)   size += 2;
  if (card.graphDegree  !== proto.card.graphDegree)  size += 2;
  return size;
}

function findBestPrototype(card: Card, registry: PrototypeRegistry): Prototype | null {
  let best: Prototype | null = null;
  let bestSize = MAX_DIFF_FOR_NEW_PROTO + 1;
  for (const proto of registry.prototypes.values()) {
    const size = estimateDiffSize(card, proto);
    if (size < bestSize) { bestSize = size; best = proto; }
  }
  return best;
}

function cardSimilarity(a: Card, b: Card): number {
  let score = 0;
  if (a.dominantCell === b.dominantCell) score++;
  if (a.recentCell   === b.recentCell)   score++;
  if (a.helixReach   === b.helixReach)   score++;
  if (a.cellSpread   === b.cellSpread)   score++;
  score += 1 - Math.abs(a.eventCount - b.eventCount)  / Math.max(a.eventCount, b.eventCount, 1);
  score += 1 - Math.abs(a.graphDegree - b.graphDegree) / Math.max(a.graphDegree, b.graphDegree, 1);
  return score / 6;
}

function resetProtoStats(proto: Prototype): void {
  proto.count = 0;
  proto.seqSum = 0;
  proto.tsSum = 0;
  proto.eventCountSum = 0;
  proto.graphDegreeSum = 0;
  proto.dominantCellCounts.fill(0);
  proto.recentCellCounts.fill(0);
  proto.helixReachCounts.fill(0);
  proto.cellSpreadSum = 0;
  proto.diffSizeSum = 0;
  proto.diffSizeSqSum = 0;
  proto.meanDiffSize = 0;
  proto.diffSizeVariance = 0;
}

function checkSplit(proto: Prototype, registry: PrototypeRegistry): void {
  if (proto.count < SPLIT_MIN_COUNT) return;
  if (proto.meanDiffSize <= SPLIT_DIFF_THRESHOLD) return;
  // Clone with same representative card; both reset and diverge naturally
  const clone = makePrototype(registry.nextId++, proto.card);
  registry.prototypes.set(clone.id, clone);
  resetProtoStats(proto);
}

function checkMerge(registry: PrototypeRegistry): void {
  const protos = Array.from(registry.prototypes.values());
  for (let i = 0; i < protos.length; i++) {
    for (let j = i + 1; j < protos.length; j++) {
      if (cardSimilarity(protos[i].card, protos[j].card) > MERGE_SIMILARITY) {
        mergePrototypes(protos[i], protos[j]);
        registry.prototypes.delete(protos[j].id);
        return; // one merge per check
      }
    }
  }
}

function mergePrototypes(a: Prototype, b: Prototype): void {
  a.count += b.count;
  a.seqSum += b.seqSum;
  a.tsSum += b.tsSum;
  a.eventCountSum += b.eventCountSum;
  a.graphDegreeSum += b.graphDegreeSum;
  for (let k = 0; k < 27; k++) {
    a.dominantCellCounts[k] += b.dominantCellCounts[k];
    a.recentCellCounts[k] += b.recentCellCounts[k];
  }
  for (let k = 0; k < 9; k++) a.helixReachCounts[k] += b.helixReachCounts[k];
  a.cellSpreadSum += b.cellSpreadSum;
  a.diffSizeSum += b.diffSizeSum;
  a.diffSizeSqSum += b.diffSizeSqSum;
  if (a.count > 0) {
    a.meanDiffSize = a.diffSizeSum / a.count;
    a.diffSizeVariance = (a.diffSizeSqSum / a.count) - a.meanDiffSize ** 2;
    a.card.temporalSeq  = Math.round(a.seqSum / a.count);
    a.card.lastTimestamp = Math.round(a.tsSum / a.count);
    a.card.dominantCell  = argmax(a.dominantCellCounts);
    a.card.recentCell    = argmax(a.recentCellCounts);
    a.card.helixReach    = argmax(a.helixReachCounts);
    a.card.cellSpread    = Math.round(a.cellSpreadSum / a.count);
    a.card.eventCount    = Math.round(a.eventCountSum / a.count);
    a.card.graphDegree   = Math.round(a.graphDegreeSum / a.count);
  }
}

// ─── Diff Encoding ───────────────────────────────────────────────────────
//
// Layout:
//   Byte 0:    prototypeId (uint8, 0-254; 0xFF = full card escape)
//   Byte 1:    diffMask
//   Bytes 2-5: targetHash (uint32, always present)
//   Bytes 6-7: seqOffset (int16, from prototype.temporalSeq)
//   Bytes 8+:  variable fields per mask bits:
//                bit 0 → dominantCell  (1 byte)
//                bit 1 → recentCell    (1 byte)
//                bit 2 → helixReach    (1 byte)
//                bit 3 → cellSpread    (1 byte)
//                bit 4 → eventCount    (2 bytes)
//                bit 5 → graphDegree   (2 bytes)
//                bit 7 → full card follows (20 bytes)
//
// Min 8 bytes. Typical 9-10. Max diff 16. Full card escape 22.

export function encodeDiff(card: Card, protoId: number, ref: Card): Uint8Array {
  const seqOffset = card.temporalSeq - ref.temporalSeq;

  // Full card escape if seqOffset overflows int16 or protoId > 254
  if (seqOffset > 32767 || seqOffset < -32768 || protoId > 254) {
    const buf = new Uint8Array(22);
    const dv = new DataView(buf.buffer);
    buf[0] = FULL_CARD_ESCAPE;
    buf[1] = 0x80;
    packCard(card, dv, 2);
    return buf;
  }

  let mask = 0;
  if (card.dominantCell !== ref.dominantCell) mask |= 0x01;
  if (card.recentCell   !== ref.recentCell)   mask |= 0x02;
  if (card.helixReach   !== ref.helixReach)   mask |= 0x04;
  if (card.cellSpread   !== ref.cellSpread)   mask |= 0x08;
  if (card.eventCount   !== ref.eventCount)   mask |= 0x10;
  if (card.graphDegree  !== ref.graphDegree)  mask |= 0x20;

  let size = 8;
  if (mask & 0x01) size += 1;
  if (mask & 0x02) size += 1;
  if (mask & 0x04) size += 1;
  if (mask & 0x08) size += 1;
  if (mask & 0x10) size += 2;
  if (mask & 0x20) size += 2;

  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  buf[0] = protoId;
  buf[1] = mask;
  dv.setUint32(2, card.targetHash, true);
  dv.setInt16(6, seqOffset, true);

  let off = 8;
  if (mask & 0x01) buf[off++] = card.dominantCell;
  if (mask & 0x02) buf[off++] = card.recentCell;
  if (mask & 0x04) buf[off++] = card.helixReach;
  if (mask & 0x08) buf[off++] = card.cellSpread;
  if (mask & 0x10) { dv.setUint16(off, card.eventCount, true); off += 2; }
  if (mask & 0x20) { dv.setUint16(off, card.graphDegree, true); off += 2; }

  return buf;
}

export function decodeDiff(
  buf: Uint8Array,
  offset: number,
  prototypes: Map<number, Card>,
): { card: Card; bytesRead: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const protoId = buf[offset];
  const mask = buf[offset + 1];

  // Full card escape
  if (protoId === FULL_CARD_ESCAPE && (mask & 0x80)) {
    return { card: unpackCard(dv, offset + 2), bytesRead: 22 };
  }

  const protoCard = prototypes.get(protoId);
  if (!protoCard) throw new Error(`Unknown prototype ${protoId} in diff`);

  const targetHash = dv.getUint32(offset + 2, true);
  const seqOffset  = dv.getInt16(offset + 6, true);

  const card: Card = {
    targetHash,
    temporalSeq:  protoCard.temporalSeq + seqOffset,
    lastTimestamp: protoCard.lastTimestamp, // approximated from prototype
    dominantCell: protoCard.dominantCell,
    recentCell:   protoCard.recentCell,
    helixReach:   protoCard.helixReach,
    cellSpread:   protoCard.cellSpread,
    eventCount:   protoCard.eventCount,
    graphDegree:  protoCard.graphDegree,
  };

  let off = offset + 8;
  if (mask & 0x01) card.dominantCell = buf[off++];
  if (mask & 0x02) card.recentCell   = buf[off++];
  if (mask & 0x04) card.helixReach   = buf[off++];
  if (mask & 0x08) card.cellSpread   = buf[off++];
  if (mask & 0x10) { card.eventCount  = dv.getUint16(off, true); off += 2; }
  if (mask & 0x20) { card.graphDegree = dv.getUint16(off, true); off += 2; }

  return { card, bytesRead: off - offset };
}

// ─── DiffChunk ───────────────────────────────────────────────────────────

export interface DiffChunk {
  chunkId: number;
  prototypeCount: number;
  prototypeIds: number[];
  prototypeSnapshot: Card[];
  baseTimestamp: number;
  diffs: Uint8Array;
  count: number;
  byteLength: number;
}

export function decodeChunk(chunk: DiffChunk): Card[] {
  const protoMap = new Map<number, Card>();
  for (let i = 0; i < chunk.prototypeIds.length; i++) {
    protoMap.set(chunk.prototypeIds[i], chunk.prototypeSnapshot[i]);
  }

  // Ensure diffs is a proper Uint8Array (msgpack may return Buffer or plain array)
  const diffs = chunk.diffs instanceof Uint8Array
    ? chunk.diffs
    : new Uint8Array(chunk.diffs);

  const cards: Card[] = [];
  let offset = 0;
  for (let i = 0; i < chunk.count; i++) {
    const { card, bytesRead } = decodeDiff(diffs, offset, protoMap);
    cards.push(card);
    offset += bytesRead;
  }
  return cards;
}

// ─── ChunkWriter ─────────────────────────────────────────────────────────

export class ChunkWriter {
  private store: EoStore;
  private registry: PrototypeRegistry;
  private buf: Uint8Array;
  private bufOff: number;
  private count: number;
  private chunkId: number;
  private baseTs: number;
  private protoIds: Set<number>;
  /** Snapshot of each prototype's card at first use within the current chunk.
   *  Encoding and the chunk snapshot both use these, preventing drift. */
  private chunkSnapshots: Map<number, Card>;
  private sincePersist: number;
  private sinceMerge: number;

  constructor(store: EoStore, registry: PrototypeRegistry, nextChunkId: number) {
    this.store = store;
    this.registry = registry;
    this.buf = new Uint8Array(MAX_CHUNK_DIFFS * 16);
    this.bufOff = 0;
    this.count = 0;
    this.chunkId = nextChunkId;
    this.baseTs = 0;
    this.protoIds = new Set();
    this.chunkSnapshots = new Map();
    this.sincePersist = 0;
    this.sinceMerge = 0;
  }

  getRegistry(): PrototypeRegistry { return this.registry; }

  async addRecord(card: Card): Promise<void> {
    // 1. Find or create best prototype
    let proto = findBestPrototype(card, this.registry);
    if (!proto) proto = createPrototype(card, this.registry);

    // Snapshot the prototype card on first use in this chunk
    if (!this.chunkSnapshots.has(proto.id)) {
      this.chunkSnapshots.set(proto.id, { ...proto.card });
    }
    const ref = this.chunkSnapshots.get(proto.id)!;

    // 2. Early-flush if seqOffset would overflow int16
    const seqOffset = card.temporalSeq - ref.temporalSeq;
    if (this.count > 0 && (seqOffset > 32767 || seqOffset < -32768)) {
      await this.flushChunk();
      // Re-snapshot after flush (prototype may have shifted)
      this.chunkSnapshots.set(proto.id, { ...proto.card });
    }

    // 3. Flush if at capacity
    if (this.count >= MAX_CHUNK_DIFFS) {
      await this.flushChunk();
      this.chunkSnapshots.set(proto.id, { ...proto.card });
    }

    // 4. Encode diff against the chunk-local snapshot
    const refCard = this.chunkSnapshots.get(proto.id)!;
    const diff = encodeDiff(card, proto.id, refCard);

    // 5. Grow buffer if needed
    if (this.bufOff + diff.length > this.buf.length) {
      const grown = new Uint8Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }

    this.buf.set(diff, this.bufOff);
    this.bufOff += diff.length;
    this.count++;
    this.protoIds.add(proto.id);
    if (this.baseTs === 0) this.baseTs = card.lastTimestamp;

    // 6. Update prototype statistics (live prototype shifts for future chunks)
    updatePrototype(proto, card, diff.length);

    // 7. Check split/merge thresholds
    checkSplit(proto, this.registry);
    this.sinceMerge++;
    if (this.sinceMerge >= MERGE_CHECK_INTERVAL) {
      checkMerge(this.registry);
      this.sinceMerge = 0;
    }

    // 8. Persist prototypes periodically
    this.sincePersist++;
    if (this.sincePersist >= PROTO_PERSIST_INTERVAL) {
      await this.persistPrototypes();
      this.sincePersist = 0;
    }
  }

  async flushChunk(): Promise<void> {
    if (this.count === 0) return;

    const ids = Array.from(this.protoIds);
    // Use the chunk-local snapshots (same cards that were used for encoding)
    const snapshot = ids.map(id => ({ ...this.chunkSnapshots.get(id)! }));

    const diffsCopy = new Uint8Array(this.bufOff);
    diffsCopy.set(this.buf.subarray(0, this.bufOff));

    const chunk: DiffChunk = {
      chunkId: this.chunkId,
      prototypeCount: ids.length,
      prototypeIds: ids,
      prototypeSnapshot: snapshot,
      baseTimestamp: this.baseTs,
      diffs: diffsCopy,
      count: this.count,
      byteLength: this.bufOff,
    };

    await this.store.put(`chunk:${padChunkId(this.chunkId)}`, chunk);
    this.chunkId++;
    await this.store.put('card:meta', { nextChunkId: this.chunkId });

    // Reset for next chunk
    this.bufOff = 0;
    this.count = 0;
    this.baseTs = 0;
    this.protoIds = new Set();
    this.chunkSnapshots = new Map();
  }

  async persistPrototypes(): Promise<void> {
    await this.store.put('proto:current', serializeRegistry(this.registry));
  }

  async shutdown(): Promise<void> {
    await this.flushChunk();
    await this.persistPrototypes();
  }
}

function padChunkId(id: number): string {
  return String(id).padStart(6, '0');
}

// ─── Registry Serialization ──────────────────────────────────────────────

function serializeRegistry(reg: PrototypeRegistry): any {
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

function deserializeRegistry(data: any): PrototypeRegistry {
  const reg = createEmptyRegistry();
  if (!data?.prototypes) return reg;
  reg.nextId = data.nextId ?? 1;
  for (const p of data.prototypes) {
    reg.prototypes.set(p.id, {
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
  return reg;
}

// ─── CardBuffer (flat typed array for CPU scanning) ──────────────────────
//
// 20 bytes per entity in a contiguous ArrayBuffer.
// Map<targetHash, slotIndex> for O(1) upsert/lookup.
// Linear scan for filtering/sorting: ~2 MB for 100K entities, <3ms.

export class CardBuffer {
  private data: ArrayBuffer;
  private view: DataView;
  private _size: number;
  private capacity: number;
  private hashIndex: Map<number, number>;

  get size(): number { return this._size; }

  constructor(initialCapacity = 8192) {
    this.capacity = initialCapacity;
    this.data = new ArrayBuffer(initialCapacity * CARD_SIZE);
    this.view = new DataView(this.data);
    this._size = 0;
    this.hashIndex = new Map();
  }

  /** Insert or update a card. O(1). */
  upsert(card: Card): void {
    let slot = this.hashIndex.get(card.targetHash);
    if (slot === undefined) {
      slot = this._size++;
      if (slot >= this.capacity) this.grow();
      this.hashIndex.set(card.targetHash, slot);
    }
    packCard(card, this.view, slot * CARD_SIZE);
  }

  /** Look up a card by targetHash. O(1). */
  get(targetHash: number): Card | null {
    const slot = this.hashIndex.get(targetHash);
    if (slot === undefined) return null;
    return unpackCard(this.view, slot * CARD_SIZE);
  }

  has(targetHash: number): boolean {
    return this.hashIndex.has(targetHash);
  }

  /** Scan all cards, returning those matching the predicate. */
  scan(predicate: (card: Card) => boolean): Card[] {
    const results: Card[] = [];
    for (let i = 0; i < this._size; i++) {
      const card = unpackCard(this.view, i * CARD_SIZE);
      if (predicate(card)) results.push(card);
    }
    return results;
  }

  /** Return target hashes matching a predicate. */
  scanHashes(predicate: (card: Card) => boolean): number[] {
    const results: number[] = [];
    for (let i = 0; i < this._size; i++) {
      const card = unpackCard(this.view, i * CARD_SIZE);
      if (predicate(card)) results.push(card.targetHash);
    }
    return results;
  }

  /** Return all cards sorted by a comparator. */
  sorted(compare: (a: Card, b: Card) => number): Card[] {
    const all = this.toArray();
    all.sort(compare);
    return all;
  }

  toArray(): Card[] {
    const result: Card[] = [];
    for (let i = 0; i < this._size; i++) {
      result.push(unpackCard(this.view, i * CARD_SIZE));
    }
    return result;
  }

  private grow(): void {
    const newCap = this.capacity * 2;
    const newData = new ArrayBuffer(newCap * CARD_SIZE);
    new Uint8Array(newData).set(new Uint8Array(this.data));
    this.data = newData;
    this.view = new DataView(this.data);
    this.capacity = newCap;
  }
}

// ─── Loading ─────────────────────────────────────────────────────────────

export async function loadAllChunks(store: EoStore): Promise<DiffChunk[]> {
  const entries = await store.iterator('chunk:');
  return entries.map(([, value]) => value as DiffChunk);
}

/** Build card buffer from persisted chunks. Deduplicates by targetHash (latest wins). */
export async function buildCardBuffer(store: EoStore): Promise<CardBuffer> {
  const buffer = new CardBuffer();
  const latestSeq = new Map<number, number>();
  for await (const batch of loadChunks(store)) {
    for (const card of batch.cards) {
      const prev = latestSeq.get(card.targetHash);
      if (prev === undefined || card.temporalSeq > prev) {
        buffer.upsert(card);
        latestSeq.set(card.targetHash, card.temporalSeq);
      }
    }
  }
  return buffer;
}

// ─── Phase 2: Progressive Loading ───────────────────────────────────────
//
// loadChunks() is an async generator that yields in two phases:
//   Phase A: prototypes only (from proto:current) — enough for overview.
//   Phase B: card batches from each chunk — caller deduplicates incrementally.
//
// buildCardBufferProgressive() consumes this generator with an onProgress
// callback so the table view can render incrementally as chunks arrive.

/** A batch yielded by the loadChunks generator. */
export interface LoadBatch {
  /** 'prototypes' for the initial overview, 'cards' for chunk data. */
  phase: 'prototypes' | 'cards';
  /** Decoded cards from this batch (empty for prototype-only phase). */
  cards: Card[];
  /** Prototype registry snapshot (present only in the 'prototypes' phase). */
  registry?: PrototypeRegistry;
  /** 1-based chunk index within the cards phase. */
  chunkIndex?: number;
  /** Total chunk count (known after first IDB scan). */
  chunkCount?: number;
}

/**
 * Async generator that yields prototype overview first, then card batches
 * one chunk at a time. Each chunk is self-contained (decodes against its
 * own prototypeSnapshot). Caller deduplicates by targetHash (latest wins).
 */
export async function* loadChunks(store: EoStore): AsyncGenerator<LoadBatch> {
  // Phase A: yield prototypes for overview (<50ms target)
  const regData = await store.get('proto:current');
  const registry = regData ? deserializeRegistry(regData) : createEmptyRegistry();
  yield { phase: 'prototypes', cards: [], registry };

  // Phase B: iterate chunk:* keys, decode each, yield card batch
  const entries = await store.iterator('chunk:');
  const chunkCount = entries.length;
  for (let i = 0; i < entries.length; i++) {
    const chunk = entries[i][1] as DiffChunk;
    const cards = decodeChunk(chunk);
    yield { phase: 'cards', cards, chunkIndex: i + 1, chunkCount };
  }
}

/** Progress info emitted by buildCardBufferProgressive. */
export interface CardBufferProgress {
  /** 'overview' after prototypes loaded, 'chunk' after each chunk batch. */
  stage: 'overview' | 'chunk';
  /** Current buffer (accumulating — same reference throughout). */
  buffer: CardBuffer;
  /** Prototype registry (available from the overview stage onward). */
  registry?: PrototypeRegistry;
  /** Number of unique entities loaded so far. */
  entityCount: number;
  /** 1-based chunk index (only for 'chunk' stage). */
  chunkIndex?: number;
  /** Total chunk count (only for 'chunk' stage). */
  chunkCount?: number;
}

/**
 * Progressive card buffer builder. Consumes loadChunks() and invokes
 * onProgress after each phase, allowing the table view to render
 * incrementally as data streams in.
 *
 * First callback fires at 'overview' stage (prototypes only, <50ms).
 * Subsequent callbacks fire per chunk with deduped card buffer.
 */
export async function buildCardBufferProgressive(
  store: EoStore,
  onProgress?: (progress: CardBufferProgress) => void,
): Promise<CardBuffer> {
  const buffer = new CardBuffer();
  const latestSeq = new Map<number, number>();

  for await (const batch of loadChunks(store)) {
    if (batch.phase === 'prototypes') {
      onProgress?.({
        stage: 'overview',
        buffer,
        registry: batch.registry,
        entityCount: 0,
      });
      continue;
    }

    for (const card of batch.cards) {
      const prev = latestSeq.get(card.targetHash);
      if (prev === undefined || card.temporalSeq > prev) {
        buffer.upsert(card);
        latestSeq.set(card.targetHash, card.temporalSeq);
      }
    }

    onProgress?.({
      stage: 'chunk',
      buffer,
      entityCount: buffer.size,
      chunkIndex: batch.chunkIndex,
      chunkCount: batch.chunkCount,
    });
  }

  return buffer;
}

// ─── Compaction ──────────────────────────────────────────────────────────
//
// Rewrites all chunks with only current (deduplicated) cards and fresh
// prototypes. Triggers: idle, stale ratio > 0.5, before encoding .eodb.

export async function compact(store: EoStore): Promise<void> {
  const chunks = await loadAllChunks(store);
  if (chunks.length === 0) return;

  // 1. Deduplicate
  const current = new Map<number, Card>();
  for (const chunk of chunks) {
    for (const card of decodeChunk(chunk)) {
      const prev = current.get(card.targetHash);
      if (!prev || card.temporalSeq > prev.temporalSeq) {
        current.set(card.targetHash, card);
      }
    }
  }

  // 2. Delete old chunks
  for (const chunk of chunks) {
    await store.del(`chunk:${padChunkId(chunk.chunkId)}`);
  }

  // 3. Re-encode with fresh prototypes and chunk IDs starting at 0
  const freshReg = createEmptyRegistry();
  const writer = new ChunkWriter(store, freshReg, 0);
  for (const card of current.values()) await writer.addRecord(card);
  await writer.shutdown();
}

// ─── Module Singleton ────────────────────────────────────────────────────

let _writer: ChunkWriter | null = null;
let _buffer: CardBuffer | null = null;

/**
 * Initialize the card encoder for a store. Loads existing prototypes and
 * chunks from IDB, builds the in-memory card buffer, returns it.
 *
 * Accepts an optional onProgress callback for progressive loading (Phase 2).
 * The first callback fires after prototypes are loaded (<50ms), before any
 * chunks are decoded — enough for a table overview. Subsequent callbacks
 * fire per chunk as cards stream in.
 */
export async function initCardEncoder(
  store: EoStore,
  onProgress?: (progress: CardBufferProgress) => void,
): Promise<CardBuffer> {
  // Registry and ChunkWriter are set up from the prototype phase callback
  let registry: PrototypeRegistry | undefined;

  _buffer = await buildCardBufferProgressive(store, (progress) => {
    if (progress.stage === 'overview' && progress.registry) {
      registry = progress.registry;
    }
    onProgress?.(progress);
  });

  // If no registry was loaded (empty store), create a fresh one
  if (!registry) registry = createEmptyRegistry();

  const meta = await store.get('card:meta');
  const nextChunkId = meta?.nextChunkId ?? 0;
  _writer = new ChunkWriter(store, registry, nextChunkId);

  return _buffer;
}

export function getChunkWriter(): ChunkWriter | null { return _writer; }
export function getCardBuffer(): CardBuffer | null { return _buffer; }

export async function shutdownCardEncoder(): Promise<void> {
  if (_writer) { await _writer.shutdown(); _writer = null; }
  _buffer = null;
}
