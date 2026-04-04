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
  private events: SigEvent[] = [];
  private maxEvents: number;

  constructor(maxEvents = 1000) {
    this.maxEvents = maxEvents;
  }

  /** Record a SIG event in memory. */
  track(event: SigEvent): void {
    this.events.push(event);
    // Ring-buffer behavior: drop oldest when over capacity
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  /** Get all tracked SIG events, optionally filtered by target pattern. */
  getEvents(target?: string): SigEvent[] {
    if (!target) return [...this.events];
    return this.events.filter(e => e.target === target || e.target.startsWith(target + '.'));
  }

  /** Get the most recent SIG event for a target. */
  getLatest(target: string): SigEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].target === target) return this.events[i];
    }
    return undefined;
  }

  /** Get count of tracked SIG events. */
  get size(): number {
    return this.events.length;
  }

  /** Clear all tracked SIG events. */
  clear(): void {
    this.events = [];
  }
}
