/**
 * Block sealer — drains the room timeline tail into an encrypted `.eodb`
 * block, uploads to Matrix media, posts an `m.eo.block` message event, and
 * advances the `m.eo.head` state-event pointer.
 *
 * Single-writer semantics across devices/tabs are provided by the
 * `encoding-claim` lease. Step ordering is chosen so a crash between any
 * two steps is recoverable on the next run without losing or duplicating
 * events:
 *
 *   1. acquire claim
 *   2. read m.eo.head
 *   3. collect tail events from room timeline after `tail_cutoff_event_id`
 *   4. write .eodb → encrypt → upload to mxc://
 *   5. post m.eo.block (timeline message — visible to all peers)
 *   6. update m.eo.head state event (atomically advances the pointer)
 *   7. release claim
 *
 * If a crash happens between (5) and (6), the next sealer run sees a block
 * event in the timeline that head doesn't yet point at; it advances head
 * without re-sealing. If a crash happens before (5), nothing externally
 * visible changed and the next run starts over.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import {
  EO_EVENT_TYPE,
  EO_HEAD_STATE_TYPE,
  EO_BLOCK_TYPE,
  uploadEncryptedAttachment,
  matrixEventToEo,
  type EncryptedAttachment,
} from '../matrix/event-bridge';
import { EodbWriter, BufferSink, type CollectionHeader } from '../db/eodb';
import type { EoEventInput } from '../db/types';
import { claimEncoding, type EncodingMatrixClient } from './encoding-claim';
import { mirrorBlockToDrive, type BlockDriveMirrorDeps } from './block-drive-mirror';

// ─── Schemas ───────────────────────────────────────────────────────────

export const BLOCK_SCHEMA_VERSION = 'eo-2026-04';

/** Trigger thresholds. Reachable from outside for the encoding-claim integration. */
export const SEAL_TRIGGER = {
  /** Seal once the tail reaches this many events. */
  MIN_TAIL_EVENTS: 5000,
  /** Seal more aggressively if the session is idle and the tail is non-trivial. */
  IDLE_MIN_TAIL_EVENTS: 500,
} as const;

export interface HeadState {
  schema_version: string;
  latest_block_event_id: string | null;
  genesis_event_id: string | null;
  block_count: number;
  /** Matrix event_id of the last event covered by the latest block (the boundary). */
  tail_cutoff_event_id: string | null;
  updated_at: string;
}

