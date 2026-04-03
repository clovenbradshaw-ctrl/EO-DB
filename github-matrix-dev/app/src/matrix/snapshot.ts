/**
 * Snapshot — create, upload, download, and apply database snapshots.
 *
 * Snapshots are delta-only: each one contains events since the last snapshot
 * plus up to 25 previous snapshot URIs for fast chain traversal. Below the
 * snapshot frequency threshold, hydration state lives in room data only.
 *
 * The room event history remains the source of truth.
 */

import { pack, unpack } from 'msgpackr';
import type { MatrixClient } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoEvent } from '../db/types';
import { processEvent } from '../db/fold';
import { EO_SNAPSHOT_TYPE, EO_SNAPSHOT_STATE_TYPE } from './event-bridge';
import { readLogSince } from '../db/log';

/** Maximum number of previous snapshot URIs carried in each snapshot. */
const MAX_PREV_MXCS = 25;

/**
 * Store the latest snapshot URI in room state for fast hydration.
 *
 * Room state is available instantly via `room.currentState` — no timeline
 * pagination needed. Each call overwrites the previous value so the state
 * always points to the most recent snapshot. The snapshot blob carries
 * `prev_mxcs` (up to 25 URIs) for fast chain traversal. If any blob
 * goes missing from the media store, the room timeline is the fallback.
 */
export async function setSnapshotStateEvent(
  client: MatrixClient,
  roomId: string,
  mxc: string,
  seq: number,
): Promise<void> {
  await client.sendStateEvent(roomId, EO_SNAPSHOT_STATE_TYPE as any, {
    mxc,
    seq,
    ts: new Date().toISOString(),
  }, '');
}

/**
 * Find the latest snapshot URI — fast path via room state, slow fallback
 * via timeline pagination.
 *
 * The room state gives us the latest mxc URI in O(1). From there the
 * snapshot blob's `prev_mxcs` array links backwards through up to 25
 * prior snapshots. The timeline fallback handles rooms that predate
 * state-based tracking.
 */
export async function findLatestSnapshot(
  client: MatrixClient,
  roomId: string,
): Promise<{ mxc: string; seq: number } | null> {
  const room = client.getRoom(roomId);
  if (!room) {
    console.warn('[EO-DB] findLatestSnapshot: room not in client room list:', roomId);
    return null;
  }

  // Fast path: read directly from room state.
  const stateEvent = room.currentState.getStateEvents(EO_SNAPSHOT_STATE_TYPE, '');
  if (stateEvent) {
    const content = stateEvent.getContent();
    if (content.mxc && typeof content.seq === 'number') {
      return { mxc: content.mxc, seq: content.seq };
    }
  }

  // Slow fallback: paginate backwards through the timeline.
  const timeline = room.getLiveTimeline();
  let canPaginate = true;
  let latest: { mxc: string; seq: number } | null = null;

  for (const event of timeline.getEvents()) {
    if (event.getType() === EO_SNAPSHOT_TYPE) {
      const content = event.getContent();
      if (!latest || content.seq > latest.seq) {
        latest = { mxc: content.mxc, seq: content.seq };
      }
    }
  }

  while (!latest && canPaginate) {
    try {
      canPaginate = await client.paginateEventTimeline(timeline, {
        backwards: true,
        limit: 100,
      });
    } catch {
      break;
    }

    for (const event of timeline.getEvents()) {
      if (event.getType() === EO_SNAPSHOT_TYPE) {
        const content = event.getContent();
        if (!latest || content.seq > latest.seq) {
          latest = { mxc: content.mxc, seq: content.seq };
        }
      }
    }
  }

  return latest;
}

/* ── Delta Snapshots ──────────────────────────────────────── */

/**
 * A delta snapshot captures only the log events since the last snapshot.
 * Each delta carries up to 25 previous snapshot URIs (`prev_mxcs`) so
 * hydrating devices can jump back in large strides instead of walking
 * the chain one link at a time.
 */
export interface DeltaSnapshot {
  version: 2;
  type: 'delta';
  from_seq: number;        // exclusive: events after this seq
  to_seq: number;          // inclusive: up to and including this seq
  prev_mxcs: string[];     // most-recent-first, up to MAX_PREV_MXCS URIs
  ts: string;
  created_by: string;
  events: EoEvent[];
}

/**
 * Auto-snapshot: create a delta every 500 log entries.
 * Below this threshold the hydration state lives in room data only.
 */
const SNAPSHOT_FREQUENCY = 500;

export async function maybeCreateSnapshot(
  client: MatrixClient,
  roomId: string,
  store: EoStore,
  myUserId: string,
): Promise<void> {
  const lastSeq = await store.getCurrentSeq();
  const lastSnapshotSeq = (await store.get('meta:snapshot_seq')) || 0;

  if (lastSeq - lastSnapshotSeq >= SNAPSHOT_FREQUENCY) {
    const delta = await createDeltaSnapshot(store, myUserId);
    const mxc = await uploadDeltaSnapshot(client, roomId, delta);
    await store.put('meta:snapshot_seq', lastSeq);
    await store.put('meta:snapshot_mxc', mxc);
    await store.put('meta:snapshot_prev_mxcs', [mxc, ...delta.prev_mxcs].slice(0, MAX_PREV_MXCS));
  }
}

/**
 * Create a delta snapshot from the log events since the last snapshot.
 * Carries prev_mxcs from store for chain traversal.
 */
