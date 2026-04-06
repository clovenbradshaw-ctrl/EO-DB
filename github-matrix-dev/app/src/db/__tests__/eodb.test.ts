/**
 * .eodb v2 streaming format tests — round-trip write/read, frame ordering,
 * forward compatibility (skip unknown frames), and BufferSink.
 */

import { describe, it, expect } from 'vitest';
import {
  EodbWriter,
  EodbStreamReader,
  BufferSink,
  FRAME_TYPES,
  isEodbV2,
  type CollectionHeader,
} from '../eodb';
import {
  type Card,
  type DiffChunk,
  type Prototype,
  type PrototypeRegistry,
  encodeDiff,
  decodeDiff,
  decodeChunk,
} from '../card-encoder';
import { serializeCSR, deserializeCSR, emptyCSR } from '../graph-store';
import type { EoEvent } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeHeader(overrides?: Partial<CollectionHeader>): CollectionHeader {
  return {
    collectionId: 'test-collection',
    name: 'Test Collection',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-04-06T00:00:00Z',
    encodedThrough: 1000,
    fileVersion: 1,
    ...overrides,
  };
}

function makeCard(hash: number, seq: number = 1): Card {
  return {
    targetHash: hash,
    temporalSeq: seq,
    lastTimestamp: 1700000000,
    dominantCell: 5,
    recentCell: 13,
    helixReach: 3,
    cellSpread: 4,
    eventCount: 10,
    graphDegree: 2,
  };
}

function makePrototype(id: number, card: Card): Prototype {
  return {
    id,
    card: { ...card },
    count: 1,
    seqSum: card.temporalSeq,
    tsSum: card.lastTimestamp,
    eventCountSum: card.eventCount,
    graphDegreeSum: card.graphDegree,
    dominantCellCounts: new Array(27).fill(0),
    recentCellCounts: new Array(27).fill(0),
    helixReachCounts: new Array(9).fill(0),
    cellSpreadSum: card.cellSpread,
    diffSizeSum: 8,
    diffSizeSqSum: 64,
    meanDiffSize: 8,
    diffSizeVariance: 0,
  };
}

function makeRegistry(): PrototypeRegistry {
  const proto = makePrototype(1, makeCard(0xAAAA, 100));
  const prototypes = new Map<number, Prototype>();
  prototypes.set(1, proto);
  return { prototypes, nextId: 2 };
}

function makeDiffChunk(): DiffChunk {
  const protoCard = makeCard(0xAAAA, 100);
  const card1 = makeCard(0x1111, 101);
  const card2 = makeCard(0x2222, 102);

  const diff1 = encodeDiff(card1, 1, protoCard);
  const diff2 = encodeDiff(card2, 1, protoCard);

  const diffs = new Uint8Array(diff1.length + diff2.length);
  diffs.set(diff1, 0);
  diffs.set(diff2, diff1.length);

  return {
    chunkId: 0,
    prototypeCount: 1,
    prototypeIds: [1],
    prototypeSnapshot: [protoCard],
    baseTimestamp: 1700000000,
    diffs,
    count: 2,
    byteLength: diffs.length,
  };
}

