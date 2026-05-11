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
import { pack, unpack } from 'msgpackr';
import type { EoStore } from '../db/encrypted-store';
import type { EoEvent, EoEventInput } from '../db/types';
import { processEvent } from '../db/fold';
import { eventHash } from '../db/hash';
import { EodbStreamReader, FRAME_TYPES, isEodbV2 } from '../db/eodb';
import {
  readHeadState,
  sealBlockFromEvents,
  BLOCK_SCHEMA_VERSION,
  type HeadState,
  type SealResult,
} from './block-sealer';

/**
 * Hard upper bound on events per hot-start block. The actual chunk size
 * is chosen dynamically from the homeserver's reported max upload size
 * (see {@link pickInitialChunkSize}), but we never exceed this many
 * events per block regardless of how cheap the events look, because
 * (a) read amplification on a 50k+ event block gets noticeable on cold
 * fetches and (b) very large blocks dominate the failure budget on slow
 * uploads.
 */
const HOT_START_MAX_EVENTS_PER_BLOCK = 20_000;

/**
 * Floor for adaptive chunk halving. Below this we give up rather than
 * spam the homeserver with one-block-per-event uploads. A homeserver
 * that won't accept this much almost certainly has a misconfiguration
 * or per-event payloads the user needs to address.
 */
const HOT_START_MIN_EVENTS_PER_BLOCK = 250;

/**
 * Default assumed homeserver max upload size when `getMediaConfig` is
 * unavailable or returns no value. Matches Synapse's default
 * `max_upload_size` of 50 MiB.
 */
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Fraction of the homeserver's max upload size we'll target per block.
 * Leaves room for the .eodb framing/header overhead and homeserver-side
 * slop (mime sniffing, content-length checks against streamed body).
 */
const UPLOAD_SAFETY_FRACTION = 0.7;

/** Per-block upload retry budget. Exponential backoff between attempts. */
const SEAL_RETRY_ATTEMPTS = 3;

/**
 * Probe the connected homeserver for its advertised max upload size
 * (`m.upload.size` from `/_matrix/media/v3/config`). Returns
 * {@link DEFAULT_MAX_UPLOAD_BYTES} if the call fails or returns no value
 * — both common when the SDK build doesn't expose the config endpoint or
 * the homeserver is older.
 */
async function getMaxUploadBytes(client: MatrixClient): Promise<number> {
  try {
    const fn = (client as any).getMediaConfig;
    if (typeof fn !== 'function') return DEFAULT_MAX_UPLOAD_BYTES;
    const config = await fn.call(client);
    const size = config?.['m.upload.size'];
    if (typeof size === 'number' && size > 0) return size;
  } catch {
    // Treat any failure as "use the default" — overshooting the real
    // limit just falls into the adaptive-halving retry below.
  }
  return DEFAULT_MAX_UPLOAD_BYTES;
}

/**
 * Estimate the average msgpack-encoded size of an event by packing a
 * sample. The .eodb LOG_SEGMENT writes events as a single packed array
 * (see EodbWriter), so msgpack overhead per element is what matters.
 * Adds a small constant for the per-block frame/header overhead.
 */
function estimateBytesPerEvent(events: EoEventInput[]): number {
  if (events.length === 0) return 256;
  const sampleSize = Math.min(events.length, 200);
  // Take a slice from the middle of the list — first/last events are
  // sometimes oddly shaped (initial scaffolding, summary rows).
  const start = Math.max(0, Math.floor((events.length - sampleSize) / 2));
  const sample = events.slice(start, start + sampleSize);
  let bytes: number;
  try {
    bytes = pack(sample).length;
  } catch {
    return 512; // conservative fallback
  }
  return Math.max(64, Math.ceil(bytes / sample.length));
}

/**
 * Pick the initial events-per-block based on the homeserver's reported
 * limit and a sample of the seed's event sizes. The adaptive halving in
 * the seal loop handles cases where this estimate is wrong (e.g. the
 * sample under-represented payload sizes, or the homeserver fronts a
 * stricter reverse proxy than its advertised limit).
 */
