import { EoDb, padSeq, encode, decode } from './level.js';
import type { EoEvent } from './types.js';

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
