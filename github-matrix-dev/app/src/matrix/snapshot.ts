/**
 * Snapshot — append-only chunked snapshot system.
 *
 * Every update is persisted to the Matrix media store as a NUL snapshot chunk.
 * Chunks are small deltas (state changes since last chunk), not full state dumps.
 * The media store acts as a shared append-only sync log across users.
 *
 * - NUL = snapshot chunk (captures delta of what changed)
 * - NUL + SEG = limited_snapshot chunk (scoped to a segment boundary)
 *
 * Hydration = download all chunks in seq order from all users, apply each.
 * Healing = discover chunks from other users on the same server, fill gaps.
 */

import { pack, unpack } from 'msgpackr';
import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoState, GraphEdge, EvaRegistration, NulSnapshotKind } from '../db/types';
import { EO_SNAPSHOT_TYPE } from './event-bridge';

/** A single snapshot chunk — a delta of changes since the last chunk. */
export interface SnapshotChunk {
  version: 1;
  kind: NulSnapshotKind;
  seq_start: number;          // first seq in this chunk (exclusive — changes after this)
  seq_end: number;            // last seq in this chunk (inclusive)
  ts: string;
  created_by: string;
  state: Record<string, EoState>;
  graph_fwd: Record<string, GraphEdge>;
  graph_rev: Record<string, GraphEdge>;
  eva: Record<string, EvaRegistration>;
  seg?: string;               // present when kind is 'limited_snapshot'
}

/** Pointer to a chunk stored in Matrix media. */
export interface ChunkRef {
  mxc: string;
  kind: NulSnapshotKind;
  seq_start: number;
  seq_end: number;
  created_by: string;
  ts: string;
  seg?: string;
}

/**
 * Create a snapshot chunk from changes since the last persisted chunk.
 *
 * Reads all state/graph/eva entries whose last_seq > sinceSeq.
 * If seg is provided, scopes to that segment boundary (limited_snapshot).
 */
