/**
 * Encoding claim protocol — coordinates .eodb encoding across devices.
 *
 * Only one device encodes at a time. Claims are broadcast via Matrix state
 * events, following the same CAS pattern as snapshot claims. The protocol
 * guarantees:
 *   - No duplicate encoding (normal case): claim + clientId tiebreaker.
 *   - No data loss on collision: idempotent encoding, last upload wins.
 *   - No stale reads: old .eodb + more loose events = correct final state.
 */

import type { EoStore } from '../db/encrypted-store';
import { compact, buildCardBufferProgressive, type CardBuffer, type CardBufferProgress } from '../db/card-encoder';
import { EodbWriter, EodbStreamReader, BufferSink, FRAME_TYPES } from '../db/eodb';
import type { CollectionHeader } from '../db/eodb';
import { decodeChunk, type DiffChunk } from '../db/card-encoder';
import { buildCSR, serializeCSR, deserializeCSR } from '../db/graph-store';

// ─── Constants ──────────────────────────────────────────────────────────

const CLAIM_TTL_MS = 5 * 60 * 1000;       // 5 minutes
const CLAIM_JITTER_MIN_MS = 1500;
const CLAIM_JITTER_MAX_MS = 2500;
const MIN_LOOSE_EVENTS = 500;
const MAX_ENCODING_GAP_MS = 24 * 60 * 60 * 1000;  // 24 hours

// ─── Types ──────────────────────────────────────────────────────────────

export interface EncodingClaim {
  type: 'encoding_claim';
  clientId: string;
  claimedThrough: number;
  timestamp: number;
  status: 'pending' | 'complete' | 'failed';
}

export interface EncodingComplete {
  type: 'encoding_complete';
  clientId: string;
  encodedThrough: number;
  fileVersion: number;
  fileHash: number;           // FNV-1a checksum from .eodb trailer
  fileUuid?: string;          // Filen file UUID
  fileKey?: string;           // Filen file key for decryption
}

/** Dependency-injected Matrix client interface. */
export interface EncodingMatrixClient {
  getDeviceId(): string;
  /** Read the current encoding claim state event from the room. */
  getEncodingClaim(roomId: string): EncodingClaim | null;
  /** Read the latest encoding_complete state event. */
  getEncodingComplete(roomId: string): EncodingComplete | null;
  /** Write an encoding claim state event. */
  setEncodingClaim(roomId: string, claim: EncodingClaim): Promise<void>;
  /** Write an encoding_complete state event. */
  setEncodingComplete(roomId: string, complete: EncodingComplete): Promise<void>;
  /** Get events since a given sequence number (for catching up loose events). */
  getEventsSince(roomId: string, sinceSeq: number): Promise<any[]>;
}

/** Dependency-injected Filen client interface. */
export interface EncodingFilenClient {
  uploadFile(fileName: string, data: Uint8Array): Promise<{ uuid: string; fileKey: string }>;
  downloadFile(fileUuid: string, fileKey: string): Promise<Uint8Array>;
}

/** Dependency-injected fold function for catching up loose events. */
export type FoldFunction = (event: any) => { targetHash: number; card: any } | null;

// ─── Decision Logic ─────────────────────────────────────────────────────

/**
 * Determine whether this device should attempt encoding.
 *
 * Triggers:
 *   - ≥500 loose events since last encoding
 *   - Session boundary (going idle / logout)
 *   - No encoding in 24 hours
 *   - Startup with large backlog
 */
export function shouldEncode(
  looseEventCount: number,
  lastEncodingTs: number,
  isIdle: boolean,
): boolean {
  if (looseEventCount >= MIN_LOOSE_EVENTS) return true;
  if (isIdle && looseEventCount > 0) return true;
  if (lastEncodingTs > 0 && Date.now() - lastEncodingTs > MAX_ENCODING_GAP_MS) return true;
  return false;
}

// ─── Claim Protocol ─────────────────────────────────────────────────────

function isClaimStale(claim: EncodingClaim, now: number = Date.now()): boolean {
  if (claim.status !== 'pending') return false;
  return now - claim.timestamp > CLAIM_TTL_MS;
}

function isClaimableByUs(
  existing: EncodingClaim | null,
  myClientId: string,
  now: number = Date.now(),
): boolean {
  if (!existing) return true;
  if (existing.status === 'complete' || existing.status === 'failed') return true;
  if (isClaimStale(existing, now)) return true;
  return existing.clientId === myClientId;
}

