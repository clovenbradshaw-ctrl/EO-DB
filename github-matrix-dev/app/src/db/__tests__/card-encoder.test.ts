/**
 * Card encoder tests — verifies round-trip encoding, chunk operations,
 * prototype lifecycle, card buffer scanning, and compaction.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  fnv1a,
  extractCard,
  encodeDiff,
  decodeDiff,
  packCard,
  unpackCard,
  decodeChunk,
  ChunkWriter,
  CardBuffer,
  buildCardBuffer,
  buildCardBufferProgressive,
  loadChunks,
  compact,
  initCardEncoder,
  shutdownCardEncoder,
  getChunkWriter,
  getCardBuffer,
  CARD_SIZE,
  type Card,
  type Prototype,
  type PrototypeRegistry,
  type DiffChunk,
  type LoadBatch,
  type CardBufferProgress,
} from '../card-encoder';
import type { EoStore } from '../encrypted-store';
import type { EoEvent, EoStateFold, LoggableOperator } from '../types';

// ─── Test helpers ────────────────────────────────────────────────────────

function createTestStore(): EoStore {
  const data = new Map<string, any>();
  let seq = 0;
  return {
    async get(key: string) { return data.has(key) ? data.get(key) : null; },
    async put(key: string, value: any) { data.set(key, value); },
    async del(key: string) { data.delete(key); },
    async iterator(prefix: string) {
      const results: [string, any][] = [];
      for (const [key, value] of data.entries()) {
        if (key >= prefix && key <= prefix + '\uffff') results.push([key, value]);
      }
      results.sort((a, b) => a[0].localeCompare(b[0]));
      return results;
    },
    async nextSeq() { return ++seq; },
    async getCurrentSeq() { return seq; },
    close() {},
  };
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    targetHash: fnv1a('test.entity.001'),
    temporalSeq: 42,
    lastTimestamp: 1700000000,
    dominantCell: 25,
    recentCell: 25,
    helixReach: 5,
    cellSpread: 3,
    eventCount: 10,
    graphDegree: 4,
    ...overrides,
  };
}

function makeFold(overrides: Partial<EoStateFold> = {}): EoStateFold {
  return {
    trajectory: [{ op: 'INS' as LoggableOperator, hash: 'abc' }, { op: 'DEF' as LoggableOperator, hash: 'def' }],
    trajectoryHead: 'def',
    trajectoryFingerprint: {
      sequence: 'INS.DEF',
      fingerprint: 'abcdef1234567890',
      opCounts: { NUL: 0, SIG: 0, INS: 1, SEG: 0, CON: 0, SYN: 0, DEF: 3, EVA: 0, REC: 0 },
    },
    cadence: { classification: 'steady', lastEventTs: '2025-01-01T00:05:00Z', eventCount: 4, description: 'Steady' },
    eventCount: 4,
    firstEventTs: '2025-01-01T00:00:00Z',
    lastEventTs: '2025-01-01T00:05:00Z',
    intervalsSorted: [60000],
    recentTimestamps: [1735689600000],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EoEvent> = {}): EoEvent {
  return {
    seq: 42,
    op: 'DEF' as LoggableOperator,
    target: 'app.tblClients.rec001.fldEmail',
    operand: 'test@example.com',
    agent: '@test:matrix.example.com',
    ts: '2025-01-01T00:05:00Z',
    acquired_ts: '2025-01-01T00:05:00Z',
    ...overrides,
  };
}

/** Create a minimal prototype for testing encodeDiff/decodeDiff. */
function makeProto(id: number, card: Card): Prototype {
  return {
    id,
    card: { ...card },
    count: 10,
    seqSum: card.temporalSeq * 10,
    tsSum: card.lastTimestamp * 10,
    eventCountSum: card.eventCount * 10,
    graphDegreeSum: card.graphDegree * 10,
    dominantCellCounts: new Array(27).fill(0),
    recentCellCounts: new Array(27).fill(0),
    helixReachCounts: new Array(9).fill(0),
    cellSpreadSum: card.cellSpread * 10,
    diffSizeSum: 80,
    diffSizeSqSum: 640,
    meanDiffSize: 8,
    diffSizeVariance: 0,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('fnv1a', () => {
  it('produces consistent hashes', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
    expect(fnv1a('hello')).not.toBe(fnv1a('world'));
  });

  it('produces uint32 values', () => {
    const h = fnv1a('test.entity.001');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xFFFFFFFF);
  });

  it('handles empty string', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
  });
});

