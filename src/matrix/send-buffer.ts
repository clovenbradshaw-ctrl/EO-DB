/**
 * Send buffer — coalesces local events into batched Matrix uploads.
 *
 * Instead of sending one Matrix room event per local write (which triggers
 * 429 rate limits on rapid edits or CSV imports), the buffer accumulates
 * events and flushes them as a single binary snapshot upload to Matrix media.
 *
 * Flush triggers:
 *   - Timer: every FLUSH_INTERVAL_MS (default 10s)
 *   - Size: when buffer reaches MAX_BUFFER_SIZE events
 *   - Manual: via flush() (e.g., on page unload / visibility hidden)
 *
 * The flush path reuses the existing snapshot infrastructure — msgpack binary
 * uploaded to Matrix media, ONE lightweight timeline event posted with the
 * mxc:// reference. Receivers hydrate through the normal snapshot chain.
 *
 * Rate-limit awareness: if a flush hits a 429, the buffer retries after the
 * server-provided backoff period. Events stay buffered (and are already
 * folded locally) so the UI is never blocked.
 */

import type { EoEventInput } from '../db/types.js';

export interface SendBufferFlushDelegate {
  /**
   * Upload buffered events to Matrix via the snapshot path.
   * Called by the buffer when it's time to flush.
   * Should return true on success, false to retry later.
   */
  uploadBufferedEvents(): Promise<boolean>;

  /**
   * Check if Matrix uploads are currently disabled.
   */
  isUploadDisabled(): boolean;

  /**
   * Check if we're currently rate-limited.
   * Returns 0 if not rate-limited, otherwise the timestamp until which
   * sends should be skipped.
   */
  getRateLimitedUntil(): number;
}

/** Default flush interval: 10 seconds. */
const FLUSH_INTERVAL_MS = 10_000;

/** Flush immediately when buffer reaches this size. */
const MAX_BUFFER_SIZE = 500;

export class SendBuffer {
  private pending: EoEventInput[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private destroyed = false;
  private delegate: SendBufferFlushDelegate;

  constructor(delegate: SendBufferFlushDelegate) {
    this.delegate = delegate;
  }

  /** Number of events waiting to be flushed. */
  get size(): number {
    return this.pending.length;
  }

  /**
   * Add an event to the buffer. The event has already been folded locally —
   * this only controls when it gets uploaded to Matrix.
   */
  enqueue(event: EoEventInput): void {
    if (this.destroyed) return;
    if (this.delegate.isUploadDisabled()) return;

    this.pending.push(event);

    if (this.pending.length >= MAX_BUFFER_SIZE) {
      // Size threshold — flush immediately
      this.flush();
    } else if (!this.timer) {
      // Start the timer for time-based flush
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  /**
   * Flush all buffered events to Matrix now.
   *
   * Safe to call multiple times — concurrent flushes are serialized via
   * the flushing flag. If a flush is already in progress, this is a no-op
   * (the in-progress flush will pick up any events added during its run).
   */
  async flush(): Promise<void> {
    if (this.flushing || this.pending.length === 0) return;
    if (this.delegate.isUploadDisabled()) {
      this.pending = [];
      return;
    }

    // If rate-limited, schedule retry after the backoff period
    const rateLimitedUntil = this.delegate.getRateLimitedUntil();
    if (Date.now() < rateLimitedUntil) {
      const delay = rateLimitedUntil - Date.now() + 100;
      if (!this.destroyed && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flush();
        }, delay);
      }
      return;
    }

    this.flushing = true;
    this.clearTimer();

    try {
      const success = await this.delegate.uploadBufferedEvents();
      if (success) {
        // Events are now in the snapshot chain — clear the buffer
        this.pending = [];
      } else {
        // Upload failed — schedule retry
        if (!this.destroyed) {
          this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
          }, FLUSH_INTERVAL_MS);
        }
      }
    } finally {
      this.flushing = false;
    }

    // If new events arrived during the flush, schedule another
    if (this.pending.length > 0 && !this.timer && !this.destroyed) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  /**
   * Take a snapshot of buffered event count for diagnostics.
   */
  getStatus(): { buffered: number; flushing: boolean } {
    return { buffered: this.pending.length, flushing: this.flushing };
  }

  /**
   * Stop the buffer — cancel timers and discard pending events.
   * Call flush() first if you want to persist before destroying.
   */
  destroy(): void {
    this.destroyed = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
