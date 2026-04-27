/**
 * Airtable one-shot hydration snapshot — encode & decode.
 *
 * Motivation: live Airtable hydration is O(records) API calls per device,
 * serialised behind a 4 req/sec rate limit. For very large bases this makes
 * fresh-device bootstrap painful and multiplies Airtable load with user count.
 *
 * A snapshot is a `.eodb` file that captures the full set of events produced
 * by a single `hydrationSync()` run, plus the per-table lastModified / webhook
 * cursors valid at the moment the snapshot was baked. Any device can replay
 * the snapshot locally — seeding its event log, folded state, and cursors —
 * then fall straight through to `updateSync()` for post-snapshot deltas.
 *
 * Design notes:
 *   - We only write a LOG_SEGMENT frame. Replay goes through the normal
 *     `processEvent` fold path, so state materialisation, graph updates,
 *     and prototype registration all happen through the same code that
 *     handles live events — no divergent snapshot-only code path to keep
 *     in sync.
 *   - Cursors live in the CollectionHeader so a reader can peek at them
 *     without scanning the whole file.
 *   - The format is a strict subset of v2 .eodb: readers that don't know
 *     about `airtable_cursor` see a normal file with one log segment.
 *
 * This module is pure: it operates on Uint8Array + event arrays. Wiring
 * into the live sync service + Google Drive persistence lives in
 * `airtable-sync.ts` / `airtable-sync-service.ts` so this module stays
 * easy to unit-test without Matrix / Drive / fold plumbing.
 */

import {
  EodbWriter,
  EodbStreamReader,
  BufferSink,
  FRAME_TYPES,
  isEodbV2,
  type CollectionHeader,
} from '../db/eodb';
import type { EoStore } from '../db/encrypted-store';
import type { EoEvent, EoEventInput } from '../db/types';
import { processEvent } from '../db/fold';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Per-table cursor state captured at snapshot time. A replaying device seeds
 * `meta:at_cursor:{baseId}:{tableId}` from `lastModified`, and the webhook
 * payload cursor from `webhookCursor`, so the first post-bootstrap sync only
 * pulls records changed AFTER the snapshot — not the whole base.
 */
export interface AirtableCursorEntry {
  lastModified?: string;
  webhookCursor?: number;
}

export type AirtableCursorMap = Record<string, Record<string, AirtableCursorEntry>>;

export interface AirtableSnapshotContents {
  header: CollectionHeader;
  events: EoEvent[];
  cursors: AirtableCursorMap;
}

export interface EncodeOptions {
  /** Stable ID for this snapshot — usually `airtable-hydration-{baseId}`. */
  collectionId: string;
  /** Human-readable label. */
  name: string;
  /** ISO timestamp marking when the snapshot was captured. */
  capturedAt?: string;
  /**
   * Reports `(encoded, total)` after each LOG_SEGMENT is written. Lets the
   * UI render encoding progress and is the hook that keeps the main thread
   * visibly responsive while large snapshots (12k+ records) are being
   * packed and framed.
   */
  onProgress?: (encoded: number, total: number) => void;
  /**
   * Events per LOG_SEGMENT frame. Large single-frame packs block the main
   * thread for seconds (msgpack `pack()` runs synchronously), which freezes
   * the UI on bases with many thousand records. Splitting into multiple
   * frames lets us yield to the event loop between packs; the decoder
   * already walks frames in a loop so this is fully backward-compatible.
   */
  chunkSize?: number;
}

/** Default events-per-frame. ~1000 keeps per-chunk `pack()` under ~100ms
 *  for typical Airtable records while keeping frame overhead negligible. */
const DEFAULT_LOG_SEGMENT_CHUNK = 1000;

// ─── Encode ─────────────────────────────────────────────────────────────────

/**
 * Serialise a set of hydration events + cursors into a `.eodb` byte buffer.
 *
 * The caller is responsible for filtering `events` down to just the events
 * produced by a single hydration run (typically via the `onEvent` callback
 * on `hydrationSync()`). Passing a mixed stream is valid but defeats the
 * "one-shot per base" assumption.
 */