describe('extractCard', () => {
  it('extracts card from fold state', () => {
    const event = makeEvent();
    const fold = makeFold();
    const card = extractCard(event.target, event, fold, 5);

    expect(card.targetHash).toBe(fnv1a(event.target));
    expect(card.temporalSeq).toBe(42);
    expect(card.lastTimestamp).toBe(Math.floor(new Date(event.ts).getTime() / 1000));
    expect(card.dominantCell).toBe(25); // DEF has highest count (3)
    expect(card.recentCell).toBe(25);   // event.op = DEF → cell 25
    expect(card.helixReach).toBe(5);    // DEF = helix 5
    expect(card.eventCount).toBe(4);
    expect(card.graphDegree).toBe(5);
  });

  it('caps eventCount at uint16 max', () => {
    const fold = makeFold({ eventCount: 100000 });
    const card = extractCard('test', makeEvent(), fold, 0);
    expect(card.eventCount).toBe(0xFFFF);
  });

  it('caps graphDegree at uint16 max', () => {
    const card = extractCard('test', makeEvent(), makeFold(), 70000);
    expect(card.graphDegree).toBe(0xFFFF);
  });
});

describe('packCard / unpackCard round-trip', () => {
  it('round-trips a card through binary packing', () => {
    const card = makeCard();
    const buf = new ArrayBuffer(CARD_SIZE);
    const dv = new DataView(buf);
    packCard(card, dv, 0);
    const result = unpackCard(dv, 0);
    expect(result).toEqual(card);
  });

  it('round-trips at non-zero offset', () => {
    const card = makeCard({ targetHash: 0xDEADBEEF, eventCount: 999 });
    const buf = new ArrayBuffer(CARD_SIZE + 20);
    const dv = new DataView(buf);
    packCard(card, dv, 20);
    const result = unpackCard(dv, 20);
    expect(result).toEqual(card);
  });
});

describe('encodeDiff / decodeDiff round-trip', () => {
  it('round-trips with identical fields (min diff = 8 bytes)', () => {
    const protoCard = makeCard({ temporalSeq: 40 });
    const proto = makeProto(1, protoCard);
    const card = makeCard({ temporalSeq: 42 });

    const diff = encodeDiff(card, proto.id, proto.card);
    expect(diff.length).toBe(8); // only base fields differ: targetHash always present + seqOffset

    const protoMap = new Map<number, Card>([[1, protoCard]]);
    const { card: decoded, bytesRead } = decodeDiff(diff, 0, protoMap);
    expect(bytesRead).toBe(8);
    expect(decoded.targetHash).toBe(card.targetHash);
    expect(decoded.temporalSeq).toBe(card.temporalSeq);
    expect(decoded.dominantCell).toBe(card.dominantCell);
    expect(decoded.recentCell).toBe(card.recentCell);
  });

  it('round-trips with all fields differing', () => {
    const protoCard = makeCard({
      temporalSeq: 10,
      dominantCell: 0,
      recentCell: 0,
      helixReach: 0,
      cellSpread: 1,
      eventCount: 1,
      graphDegree: 0,
    });
    const proto = makeProto(2, protoCard);
    const card = makeCard({
      temporalSeq: 42,
      dominantCell: 25,
      recentCell: 13,
      helixReach: 5,
      cellSpread: 4,
      eventCount: 100,
      graphDegree: 20,
    });

    const diff = encodeDiff(card, proto.id, proto.card);
    expect(diff.length).toBe(16); // 8 base + 1+1+1+1+2+2

    const protoMap = new Map<number, Card>([[2, protoCard]]);
    const { card: decoded, bytesRead } = decodeDiff(diff, 0, protoMap);
    expect(bytesRead).toBe(16);
    expect(decoded.targetHash).toBe(card.targetHash);
    expect(decoded.temporalSeq).toBe(card.temporalSeq);
    expect(decoded.dominantCell).toBe(card.dominantCell);
    expect(decoded.recentCell).toBe(card.recentCell);
    expect(decoded.helixReach).toBe(card.helixReach);
    expect(decoded.cellSpread).toBe(card.cellSpread);
    expect(decoded.eventCount).toBe(card.eventCount);
    expect(decoded.graphDegree).toBe(card.graphDegree);
  });

  it('uses full card escape for large seqOffset', () => {
    const protoCard = makeCard({ temporalSeq: 0 });
    const proto = makeProto(1, protoCard);
    const card = makeCard({ temporalSeq: 50000 }); // > 32767

    const diff = encodeDiff(card, proto.id, proto.card);
    expect(diff.length).toBe(22); // full card escape
    expect(diff[0]).toBe(0xFF);
    expect(diff[1]).toBe(0x80);

    const protoMap = new Map<number, Card>([[1, protoCard]]);
    const { card: decoded, bytesRead } = decodeDiff(diff, 0, protoMap);
    expect(bytesRead).toBe(22);
    expect(decoded).toEqual(card);
  });

  it('decodes at non-zero buffer offset', () => {
    const protoCard = makeCard({ temporalSeq: 40 });
    const proto = makeProto(1, protoCard);
    const card = makeCard({ temporalSeq: 42, recentCell: 13 });

    const diff = encodeDiff(card, proto.id, proto.card);
    // Embed diff in a larger buffer at offset 10
    const outer = new Uint8Array(diff.length + 10);
    outer.set(diff, 10);

    const protoMap = new Map<number, Card>([[1, protoCard]]);
    const { card: decoded, bytesRead } = decodeDiff(outer, 10, protoMap);
    expect(decoded.targetHash).toBe(card.targetHash);
    expect(decoded.recentCell).toBe(13);
    expect(bytesRead).toBe(diff.length);
  });
});