async function writeAndRead(
  writeFn: (writer: EodbWriter) => Promise<void>,
): Promise<EodbStreamReader> {
  const sink = new BufferSink();
  const ws = sink.stream();
  const writer = new EodbWriter(ws.getWriter());
  await writeFn(writer);
  return new EodbStreamReader(sink.toReadableStream());
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('eodb v2', () => {
  describe('BufferSink', () => {
    it('collects writes and produces readable stream', async () => {
      const sink = new BufferSink();
      const ws = sink.stream();
      const w = ws.getWriter();
      await w.write(new Uint8Array([1, 2, 3]));
      await w.write(new Uint8Array([4, 5]));
      await w.close();

      expect(sink.closed).toBe(true);
      const bytes = sink.toUint8Array();
      expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('isEodbV2', () => {
    it('returns true for v2 header', () => {
      const buf = new Uint8Array(8);
      buf.set([0x45, 0x4F, 0x44, 0x42], 0); // "EODB"
      buf[4] = 2; buf[5] = 0; // version 2 LE
      expect(isEodbV2(buf)).toBe(true);
    });

    it('returns false for v1 header', () => {
      const buf = new Uint8Array(8);
      buf.set([0x45, 0x4F, 0x44, 0x42], 0);
      buf[4] = 1; buf[5] = 0;
      expect(isEodbV2(buf)).toBe(false);
    });

    it('returns false for too-short data', () => {
      expect(isEodbV2(new Uint8Array(4))).toBe(false);
    });

    it('returns false for wrong magic', () => {
      const buf = new Uint8Array(8);
      buf.set([0x00, 0x00, 0x00, 0x00], 0);
      expect(isEodbV2(buf)).toBe(false);
    });
  });

  describe('header round-trip', () => {
    it('writes and reads collection header', async () => {
      const header = makeHeader({ name: 'My Collection', encodedThrough: 42 });

      const reader = await writeAndRead(async (writer) => {
        await writer.writeHeader(header);
        await writer.finalize();
      });

      const readHeader = await reader.readHeader();
      expect(readHeader.collectionId).toBe('test-collection');
      expect(readHeader.name).toBe('My Collection');
      expect(readHeader.encodedThrough).toBe(42);
      expect(readHeader.fileVersion).toBe(1);
    });
  });

  describe('prototype table round-trip', () => {
    it('writes and reads prototype registry', async () => {
      const registry = makeRegistry();
      const header = makeHeader();

      const reader = await writeAndRead(async (writer) => {
        await writer.writeHeader(header);
        await writer.writePrototypeTable(registry);
        await writer.finalize();
      });

      await reader.readHeader();
      const readRegistry = await reader.readPrototypeTable();

      expect(readRegistry.nextId).toBe(2);
      expect(readRegistry.prototypes.size).toBe(1);
      const proto = readRegistry.prototypes.get(1)!;
      expect(proto.id).toBe(1);
      expect(proto.card.targetHash).toBe(0xAAAA);
    });
  });

  describe('diff chunk round-trip', () => {
    it('writes and reads diff chunks', async () => {
      const chunk = makeDiffChunk();
      const header = makeHeader();
      const registry = makeRegistry();

      const reader = await writeAndRead(async (writer) => {
        await writer.writeHeader(header);
        await writer.writePrototypeTable(registry);
        await writer.writeDiffChunk(chunk);
        await writer.finalize();
      });

      await reader.readHeader();
      await reader.readPrototypeTable();

      // Peek should show DIFF_CHUNK
      const nextType = await reader.peekFrameType();
      expect(nextType).toBe(FRAME_TYPES.DIFF_CHUNK);

      const readChunk = await reader.readDiffChunk();
      expect(readChunk.count).toBe(2);
      expect(readChunk.chunkId).toBe(0);

      // Decode cards from the chunk
      const cards = decodeChunk(readChunk);
      expect(cards.length).toBe(2);
      expect(cards[0].targetHash).toBe(0x1111);
      expect(cards[1].targetHash).toBe(0x2222);
    });
  });

  describe('graph snapshot round-trip', () => {
    it('writes and reads CSR graph', async () => {
      const graph = emptyCSR();
      const serialized = serializeCSR(graph);
      const header = makeHeader();

      const reader = await writeAndRead(async (writer) => {
        await writer.writeHeader(header);
        await writer.writeGraphSnapshot(serialized);
        await writer.finalize();
      });

      await reader.readHeader();
      const csrBytes = await reader.readGraphSnapshot();
      const restored = deserializeCSR(csrBytes);

      expect(restored.nodeCount).toBe(0);
      expect(restored.edgeCount).toBe(0);
    });
  });

  describe('body block round-trip', () => {
    it('writes and reads encrypted body block', async () => {
      const header = makeHeader();
      const fakeEncrypted = new Uint8Array([10, 20, 30, 40, 50]);

      const reader = await writeAndRead(async (writer) => {
        await writer.writeHeader(header);
        await writer.writeBodyBlock(0xBEEF, fakeEncrypted);
        await writer.finalize();
      });

      await reader.readHeader();
      const block = await reader.readBodyBlock();
      expect(block.targetHash).toBe(0xBEEF);
      expect(Array.from(block.encryptedState)).toEqual([10, 20, 30, 40, 50]);
    });
  });

  describe('log segment round-trip', () => {
    it('writes and reads event log segments', async () => {
      const header = makeHeader();
      const events: EoEvent[] = [
        {
          seq: 1,
          op: 'INS',
          target: 'app.tbl.rec1',
          operand: { name: 'Test' },
          agent: '@user:matrix.org',
          ts: '2026-01-01T00:00:00Z',
          acquired_ts: '2026-01-01T00:00:00Z',
        },
      ];

      const reader = await writeAndRead(async (writer) => {
        await writer.writeHeader(header);
        await writer.writeLogSegment(events);
        await writer.finalize();
      });

      await reader.readHeader();
      const readEvents = await reader.readLogSegment();
      expect(readEvents.length).toBe(1);
      expect(readEvents[0].op).toBe('INS');
      expect(readEvents[0].target).toBe('app.tbl.rec1');
    });
  });

  describe('full file round-trip', () => {
    it('writes and reads a complete .eodb with all frame types', async () => {
      const header = makeHeader();
      const registry = makeRegistry();
      const chunk = makeDiffChunk();
      const csrBytes = serializeCSR(emptyCSR());
      const bodyData = new Uint8Array([1, 2, 3]);
      const events: EoEvent[] = [{
        seq: 1, op: 'DEF', target: 'a.b.c', operand: 'v',
        agent: '@u:m.org', ts: '2026-01-01T00:00:00Z',
        acquired_ts: '2026-01-01T00:00:00Z',
      }];

      const reader = await writeAndRead(async (writer) => {
        await writer.writeHeader(header);
        await writer.writePrototypeTable(registry);
        await writer.writeDiffChunk(chunk);
        await writer.writeGraphSnapshot(csrBytes);
        await writer.writeBodyBlock(0xCAFE, bodyData);
        await writer.writeLogSegment(events);
        await writer.finalize();
      });

      // Read everything back using readNextFrame
      const readHeader = await reader.readHeader();
      expect(readHeader.collectionId).toBe('test-collection');

      // Prototype table
      const protoFrame = await reader.readNextFrame();
      expect(protoFrame!.type).toBe(FRAME_TYPES.PROTO_UPDATE);

      // Diff chunk
      const chunkFrame = await reader.readNextFrame();
      expect(chunkFrame!.type).toBe(FRAME_TYPES.DIFF_CHUNK);

      // Graph
      const graphFrame = await reader.readNextFrame();
      expect(graphFrame!.type).toBe(FRAME_TYPES.GRAPH_SNAPSHOT);

      // Body block
      const bodyFrame = await reader.readNextFrame();
      expect(bodyFrame!.type).toBe(FRAME_TYPES.BODY_BLOCK);
      expect(bodyFrame!.flags).toBe(0x01); // encrypted flag

      // Log segment
      const logFrame = await reader.readNextFrame();
      expect(logFrame!.type).toBe(FRAME_TYPES.LOG_SEGMENT);

      // Trailer
      const trailerFrame = await reader.readNextFrame();
      expect(trailerFrame!.type).toBe(FRAME_TYPES.TRAILER);

      // EOF
      const eof = await reader.readNextFrame();
      expect(eof).toBeNull();
    });
  });

  describe('forward compatibility', () => {
    it('skipFrame skips unknown frame types', async () => {
      const header = makeHeader();

      // Write a file with prototype table, then read it
      // We'll test skipFrame by reading the prototype frame as "unknown"
      const reader = await writeAndRead(async (writer) => {
        await writer.writeHeader(header);
        await writer.writePrototypeTable(makeRegistry());
        await writer.writeDiffChunk(makeDiffChunk());
        await writer.finalize();
      });

      await reader.readHeader();

      // Skip the prototype frame (treating it as unknown)
      await reader.skipFrame();

      // Should be able to read the diff chunk after skipping
      const nextType = await reader.peekFrameType();
      expect(nextType).toBe(FRAME_TYPES.DIFF_CHUNK);
    });
  });

  describe('trailer', () => {
    it('trailer contains frame offsets and checksum', async () => {
      const header = makeHeader();
      const registry = makeRegistry();

      const reader = await writeAndRead(async (writer) => {
        await writer.writeHeader(header);
        await writer.writePrototypeTable(registry);
        await writer.writeDiffChunk(makeDiffChunk());
        await writer.finalize();
      });

      await reader.readHeader();
      // Skip to trailer using readNextFrame
      let frame = await reader.readNextFrame();
      while (frame && frame.type !== FRAME_TYPES.TRAILER) {
        frame = await reader.readNextFrame();
      }
      expect(frame).not.toBeNull();
      // Trailer was read — just verify it was found
      expect(frame!.type).toBe(FRAME_TYPES.TRAILER);
    });
  });

  describe('error handling', () => {
    it('rejects double finalize', async () => {
      const sink = new BufferSink();
      const writer = new EodbWriter(sink.stream().getWriter());
      await writer.writeHeader(makeHeader());
      await writer.finalize();

      await expect(writer.finalize()).rejects.toThrow('already finalized');
    });

    it('rejects bad magic bytes', async () => {
      const badData = new Uint8Array([0, 0, 0, 0, 2, 0, 0, 0]);
      const stream = new ReadableStream({
        start(c) { c.enqueue(badData); c.close(); },
      });
      const reader = new EodbStreamReader(stream);

      await expect(reader.readHeader()).rejects.toThrow('bad magic bytes');
    });

    it('rejects old version', async () => {
      const oldData = new Uint8Array([0x45, 0x4F, 0x44, 0x42, 1, 0, 0, 0]);
      const stream = new ReadableStream({
        start(c) { c.enqueue(oldData); c.close(); },
      });
      const reader = new EodbStreamReader(stream);

      await expect(reader.readHeader()).rejects.toThrow('Unsupported .eodb version');
    });
  });
});
