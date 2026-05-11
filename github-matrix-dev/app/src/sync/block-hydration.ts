/**
 * Block-chain hydration — replaces the snapshot-chain walk.
 *
 * Four phases:
 *   1. Read `m.eo.head` state event.
 *   2. Walk the block chain backwards (`prior_block_event_id`) to gather
 *      every block-message-event in the chain.
 *   3. Download + decrypt every block in parallel; parse the `.eodb`.
 *   4. Apply events to the fold engine in chain order, then walk the room
 *      timeline forward from `tail_cutoff_event_id` and apply tail events.
 *
 * Failure modes are fatal: a missing block on `mxc://` or a hash mismatch
 * surfaces to the caller. There is no fallback storage.
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import {
  EO_EVENT_TYPE,
  EO_BLOCK_TYPE,
  downloadEncryptedAttachment,
  matrixEventToEo,
} from '../matrix/event-bridge';
import { EodbStreamReader, FRAME_TYPES } from '../db/eodb';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput, EoEvent } from '../db/types';
import { processEvent } from '../db/fold';
import { readHeadState, type BlockMessage } from './block-sealer';

// ─── Block event fetch ─────────────────────────────────────────────────

/**
 * Fetch a block message event by id. Prefers the live-timeline cache when
 * available; falls back to {@link MatrixClient.fetchRoomEvent} so older
 * blocks that have aged out of the local timeline are still reachable.
 *
 * Returns the parsed content (`BlockMessage`) plus the event id so callers
 * can recurse via `prior_block_event_id`.
 */
async function fetchBlockMessage(
  client: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<BlockMessage> {
  const room = client.getRoom(roomId);
  const local = room?.findEventById?.(eventId) as MatrixEvent | undefined;
  if (local) {
    const content = local.getContent() as Partial<BlockMessage>;
    if (content.file && typeof content.block_index === 'number') {
      return content as BlockMessage;
    }
  }

  // Slow path: HTTP fetch. The SDK decrypts Megolm transparently on read
  // so the returned content has the cleartext block metadata.
  const raw: any = await (client as any).fetchRoomEvent?.(roomId, eventId);
  if (!raw) {
    throw new Error(`Block event ${eventId} not found in room ${roomId}`);
  }
  const content = (raw.content ?? raw) as Partial<BlockMessage>;
  if (!content.file || typeof content.block_index !== 'number') {
    throw new Error(`Event ${eventId} is not a well-formed m.eo.block (missing file/index)`);
  }
  return content as BlockMessage;
}

/**
 * Walk the chain backwards from the latest block. Returns the chain in
 * chronological order (genesis first, head last).
 */
export async function walkBlockChain(
  client: MatrixClient,
  roomId: string,
  latestBlockEventId: string,
): Promise<Array<{ eventId: string; content: BlockMessage }>> {
  const chain: Array<{ eventId: string; content: BlockMessage }> = [];
  let cursor: string | null = latestBlockEventId;
  const seen = new Set<string>();

  while (cursor) {
    if (seen.has(cursor)) {
      throw new Error(`Block chain cycle detected at ${cursor}`);
    }
    seen.add(cursor);

    const block = await fetchBlockMessage(client, roomId, cursor);
    chain.push({ eventId: cursor, content: block });
    cursor = block.prior_block_event_id;
  }

  chain.reverse();
  return chain;
}

// ─── Block payload reading ─────────────────────────────────────────────

/**
 * Decode an `.eodb` block payload into the event list it carries.
 * Reads only the LOG_SEGMENT frames; other frame types are skipped
 * (forward-compatible).
 */
export async function readBlockEvents(payload: Uint8Array): Promise<EoEvent[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(payload); c.close(); },
  });
  const reader = new EodbStreamReader(stream);
  await reader.readHeader();

  const events: EoEvent[] = [];
  let frame = await reader.readNextFrame();
  while (frame) {
    if (frame.type === FRAME_TYPES.LOG_SEGMENT) {
      const { unpack } = await import('msgpackr');
      const segEvents = unpack(frame.payload) as EoEvent[];
      events.push(...segEvents);
    } else if (frame.type === FRAME_TYPES.TRAILER || frame.type === FRAME_TYPES.EOF) {
      break;
    }
    frame = await reader.readNextFrame();
  }
  return events;
}

// ─── Schema dispatch ───────────────────────────────────────────────────