/**
 * Attempt to claim the encoding job. Returns true if we successfully
 * acquired the claim.
 *
 * Protocol:
 *   1. Check for existing active claims (expire after 5 min).
 *   2. Send encoding_claim state event.
 *   3. Wait 1.5-2.5s (jittered) for conflicting claims.
 *   4. Re-read claim. If another device claimed with lower clientId, back off.
 */
export async function claimEncoding(
  matrix: EncodingMatrixClient,
  roomId: string,
  clientId: string,
  throughSeq: number,
): Promise<boolean> {
  const existing = matrix.getEncodingClaim(roomId);
  if (!isClaimableByUs(existing, clientId)) return false;

  const claim: EncodingClaim = {
    type: 'encoding_claim',
    clientId,
    claimedThrough: throughSeq,
    timestamp: Date.now(),
    status: 'pending',
  };
  await matrix.setEncodingClaim(roomId, claim);

  // Jitter to allow conflicting claims to land
  const jitter = CLAIM_JITTER_MIN_MS +
    Math.random() * (CLAIM_JITTER_MAX_MS - CLAIM_JITTER_MIN_MS);
  await new Promise<void>(resolve => setTimeout(resolve, jitter));

  // Re-check: did another device claim?
  const afterWrite = matrix.getEncodingClaim(roomId);
  if (!afterWrite) return true;
  if (afterWrite.clientId !== clientId && afterWrite.status === 'pending') {
    // Lower clientId wins ties
    if (afterWrite.clientId < clientId) return false;
  }
  return afterWrite.clientId === clientId;
}

// ─── Encoding Pipeline ──────────────────────────────────────────────────

/**
 * Full encoding pipeline:
 *   1. Claim encoding via Matrix state event.
 *   2. Compact local chunks.
 *   3. Build .eodb via EodbWriter (card-only export).
 *   4. Upload to Filen.
 *   5. Broadcast encoding_complete.
 */
export async function performEncoding(
  store: EoStore,
  matrix: EncodingMatrixClient,
  filen: EncodingFilenClient,
  roomId: string,
  clientId: string,
  collectionId: string,
  collectionName: string,
): Promise<boolean> {
  const currentSeq = await store.getCurrentSeq();

  // 1. Claim
  const claimed = await claimEncoding(matrix, roomId, clientId, currentSeq);
  if (!claimed) return false;

  try {
    // 2. Compact
    await compact(store);

    // 3. Build .eodb
    const cardBuffer = await buildCardBufferProgressive(store);
    const csrGraph = await buildCSR(store, cardBuffer);
    const csrBytes = serializeCSR(csrGraph);

    const sink = new BufferSink();
    const writer = new EodbWriter(sink.stream().getWriter());

    const header: CollectionHeader = {
      collectionId,
      name: collectionName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      encodedThrough: currentSeq,
      fileVersion: getNextFileVersion(matrix, roomId),
    };

    await writer.writeHeader(header);

    // Write chunks from IDB
    const chunks = await store.iterator('chunk:');
    for (const [, chunk] of chunks) {
      await writer.writeDiffChunk(chunk as DiffChunk);
    }

    await writer.writeGraphSnapshot(csrBytes);
    await writer.finalize();

    const eodbData = sink.toUint8Array();

    // 4. Upload to Filen
    const fileName = `${collectionId}.eodb`;
    const { uuid, fileKey } = await filen.uploadFile(fileName, eodbData);

    // 5. Broadcast completion
    // Extract checksum from the trailer data (it's the FNV-1a of all bytes before trailer)
    const complete: EncodingComplete = {
      type: 'encoding_complete',
      clientId,
      encodedThrough: currentSeq,
      fileVersion: header.fileVersion,
      fileHash: computeFileHash(eodbData),
      fileUuid: uuid,
      fileKey: fileKey,
    };
    await matrix.setEncodingComplete(roomId, complete);

    // Mark claim as complete
    const doneClaim: EncodingClaim = {
      type: 'encoding_claim',
      clientId,
      claimedThrough: currentSeq,
      timestamp: Date.now(),
      status: 'complete',
    };
    await matrix.setEncodingClaim(roomId, doneClaim);

    return true;
  } catch (err) {
    // Mark claim as failed
    const failClaim: EncodingClaim = {
      type: 'encoding_claim',
      clientId,
      claimedThrough: currentSeq,
      timestamp: Date.now(),
      status: 'failed',
    };
    await matrix.setEncodingClaim(roomId, failClaim);
    throw err;
  }
}

