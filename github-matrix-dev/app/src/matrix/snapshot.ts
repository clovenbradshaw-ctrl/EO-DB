/**
 * Snapshot — create, upload, download, and apply database snapshots.
 *
 * Snapshots are hydration accelerators stored as encrypted binary blobs
 * in the Matrix media store. The room event history is the source of truth.
 *
 * Full snapshots include the event log so that a device hydrated from a
 * snapshot can serve as a peer sync source for other devices.
 */

import { pack, unpack } from 'msgpackr';
import type { MatrixClient } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoState, GraphEdge, EvaRegistration, EoEvent } from '../db/types';
import { processEvent } from '../db/fold';
import { EO_SNAPSHOT_TYPE } from './event-bridge';
import { readLogSince } from '../db/log';

interface Snapshot {
  version: 2;
  seq: number;
  ts: string;
  created_by: string;
  state: Record<string, EoState>;
  graph_fwd: Record<string, GraphEdge>;
  graph_rev: Record<string, GraphEdge>;
  eva: Record<string, EvaRegistration>;
  /** Event log — included so hydrated devices can serve as peer sync sources. */
  log?: EoEvent[];
  /** Idempotency keys — included so hydrated devices don't re-fold events. */
  idem?: Record<string, number>;
}

/**
 * Create a snapshot from current store state, including the event log.
 */
export async function createSnapshot(
  store: EoStore,
  myUserId: string,
): Promise<Snapshot> {
  const state: Record<string, EoState> = {};
  const stateEntries = await store.iterator('state:');
  for (const [key, value] of stateEntries) {
    const target = key.slice(6); // remove 'state:'
    state[target] = value as EoState;
  }

  const graph_fwd: Record<string, GraphEdge> = {};
  const fwdEntries = await store.iterator('graph:fwd:');
  for (const [key, value] of fwdEntries) {
    graph_fwd[key] = value as GraphEdge;
  }

  const graph_rev: Record<string, GraphEdge> = {};
  const revEntries = await store.iterator('graph:rev:');
  for (const [key, value] of revEntries) {
    graph_rev[key] = value as GraphEdge;
  }

  const eva: Record<string, EvaRegistration> = {};
  const evaEntries = await store.iterator('eva:');
  for (const [key, value] of evaEntries) {
    const target = key.slice(4); // remove 'eva:'
    eva[target] = value as EvaRegistration;
  }

  // Include the event log so hydrated devices have full history
  const log = await readLogSince(store, 0);

  // Include idempotency keys so hydrated devices don't re-process events
  const idem: Record<string, number> = {};
  const idemEntries = await store.iterator('idem:');
  for (const [key, value] of idemEntries) {
    idem[key.slice(5)] = value as number; // remove 'idem:'
  }

  const seq = await store.getCurrentSeq();

  return {
    version: 2,
    seq,
    ts: new Date().toISOString(),
    created_by: myUserId,
    state,
    graph_fwd,
    graph_rev,
    eva,
    log,
    idem,
  };
}

/**
 * Serialize and upload a snapshot to the Matrix media store.
 */
export async function uploadSnapshot(
  client: MatrixClient,
  roomId: string,
  snapshot: Snapshot,
): Promise<string> {
  const binary = pack(snapshot);

  const uploadResult = await client.uploadContent(new Blob([binary]), {
    name: `eo-snapshot-${snapshot.seq}.bin`,
    type: 'application/octet-stream',
  });

  const mxcUrl = uploadResult.content_uri;

  await client.sendEvent(roomId, EO_SNAPSHOT_TYPE as any, {
    mxc: mxcUrl,
    seq: snapshot.seq,
    ts: snapshot.ts,
    size_bytes: binary.byteLength,
    version: snapshot.version,
  });

  return mxcUrl;
}

/**
 * Find the latest snapshot reference in the room timeline.
 * Paginates backwards through the timeline to find snapshot pointer events,
 * which is necessary on a fresh device where the SDK has minimal history.
 */