export interface BlockMessage {
  block_index: number;
  event_count: number;
  first_event_id: string | null;
  last_event_id: string | null;
  prior_block_event_id: string | null;
  schema_version: string;
  file: EncryptedAttachment;
  sealed_by: { user_id: string; device_id: string };
  sealed_at: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyHead(): HeadState {
  return {
    schema_version: BLOCK_SCHEMA_VERSION,
    latest_block_event_id: null,
    genesis_event_id: null,
    block_count: 0,
    tail_cutoff_event_id: null,
    updated_at: new Date().toISOString(),
  };
}

/** Read the current head state event for the room, or a zero-value head. */
export function readHeadState(client: MatrixClient, roomId: string): HeadState {
  const room = client.getRoom(roomId);
  if (!room) return emptyHead();
  const state = room.currentState.getStateEvents(EO_HEAD_STATE_TYPE, '');
  if (!state) return emptyHead();
  const content = state.getContent() as Partial<HeadState>;
  return {
    schema_version: content.schema_version ?? BLOCK_SCHEMA_VERSION,
    latest_block_event_id: content.latest_block_event_id ?? null,
    genesis_event_id: content.genesis_event_id ?? null,
    block_count: content.block_count ?? 0,
    tail_cutoff_event_id: content.tail_cutoff_event_id ?? null,
    updated_at: content.updated_at ?? new Date(0).toISOString(),
  };
}

/**
 * Collect the EO events in the room timeline that fall after the head's
 * `tail_cutoff_event_id`. Returns them in timeline order plus the matrix
 * event ids of the first and last (so the sealer can record the new
 * cutoff). If `cutoffEventId` is null, returns every EO event in the
 * timeline (initial seal / genesis case).
 */
export function collectTailEvents(
  client: MatrixClient,
  roomId: string,
  cutoffEventId: string | null,
): { events: EoEventInput[]; matrixEventIds: string[] } {
  const room = client.getRoom(roomId);
  if (!room) return { events: [], matrixEventIds: [] };

  const timeline = room.getLiveTimeline().getEvents();
  const events: EoEventInput[] = [];
  const matrixEventIds: string[] = [];
  let passedCutoff = cutoffEventId === null;

  for (const ev of timeline) {
    const id = ev.getId();
    if (!passedCutoff) {
      if (id === cutoffEventId) passedCutoff = true;
      continue;
    }
    if (ev.getType() !== EO_EVENT_TYPE) continue;
    if (!id) continue;
    events.push(matrixEventToEo(ev));
    matrixEventIds.push(id);
  }

  return { events, matrixEventIds };
}

/**
 * Build the `.eodb` payload bytes for a block.
 *
 * The events are written as a single LOG_SEGMENT frame. The header records
 * the block index + predecessor + schema version so a downloaded block can
 * be verified against the chain even out of room context.
 */
export async function buildBlockBytes(opts: {
  collectionId: string;
  blockIndex: number;
  priorBlockEventId: string | null;
  schemaVersion: string;
  events: EoEventInput[];
}): Promise<Uint8Array> {
  const sink = new BufferSink();
  const writer = new EodbWriter(sink.stream().getWriter());

  const header: CollectionHeader = {
    collectionId: opts.collectionId,
    name: `block-${opts.blockIndex}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    encodedThrough: opts.events.length,
    fileVersion: opts.blockIndex,
    blockIndex: opts.blockIndex,
    priorBlockEventId: opts.priorBlockEventId,
    schemaVersion: opts.schemaVersion,
  };

  await writer.writeHeader(header);
  if (opts.events.length > 0) {
    // LOG_SEGMENT msgpacks the array as-is.
    // Block payload is small relative to the 1 GiB media ceiling; one
    // segment per block keeps the reader simple.
    await writer.writeLogSegment(opts.events as any);
  }
  await writer.finalize();
  return sink.toUint8Array();
}

// ─── Sealing pipeline ──────────────────────────────────────────────────

export interface SealResult {
  blockIndex: number;
  blockEventId: string;
  eventCount: number;
  tailCutoffEventId: string;
}

export interface SealOptions {
  /** Override the trigger threshold (e.g. for forced/manual seals). */
  forceMinEvents?: number;
  /** Skip the claim step (e.g. callers managing their own lease). */
  skipClaim?: boolean;
  /** Override the schema version stamp. */
  schemaVersion?: string;
  /**
   * When supplied, the same plaintext `.eodb` bytes uploaded to `mxc://`
   * are mirrored to Drive (fire-and-forget) so subsequent reads can
   * fall back from a slow homeserver. Pass `null`/omit to disable.
   */
  mirror?: BlockDriveMirrorDeps | null;
}

/**
 * Seal the current room tail into a new block. Returns null if the tail is
 * too short to seal under the active threshold, or if the claim was lost.
 *
 * On success returns the new block's id + event count. On failure throws.
 */
export async function sealNextBlock(
  client: MatrixClient,
  roomId: string,
  collectionId: string,
  matrix: EncodingMatrixClient,
  clientId: string,
  opts: SealOptions = {},
): Promise<SealResult | null> {
  const head = readHeadState(client, roomId);
  const { events, matrixEventIds } = collectTailEvents(client, roomId, head.tail_cutoff_event_id);

  const minEvents = opts.forceMinEvents ?? SEAL_TRIGGER.MIN_TAIL_EVENTS;
  if (events.length === 0) return null;
  if (events.length < minEvents && opts.forceMinEvents === undefined) {
    return null;
  }

  // 1. Acquire claim (unless skipping)
  if (!opts.skipClaim) {
    const claimed = await claimEncoding(matrix, roomId, clientId, events.length);
    if (!claimed) return null;
  }

  return sealBlockFromEvents(client, roomId, collectionId, clientId, events, matrixEventIds, head, opts);
}

/**
 * Lower-level: seal a block from a pre-collected event list. Used by both
 * {@link sealNextBlock} and the seed-uploader hot-start path. Does NOT
 * acquire a claim — callers are responsible for serializing writes.
 */
export async function sealBlockFromEvents(
  client: MatrixClient,
  roomId: string,
  collectionId: string,
  clientId: string,
  events: EoEventInput[],
  matrixEventIds: string[],
  head: HeadState,
  opts: { schemaVersion?: string; mirror?: BlockDriveMirrorDeps | null } = {},
): Promise<SealResult> {
  const schemaVersion = opts.schemaVersion ?? BLOCK_SCHEMA_VERSION;
  const newBlockIndex = head.block_count;

  // 1. Build .eodb
  const payload = await buildBlockBytes({
    collectionId,
    blockIndex: newBlockIndex,
    priorBlockEventId: head.latest_block_event_id,
    schemaVersion,
    events,
  });

  // 2. Encrypt + upload (AES key lives only in the returned attachment
  // object, which is embedded in the Megolm-encrypted block message event).
  const attachment = await uploadEncryptedAttachment(
    client,
    payload,
    `block-${newBlockIndex}.eodb`,
  );

  // 2a. Mirror the same plaintext to Drive — fire-and-forget. Failure here
  // never blocks the canonical write; the mxc URL is what lands in
  // m.eo.block and m.eo.head, and a missing mirror just means a slightly
  // slower read on this block until the next successful seal of any block.
  if (opts.mirror) {
    void mirrorBlockToDrive(opts.mirror, payload, attachment.url).catch((e) =>
      console.warn('[EO-DB] block Drive mirror failed:', e),
    );
  }

  // 3. Post m.eo.block message event
  const firstId = matrixEventIds[0] ?? null;
  const lastId = matrixEventIds[matrixEventIds.length - 1] ?? null;
  const myUserId = client.getUserId() ?? '@unknown:unknown';
  const myDeviceId = client.getDeviceId() ?? clientId;

  const blockBody: BlockMessage = {
    block_index: newBlockIndex,
    event_count: events.length,
    first_event_id: firstId,
    last_event_id: lastId,
    prior_block_event_id: head.latest_block_event_id,
    schema_version: schemaVersion,
    file: attachment,
    sealed_by: { user_id: myUserId, device_id: myDeviceId },
    sealed_at: new Date().toISOString(),
  };

  const sendResult = await client.sendEvent(roomId, EO_BLOCK_TYPE as any, blockBody as any);
  const newBlockEventId = sendResult.event_id;

  // 4. Advance m.eo.head — only after the block message succeeded
  const newHead: HeadState = {
    schema_version: schemaVersion,
    latest_block_event_id: newBlockEventId,
    genesis_event_id: head.genesis_event_id ?? newBlockEventId,
    block_count: newBlockIndex + 1,
    tail_cutoff_event_id: lastId,
    updated_at: new Date().toISOString(),
  };
  await client.sendStateEvent(roomId, EO_HEAD_STATE_TYPE as any, newHead as any, '');

  return {
    blockIndex: newBlockIndex,
    blockEventId: newBlockEventId,
    eventCount: events.length,
    tailCutoffEventId: lastId ?? '',
  };
}

/**
 * Seal a precomputed `.eodb` byte payload as a new block. Used by the
 * seed-uploader fast path to upload the input file verbatim instead of
 * unpacking it into an event array and re-packing it through
 * {@link buildBlockBytes}. The caller is responsible for ensuring the
 * payload is a valid `.eodb` (matching `schemaVersion`) — the block
 * message's `event_count` is informational only and the readers
 * (block-hydration) re-derive the event list from the payload itself.
 *
 * `first_event_id` / `last_event_id` are null because the events never
 * passed through the room timeline before being sealed; they live only
 * inside the encrypted attachment.
 */
export async function sealBlockFromPayload(
  client: MatrixClient,
  roomId: string,
  clientId: string,
  payload: Uint8Array,
  eventCount: number,
  head: HeadState,
  opts: { schemaVersion?: string; mirror?: BlockDriveMirrorDeps | null } = {},
): Promise<SealResult> {
  const schemaVersion = opts.schemaVersion ?? BLOCK_SCHEMA_VERSION;
  const newBlockIndex = head.block_count;

  const attachment = await uploadEncryptedAttachment(
    client,
    payload,
    `block-${newBlockIndex}.eodb`,
  );

  if (opts.mirror) {
    void mirrorBlockToDrive(opts.mirror, payload, attachment.url).catch((e) =>
      console.warn('[EO-DB] block Drive mirror failed:', e),
    );
  }

  const myUserId = client.getUserId() ?? '@unknown:unknown';
  const myDeviceId = client.getDeviceId() ?? clientId;

  const blockBody: BlockMessage = {
    block_index: newBlockIndex,
    event_count: eventCount,
    first_event_id: null,
    last_event_id: null,
    prior_block_event_id: head.latest_block_event_id,
    schema_version: schemaVersion,
    file: attachment,
    sealed_by: { user_id: myUserId, device_id: myDeviceId },
    sealed_at: new Date().toISOString(),
  };

  const sendResult = await client.sendEvent(roomId, EO_BLOCK_TYPE as any, blockBody as any);
  const newBlockEventId = sendResult.event_id;

  const newHead: HeadState = {
    schema_version: schemaVersion,
    latest_block_event_id: newBlockEventId,
    genesis_event_id: head.genesis_event_id ?? newBlockEventId,
    block_count: newBlockIndex + 1,
    tail_cutoff_event_id: head.tail_cutoff_event_id,
    updated_at: new Date().toISOString(),
  };
  await client.sendStateEvent(roomId, EO_HEAD_STATE_TYPE as any, newHead as any, '');

  return {
    blockIndex: newBlockIndex,
    blockEventId: newBlockEventId,
    eventCount,
    tailCutoffEventId: '',
  };
}
