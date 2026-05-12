/**
 * Generates `sanity-check.eodb` — a minimal, valid `.eodb` v2 block payload
 * intended for manual upload testing of the seed/hydration flow in
 * `github-matrix-dev/app/src/components/SeedSpaceSection.tsx`.
 *
 * The file mirrors what `buildBlockBytes()` in src/sync/block-sealer.ts
 * produces: file header, one LOG_SEGMENT frame with a handful of EoEvents,
 * trailer, EOF. Format reference: github-matrix-dev/app/src/db/eodb.ts.
 *
 * Run with:
 *   node test-fixtures/generate-sanity-check.mjs
 */

import { pack } from '../github-matrix-dev/app/node_modules/msgpackr/dist/node.cjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants (from src/db/eodb.ts) ────────────────────────────────────
const EODB_MAGIC = Uint8Array.from([0x45, 0x4f, 0x44, 0x42]); // "EODB"
const EODB_VERSION = 2;
const FRAME_TYPES = {
  LOG_SEGMENT: 0x03,
  TRAILER: 0xfe,
  EOF: 0xff,
};
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1aBytes(data, seed = FNV_OFFSET) {
  let h = seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

// ─── Builder ────────────────────────────────────────────────────────────
class EodbBuilder {
  constructor() {
    this.chunks = [];
    this.bytesWritten = 0;
    this.checksum = FNV_OFFSET;
    this.frameOffsets = {};
  }

  _push(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.checksum = fnv1aBytes(u8, this.checksum);
    this.bytesWritten += u8.length;
    this.chunks.push(u8);
  }

  _recordFrame(type) {
    if (!this.frameOffsets[type]) this.frameOffsets[type] = [];
    this.frameOffsets[type].push(this.bytesWritten);
  }

  _writeFrame(type, flags, payload) {
    this._recordFrame(type);
    const header = new Uint8Array(6);
    const dv = new DataView(header.buffer);
    header[0] = type;
    header[1] = flags;
    dv.setUint32(2, payload.length, true);
    this._push(header);
    this._push(payload);
  }

  writeHeader(header) {
    const fileHeader = new Uint8Array(8);
    fileHeader.set(EODB_MAGIC, 0);
    const dv = new DataView(fileHeader.buffer);
    dv.setUint16(4, EODB_VERSION, true);
    dv.setUint16(6, 0, true);
    this._push(fileHeader);

    const headerPayload = pack(header);
    const headerBytes = new Uint8Array(
      headerPayload.buffer,
      headerPayload.byteOffset,
      headerPayload.byteLength,
    );
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setUint32(0, headerBytes.length, true);
    this._push(lenBuf);
    this._push(headerBytes);
  }

  writeLogSegment(events) {
    const payload = pack(events);
    const bytes = new Uint8Array(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
    this._writeFrame(FRAME_TYPES.LOG_SEGMENT, 0, bytes);
  }

  finalize() {
    const trailer = {
      frameOffsets: this.frameOffsets,
      checksum: this.checksum,
      totalBytes: this.bytesWritten,
    };
    const trailerPayload = pack(trailer);
    const trailerBytes = new Uint8Array(
      trailerPayload.buffer,
      trailerPayload.byteOffset,
      trailerPayload.byteLength,
    );
    this._writeFrame(FRAME_TYPES.TRAILER, 0, trailerBytes);
    this._writeFrame(FRAME_TYPES.EOF, 0, new Uint8Array(0));
  }

  toUint8Array() {
    const out = new Uint8Array(this.bytesWritten);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

// ─── Build the sanity-check payload ─────────────────────────────────────
// Stable timestamps so the file is byte-deterministic across regenerations.
const TS = '2026-05-12T00:00:00.000Z';
const COLLECTION_ID = 'sanity-check-collection';
const AGENT = '@sanity:eo-db.test';

const events = [
  {
    seq: 1,
    op: 'INS',
    target: 'sanity.tbl.rec_alpha',
    operand: { name: 'Alpha', notes: 'first sanity-check record' },
    agent: AGENT,
    ts: TS,
    acquired_ts: TS,
    level: 1,
    client_event_id: 'sanity-check-evt-1',
    source: 'sandbox',
  },
  {
    seq: 2,
    op: 'INS',
    target: 'sanity.tbl.rec_beta',
    operand: { name: 'Beta', notes: 'second sanity-check record' },
    agent: AGENT,
    ts: TS,
    acquired_ts: TS,
    level: 1,
    client_event_id: 'sanity-check-evt-2',
    source: 'sandbox',
  },
  {
    seq: 3,
    op: 'CON',
    target: 'sanity.tbl.rec_alpha',
    operand: { added: ['sanity.tbl.rec_beta'], edge_type: 'sanity_link' },
    agent: AGENT,
    ts: TS,
    acquired_ts: TS,
    level: 1,
    client_event_id: 'sanity-check-evt-3',
    source: 'sandbox',
  },
];

const header = {
  collectionId: COLLECTION_ID,
  name: 'block-0',
  createdAt: TS,
  updatedAt: TS,
  encodedThrough: events.length,
  fileVersion: 0,
  blockIndex: 0,
  priorBlockEventId: null,
  schemaVersion: '1',
};

const b = new EodbBuilder();
b.writeHeader(header);
b.writeLogSegment(events);
b.finalize();
const bytes = b.toUint8Array();

const outPath = join(__dirname, 'sanity-check.eodb');
writeFileSync(outPath, bytes);
console.log(`Wrote ${bytes.length} bytes to ${outPath}`);
console.log(`  events: ${events.length}, collection: ${COLLECTION_ID}`);
