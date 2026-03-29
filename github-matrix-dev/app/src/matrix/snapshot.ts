/**
 * Snapshot — create, upload, download, and apply database snapshots.
 *
 * Snapshots are hydration accelerators stored as encrypted binary blobs
 * in the Matrix media store. The room event history is the source of truth.
 */

import { pack, unpack } from 'msgpackr';
import type { MatrixClient } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoState, GraphEdge, EvaRegistration, NulSnapshotKind } from '../db/types';
import { EO_SNAPSHOT_TYPE } from './event-bridge';

interface Snapshot {
  version: 1;
  kind: NulSnapshotKind;
  seq: number;
  ts: string;
  created_by: string;
  state: Record<string, EoState>;
  graph_fwd: Record<string, GraphEdge>;
  graph_rev: Record<string, GraphEdge>;
  eva: Record<string, EvaRegistration>;
  seg?: string;               // present when kind is 'limited_snapshot' — the SEG boundary
}

/**
 * Create a snapshot from current store state.
 *
 * NUL is a snapshot. If a SEG boundary is provided, the snapshot is limited
 * to targets within that segment — making it a 'limited_snapshot'.
 * Without a SEG, it captures full state — a plain 'snapshot'.
 */
export async function createSnapshot(
  store: EoStore,
  myUserId: string,
  seg?: string,
): Promise<Snapshot> {
  const state: Record<string, EoState> = {};
  const stateEntries = await store.iterator('state:');
  for (const [key, value] of stateEntries) {
    const target = key.slice(6); // remove 'state:'
    // If SEG boundary is set, only include targets within that segment
    if (seg && !target.startsWith(seg)) continue;
    state[target] = value as EoState;
  }

  const graph_fwd: Record<string, GraphEdge> = {};
  const fwdEntries = await store.iterator('graph:fwd:');
  for (const [key, value] of fwdEntries) {
    const edge = value as GraphEdge;
    if (seg && !edge.source.startsWith(seg) && !edge.dest.startsWith(seg)) continue;
    graph_fwd[key] = edge;
  }

  const graph_rev: Record<string, GraphEdge> = {};
  const revEntries = await store.iterator('graph:rev:');
  for (const [key, value] of revEntries) {
    const edge = value as GraphEdge;
    if (seg && !edge.source.startsWith(seg) && !edge.dest.startsWith(seg)) continue;
    graph_rev[key] = edge;
  }

  const eva: Record<string, EvaRegistration> = {};
  const evaEntries = await store.iterator('eva:');
  for (const [key, value] of evaEntries) {
    const target = key.slice(4); // remove 'eva:'
    if (seg && !target.startsWith(seg)) continue;
    eva[target] = value as EvaRegistration;
  }

  const seq = await store.getCurrentSeq();
  const kind = seg ? 'limited_snapshot' : 'snapshot';

  return {
    version: 1,
    kind,
    seq,
    ts: new Date().toISOString(),
    created_by: myUserId,
    state,
    graph_fwd,
    graph_rev,
    eva,
    ...(seg ? { seg } : {}),
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
    kind: snapshot.kind,
    seq: snapshot.seq,
    ts: snapshot.ts,
    size_bytes: binary.byteLength,
    version: snapshot.version,
    ...(snapshot.seg ? { seg: snapshot.seg } : {}),
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
  const snapshot: Snapshot = unpack(new Uint8Array(buffer));

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