function pickInitialChunkSize(
  events: EoEventInput[],
  maxUploadBytes: number,
): number {
  const avgBytes = estimateBytesPerEvent(events);
  const targetBytes = Math.floor(maxUploadBytes * UPLOAD_SAFETY_FRACTION);
  const fromBytes = Math.max(1, Math.floor(targetBytes / avgBytes));
  return Math.min(
    HOT_START_MAX_EVENTS_PER_BLOCK,
    Math.max(HOT_START_MIN_EVENTS_PER_BLOCK, fromBytes),
  );
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  label: string,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        const delayMs = 1000 * Math.pow(2, i);
        console.warn(`[seed-uploader] ${label} attempt ${i + 1}/${attempts} failed, retrying in ${delayMs}ms:`, e);
        await new Promise<void>((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

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
  /**
   * Optional bulk-apply hook. When provided, novel events are folded via
   * this callback in a single batch instead of through the per-event
   * `processEvent` loop. Wire this to `useEoStore.getState().batchImport`
   * in the app so large seeds (80k+ events) go through the chunked,
   * throttled, worker-pooled import path that yields to the browser
   * between chunks. Without it, applying a 500MB seed hangs the tab.
   */
  bulkApply?: (
    events: EoEventInput[],
    onProgress?: (current: number, total: number) => void,
  ) => Promise<unknown>;
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

      // Split into multiple encrypted blocks if the seed is large. A
      // single .eodb block for 80k+ events would balloon into a 100MB+
      // attachment, which is exactly the upload that fails on the
      // network layer. Each chunk seals into its own encrypted .eodb
      // (AES-CTR via uploadEncryptedAttachment) and gets chained
      // through prior_block_event_id, so the resulting block chain is
      // the same shape as if it had been sealed live.
      //
      // Chunk sizing is dynamic: probe the homeserver's max upload
      // size, sample the seed's per-event byte cost, and pick a count
      // that should land under the limit. If the homeserver still
      // rejects an upload (advertised limit lies, reverse proxy is
      // stricter, content-length math drifts), we halve the chunk and
      // retry. This was the failure mode for the
      // airtable-hydration seed against synapse: 20k rich Airtable
      // rows packed into >50 MiB, the default `max_upload_size`, and
      // the homeserver returned `[500] Internal server error` from
      // `/_matrix/media/v3/upload` instead of a clean 413.
      const schemaVersion = opts.schemaVersion ?? BLOCK_SCHEMA_VERSION;
      const maxUploadBytes = await getMaxUploadBytes(client);
      let chunkSize = pickInitialChunkSize(eventsWithAgent, maxUploadBytes);

      let currentHead: HeadState = head;
      let firstResult: SealResult | null = null;

      // Reserve the first half of the progress bar for sealing; the
      // local fold reports the second half. (If there's no bulkApply
      // hook the local fold below reports its own per-event progress.)
      const sealReportBudget = opts.bulkApply ? Math.floor(total / 2) : 0;

      let sealedCount = 0;
      while (sealedCount < eventsWithAgent.length) {
        const chunkEnd = Math.min(sealedCount + chunkSize, eventsWithAgent.length);
        const chunkEvents = eventsWithAgent.slice(sealedCount, chunkEnd);

        let result: SealResult;
        try {
          result = await withRetry(
            () => sealBlockFromEvents(
              client,
              roomId,
              collectionId,
              myDeviceId,
              chunkEvents,
              [],
              currentHead,
              { schemaVersion },
            ),
            SEAL_RETRY_ATTEMPTS,
            `seal block ${currentHead.block_count} (${chunkEvents.length} events)`,
          );
        } catch (e) {
          // If the chunk is bigger than the homeserver actually
          // accepts, halving it converges on a working size in
          // O(log) reattempts. We only do this above the floor — at
          // that point the failure isn't size-related.
          if (chunkSize > HOT_START_MIN_EVENTS_PER_BLOCK) {
            const next = Math.max(
              HOT_START_MIN_EVENTS_PER_BLOCK,
              Math.floor(chunkSize / 2),
            );
            console.warn(
              `[seed-uploader] seal failed for ${chunkEvents.length}-event chunk after ${SEAL_RETRY_ATTEMPTS} attempts; halving chunk to ${next} and retrying:`,
              e,
            );
            chunkSize = next;
            continue;
          }
          throw e;
        }

        if (firstResult === null) firstResult = result;

        // Advance our local head reflection so the next chunk chains
        // off this just-sealed block. Mirror the head update that
        // sealBlockFromEvents posted to the room state.
        currentHead = {
          schema_version: schemaVersion,
          latest_block_event_id: result.blockEventId,
          genesis_event_id: currentHead.genesis_event_id ?? result.blockEventId,
          block_count: result.blockIndex + 1,
          tail_cutoff_event_id: result.tailCutoffEventId || currentHead.tail_cutoff_event_id,
          updated_at: new Date().toISOString(),
        };

        sealedCount = chunkEnd;

        if (sealReportBudget > 0) {
          opts.onProgress?.(
            Math.floor((sealedCount / eventsWithAgent.length) * sealReportBudget),
            total,
          );
        }

        // Yield between blocks so the browser can paint progress.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      // Apply locally too so the running session reflects the seed. Prefer
      // the bulk-apply hook (chunked, worker-pooled, yields between chunks)
      // when wired; otherwise fall back to the per-event loop used by tests.
      if (opts.bulkApply) {
        await opts.bulkApply(eventsWithAgent, (current, _bulkTotal) => {
          const scaled = Math.floor((current / eventsWithAgent.length) * (total - sealReportBudget));
          opts.onProgress?.(sealReportBudget + scaled, total);
        });
        opts.onProgress?.(total, total);
      } else {
        for (let i = 0; i < eventsWithAgent.length; i++) {
          await processEvent(store, eventsWithAgent[i]);
          opts.onProgress?.(i + 1, total);
        }
      }

      return {
        total,
        added: total,
        skipped: 0,
        hotStartGenesis: {
          blockEventId: firstResult!.blockEventId,
          blockIndex: firstResult!.blockIndex,
        },
      };
    }
  }

  // Diff path: O(events) check against `idem:` keys.
  if (opts.bulkApply) {
    // Pre-filter in a yield-aware pass so 80k-event seeds don't block the
    // main thread. The filter is read-only against the store, so we can
    // safely yield every YIELD_EVERY events; React paints + input runs.
    const YIELD_EVERY = 1000;
    const novel: EoEventInput[] = [];
    let skippedCount = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const id = ev.client_event_id!;
      if (await isAlreadyApplied(store, id)) {
        skippedCount++;
      } else {
        novel.push(ev);
      }
      // Halve the progress bar for the filter pass so the user sees motion
      // during the pre-scan; bulkApply reports the second half.
      if ((i + 1) % YIELD_EVERY === 0 || i === events.length - 1) {
        opts.onProgress?.(Math.floor((i + 1) / 2), total);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    if (novel.length > 0) {
      const filterHalf = Math.floor(total / 2);
      await opts.bulkApply(novel, (current, _bulkTotal) => {
        const scaled = Math.floor((current / novel.length) * (total - filterHalf));
        opts.onProgress?.(filterHalf + scaled, total);
      });
    }
    opts.onProgress?.(total, total);
    return { total, added: novel.length, skipped: skippedCount };
  }

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