export async function createDeltaSnapshot(
  store: EoStore,
  myUserId: string,
): Promise<DeltaSnapshot> {
  const lastSnapshotSeq: number = (await store.get('meta:snapshot_seq')) || 0;
  const currentSeq = await store.getCurrentSeq();
  const prevMxcs: string[] = (await store.get('meta:snapshot_prev_mxcs')) || [];

  const events = await readLogSince(store, lastSnapshotSeq);

  return {
    version: 2,
    type: 'delta',
    from_seq: lastSnapshotSeq,
    to_seq: currentSeq,
    prev_mxcs: prevMxcs.slice(0, MAX_PREV_MXCS),
    ts: new Date().toISOString(),
    created_by: myUserId,
    events,
  };
}

/**
 * Upload a delta snapshot to Matrix media and post a timeline event.
 */
export async function uploadDeltaSnapshot(
  client: MatrixClient,
  roomId: string,
  delta: DeltaSnapshot,
): Promise<string> {
  const binary = pack(delta);

  const uploadResult = await client.uploadContent(new Blob([binary]), {
    name: `eo-delta-${delta.from_seq}-${delta.to_seq}.bin`,
    type: 'application/octet-stream',
  });

  const mxcUrl = uploadResult.content_uri;

  await client.sendEvent(roomId, EO_SNAPSHOT_TYPE as any, {
    mxc: mxcUrl,
    seq: delta.to_seq,
    ts: delta.ts,
    size_bytes: binary.byteLength,
    version: delta.version,
    type: 'delta',
  });

  await setSnapshotStateEvent(client, roomId, mxcUrl, delta.to_seq);

  return mxcUrl;
}

/**
 * Download and decode a delta snapshot from its mxc URI.
 *
 * Retries with exponential backoff (1s, 2s, 4s) so a single transient
 * network failure doesn't permanently break hydration.
 */
export async function downloadDeltaSnapshot(
  client: MatrixClient,
  mxcUrl: string,
  maxRetries = 3,
): Promise<DeltaSnapshot> {
  const httpUrl = client.mxcUrlToHttp(mxcUrl);
  if (!httpUrl) throw new Error('Cannot resolve mxc URL');

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(httpUrl);
      if (!response.ok) {
        throw new Error(`Snapshot download failed: ${response.status} ${response.statusText}`);
      }
      const buffer = await response.arrayBuffer();
      return unpack(new Uint8Array(buffer)) as DeltaSnapshot;
    } catch (e) {
      lastError = e as Error;
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(`[EO-DB] Snapshot download attempt ${attempt + 1} failed, retrying in ${delay}ms:`, e);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}

/**
 * Restore from a chain of delta snapshots.
 *
 * Downloads the latest delta, then batch-fetches all its `prev_mxcs`
 * (up to 25) in parallel. If we still haven't reached local seq, the
 * oldest fetched delta's own `prev_mxcs` gives us the next batch, and
 * so on. This means we fetch ~26 deltas per round trip instead of 1.
 *
 * Once all needed deltas are collected, events are applied in
 * chronological order through the fold engine (which deduplicates via
 * content-addressable hashing).
 */
export async function restoreFromDeltaChain(
  client: MatrixClient,
  store: EoStore,
  latestMxc: string,
  onEvent?: (event: any) => void,
): Promise<number> {
  const localSeq = await store.getCurrentSeq();
  const deltas: DeltaSnapshot[] = [];
  const seen = new Set<string>(); // avoid re-downloading the same mxc

  // Fetch the head delta first. If this fails after retries, fall back
  // to timeline replay rather than crashing the entire hydration chain.
  let head: DeltaSnapshot;
  try {
    head = await downloadDeltaSnapshot(client, latestMxc);
  } catch (e) {
    console.warn('[EO-DB] Head snapshot download failed — falling back to timeline replay:', e);
    return localSeq;
  }
  seen.add(latestMxc);

  if (head.to_seq <= localSeq) return localSeq; // nothing to apply

  deltas.push(head);

  // Keep fetching batches until we have continuity with local state
  let needMore = head.from_seq > localSeq;

  while (needMore) {
    // Find the oldest delta we've collected so far — its prev_mxcs
    // point to the next batch of snapshots to fetch.
    const oldest = deltas[0];
    const toFetch = oldest.prev_mxcs.filter((mxc) => !seen.has(mxc));

    if (toFetch.length === 0) break; // no more links in the chain

    // Batch-fetch all prev_mxcs in parallel — use allSettled so a single
    // failed download doesn't crash the entire hydration chain.
    for (const mxc of toFetch) seen.add(mxc);
    const results = await Promise.allSettled(
      toFetch.map((mxc) => downloadDeltaSnapshot(client, mxc)),
    );
    const batch = results
      .filter((r): r is PromiseFulfilledResult<DeltaSnapshot> => r.status === 'fulfilled')
      .map(r => r.value);

    // Insert in seq order (oldest first)
    for (const delta of batch) {
      if (delta.to_seq <= localSeq) continue; // already have these events
      deltas.push(delta);
    }

    // Sort so deltas are in chronological order
    deltas.sort((a, b) => a.from_seq - b.from_seq);

    // Check if the oldest delta now reaches our local seq
    needMore = deltas[0].from_seq > localSeq;
  }

  // Apply events from each delta through the fold engine.
  let lastAppliedSeq = localSeq;
  for (const delta of deltas) {
    for (const event of delta.events) {
      if (event.seq <= localSeq) continue;
      const seq = await processEvent(store, event, onEvent);
      lastAppliedSeq = Math.max(lastAppliedSeq, seq);
    }
  }

  return lastAppliedSeq;
}
