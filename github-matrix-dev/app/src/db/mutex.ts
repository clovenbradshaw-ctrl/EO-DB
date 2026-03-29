/**
 * Async mutex — serializes access to the fold engine.
 *
 * Only one processEvent() call runs at a time. Others queue behind it.
 * This prevents interleaved reads/writes to state, seq, and graph
 * when events arrive from multiple sources (local, Matrix, peer sync).
 */

export class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }

  /**
   * Run a function while holding the lock.
   * Guarantees release even if fn throws.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}
