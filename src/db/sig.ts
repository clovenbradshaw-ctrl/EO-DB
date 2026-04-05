import type { Operator } from './types.js';

/** An ephemeral SIG event — tracked in memory, never persisted. */
export interface SigEvent {
  op: 'SIG';
  target: string;
  operand: any;
  agent: string;
  ts: string;
  acquired_ts: string;
}

/**
 * In-memory tracker for SIG (attention-directing) operations.
 * SIG is ephemeral by design — it represents directed attention
 * (cursor, gaze, coordinate targeting) and is never written to the log.
 */
export class SigTracker {
  private buffer: (SigEvent | undefined)[];
  private head: number = 0;   // next write position
  private count: number = 0;
  private maxEvents: number;

  constructor(maxEvents = 1000) {
    this.maxEvents = maxEvents;
    this.buffer = new Array(maxEvents);
  }

  /** Record a SIG event in memory. O(1) — no array shifting. */
  track(event: SigEvent): void {
    this.buffer[this.head] = event;
    this.head = (this.head + 1) % this.maxEvents;
    if (this.count < this.maxEvents) this.count++;
  }

  /** Iterate events oldest-first. */
  private *iterateEvents(): Generator<SigEvent> {
    if (this.count === 0) return;
    const start = this.count < this.maxEvents ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      yield this.buffer[(start + i) % this.maxEvents]!;
    }
  }

  /** Get all tracked SIG events, optionally filtered by target pattern. */
  getEvents(target?: string): SigEvent[] {
    const result: SigEvent[] = [];
    for (const e of this.iterateEvents()) {
      if (!target || e.target === target || e.target.startsWith(target + '.')) {
        result.push(e);
      }
    }
    return result;
  }

  /** Get the most recent SIG event for a target. */
  getLatest(target: string): SigEvent | undefined {
    // Walk backwards from most recent
    if (this.count === 0) return undefined;
    const start = this.count < this.maxEvents ? 0 : this.head;
    for (let i = this.count - 1; i >= 0; i--) {
      const e = this.buffer[(start + i) % this.maxEvents]!;
      if (e.target === target) return e;
    }
    return undefined;
  }

  /** Get count of tracked SIG events. */
  get size(): number {
    return this.count;
  }

  /** Clear all tracked SIG events. */
  clear(): void {
    this.buffer = new Array(this.maxEvents);
    this.head = 0;
    this.count = 0;
  }
}