export async function findLatestSnapshot(
  client: MatrixClient,
  roomId: string,
): Promise<{ mxc: string; seq: number } | null> {
  const room = client.getRoom(roomId);
  if (!room) return null;

  // Paginate backwards to find snapshot events (they may not be in the
  // initial sync window since they're only posted every 1000 events)
  const timeline = room.getLiveTimeline();
  let canPaginate = true;
  let latest: { mxc: string; seq: number } | null = null;

  // Check current timeline first
  for (const event of timeline.getEvents()) {
    if (event.getType() === EO_SNAPSHOT_TYPE) {
      const content = event.getContent();
      if (!latest || content.seq > latest.seq) {
        latest = { mxc: content.mxc, seq: content.seq };
      }
    }
  }

  // If we already found one, great. Otherwise paginate backwards to find it.
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

/**
 * Download and apply a snapshot to the store.
 *
 * Loads state, graph, EVA registrations, and (if present) the event log
 * and idempotency keys. The seq counter is set to the snapshot's seq so
 * new events continue from the right place.
 */
export async function applySnapshot(
  client: MatrixClient,
  store: EoStore,
  mxcUrl: string,
): Promise<number> {
  const httpUrl = client.mxcUrlToHttp(mxcUrl);
  if (!httpUrl) throw new Error('Cannot resolve mxc URL');

  const response = await fetch(httpUrl);
  const buffer = await response.arrayBuffer();
  const snapshot = unpack(new Uint8Array(buffer)) as Snapshot;

  // Load state
  for (const [target, state] of Object.entries(snapshot.state)) {
    await store.put(`state:${target}`, state);
  }

  // Load graph
  for (const [key, edge] of Object.entries(snapshot.graph_fwd)) {
    await store.put(key, edge);
  }
  for (const [key, edge] of Object.entries(snapshot.graph_rev)) {
    await store.put(key, edge);
  }

  // Load EVA registrations
  for (const [target, reg] of Object.entries(snapshot.eva)) {
    await store.put(`eva:${target}`, reg);
  }

  // Load event log (v2 snapshots include this)
  if (snapshot.log) {
    for (const event of snapshot.log) {
      const padded = String(event.seq).padStart(12, '0');
      await store.put(`log:${padded}`, event);
    }
  }

  // Load idempotency keys (v2 snapshots include this)
  if (snapshot.idem) {
    for (const [id, seq] of Object.entries(snapshot.idem)) {
      await store.put(`idem:${id}`, seq);
    }
  }

  return snapshot.seq;
}

/**
 * Auto-snapshot: create every 1000 events.
 */
export async function maybeCreateSnapshot(
  client: MatrixClient,
  roomId: string,
  store: EoStore,
  myUserId: string,
): Promise<void> {
  const lastSeq = await store.getCurrentSeq();
  const lastSnapshotSeq = (await store.get('meta:snapshot_seq')) || 0;

  if (lastSeq - lastSnapshotSeq >= 1000) {
    const snapshot = await createSnapshot(store, myUserId);
    await uploadSnapshot(client, roomId, snapshot);
    await store.put('meta:snapshot_seq', lastSeq);
  }
}

/* ── Delta Snapshots ──────────────────────────────────────── */

/**
 * A delta snapshot captures only the log events since the last snapshot.
 * Each delta references the previous snapshot's mxc URI, forming a chain
 * that allows full reconstruction by walking backwards.
 */
interface DeltaSnapshot {
  version: 1;
  type: 'delta';
  from_seq: number;       // exclusive: events after this seq
  to_seq: number;         // inclusive: up to and including this seq
  prev_mxc: string | null; // mxc URI of the previous delta (or null if first)
  ts: string;
  created_by: string;
  events: EoEvent[];
}

/**
 * Create a delta snapshot from the log events since the last snapshot.
 */
export async function createDeltaSnapshot(
  store: EoStore,
  myUserId: string,
): Promise<DeltaSnapshot> {
  const lastSnapshotSeq: number = (await store.get('meta:snapshot_seq')) || 0;
  const currentSeq = await store.getCurrentSeq();
  const prevMxc: string | null = (await store.get('meta:snapshot_mxc')) || null;

  const events = await readLogSince(store, lastSnapshotSeq);

  return {
    version: 1,
    type: 'delta',
    from_seq: lastSnapshotSeq,
    to_seq: currentSeq,
    prev_mxc: prevMxc,
    ts: new Date().toISOString(),
    created_by: myUserId,
    events,
  };
}

/**
 * Upload a delta snapshot and return its mxc URI.
 */
export async function uploadDeltaSnapshot(
  client: MatrixClient,
  delta: DeltaSnapshot,
): Promise<string> {
  const binary = pack(delta);

  const uploadResult = await client.uploadContent(new Blob([binary]), {
    name: `eo-delta-${delta.from_seq}-${delta.to_seq}.bin`,
    type: 'application/octet-stream',
  });

  return uploadResult.content_uri;
}

/**
 * Download and decode a delta snapshot from its mxc URI.
 */
export async function downloadDeltaSnapshot(
  client: MatrixClient,
  mxcUrl: string,
): Promise<DeltaSnapshot> {
  const httpUrl = client.mxcUrlToHttp(mxcUrl);
  if (!httpUrl) throw new Error('Cannot resolve mxc URL');

  const response = await fetch(httpUrl);
  const buffer = await response.arrayBuffer();
  return unpack(new Uint8Array(buffer)) as DeltaSnapshot;
}

/**
 * Restore from a chain of delta snapshots.
 *
 * Walks the prev_mxc chain backwards from the given mxc URI, collecting
 * deltas until it reaches the local seq (i.e. events we already have).
 * Then applies them in chronological order through the fold engine,
 * which handles deduplication via content-addressable hashing.
 */
export async function restoreFromDeltaChain(
  client: MatrixClient,
  store: EoStore,
  latestMxc: string,
  onEvent?: (event: any) => void,
): Promise<number> {
  const localSeq = await store.getCurrentSeq();
  const deltas: DeltaSnapshot[] = [];

  let currentMxc: string | null = latestMxc;
  while (currentMxc) {
    const delta = await downloadDeltaSnapshot(client, currentMxc);

    // If this delta's events are all before our local seq, we're done
    if (delta.to_seq <= localSeq) break;

    deltas.unshift(delta); // prepend so we process oldest first

    // If this delta starts at or before our local seq, we have continuity
    if (delta.from_seq <= localSeq) break;

    currentMxc = delta.prev_mxc;
  }

  // Apply events from each delta through the fold engine.
  // processEvent handles dedup: events we already have are skipped
  // via the idempotency check (content hash or client_event_id).
  let lastAppliedSeq = localSeq;
  for (const delta of deltas) {
    for (const event of delta.events) {
      if (event.seq <= localSeq) continue; // fast-skip known events
      const seq = await processEvent(store, event, onEvent);
      lastAppliedSeq = Math.max(lastAppliedSeq, seq);
    }
  }

  return lastAppliedSeq;
}