/**
 * Apply a block's events to the store. Currently every schema version
 * dispatches to the same `processEvent` — the switch is here so future
 * schema bumps (e.g. operand-shape changes) can branch without touching
 * the surrounding hydration code.
 */
async function applyBlockEvents(
  store: EoStore,
  events: EoEventInput[],
  schemaVersion: string,
  onEvent?: (ev: EoEvent) => void,
): Promise<void> {
  switch (schemaVersion) {
    case 'eo-2026-04':
    default:
      for (const ev of events) {
        await processEvent(store, ev, onEvent);
      }
      return;
  }
}

// ─── Tail walk ─────────────────────────────────────────────────────────

/**
 * Walk the room timeline forward from `cutoffEventId` and fold every EO
 * event found. If `cutoffEventId` is null, the entire timeline is folded
 * (room has no sealed blocks yet).
 */
async function applyTail(
  client: MatrixClient,
  roomId: string,
  cutoffEventId: string | null,
  store: EoStore,
  onEvent?: (ev: EoEvent) => void,
): Promise<number> {
  const room = client.getRoom(roomId);
  if (!room) return 0;

  const timeline = room.getLiveTimeline().getEvents();
  let passedCutoff = cutoffEventId === null;
  let applied = 0;

  for (const ev of timeline) {
    if (!passedCutoff) {
      if (ev.getId() === cutoffEventId) passedCutoff = true;
      continue;
    }
    if (ev.getType() !== EO_EVENT_TYPE) continue;
    await processEvent(store, matrixEventToEo(ev), onEvent);
    applied++;
  }
  return applied;
}

// ─── Top-level entry point ─────────────────────────────────────────────

export interface HydrationProgress {
  phase: 'head' | 'chain' | 'download' | 'apply' | 'tail' | 'done';
  blockCount?: number;
  eventCount?: number;
  tailEventCount?: number;
}

export interface HydrationResult {
  blockCount: number;
  blockEventCount: number;
  tailEventCount: number;
}

/**
 * Hydrate the local store from the block chain + tail.
 *
 * No-ops cleanly if the room has no `m.eo.head` yet: phase 1 returns an
 * empty head, phases 2–4 short-circuit, phase 5 still walks the entire
 * timeline (which for a brand-new room is empty / very small).
 */
export async function hydrateFromBlocks(
  client: MatrixClient,
  roomId: string,
  store: EoStore,
  onEvent?: (ev: EoEvent) => void,
  onProgress?: (p: HydrationProgress) => void,
): Promise<HydrationResult> {
  onProgress?.({ phase: 'head' });
  const head = readHeadState(client, roomId);

  if (!head.latest_block_event_id) {
    // Brand-new room: nothing sealed yet. Fold the entire timeline.
    onProgress?.({ phase: 'tail' });
    const tailApplied = await applyTail(client, roomId, null, store, onEvent);
    onProgress?.({ phase: 'done', tailEventCount: tailApplied });
    return { blockCount: 0, blockEventCount: 0, tailEventCount: tailApplied };
  }

  // Phase 2: walk the chain.
  onProgress?.({ phase: 'chain' });
  const chain = await walkBlockChain(client, roomId, head.latest_block_event_id);

  // Phase 3: parallel download + decrypt + parse.
  onProgress?.({ phase: 'download', blockCount: chain.length });
  const decoded = await Promise.all(
    chain.map(async ({ content }) => {
      const bytes = await downloadEncryptedAttachment(client, content.file);
      const events = await readBlockEvents(bytes);
      return { schemaVersion: content.schema_version, events };
    }),
  );

  // Phase 4: apply in chain order.
  let totalBlockEvents = 0;
  onProgress?.({ phase: 'apply', blockCount: chain.length });
  for (const block of decoded) {
    await applyBlockEvents(store, block.events as EoEventInput[], block.schemaVersion, onEvent);
    totalBlockEvents += block.events.length;
  }

  // Phase 5: walk the tail forward from the cutoff.
  onProgress?.({ phase: 'tail' });
  const tailApplied = await applyTail(client, roomId, head.tail_cutoff_event_id, store, onEvent);

  onProgress?.({
    phase: 'done',
    blockCount: chain.length,
    eventCount: totalBlockEvents,
    tailEventCount: tailApplied,
  });
  return { blockCount: chain.length, blockEventCount: totalBlockEvents, tailEventCount: tailApplied };
}
