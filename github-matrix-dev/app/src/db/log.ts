import type { EoStore } from './encrypted-store';
import { padSeq } from './encrypted-store';
import type { EoEvent } from './types';

export async function appendToLog(store: EoStore, event: EoEvent): Promise<void> {
  const key = `log:${padSeq(event.seq)}`;
  await store.put(key, event);
}

export async function readLogSince(
  store: EoStore,
  since: number,
  limit?: number,
): Promise<EoEvent[]> {
  // Scan all log entries, then filter by seq > since.
  // Keys are lexicographically ordered by padded seq, so the iterator
  // returns them in order. We filter rather than prefix-match because
  // iterator(prefix) only matches keys starting with that exact prefix.
  const entries = await store.iterator('log:');
  const events: EoEvent[] = [];
  for (const [, value] of entries) {
    const event = value as EoEvent;
    if (event.seq > since) {
      events.push(event);
      if (limit && limit > 0 && events.length >= limit) break;
    }
  }
  return events;
}

export async function readLogForTarget(
  store: EoStore,
  target: string,
): Promise<EoEvent[]> {
  const entries = await store.iterator('log:');
  return entries
    .map(([, value]) => value as EoEvent)
    .filter((event) => event.target === target);
}

export async function readLogForPrefix(
  store: EoStore,
  prefix: string,
): Promise<EoEvent[]> {
  const entries = await store.iterator('log:');
  return entries
    .map(([, value]) => value as EoEvent)
    .filter((event) => event.target.startsWith(prefix));
}
