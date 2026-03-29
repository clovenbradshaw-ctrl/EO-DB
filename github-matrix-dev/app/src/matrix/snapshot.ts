/**
 * Snapshot — incremental event backups stored in Matrix media.
 *
 * A snapshot is just a batch of raw events since the last save.
 * It is NOT projected state — we never serialize the fold output.
 * The room event timeline is the source of truth; snapshots only
 * exist so a new device can hydrate faster than paginating the
 * entire room history.
 *
 * Non-destructive pruning: old snapshot media can be deleted from
 * the Matrix media store at any time. Hydration falls back to
 * timeline pagination for any gaps in the snapshot chain.
 */

import { pack, unpack } from 'msgpackr';
import type { MatrixClient } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoEvent } from '../db/types';
import { readLogSince } from '../db/log';
import { EO_EVENT_TYPE } from './event-bridge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A snapshot is a batch of raw events since the previous save. */
export interface Snapshot {
  version: 2;
  base_seq: number;           // events start AFTER this seq (0 = from the beginning)
  seq: number;                // last event seq included
  ts: string;                 // creation timestamp
  created_by: string;         // Matrix user ID of creator
  events: EoEvent[];          // the raw event batch — not projected state
}

/** Pointer stored as a NUL op in the room timeline. */
export interface SnapshotRef {
  mxc: string;
  base_seq: number;
  seq: number;
  ts: string;
  size_bytes: number;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a snapshot: raw events from (last_save_seq, current_seq].
 */
export async function createSnapshot(
  store: EoStore,
  myUserId: string,
): Promise<Snapshot> {
  const lastSnapshotSeq: number = (await store.get('meta:snapshot_seq')) ?? 0;
  const currentSeq = await store.getCurrentSeq();
  const events = await readLogSince(store, lastSnapshotSeq);

  return {
    version: 2,
    base_seq: lastSnapshotSeq,
    seq: currentSeq,
    ts: new Date().toISOString(),
    created_by: myUserId,
    events,
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Serialize and upload a snapshot to the Matrix media store,
 * then post a NUL event into the room as the pointer.
 *
 * NUL is the correct operator: a save observes the log without
 * changing state. It's not a LoggableOperator, so the fold ignores it.
 */
export async function uploadSnapshot(
  client: MatrixClient,
  roomId: string,
  snapshot: Snapshot,
): Promise<string> {
  const binary = pack(snapshot);

  const uploadResult = await client.uploadContent(new Blob([binary]), {
    name: `eo-snapshot-${snapshot.base_seq}-${snapshot.seq}.bin`,
    type: 'application/octet-stream',
  });

  const mxcUrl = uploadResult.content_uri;

  // Snapshot pointer is a NUL op — no state change, just a reference
  await client.sendEvent(roomId, EO_EVENT_TYPE as any, {
    op: 'NUL',
    target: '_snapshot',
    operand: {
      mxc: mxcUrl,
      base_seq: snapshot.base_seq,
      seq: snapshot.seq,
      ts: snapshot.ts,
      size_bytes: binary.byteLength,
    },
  });

  return mxcUrl;
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

/**
 * Find ALL snapshot references in the room timeline, ordered by base_seq.
 * Paginates backwards through the full timeline.
 */
export async function findAllSnapshots(
  client: MatrixClient,
  roomId: string,
): Promise<SnapshotRef[]> {
  const room = client.getRoom(roomId);
  if (!room) return [];

  const timeline = room.getLiveTimeline();
  const refs: SnapshotRef[] = [];
  const seen = new Set<string>();         // deduplicate by mxc

  function collectFromTimeline() {
    for (const event of timeline.getEvents()) {
      if (event.getType() !== EO_EVENT_TYPE) continue;
      const c = event.getContent();
      // Snapshot pointers are NUL ops targeting '_snapshot'
      if (c.op !== 'NUL' || c.target !== '_snapshot') continue;
      const operand = c.operand;
      if (!operand?.mxc || seen.has(operand.mxc)) continue;
      seen.add(operand.mxc);
      refs.push({
        mxc: operand.mxc,
        base_seq: operand.base_seq ?? 0,
        seq: operand.seq,
        ts: operand.ts,
        size_bytes: operand.size_bytes,
      });
    }
  }

  collectFromTimeline();

  // Paginate backwards to find older snapshots
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
    collectFromTimeline();
  }

  // Sort ascending by base_seq so the chain is in application order
  refs.sort((a, b) => a.base_seq - b.base_seq);
  return refs;
}

/**
 * Convenience: find just the latest snapshot (highest seq).
 * Used by the auto-snapshot trigger to decide if a new one is needed.
 */
export async function findLatestSnapshot(
  client: MatrixClient,
  roomId: string,
): Promise<SnapshotRef | null> {
  const all = await findAllSnapshots(client, roomId);
  if (all.length === 0) return null;
  return all.reduce((best, ref) => (ref.seq > best.seq ? ref : best));
}

// ---------------------------------------------------------------------------
// Download & Apply
// ---------------------------------------------------------------------------

/**
 * Download a snapshot blob and decode it.
 */
async function downloadSnapshot(
  client: MatrixClient,
  mxcUrl: string,
): Promise<Snapshot> {
  const httpUrl = client.mxcUrlToHttp(mxcUrl);
  if (!httpUrl) throw new Error('Cannot resolve mxc URL');

  const response = await fetch(httpUrl);
  const buffer = await response.arrayBuffer();
  return unpack(new Uint8Array(buffer)) as Snapshot;
}

/**
 * Apply a snapshot by replaying its raw events through the fold.
 */
async function applySnapshot(
  store: EoStore,
  snap: Snapshot,
  processEvent: (store: EoStore, event: EoEvent) => Promise<number>,
): Promise<number> {
  for (const event of snap.events) {
    await processEvent(store, event);
  }
  return snap.seq;
}

/**
 * Hydrate the store from the snapshot chain.
 *
 * Downloads and replays each snapshot's events in order.
 * If any snapshot media was pruned (404), the range is recorded
 * as a gap — the SyncManager fills gaps from the room timeline.
 */
export async function applySnapshotChain(
  client: MatrixClient,
  store: EoStore,
  refs: SnapshotRef[],
  processEvent: (store: EoStore, event: EoEvent) => Promise<number>,
): Promise<{ seq: number; gaps: Array<{ from: number; to: number }> }> {
  if (refs.length === 0) return { seq: 0, gaps: [] };

  let currentSeq = 0;
  const gaps: Array<{ from: number; to: number }> = [];

  for (const ref of refs) {
    // Detect gap: this snapshot starts after where we left off
    if (ref.base_seq > currentSeq) {
      gaps.push({ from: currentSeq, to: ref.base_seq });
    }

    if (ref.seq <= currentSeq) continue;

    try {
      const snap = await downloadSnapshot(client, ref.mxc);
      currentSeq = await applySnapshot(store, snap, processEvent);
    } catch {
      // Media was pruned or unreachable — record as gap
      gaps.push({ from: ref.base_seq, to: ref.seq });
    }
  }

  return { seq: currentSeq, gaps };
}

// ---------------------------------------------------------------------------
// Auto-snapshot trigger
// ---------------------------------------------------------------------------

/**
 * Auto-snapshot: create every 1000 events since the last snapshot.
 */
export async function maybeCreateSnapshot(
  client: MatrixClient,
  roomId: string,
  store: EoStore,
  myUserId: string,
): Promise<void> {
  const lastSeq = await store.getCurrentSeq();
  const lastSnapshotSeq: number = (await store.get('meta:snapshot_seq')) ?? 0;

  if (lastSeq - lastSnapshotSeq >= 1000) {
    const snapshot = await createSnapshot(store, myUserId);
    await uploadSnapshot(client, roomId, snapshot);
    await store.put('meta:snapshot_seq', lastSeq);
  }
}

// ---------------------------------------------------------------------------
// Non-destructive pruning
// ---------------------------------------------------------------------------

/**
 * Parse an mxc:// URL into server_name and media_id.
 * e.g. "mxc://app.aminoimmigration.com/AbCdEfGh" → ["app.aminoimmigration.com", "AbCdEfGh"]
 */
function parseMxcUrl(mxc: string): { serverName: string; mediaId: string } {
  const match = mxc.match(/^mxc:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid mxc URL: ${mxc}`);
  return { serverName: match[1], mediaId: match[2] };
}

/**
 * Delete a single media item from the Synapse media store.
 * Requires a Synapse server admin access token.
 *
 * This is non-destructive: the room timeline still contains all events,
 * so any deleted snapshot range can be reconstructed by replaying from
 * the timeline (it just takes longer).
 */
export async function deleteMedia(
  homeserver: string,
  accessToken: string,
  mxc: string,
): Promise<void> {
  const { serverName, mediaId } = parseMxcUrl(mxc);
  const url = `${homeserver}/_synapse/admin/v1/media/${serverName}/${mediaId}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to delete media ${mxc}: ${response.status} ${body}`);
  }
}

export interface PruneResult {
  deleted: string[];     // mxc URLs successfully deleted
  kept: string[];        // mxc URLs retained
  errors: string[];      // mxc URLs that failed to delete
}

/**
 * Prune old snapshots from the Matrix media store.
 *
 * Strategy: keep the most recent `keepCount` snapshots, delete the rest.
 * This is always safe because:
 *   1. The room timeline has every event (source of truth)
 *   2. Remaining snapshots still accelerate hydration
 *   3. Gaps are filled by timeline pagination at hydration time
 *
 * The snapshot *pointer events* in the room are immutable (Matrix doesn't
 * allow redacting others' events without admin), but the media behind
 * the mxc:// URLs is deleted — download attempts will 404, which the
 * hydration code treats as a gap.
 */
export async function pruneSnapshots(
  client: MatrixClient,
  roomId: string,
  homeserver: string,
  accessToken: string,
  keepCount: number = 3,
): Promise<PruneResult> {
  const all = await findAllSnapshots(client, roomId);
  const result: PruneResult = { deleted: [], kept: [], errors: [] };

  if (all.length <= keepCount) {
    result.kept = all.map(r => r.mxc);
    return result;
  }

  // Keep the N most recent (by seq), prune the rest
  const sorted = [...all].sort((a, b) => b.seq - a.seq);
  const toKeep = new Set(sorted.slice(0, keepCount).map(r => r.mxc));

  for (const ref of all) {
    if (toKeep.has(ref.mxc)) {
      result.kept.push(ref.mxc);
      continue;
    }

    try {
      await deleteMedia(homeserver, accessToken, ref.mxc);
      result.deleted.push(ref.mxc);
    } catch {
      result.errors.push(ref.mxc);
    }
  }

  return result;
}