describe('decodeChunk', () => {
  it('decodes a chunk of diffs', () => {
    const protoCard = makeCard({ temporalSeq: 10 });
    const proto = makeProto(1, protoCard);

    const cards = [
      makeCard({ targetHash: fnv1a('a'), temporalSeq: 11 }),
      makeCard({ targetHash: fnv1a('b'), temporalSeq: 12, recentCell: 13 }),
      makeCard({ targetHash: fnv1a('c'), temporalSeq: 13, helixReach: 6 }),
    ];

    // Manually encode diffs
    const diffs: Uint8Array[] = cards.map(c => encodeDiff(c, proto.id, proto.card));
    const totalLen = diffs.reduce((s, d) => s + d.length, 0);
    const combined = new Uint8Array(totalLen);
    let off = 0;
    for (const d of diffs) { combined.set(d, off); off += d.length; }

    const chunk: DiffChunk = {
      chunkId: 0,
      prototypeCount: 1,
      prototypeIds: [1],
      prototypeSnapshot: [protoCard],
      baseTimestamp: 1700000000,
      diffs: combined,
      count: 3,
      byteLength: totalLen,
    };

    const decoded = decodeChunk(chunk);
    expect(decoded).toHaveLength(3);
    expect(decoded[0].targetHash).toBe(fnv1a('a'));
    expect(decoded[1].recentCell).toBe(13);
    expect(decoded[2].helixReach).toBe(6);
  });
});

describe('CardBuffer', () => {
  let buffer: CardBuffer;

  beforeEach(() => {
    buffer = new CardBuffer(4); // small initial capacity to test growth
  });

  it('inserts and retrieves cards', () => {
    const card = makeCard();
    buffer.upsert(card);
    expect(buffer.size).toBe(1);

    const retrieved = buffer.get(card.targetHash);
    expect(retrieved).toEqual(card);
  });

  it('upserts (updates existing card)', () => {
    const card1 = makeCard({ eventCount: 5 });
    const card2 = makeCard({ eventCount: 10 });
    buffer.upsert(card1);
    buffer.upsert(card2);
    expect(buffer.size).toBe(1); // same targetHash, updated in place
    expect(buffer.get(card1.targetHash)!.eventCount).toBe(10);
  });

  it('grows when capacity is exceeded', () => {
    for (let i = 0; i < 10; i++) {
      buffer.upsert(makeCard({ targetHash: i + 1 }));
    }
    expect(buffer.size).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(buffer.has(i + 1)).toBe(true);
    }
  });

  it('scans with predicate', () => {
    buffer.upsert(makeCard({ targetHash: 1, helixReach: 3 }));
    buffer.upsert(makeCard({ targetHash: 2, helixReach: 5 }));
    buffer.upsert(makeCard({ targetHash: 3, helixReach: 7 }));

    const advanced = buffer.scan(c => c.helixReach >= 5);
    expect(advanced).toHaveLength(2);
  });

  it('sorts cards', () => {
    buffer.upsert(makeCard({ targetHash: 1, temporalSeq: 30 }));
    buffer.upsert(makeCard({ targetHash: 2, temporalSeq: 10 }));
    buffer.upsert(makeCard({ targetHash: 3, temporalSeq: 20 }));

    const sorted = buffer.sorted((a, b) => a.temporalSeq - b.temporalSeq);
    expect(sorted.map(c => c.temporalSeq)).toEqual([10, 20, 30]);
  });

  it('returns null for missing hash', () => {
    expect(buffer.get(999)).toBeNull();
    expect(buffer.has(999)).toBe(false);
  });
});