function getNextFileVersion(matrix: EncodingMatrixClient, roomId: string): number {
  const last = matrix.getEncodingComplete(roomId);
  return (last?.fileVersion ?? 0) + 1;
}

// ─── FNV-1a file hash ───────────────────────────────────────────────────

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function computeFileHash(data: Uint8Array): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

// ─── Hydration ──────────────────────────────────────────────────────────

/**
 * Hydrate a device from the latest .eodb file + loose events.
 *
 * Flow:
 *   1. Get last encoding_complete from Matrix room state.
 *   2. Download .eodb from Filen.
 *   3. Stream-read prototypes → immediate overview callback.
 *   4. Stream-read diff chunks → deduplicate into CardBuffer.
 *   5. Catch up with loose events since encodedThrough.
 *   6. Return the hydrated CardBuffer.
 *
 * If no .eodb exists, builds from local IDB.
 */
export async function hydrate(
  store: EoStore,
  matrix: EncodingMatrixClient,
  filen: EncodingFilenClient,
  roomId: string,
  foldFn: FoldFunction,
  onProgress?: (stage: string, count: number) => void,
): Promise<CardBuffer> {
  const lastComplete = matrix.getEncodingComplete(roomId);

  if (!lastComplete?.fileUuid || !lastComplete?.fileKey) {
    // No .eodb available — build from local IDB
    onProgress?.('local', 0);
    const buffer = await buildCardBufferProgressive(store, (p) => {
      onProgress?.(p.stage, p.entityCount);
    });
    return buffer;
  }

  // 1. Download .eodb
  onProgress?.('download', 0);
  const eodbData = await filen.downloadFile(lastComplete.fileUuid, lastComplete.fileKey);

  // 2. Stream-read
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(eodbData); c.close(); },
  });
  const reader = new EodbStreamReader(stream);

  const { CardBuffer: CB } = await import('../db/card-encoder');
  const cardBuffer = new (CB as any)() as CardBuffer;
  const latestSeq = new Map<number, number>();

  // Read header
  await reader.readHeader();

  // Read frames until trailer/EOF
  let frame = await reader.readNextFrame();
  while (frame) {
    if (frame.type === FRAME_TYPES.DIFF_CHUNK) {
      const { unpack } = await import('msgpackr');
      const chunk = unpack(frame.payload) as DiffChunk;
      // Ensure diffs is Uint8Array
      const diffs = chunk.diffs instanceof Uint8Array
        ? chunk.diffs
        : new Uint8Array(chunk.diffs as any);

      const cards = decodeChunk({ ...chunk, diffs });
      for (const card of cards) {
        const prev = latestSeq.get(card.targetHash);
        if (prev === undefined || card.temporalSeq > prev) {
          cardBuffer.upsert(card);
          latestSeq.set(card.targetHash, card.temporalSeq);
        }
      }
      onProgress?.('chunk', cardBuffer.size);
    } else if (frame.type === FRAME_TYPES.TRAILER || frame.type === FRAME_TYPES.EOF) {
      break;
    }
    // Skip unknown frame types (forward compatible)
    frame = await reader.readNextFrame();
  }

  onProgress?.('cards_loaded', cardBuffer.size);

  // 3. Catch up with loose events since .eodb was built
  const looseEvents = await matrix.getEventsSince(roomId, lastComplete.encodedThrough);
  for (const event of looseEvents) {
    const result = foldFn(event);
    if (result) {
      cardBuffer.upsert(result.card);
    }
  }

  onProgress?.('hydrated', cardBuffer.size);

  // 4. Populate local IDB for subsequent opens
  await populateLocalIdb(store, cardBuffer);

  return cardBuffer;
}

/**
 * Populate local IDB with cards from the hydrated buffer,
 * so subsequent opens can load from local storage without downloading.
 */
async function populateLocalIdb(store: EoStore, buffer: CardBuffer): Promise<void> {
  const { ChunkWriter } = await import('../db/card-encoder');

  // Create a fresh prototype registry for local storage
  const registry = { prototypes: new Map(), nextId: 1 };
  const writer = new ChunkWriter(store, registry, 0);

  // Clear old chunks
  const oldChunks = await store.iterator('chunk:');
  for (const [key] of oldChunks) {
    await store.del(key);
  }

  const cards = buffer.toArray();
  for (const card of cards) {
    await writer.addRecord(card);
  }
  await writer.shutdown();
}
