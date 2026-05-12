/**
 * Publish a batch of EO events to a Matrix room with automatic spillover
 * to the media store for oversized payloads.
 *
 * Two modes:
 *   - **inline** — each event is sent as its own `m.eo.event` timeline
 *     message via `sendEoEvent`. Cheap and immediate, but bounded by
 *     Matrix's per-event content size limit (~64 KB on most homeservers).
 *   - **block** — the whole batch is packed into a `.eodb` block payload
 *     via `buildBlockBytes`, AES-encrypted, uploaded to the media store,
 *     and announced with a single `m.eo.block` pointer event (plus an
 *     updated `m.eo.head` state event) via `sealBlockFromPayload`.
 *
 * The mode is decided by total / maximum event size — callers don't need
 * to think about it. Schema imports are the primary motivation: a base
 * with hundreds of fields produces hundreds of small DEF / INS events
 * that fit inline, but a single table DEF with a huge embedded `fields`
 * array can exceed the per-event ceiling and must spill to a block.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import type { EoEventInput } from '../db/types';
import { sendEoEvent } from '../matrix/event-bridge';
import {
  BLOCK_SCHEMA_VERSION,
  buildBlockBytes,
  readHeadState,
  sealBlockFromPayload,
} from './block-sealer';

/**
 * Soft size ceiling per individual `m.eo.event` content payload. Set
 * below the 65 KB Matrix default to leave room for the encryption /
 * routing envelope. If any single event in the batch exceeds this, OR
 * the cumulative JSON size of all events does, we fall back to sealing
 * the whole batch as one media-store block.
 */
const INLINE_BATCH_SIZE_LIMIT_BYTES = 48_000;

export interface PublishResult {
  /** Which path was taken. */
  mode: 'inline' | 'block' | 'noop';
  /** Number of EO events published (or sealed). */
  eventCount: number;
  /** Matrix event ids for inline mode. Empty in block mode. */
  inlineEventIds: string[];
  /** Block-pointer event id in block mode. Undefined in inline mode. */
  blockEventId?: string;
}

export interface PublishOptions {
  /**
   * Collection id stamped into the `.eodb` header when sealing. Defaults
   * to the room id — readers only consult this for diagnostics; the
   * block chain itself is keyed off `prior_block_event_id`.
   */
  collectionId?: string;
  /**
   * Force a specific publish mode. Useful for tests and for callers that
   * know up-front the batch is huge. Default: auto-decide by size.
   */
  forceMode?: 'inline' | 'block';
}

/**
 * Publish a batch of pre-collected EO events to the room. Returns a
 * summary of what was sent. Throws if the room rejects either the
 * inline send or the block upload.
 */
export async function publishEoEventBatch(
  client: MatrixClient,
  roomId: string,
  events: EoEventInput[],
  opts: PublishOptions = {},
): Promise<PublishResult> {
  if (events.length === 0) {
    return { mode: 'noop', eventCount: 0, inlineEventIds: [] };
  }

  const mode = opts.forceMode ?? decideMode(events);

  if (mode === 'inline') {
    const inlineEventIds: string[] = [];
    for (const ev of events) {
      inlineEventIds.push(await sendEoEvent(client, roomId, ev));
    }
    return { mode: 'inline', eventCount: events.length, inlineEventIds };
  }

  // Spill the batch to the media store as a single sealed block. Note
  // that concurrent block seals from other code paths (continuous tick,
  // background snapshot) race on the `m.eo.head` state event; the last
  // writer wins and earlier blocks may end up orphaned. Schema imports
  // are infrequent enough that we accept this rather than serialising
  // through a global seal lock here.
  const head = readHeadState(client, roomId);
  const deviceId = client.getDeviceId?.() ?? 'schema-publish';
  const payload = await buildBlockBytes({
    collectionId: opts.collectionId ?? roomId,
    blockIndex: head.block_count,
    priorBlockEventId: head.latest_block_event_id,
    schemaVersion: BLOCK_SCHEMA_VERSION,
    events,
  });
  const result = await sealBlockFromPayload(
    client,
    roomId,
    deviceId,
    payload,
    events.length,
    head,
  );
  return {
    mode: 'block',
    eventCount: events.length,
    inlineEventIds: [],
    blockEventId: result.blockEventId,
  };
}

function decideMode(events: EoEventInput[]): 'inline' | 'block' {
  let total = 0;
  let max = 0;
  for (const ev of events) {
    const size = JSON.stringify(ev).length;
    total += size;
    if (size > max) max = size;
  }
  if (max > INLINE_BATCH_SIZE_LIMIT_BYTES) return 'block';
  if (total > INLINE_BATCH_SIZE_LIMIT_BYTES) return 'block';
  return 'inline';
}
