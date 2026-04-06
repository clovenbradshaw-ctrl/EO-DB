/**
 * Event sink — abstraction for routing EO events during import.
 *
 * Two modes:
 *   - **DirectSink** — folds events locally via processEvent(). No Matrix
 *     interaction. This is the current behavior and serves as the fallback
 *     when no SyncManager is available (offline / local-only).
 *
 *   - **GroundedSink** — folds events locally (immediate UI update), then
 *     on flush() packages all new events as a single binary snapshot and
 *     uploads to Matrix media. The room gets ONE lightweight timeline event
 *     instead of thousands of individual messages. Other devices restore
 *     grounded imports through the normal snapshot chain.
 *
 * Usage:
 *   const sink = new GroundedSink(db, feed, syncManager, { source: 'json' });
 *   await sink.emit({ op: 'INS', target: '...', operand: {...}, agent, ts, acquired_ts });
 *   await sink.emit({ op: 'DEF', target: '...', operand: {...}, agent, ts, acquired_ts });
 *   const result = await sink.flush();
 *   // result.mxc = 'mxc://...' (single Matrix media upload)
 *   // result.event_count = 2
 */

import type { EoDb } from '../db/level.js';
import { getCurrentSeq } from '../db/level.js';
import type { EoEventInput } from '../db/types.js';
import { processEvent, processEventBatch, type ProcessBatchResult } from '../db/fold.js';
import { readLogSince } from '../db/log.js';
import type { Feed } from '../db/feed.js';
import type { SyncManager } from '../matrix/sync-manager.js';
import type { ImportMeta } from '../matrix/types.js';

// ─── Interface ─────────────────────────────────────────────────────────────

export interface FlushResult {
  /** Matrix media URI (present only for grounded imports). */
  mxc?: string;
  /** Number of events that were folded. */
  event_count: number;
  /** Seq range of the import (present only for grounded imports). */
  from_seq?: number;
  to_seq?: number;
}

export interface EventSink {
  /** Fold a single event locally, return its seq number. */
  emit(event: EoEventInput): Promise<number>;

  /**
   * Fold a batch of events locally using optimized batch processing.
   * Returns seqs for successful events and per-event errors.
   */
  emitBatch(events: EoEventInput[]): Promise<ProcessBatchResult>;

  /**
   * Finalize the import batch. For grounded sinks this uploads the
   * accumulated events to Matrix media as a single binary snapshot.
   * For direct sinks this is a no-op.
   */
  flush(): Promise<FlushResult>;
}

// ─── DirectSink (local-only, no Matrix) ───────────────────────────────────

/**
 * Passes each event straight to processEvent(). flush() is a no-op.
 * This preserves the current import behavior for offline / local-only mode.
 */
export class DirectSink implements EventSink {
  private db: EoDb;
  private feed: Feed;
  private count = 0;

  constructor(db: EoDb, feed: Feed) {
    this.db = db;
    this.feed = feed;
  }

  async emit(event: EoEventInput): Promise<number> {
    const seq = await processEvent(this.db, event, this.feed);
    this.count++;
    return seq;
  }

  async emitBatch(events: EoEventInput[]): Promise<ProcessBatchResult> {
    const result = await processEventBatch(this.db, events, this.feed);
    this.count += result.seqs.length;
    return result;
  }

  async flush(): Promise<FlushResult> {
    return { event_count: this.count };
  }
}

// ─── GroundedSink (fold locally, batch upload to Matrix) ──────────────────

/**
 * Folds every event locally via processEvent() (immediate UI update),
 * then on flush() reads back all new events from the log and uploads
 * them as a grounded import snapshot to Matrix.
 *
 * The Matrix room receives exactly ONE timeline event per flush() call
 * instead of N individual messages.
 */
export class GroundedSink implements EventSink {
  private db: EoDb;
  private feed: Feed;
  private syncManager: SyncManager;
  private importMeta?: ImportMeta;

  /** Seq before the first event in this batch. */
  private fromSeq: number | null = null;
  private count = 0;

  constructor(
    db: EoDb,
    feed: Feed,
    syncManager: SyncManager,
    importMeta?: Omit<ImportMeta, 'record_count'>,
  ) {
    this.db = db;
    this.feed = feed;
    this.syncManager = syncManager;
    this.importMeta = importMeta
      ? { ...importMeta, record_count: 0 }
      : undefined;
  }

  async emit(event: EoEventInput): Promise<number> {
    // Capture seq before first event
    if (this.fromSeq === null) {
      this.fromSeq = await getCurrentSeq(this.db);
    }

    const seq = await processEvent(this.db, event, this.feed);
    this.count++;
    return seq;
  }

  async emitBatch(events: EoEventInput[]): Promise<ProcessBatchResult> {
    if (this.fromSeq === null) {
      this.fromSeq = await getCurrentSeq(this.db);
    }

    const result = await processEventBatch(this.db, events, this.feed);
    this.count += result.seqs.length;
    return result;
  }

  async flush(): Promise<FlushResult> {
    if (this.count === 0 || this.fromSeq === null) {
      return { event_count: 0 };
    }

    const toSeq = await getCurrentSeq(this.db);

    // Update record count in import metadata
    if (this.importMeta) {
      this.importMeta.record_count = this.count;
    }

    // Delegate to SyncManager which handles snapshot creation,
    // upload, and chain management
    const result = await this.syncManager.processImportBatch(
      this.fromSeq,
      toSeq,
      this.importMeta,
    );

    // Reset for potential reuse
    const eventCount = this.count;
    this.fromSeq = null;
    this.count = 0;

    return {
      mxc: result.mxc,
      event_count: eventCount,
      from_seq: result.from_seq,
      to_seq: result.to_seq,
    };
  }
}

/**
 * Create the appropriate EventSink based on whether a SyncManager is available.
 *
 * When grounding is enabled (SyncManager present), imported events are folded
 * locally but batched into a single Matrix upload. When no SyncManager is
 * available (offline/local), events are folded directly with no Matrix interaction.
 */
export function createEventSink(
  db: EoDb,
  feed: Feed,
  syncManager?: SyncManager,
  importMeta?: Omit<ImportMeta, 'record_count'>,
): EventSink {
  if (syncManager) {
    return new GroundedSink(db, feed, syncManager, importMeta);
  }
  return new DirectSink(db, feed);
}