describe('ChunkWriter', () => {
  let store: EoStore;

  beforeEach(() => {
    store = createTestStore();
  });

  it('writes and flushes a chunk to the store', async () => {
    const reg: PrototypeRegistry = { prototypes: new Map(), nextId: 1 };
    const writer = new ChunkWriter(store, reg, 0);

    const card = makeCard();
    await writer.addRecord(card);
    await writer.flushChunk();

    const chunk = await store.get('chunk:000000');
    expect(chunk).not.toBeNull();
    expect(chunk.count).toBe(1);
    expect(chunk.prototypeCount).toBeGreaterThanOrEqual(1);
  });

  it('creates prototypes on first write', async () => {
    const reg: PrototypeRegistry = { prototypes: new Map(), nextId: 1 };
    const writer = new ChunkWriter(store, reg, 0);

    await writer.addRecord(makeCard());
    expect(reg.prototypes.size).toBe(1);
  });

  it('round-trips through write + buildCardBuffer', async () => {
    const reg: PrototypeRegistry = { prototypes: new Map(), nextId: 1 };
    const writer = new ChunkWriter(store, reg, 0);

    const cards = [
      makeCard({ targetHash: fnv1a('a'), temporalSeq: 1 }),
      makeCard({ targetHash: fnv1a('b'), temporalSeq: 2, recentCell: 13 }),
      makeCard({ targetHash: fnv1a('c'), temporalSeq: 3, helixReach: 7 }),
    ];

    for (const c of cards) await writer.addRecord(c);
    await writer.shutdown();

    const buffer = await buildCardBuffer(store);
    expect(buffer.size).toBe(3);

    const a = buffer.get(fnv1a('a'));
    expect(a).not.toBeNull();
    expect(a!.temporalSeq).toBe(1);

    const b = buffer.get(fnv1a('b'));
    expect(b!.recentCell).toBe(13);

    const c = buffer.get(fnv1a('c'));
    expect(c!.helixReach).toBe(7);
  });

  it('deduplicates by targetHash (latest temporalSeq wins)', async () => {
    const reg: PrototypeRegistry = { prototypes: new Map(), nextId: 1 };
    const writer = new ChunkWriter(store, reg, 0);

    // Write same entity twice with different seqs
    await writer.addRecord(makeCard({ targetHash: fnv1a('x'), temporalSeq: 1, eventCount: 5 }));
    await writer.addRecord(makeCard({ targetHash: fnv1a('x'), temporalSeq: 2, eventCount: 10 }));
    await writer.shutdown();

    const buffer = await buildCardBuffer(store);
    expect(buffer.size).toBe(1);
    expect(buffer.get(fnv1a('x'))!.eventCount).toBe(10);
  });
});

describe('compact', () => {
  it('removes stale entries and rewrites chunks', async () => {
    const store = createTestStore();
    const reg: PrototypeRegistry = { prototypes: new Map(), nextId: 1 };
    const writer = new ChunkWriter(store, reg, 0);

    // Write entity twice across chunks
    await writer.addRecord(makeCard({ targetHash: fnv1a('x'), temporalSeq: 1, eventCount: 5 }));
    await writer.flushChunk();
    await writer.addRecord(makeCard({ targetHash: fnv1a('x'), temporalSeq: 2, eventCount: 10 }));
    await writer.addRecord(makeCard({ targetHash: fnv1a('y'), temporalSeq: 3, eventCount: 1 }));
    await writer.shutdown();

    // Verify pre-compaction state: 2 chunks
    const preChunks = await store.iterator('chunk:');
    expect(preChunks.length).toBe(2);

    await compact(store);

    // Post-compaction: only current cards remain
    const buffer = await buildCardBuffer(store);
    expect(buffer.size).toBe(2);
    expect(buffer.get(fnv1a('x'))!.eventCount).toBe(10); // latest version
    expect(buffer.get(fnv1a('y'))!.eventCount).toBe(1);
  });
});