export async function encodeAirtableSnapshot(
  events: EoEvent[],
  cursors: AirtableCursorMap,
  opts: EncodeOptions,
): Promise<Uint8Array> {
  const now = opts.capturedAt ?? new Date().toISOString();
  const header: CollectionHeader = {
    collectionId: opts.collectionId,
    name: opts.name,
    createdAt: now,
    updatedAt: now,
    encodedThrough: events.length > 0 ? events[events.length - 1].seq : 0,
    fileVersion: 2,
    airtable_cursor: cursors,
  };

  const chunkSize = Math.max(1, opts.chunkSize ?? DEFAULT_LOG_SEGMENT_CHUNK);
  const sink = new BufferSink();
  const writer = new EodbWriter(sink.stream().getWriter());
  try {
    await writer.writeHeader(header);
    opts.onProgress?.(0, events.length);
    for (let i = 0; i < events.length; i += chunkSize) {
      const batch = events.slice(i, i + chunkSize);
      await writer.writeLogSegment(batch);
      const encoded = Math.min(i + chunkSize, events.length);
      opts.onProgress?.(encoded, events.length);
      // Yield to the event loop between batches so the UI can repaint
      // and process input while we pack the next chunk. Without this,
      // encoding 12k+ events freezes the page for several seconds.
      if (encoded < events.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    await writer.finalize();
  } catch (e) {
    // Best-effort: if finalize throws partway, the sink may hold a partial
    // buffer. Surface the error — callers should NOT upload partial files.
    throw new Error(`encodeAirtableSnapshot failed: ${(e as Error).message}`);
  }
  return sink.toUint8Array();
}

// ─── Decode ─────────────────────────────────────────────────────────────────

/**
 * Read a snapshot byte buffer back into its constituent pieces. Validates
 * the `.eodb` magic + trailer checksum by delegating to EodbStreamReader.
 *
 * Unknown frame types are skipped (forward-compatible). Missing
 * `airtable_cursor` header field → empty cursor map (back-compat for
 * snapshots produced before this format existed).
 */
export async function decodeAirtableSnapshot(
  bytes: Uint8Array,
): Promise<AirtableSnapshotContents> {
  if (!isEodbV2(bytes)) {
    throw new Error('decodeAirtableSnapshot: input is not a valid .eodb v2 file');
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = new EodbStreamReader(stream);
  try {
    const header = await reader.readHeader();
    const events: EoEvent[] = [];

    while (true) {
      const frame = await reader.readNextFrame();
      if (!frame) break;
      if (frame.type === FRAME_TYPES.TRAILER) break;
      if (frame.type === FRAME_TYPES.LOG_SEGMENT) {
        // LOG_SEGMENT payload is msgpack-packed EoEvent[]. Re-feed through
        // a tiny one-shot stream so we can reuse the reader's framed
        // helper; simpler to just unpack inline.
        const { unpack } = await import('msgpackr');
        const segment = unpack(frame.payload) as EoEvent[];
        for (const ev of segment) events.push(ev);
      }
      // Other frame types (PROTO_UPDATE, BODY_BLOCK, DIFF_CHUNK,
      // GRAPH_SNAPSHOT, …) are allowed but not consumed here — future
      // snapshot versions may include them. They're already length-
      // prefixed so skipping is implicit in readNextFrame's contract.
    }

    return {
      header,
      events,
      cursors: header.airtable_cursor ?? {},
    };
  } finally {
    reader.cancel();
  }
}

// ─── Filename helpers ───────────────────────────────────────────────────────

/**
 * Deterministic filename for a base's snapshot. Using a stable name means
 * rebake overwrites the previous version, and any device can find the
 * current snapshot without an index lookup.
 */
export function airtableSnapshotFilename(baseId: string): string {
  const safe = baseId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `airtable-hydration-${safe}.eodb`;
}

/**
 * IndexedDB meta key where the local device remembers the Drive ref for a
 * baked snapshot. Parallels the existing `meta:at_cursor:*` and
 * `meta:at_webhook:*` key families.
 */
export function airtableSnapshotRefKey(baseId: string): string {
  return `meta:at_snapshot_ref:${baseId}`;
}

// ─── Replay ─────────────────────────────────────────────────────────────────

export interface ReplayResult {
  eventsReplayed: number;
  tablesSeeded: number;
  /** Last seq observed in the snapshot — useful for diagnostics. */
  lastSeq: number;
  /**
   * INS events skipped because the target was already instantiated locally
   * (e.g. from a prior snapshot import or cross-device sync). Subsequent
   * DEF/CON/SEG events on the same target still fold normally, so new
   * content in the snapshot still lands — matching the live ingest path
   * in airtable-sync.ts which also treats duplicate INS as a no-op.
   */
  insSkippedExisting: number;
}

/**
 * Fold a snapshot's events into the store and seed per-table Airtable
 * cursors. After replay the store is in the same state it would have been
 * in had the originating device run `hydrationSync()` locally, and the
 * next `updateSync()` will pull only post-snapshot deltas.
 *
 * Events are replayed one-at-a-time via `processEvent`, matching how
 * live events are folded. The snapshot's original seq numbers are
 * discarded — `processEvent` assigns fresh monotonic seqs from
 * `store.nextSeq()` to avoid colliding with the replaying device's
 * own seq space.
 *
 * Duplicate-INS tolerance. When replaying a snapshot into a store that
 * already knows some of its targets (re-import, partial previous run,
 * peer sync), `processEvent` throws "Target already instantiated" on the
 * INS. We treat that as a no-op and continue — the entity is already born,
 * and the DEF/CON/SEG events that follow still apply and deliver any new
 * content the snapshot carries. This mirrors `ingestRecordEvent()` in
 * airtable-sync.ts, which catches the same error around its record-level
 * INS so a re-ingest still fields in new changes.
 */
export async function replayAirtableSnapshot(
  store: EoStore,
  snapshot: AirtableSnapshotContents,
  onEvent?: (event: EoEvent) => void,
): Promise<ReplayResult> {
  let lastSeq = 0;
  let insSkippedExisting = 0;
  for (const event of snapshot.events) {
    // Strip the embedded seq — processEvent assigns its own.
    const { seq: _seq, ...rest } = event;
    void _seq;
    const input = rest as EoEventInput;
    try {
      const assignedSeq = await processEvent(store, input, onEvent);
      if (assignedSeq > lastSeq) lastSeq = assignedSeq;
    } catch (e: any) {
      // Duplicate-INS tolerance. Two paths can raise this error on replay:
      //   (a) An explicit INS in the snapshot whose target already has
      //       local state (prior import, peer sync, partial hydration).
      //   (b) A DEF/SEG/CON whose helix-promotion path emits a synthetic
      //       INS on the same already-instantiated target.
      // In both cases the target is already born locally; skipping the
      // throw lets the rest of the snapshot fold so new DEF/CON content
      // still lands. Any other error is a real problem — rethrow.
      if (typeof e?.message === 'string'
          && e.message.includes('Target already instantiated')) {
        insSkippedExisting++;
        continue;
      }
      throw e;
    }
  }

  // Seed cursors so the first post-bootstrap updateSync only pulls deltas.
  // Mirrors the cursorKey() format in airtable-sync.ts (duplicated here to
  // avoid an import cycle; the format is a stable contract of that module).
  let tablesSeeded = 0;
  for (const [baseId, tables] of Object.entries(snapshot.cursors)) {
    for (const [tableId, cursor] of Object.entries(tables)) {
      if (cursor.lastModified) {
        await store.put(`meta:at_cursor:${baseId}:${tableId}`, cursor.lastModified);
        tablesSeeded++;
      }
      if (cursor.webhookCursor !== undefined) {
        // Webhook state has a richer shape (webhookId, cursor, createdAt);
        // we can only seed the cursor half here. airtable-sync.ts will
        // treat missing webhook state as "no webhook registered" and
        // fall back to lastModified, which is exactly what we want: the
        // replaying device registers its own webhook if it becomes primary.
      }
    }
  }

  return {
    eventsReplayed: snapshot.events.length,
    tablesSeeded,
    lastSeq,
    insSkippedExisting,
  };
}
