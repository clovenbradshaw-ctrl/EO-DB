import { EoDb, padSeq, encode, decode } from './level.js';
import type { EoEvent } from './types.js';

/**
 * Branch-scoped log scan — yields events in seq order that belong to branchId.
 *
 * NOTE: O(total log) — iterates all events in the seq range and filters by the
 * branch field. For databases with >100k events, replace with a secondary index
 * (branch-log:{branchId}:{padSeq}) in the next PR.
 *
 * @param fromSeq Exclusive lower bound — yields events with seq > fromSeq.
 * @param upTo    Inclusive upper bound — yields events with seq ≤ upTo (undefined = no limit).
 */
export async function* logScanByBranch(
  db: EoDb,
  branchId: string,
  fromSeq: number,
  upTo?: number,
): AsyncGenerator<EoEvent> {
  const startKey = `log:${padSeq(fromSeq + 1)}`;
  const endKey = upTo !== undefined ? `log:${padSeq(upTo)}` : `log:${padSeq(999999999999)}`;

  for await (const [, value] of db.iterator({ gte: startKey, lte: endKey })) {
    const event = decode(value) as EoEvent;
    // Backward compat: events without a branch field belong to 'main'
    const eventBranch = event.branch ?? 'main';
    if (eventBranch === branchId) {
      yield event;
    }
  }
}

export async function appendToLog(db: EoDb, event: EoEvent): Promise<void> {
  const key = `log:${padSeq(event.seq)}`;
  await db.put(key, encode(event));
}

export async function readLogSince(
  db: EoDb,
  since: number,
  limit?: number
): Promise<EoEvent[]> {
  const events: EoEvent[] = [];
  const startKey = `log:${padSeq(since + 1)}`;
  const endKey = `log:${padSeq(999999999999)}`;

  for await (const [, value] of db.iterator({
    gte: startKey,
    lte: endKey,
    limit: limit ?? -1,
  })) {
    events.push(decode(value));
  }
  return events;
}

export async function readLogForTarget(
  db: EoDb,
  target: string
): Promise<EoEvent[]> {
  const events: EoEvent[] = [];
  const startKey = 'log:';
  const endKey = `log:${padSeq(999999999999)}`;

  for await (const [, value] of db.iterator({
    gte: startKey,
    lte: endKey,
  })) {
    const event = decode(value) as EoEvent;
    if (event.target === target) {
      events.push(event);
    }
  }
  return events;
}
