import { EoDb, padSeq, encode, decode } from './level.js';
import type { EoEvent } from './types.js';

// ─── Secondary index helpers ──────────────────────────────────────────────────
// `log-target:{target}:{padSeq}` → seq (number) lets readLogForTarget skip
// the full-log scan.  `branch-log:{branchId}:{padSeq}` → seq does the same
// for logScanByBranch (replacement for the O(total log) scan flagged on line 9).

async function writeSecondaryIndexes(db: EoDb, event: EoEvent): Promise<void> {
  const branch = event.branch ?? 'main';
  const p = padSeq(event.seq);
  await Promise.all([
    db.put(`log-target:${event.target}:${p}`, encode(event.seq)),
    db.put(`branch-log:${branch}:${p}`, encode(event.seq)),
  ]);
}

/**
 * Branch-scoped log scan — yields events in seq order that belong to branchId.
 *
 * Uses the `branch-log:{branchId}:{padSeq}` secondary index for O(m) iteration
 * where m = events in that branch, instead of scanning the entire log.
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
  const startKey = `branch-log:${branchId}:${padSeq(fromSeq + 1)}`;
  const endKey = upTo !== undefined
    ? `branch-log:${branchId}:${padSeq(upTo)}`
    : `branch-log:${branchId}:\xff`;

  for await (const [, seqBuf] of db.iterator({ gte: startKey, lte: endKey })) {
    const seq = decode(seqBuf) as number;
    const eventBuf = await db.get(`log:${padSeq(seq)}`);
    yield decode(eventBuf) as EoEvent;
  }
}

export async function appendToLog(db: EoDb, event: EoEvent): Promise<void> {
  const key = `log:${padSeq(event.seq)}`;
  await db.put(key, encode(event));
  await writeSecondaryIndexes(db, event);
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
  const startKey = `log-target:${target}:`;
  const endKey = `log-target:${target}:\xff`;

  for await (const [, seqBuf] of db.iterator({ gte: startKey, lte: endKey })) {
    const seq = decode(seqBuf) as number;
    const eventBuf = await db.get(`log:${padSeq(seq)}`);
    events.push(decode(eventBuf) as EoEvent);
  }
  return events;
}