describe('initCardEncoder / shutdownCardEncoder', () => {
  it('initializes writer and buffer, then shuts down cleanly', async () => {
    const store = createTestStore();

    const buffer = await initCardEncoder(store);
    expect(buffer).toBeInstanceOf(CardBuffer);
    expect(buffer.size).toBe(0);
    expect(getChunkWriter()).not.toBeNull();
    expect(getCardBuffer()).toBe(buffer);

    await shutdownCardEncoder();
    expect(getChunkWriter()).toBeNull();
    expect(getCardBuffer()).toBeNull();
  });

  it('restores from persisted state', async () => {
    const store = createTestStore();

    // Session 1: write some cards
    const buf1 = await initCardEncoder(store);
    const writer1 = getChunkWriter()!;
    await writer1.addRecord(makeCard({ targetHash: fnv1a('a'), temporalSeq: 1 }));
    await writer1.addRecord(makeCard({ targetHash: fnv1a('b'), temporalSeq: 2 }));
    await shutdownCardEncoder();

    // Session 2: init should restore from IDB
    const buf2 = await initCardEncoder(store);
    expect(buf2.size).toBe(2);
    expect(buf2.has(fnv1a('a'))).toBe(true);
    expect(buf2.has(fnv1a('b'))).toBe(true);
    await shutdownCardEncoder();
  });
});

describe('verification: decodeDiff(encodeDiff(card, proto.id, proto.card), proto) === card', () => {
  it('holds for many card variations', () => {
    const variations: Partial<Card>[] = [
      {},
      { dominantCell: 0, recentCell: 0, helixReach: 0, cellSpread: 1, eventCount: 1, graphDegree: 0 },
      { dominantCell: 26, recentCell: 26, helixReach: 7, cellSpread: 27, eventCount: 65535, graphDegree: 65535 },
      { temporalSeq: 100, eventCount: 500, graphDegree: 50 },
      { dominantCell: 13, recentCell: 4 },
    ];

    const protoCard = makeCard({ temporalSeq: 40 });
    const proto = makeProto(1, protoCard);
    const protoMap = new Map<number, Card>([[1, protoCard]]);

    for (const v of variations) {
      const card = makeCard({ temporalSeq: 42, ...v });
      const diff = encodeDiff(card, proto.id, proto.card);
      const { card: decoded } = decodeDiff(diff, 0, protoMap);

      // Fields stored in diff must match exactly
      expect(decoded.targetHash).toBe(card.targetHash);
      expect(decoded.temporalSeq).toBe(card.temporalSeq);
      expect(decoded.dominantCell).toBe(card.dominantCell);
      expect(decoded.recentCell).toBe(card.recentCell);
      expect(decoded.helixReach).toBe(card.helixReach);
      expect(decoded.cellSpread).toBe(card.cellSpread);
      expect(decoded.eventCount).toBe(card.eventCount);
      expect(decoded.graphDegree).toBe(card.graphDegree);
    }
  });
});

// ─── Phase 2: Progressive Loading ──────────────────────────────────────

describe('loadChunks async generator', () => {
  it('yields prototypes phase first on empty store', async () => {
    const store = createTestStore();
    const batches: LoadBatch[] = [];
    for await (const batch of loadChunks(store)) batches.push(batch);

    expect(batches).toHaveLength(1);
    expect(batches[0].phase).toBe('prototypes');
    expect(batches[0].cards).toHaveLength(0);
    expect(batches[0].registry).toBeDefined();
  });

  it('yields prototypes then card batches per chunk', async () => {
    const store = createTestStore();
    const reg: PrototypeRegistry = { prototypes: new Map(), nextId: 1 };
    const writer = new ChunkWriter(store, reg, 0);

    await writer.addRecord(makeCard({ targetHash: fnv1a('a'), temporalSeq: 1 }));
    await writer.flushChunk();
    await writer.addRecord(makeCard({ targetHash: fnv1a('b'), temporalSeq: 2 }));
    await writer.shutdown();

    const batches: LoadBatch[] = [];
    for await (const batch of loadChunks(store)) batches.push(batch);

    // 1 prototype batch + 2 chunk batches
    expect(batches).toHaveLength(3);
    expect(batches[0].phase).toBe('prototypes');
    expect(batches[1].phase).toBe('cards');
    expect(batches[1].chunkIndex).toBe(1);
    expect(batches[1].chunkCount).toBe(2);
    expect(batches[1].cards.length).toBeGreaterThanOrEqual(1);
    expect(batches[2].phase).toBe('cards');
    expect(batches[2].chunkIndex).toBe(2);
    expect(batches[2].chunkCount).toBe(2);
  });
});

