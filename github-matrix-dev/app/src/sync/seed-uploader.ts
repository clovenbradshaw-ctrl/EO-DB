/**
 * Seed uploader — "this is the file to get started."
 *
 * Reads an `.eodb` or NDJSON event bundle, diffs the events against
 * whatever is already in the space (via the deterministic
 * `client_event_id` content hash), and emits only the novel ones through
 * the normal SyncManager pipeline so they land in the timeline and are
 * eventually sealed into blocks like any other event.
 *
 * Hot-start: on a brand-new room (no `m.eo.head` and an empty local
 * store), an `.eodb` seed file can be posted directly as the genesis
 * block — one upload, one state event, fully hydrated chain.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import { unpack } from 'msgpackr';
import type { EoStore } from '../db/encrypted-store';
import type { EoEvent, EoEventInput } from '../db/types';
import { processEvent } from '../db/fold';
import { eventHash } from '../db/hash';
import { EodbStreamReader, FRAME_TYPES, isEodbV2 } from '../db/eodb';
import {
  readHeadState,
  sealBlockFromEvents,
  BLOCK_SCHEMA_VERSION,
} from './block-sealer';

// ─── Seed parsing ──────────────────────────────────────────────────────

export type SeedFormat = 'eodb' | 'ndjson';

export interface ParsedSeed {
  format: SeedFormat;
  events: EoEventInput[];
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Detect the seed file's format by magic bytes / extension and decode it
 * into a flat event list. `.eodb` events come from LOG_SEGMENT frames;
 * NDJSON bundles are one EO event per non-empty line.
 */
export async function parseSeedFile(bytes: Uint8Array, fileName?: string): Promise<ParsedSeed> {
  if (isEodbV2(bytes)) {
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes); c.close(); },
    });
    const reader = new EodbStreamReader(stream);
    await reader.readHeader();
    const events: EoEvent[] = [];
    let frame = await reader.readNextFrame();
    while (frame) {
      if (frame.type === FRAME_TYPES.LOG_SEGMENT) {
        const segEvents = unpack(frame.payload) as EoEvent[];
        events.push(...segEvents);
      } else if (frame.type === FRAME_TYPES.TRAILER || frame.type === FRAME_TYPES.EOF) {
        break;
      }
      frame = await reader.readNextFrame();
    }
    return { format: 'eodb', events: events as EoEventInput[] };
  }

  // Fallback: NDJSON (one event per line).
  const text = decodeText(bytes);
  const events: EoEventInput[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as EoEventInput;
      if (parsed && typeof parsed === 'object' && parsed.op && parsed.target !== undefined) {
        events.push(parsed);
      }
    } catch {
      // Skip malformed lines silently — UX hint via {skippedLines} would
      // be nice but the typical seed file is well-formed.
    }
  }
  if (events.length === 0 && fileName && !fileName.endsWith('.ndjson') && !fileName.endsWith('.jsonl')) {
    throw new Error('Seed file is neither a valid .eodb nor an NDJSON event bundle');
  }
  return { format: 'ndjson', events };
}

// ─── Diff + apply ──────────────────────────────────────────────────────

/**
 * Ensure every parsed event has a `client_event_id`. Seed files produced
 * by the app already carry one; foreign NDJSON bundles may not. The id
 * is derived from event content, so the same event always hashes to the
 * same id regardless of producer.
 */
async function ensureClientEventIds(events: EoEventInput[]): Promise<EoEventInput[]> {
  const out: EoEventInput[] = new Array(events.length);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.client_event_id) {
      out[i] = ev;
      continue;
    }
    const id = await eventHash({
      op: ev.op,
      target: ev.target,
      operand: ev.operand,
      agent: ev.agent ?? '@seed:local',
      ts: ev.ts ?? new Date(0).toISOString(),
    });
    out[i] = { ...ev, client_event_id: id };
  }
  return out;
}

/**
 * Check whether the store already knows about an event by id. Mirrors
 * the dedup-fast-path used in sync-manager.processIncomingEvent.
 */
async function isAlreadyApplied(store: EoStore, clientEventId: string): Promise<boolean> {
  const existing = await store.get(`idem:${clientEventId}`);
  return existing != null;
}

export interface SeedApplyResult {
  total: number;
  added: number;
  skipped: number;
  hotStartGenesis?: { blockEventId: string; blockIndex: number };
}

export interface SeedApplyOptions {
  /** Emit progress as events are applied. */
  onProgress?: (current: number, total: number) => void;
  /**
   * Force the slow per-event path even when the room is empty and the
   * seed is `.eodb` (which would normally hot-start as a genesis block).
   * Tests use this to exercise the diff path on empty rooms.
   */
  forceDiffPath?: boolean;
  /**
   * Optional locally-generated agent used when seed events lack one.
   * Defaults to the Matrix user id from the client.
   */
  defaultAgent?: string;
  /** Schema-version stamp for hot-start genesis blocks. */
  schemaVersion?: string;
}

/**
 * Apply a parsed seed to a space. Diffs every event against the store
 * via `client_event_id`; new events go through `processEvent` (locally
 * folded) and `sendEoEvent` indirectly via the SyncManager — but to keep
 * the seed flow independent of SyncManager wiring we fold directly here
 * and let the live timeline pick up echo events (which dedup).
 *
 * Hot-start: when `forceDiffPath` is false, the room has no `m.eo.head`
 * yet AND the local store is empty AND the seed is `.eodb`, we post the
 * seed directly as the genesis block instead of replaying it event by
 * event. This is the fast path for spinning up a copy of an existing
 * database.
 */
export async function seedSpaceFromFile(
  client: MatrixClient,
  roomId: string,
  collectionId: string,
  store: EoStore,
  seed: ParsedSeed,
  opts: SeedApplyOptions = {},
): Promise<SeedApplyResult> {
  const events = await ensureClientEventIds(seed.events);
  const total = events.length;

  // Hot-start path: empty room, empty store, .eodb seed → seal as genesis.
  if (!opts.forceDiffPath && seed.format === 'eodb' && total > 0) {
    const head = readHeadState(client, roomId);
    const currentSeq = await store.getCurrentSeq();
    if (!head.latest_block_event_id && currentSeq === 0) {
      const myUserId = client.getUserId?.() ?? '@seed:local';
      const myDeviceId = client.getDeviceId?.() ?? 'seed';
      const eventsWithAgent = events.map(e =>
        e.agent ? e : { ...e, agent: opts.defaultAgent ?? myUserId }
      );

      const result = await sealBlockFromEvents(
        client,
        roomId,
        collectionId,
        myDeviceId,
        eventsWithAgent,
        [],
        head,
        { schemaVersion: opts.schemaVersion ?? BLOCK_SCHEMA_VERSION },
      );

      // Apply locally too so the running session reflects the seed.
      for (let i = 0; i < eventsWithAgent.length; i++) {
        await processEvent(store, eventsWithAgent[i]);
        opts.onProgress?.(i + 1, total);
      }

      return {
        total,
        added: total,
        skipped: 0,
        hotStartGenesis: {
          blockEventId: result.blockEventId,
          blockIndex: result.blockIndex,
        },
      };
    }
  }

  // Diff path: O(events) check against `idem:` keys.
  let added = 0;
  let skipped = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const id = ev.client_event_id!;
    if (await isAlreadyApplied(store, id)) {
      skipped++;
    } else {
      await processEvent(store, ev);
      added++;
    }
    opts.onProgress?.(i + 1, total);
  }
  return { total, added, skipped };
}