export async function createChunk(
  store: EoStore,
  myUserId: string,
  sinceSeq: number,
  seg?: string,
): Promise<SnapshotChunk | null> {
  const currentSeq = await store.getCurrentSeq();
  if (currentSeq <= sinceSeq) return null; // nothing new

  const state: Record<string, EoState> = {};
  const stateEntries = await store.iterator('state:');
  for (const [key, value] of stateEntries) {
    const entry = value as EoState;
    if (entry.last_seq <= sinceSeq) continue;
    const target = key.slice(6); // remove 'state:'
    if (seg && !target.startsWith(seg)) continue;
    state[target] = entry;
  }

  const graph_fwd: Record<string, GraphEdge> = {};
  const fwdEntries = await store.iterator('graph:fwd:');
  for (const [key, value] of fwdEntries) {
    const edge = value as GraphEdge;
    if (edge.seq <= sinceSeq) continue;
    if (seg && !edge.source.startsWith(seg) && !edge.dest.startsWith(seg)) continue;
    graph_fwd[key] = edge;
  }

  const graph_rev: Record<string, GraphEdge> = {};
  const revEntries = await store.iterator('graph:rev:');
  for (const [key, value] of revEntries) {
    const edge = value as GraphEdge;
    if (edge.seq <= sinceSeq) continue;
    if (seg && !edge.source.startsWith(seg) && !edge.dest.startsWith(seg)) continue;
    graph_rev[key] = edge;
  }

  const eva: Record<string, EvaRegistration> = {};
  const evaEntries = await store.iterator('eva:');
  for (const [key, value] of evaEntries) {
    const target = key.slice(4); // remove 'eva:'
    if (seg && !target.startsWith(seg)) continue;
    // EVA registrations don't have seq — include all when in range
    eva[target] = value as EvaRegistration;
  }

  const kind: NulSnapshotKind = seg ? 'limited_snapshot' : 'snapshot';

  return {
    version: 1,
    kind,
    seq_start: sinceSeq,
    seq_end: currentSeq,
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
 * Upload a chunk to Matrix media and post a room reference event.
 */
export async function uploadChunk(
  client: MatrixClient,
  roomId: string,
  chunk: SnapshotChunk,
): Promise<string> {
  const binary = pack(chunk);

  const uploadResult = await client.uploadContent(new Blob([binary]), {
    name: `eo-chunk-${chunk.seq_start}-${chunk.seq_end}.bin`,
    type: 'application/octet-stream',
  });

  const mxcUrl = uploadResult.content_uri;

  await client.sendEvent(roomId, EO_SNAPSHOT_TYPE as any, {
    mxc: mxcUrl,
    kind: chunk.kind,
    seq_start: chunk.seq_start,
    seq_end: chunk.seq_end,
    ts: chunk.ts,
    created_by: chunk.created_by,
    size_bytes: binary.byteLength,
    version: chunk.version,
    ...(chunk.seg ? { seg: chunk.seg } : {}),
  });

  return mxcUrl;
}

/**
 * Collect all chunk references from the room timeline, from all users.
 * Returns them sorted by seq_start ascending for ordered replay.
 */
export async function collectChunkRefs(
  client: MatrixClient,
  roomId: string,
  sinceSeq?: number,
): Promise<ChunkRef[]> {
  const room = client.getRoom(roomId);
  if (!room) return [];

  const timeline = room.getLiveTimeline();
  const refs: ChunkRef[] = [];

  const extractRefs = (events: MatrixEvent[]) => {
    for (const event of events) {
      if (event.getType() !== EO_SNAPSHOT_TYPE) continue;
      const content = event.getContent();
      // Skip chunks we already have
      if (sinceSeq != null && content.seq_end <= sinceSeq) continue;
      refs.push({
        mxc: content.mxc,
        kind: content.kind || 'snapshot',
        seq_start: content.seq_start ?? 0,
        seq_end: content.seq_end ?? content.seq ?? 0,
        created_by: content.created_by || event.getSender()!,
        ts: content.ts,
        seg: content.seg,
      });
    }
  };

  // Scan current timeline
  extractRefs(timeline.getEvents());

  // Paginate backwards to find all chunks
  let canPaginate = true;
  while (canPaginate) {
    try {
      canPaginate = await client.paginateEventTimeline(timeline, {
        backwards: true,
        limit: 100,
      });
    } catch {
      break;
    }
    extractRefs(timeline.getEvents());
  }

  // Deduplicate by mxc URL and sort by seq range
  const seen = new Set<string>();
  const unique = refs.filter(r => {
    if (seen.has(r.mxc)) return false;
    seen.add(r.mxc);
    return true;
  });

  return unique.sort((a, b) => a.seq_start - b.seq_start);
}

/**
 * Download and apply a single chunk to the store.
 * Merges the chunk's delta state into the local store.
 */
export async function applyChunk(
  client: MatrixClient,
  store: EoStore,
  mxcUrl: string,
): Promise<number> {
  const httpUrl = client.mxcUrlToHttp(mxcUrl);
  if (!httpUrl) throw new Error('Cannot resolve mxc URL');

  const response = await fetch(httpUrl);
  const buffer = await response.arrayBuffer();
  const chunk: SnapshotChunk = unpack(new Uint8Array(buffer));

  // Apply state deltas — newer seq wins
  for (const [target, state] of Object.entries(chunk.state)) {
    const existing = await store.get(`state:${target}`) as EoState | null;
    if (!existing || state.last_seq > existing.last_seq) {
      await store.put(`state:${target}`, state);
    }
  }

  // Apply graph deltas
  for (const [key, edge] of Object.entries(chunk.graph_fwd)) {
    const existing = await store.get(key) as GraphEdge | null;
    if (!existing || edge.seq > existing.seq) {
      await store.put(key, edge);
    }
  }
  for (const [key, edge] of Object.entries(chunk.graph_rev)) {
    const existing = await store.get(key) as GraphEdge | null;
    if (!existing || edge.seq > existing.seq) {
      await store.put(key, edge);
    }
  }

  // Apply EVA registrations
  for (const [target, reg] of Object.entries(chunk.eva)) {
    await store.put(`eva:${target}`, reg);
  }

  return chunk.seq_end;
}

/**
 * Hydrate from all available chunks — used on fresh device or for healing.
 * Downloads and applies chunks from all users in seq order.
 */
export async function hydrateFromChunks(
  client: MatrixClient,
  store: EoStore,
  roomId: string,
): Promise<number> {
  const localSeq = await store.getCurrentSeq();
  const refs = await collectChunkRefs(client, roomId, localSeq);

  let highestSeq = localSeq;
  for (const ref of refs) {
    const chunkSeq = await applyChunk(client, store, ref.mxc);
    if (chunkSeq > highestSeq) highestSeq = chunkSeq;
  }

  if (highestSeq > localSeq) {
    await store.put('meta:chunk_seq', highestSeq);
  }

  return highestSeq;
}

/**
 * Append a chunk after local writes — called after every processEvent.
 * Creates and uploads a delta chunk of everything since the last persisted chunk.
 */
export async function appendChunk(
  client: MatrixClient,
  roomId: string,
  store: EoStore,
  myUserId: string,
  seg?: string,
): Promise<void> {
  const lastChunkSeq = ((await store.get('meta:chunk_seq')) as number) || 0;
  const chunk = await createChunk(store, myUserId, lastChunkSeq, seg);
  if (!chunk) return;

  await uploadChunk(client, roomId, chunk);
  await store.put('meta:chunk_seq', chunk.seq_end);
}

// --- Backward compatibility ---

/** @deprecated Use createChunk + uploadChunk instead. */
export const createSnapshot = async (
  store: EoStore,
  myUserId: string,
  seg?: string,
) => createChunk(store, myUserId, 0, seg);

/** @deprecated Use uploadChunk instead. */
export const uploadSnapshot = uploadChunk;

/** @deprecated Use hydrateFromChunks instead. */
export async function findLatestSnapshot(
  client: MatrixClient,
  roomId: string,
): Promise<{ mxc: string; seq: number } | null> {
  const refs = await collectChunkRefs(client, roomId);
  if (refs.length === 0) return null;
  const last = refs[refs.length - 1];
  return { mxc: last.mxc, seq: last.seq_end };
}

/** @deprecated Use applyChunk instead. */
export const applySnapshot = applyChunk;

/** @deprecated Use appendChunk instead. */
export const maybeCreateSnapshot = async (
  client: MatrixClient,
  roomId: string,
  store: EoStore,
  myUserId: string,
) => appendChunk(client, roomId, store, myUserId);