describe('buildCardBufferProgressive', () => {
  it('emits overview callback before any cards', async () => {
    const store = createTestStore();
    const reg: PrototypeRegistry = { prototypes: new Map(), nextId: 1 };
    const writer = new ChunkWriter(store, reg, 0);

    await writer.addRecord(makeCard({ targetHash: fnv1a('a'), temporalSeq: 1 }));
    await writer.addRecord(makeCard({ targetHash: fnv1a('b'), temporalSeq: 2 }));
    await writer.shutdown();

    const stages: string[] = [];
    const entityCounts: number[] = [];

    const buffer = await buildCardBufferProgressive(store, (progress) => {
      stages.push(progress.stage);
      entityCounts.push(progress.entityCount);
    });

    expect(stages[0]).toBe('overview');
    expect(entityCounts[0]).toBe(0); // no cards loaded yet at overview
    expect(stages.slice(1).every(s => s === 'chunk')).toBe(true);
    expect(buffer.size).toBe(2);
  });

  it('deduplicates across chunks (latest seq wins)', async () => {
    const store = createTestStore();
    const reg: PrototypeRegistry = { prototypes: new Map(), nextId: 1 };
    const writer = new ChunkWriter(store, reg, 0);

    await writer.addRecord(makeCard({ targetHash: fnv1a('x'), temporalSeq: 1, eventCount: 5 }));
    await writer.flushChunk();
    await writer.addRecord(makeCard({ targetHash: fnv1a('x'), temporalSeq: 2, eventCount: 10 }));
    await writer.shutdown();

    const buffer = await buildCardBufferProgressive(store);
    expect(buffer.size).toBe(1);
    expect(buffer.get(fnv1a('x'))!.eventCount).toBe(10);
  });

  it('entity count increases monotonically across progress callbacks', async () => {
    const store = createTestStore();
    const reg: PrototypeRegistry = { prototypes: new Map(), nextId: 1 };
    const writer = new ChunkWriter(store, reg, 0);

    // Spread entities across 3 chunks
    for (let i = 0; i < 3; i++) {
      await writer.addRecord(makeCard({ targetHash: fnv1a(`entity-${i}`), temporalSeq: i + 1 }));
      await writer.flushChunk();
    }
    await writer.shutdown();

    const counts: number[] = [];
    await buildCardBufferProgressive(store, (progress) => {
      if (progress.stage === 'chunk') counts.push(progress.entityCount);
    });

    // Each chunk adds one unique entity
    expect(counts).toEqual([1, 2, 3]);
  });
});

describe('initCardEncoder with progressive loading', () => {
  it('fires onProgress callbacks during initialization', async () => {
    const store = createTestStore();

    // Pre-populate with data
    const reg: PrototypeRegistry = { prototypes: new Map(), nextId: 1 };
    const writer = new ChunkWriter(store, reg, 0);
    await writer.addRecord(makeCard({ targetHash: fnv1a('a'), temporalSeq: 1 }));
    await writer.addRecord(makeCard({ targetHash: fnv1a('b'), temporalSeq: 2 }));
    await writer.shutdown();

    const progressEvents: CardBufferProgress[] = [];
    const buffer = await initCardEncoder(store, (p) => progressEvents.push(p));

    expect(progressEvents.length).toBeGreaterThanOrEqual(2); // overview + at least 1 chunk
    expect(progressEvents[0].stage).toBe('overview');
    expect(buffer.size).toBe(2);
    expect(getChunkWriter()).not.toBeNull();

    await shutdownCardEncoder();
  });

  it('works without onProgress (backward compatible)', async () => {
    const store = createTestStore();
    const buffer = await initCardEncoder(store);
    expect(buffer).toBeInstanceOf(CardBuffer);
    expect(getChunkWriter()).not.toBeNull();
    await shutdownCardEncoder();
  });

  it('restores from persisted state with progressive loading', async () => {
    const store = createTestStore();

    // Session 1: write cards
    await initCardEncoder(store);
    const writer1 = getChunkWriter()!;
    await writer1.addRecord(makeCard({ targetHash: fnv1a('a'), temporalSeq: 1 }));
    await writer1.addRecord(makeCard({ targetHash: fnv1a('b'), temporalSeq: 2 }));
    await shutdownCardEncoder();

    // Session 2: progressive init should restore
    let overviewFired = false;
    const buf2 = await initCardEncoder(store, (p) => {
      if (p.stage === 'overview') overviewFired = true;
    });

    expect(overviewFired).toBe(true);
    expect(buf2.size).toBe(2);
    expect(buf2.has(fnv1a('a'))).toBe(true);
    expect(buf2.has(fnv1a('b'))).toBe(true);
    await shutdownCardEncoder();
  });
});
