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
import type { EoDb } from '../db/level.js';
import { getCurrentSeq, encode, decode } from '../db/level.js';
import { readLogSince } from '../db/log.js';
import { processEvent } from '../db/fold.js';
import type { Feed } from '../db/feed.js';
import type { IMatrixClient, ImportMeta } from './types.js';
import type { DeltaSnapshot } from './types.js';
import { EO_SNAPSHOT_TYPE, EO_SNAPSHOT_STATE_TYPE, EO_IMPORT_TYPE } from './event-bridge.js';
import type { LocalKeyring, KeyringEntry } from '../db/crypto-types.js';
import { getKeyById } from '../crypto/segment-keys.js';
import {
  encryptSnapshot,
  decryptSnapshot,
  isEncryptedEnvelope,
  getEnvelopeKeyId,
} from '../crypto/snapshot-crypto.js';

/** Maximum number of previous snapshot URIs carried in each snapshot. */
const MAX_PREV_MXCS = 25;

/** Auto-snapshot every 500 log entries. */
export const SNAPSHOT_FREQUENCY = 500;

// ─── Meta key helpers (LevelDB) ────────────────────────────────────────────

async function getMeta<T>(db: EoDb, key: string): Promise<T | null> {
  try {
    return decode(await db.get(key)) as T;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

async function setMeta(db: EoDb, key: string, value: any): Promise<void> {
  await db.put(key, encode(value));
}

// ─── Room State Events ─────────────────────────────────────────────────────

/**
 * Store the latest snapshot URI in room state for fast hydration.
 *
 * Room state is available instantly via `room.currentState` — no timeline
 * pagination needed. Each call overwrites the previous value so the state
 * always points to the most recent snapshot.
 */
export async function setSnapshotStateEvent(
  client: IMatrixClient,
  roomId: string,
  mxc: string,
  seq: number,
  keyId?: string,
): Promise<void> {
  await client.sendStateEvent(roomId, EO_SNAPSHOT_STATE_TYPE, {
    mxc,
    seq,
    ts: new Date().toISOString(),
    ...(keyId ? { key_id: keyId } : {}),
  }, '');
}

/**
 * Find the latest snapshot URI — fast path via room state, slow fallback
 * via timeline pagination.
 */
export async function findLatestSnapshot(
  client: IMatrixClient,
  roomId: string,
): Promise<{ mxc: string; seq: number } | null> {
  const room = client.getRoom(roomId);
  if (!room) return null;

  // Fast path: read directly from room state (O(1)).
  const stateEvent = room.currentState.getStateEvents(EO_SNAPSHOT_STATE_TYPE, '');
  if (stateEvent) {
    const content = stateEvent.getContent();
    if (content.mxc && typeof content.seq === 'number') {
      return { mxc: content.mxc, seq: content.seq };
    }
  }

  // Slow fallback: walk the live timeline looking for snapshot events.
  const timeline = room.getLiveTimeline();
  let latest: { mxc: string; seq: number } | null = null;

  for (const event of timeline.getEvents()) {
    const evType = event.getType();
    if (evType === EO_SNAPSHOT_TYPE || evType === EO_IMPORT_TYPE) {
      const content = event.getContent();
      if (!latest || content.seq > latest.seq) {
        latest = { mxc: content.mxc, seq: content.seq };
      }
    }
  }

  // Attempt to paginate backwards if nothing found yet.
  let canPaginate = !latest;
  while (canPaginate) {
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
    if (latest) break;
  }

  return latest;
}

// ─── Delta Snapshot Create / Upload ────────────────────────────────────────

/**
 * Auto-snapshot: create a delta every SNAPSHOT_FREQUENCY log entries.
 * Below this threshold the hydration state lives in room data only.
 */
export async function maybeCreateSnapshot(
  client: IMatrixClient,
  roomId: string,
  db: EoDb,
  myUserId: string,
  snapshotKey?: { key: CryptoKey; key_id: string },
): Promise<void> {
  const lastSeq = await getCurrentSeq(db);
  const lastSnapshotSeq = (await getMeta<number>(db, 'meta:snapshot_seq')) || 0;

  if (lastSeq - lastSnapshotSeq >= SNAPSHOT_FREQUENCY) {
    const delta = await createDeltaSnapshot(db, myUserId);
    const mxc = await uploadDeltaSnapshot(client, roomId, delta, snapshotKey);
    await setMeta(db, 'meta:snapshot_seq', lastSeq);
    await setMeta(db, 'meta:snapshot_mxc', mxc);
    const prevMxcs: string[] = (await getMeta<string[]>(db, 'meta:snapshot_prev_mxcs')) || [];
    await setMeta(db, 'meta:snapshot_prev_mxcs', [mxc, ...prevMxcs].slice(0, MAX_PREV_MXCS));
  }
}

/**
 * Create a delta snapshot from the log events since the last snapshot.
 * Carries prev_mxcs from the store for chain traversal.
 */
export async function createDeltaSnapshot(
  db: EoDb,
  myUserId: string,
): Promise<DeltaSnapshot> {
  const lastSnapshotSeq = (await getMeta<number>(db, 'meta:snapshot_seq')) || 0;
  const currentSeq = await getCurrentSeq(db);
  const prevMxcs: string[] = (await getMeta<string[]>(db, 'meta:snapshot_prev_mxcs')) || [];

  const events = await readLogSince(db, lastSnapshotSeq);

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
 *
 * Encoding: msgpack binary, uploaded as application/octet-stream.
 * Filename: eo-delta-{from_seq}-{to_seq}.bin
 */
export async function uploadDeltaSnapshot(
  client: IMatrixClient,
  roomId: string,
  delta: DeltaSnapshot,
  snapshotKey?: { key: CryptoKey; key_id: string },
): Promise<string> {
  const plainBinary = pack(delta);

  // Encrypt the blob if a snapshot key is available (defense-in-depth)
  const binary = snapshotKey
    ? await encryptSnapshot(snapshotKey.key, snapshotKey.key_id, plainBinary)
    : plainBinary;

  const uploadResult = await client.uploadContent(binary, {
    name: `eo-delta-${delta.from_seq}-${delta.to_seq}.bin`,
    type: 'application/octet-stream',
  });

  const mxcUrl = uploadResult.content_uri;

  // Post a timeline event referencing the snapshot (for timeline-walking fallback)
  await client.sendEvent(roomId, EO_SNAPSHOT_TYPE, {
    mxc: mxcUrl,
    seq: delta.to_seq,
    ts: delta.ts,
    size_bytes: binary.byteLength,
    version: delta.version,
    type: 'delta',
    encrypted: !!snapshotKey,
  });

  // Set room state for O(1) fast-path lookup
  await setSnapshotStateEvent(client, roomId, mxcUrl, delta.to_seq, snapshotKey?.key_id);

  return mxcUrl;
}

/**
 * Download and decode a delta snapshot from its mxc URI.
 */
export async function downloadDeltaSnapshot(
  client: IMatrixClient,
  mxcUrl: string,
  keyring?: LocalKeyring,
): Promise<DeltaSnapshot> {
  const httpUrl = client.mxcUrlToHttp(mxcUrl);
  if (!httpUrl) throw new Error('Cannot resolve mxc URL');

  const response = await fetch(httpUrl);
  const raw = new Uint8Array(await response.arrayBuffer());

  // Check if the blob is an encrypted envelope
  if (isEncryptedEnvelope(raw)) {
    const keyId = getEnvelopeKeyId(raw);
    if (!keyId) throw new Error('Encrypted snapshot has no key_id');

    const entry = keyring ? getKeyById(keyring, keyId) : null;
    if (!entry) {
      throw new Error(`Cannot decrypt snapshot — missing key ${keyId}`);
    }

    const plainBytes = await decryptSnapshot(entry.key, raw);
    return unpack(plainBytes) as DeltaSnapshot;
  }

  // Legacy unencrypted snapshot
  return unpack(raw) as DeltaSnapshot;
}

/**
 * Restore from a chain of delta snapshots.
 *
 * Downloads the latest delta, then batch-fetches all its `prev_mxcs`
 * (up to 25) in parallel. If we still haven't reached local seq, the
 * oldest fetched delta's own `prev_mxcs` gives us the next batch.
 * This means we fetch ~26 deltas per round trip instead of 1.
 *
 * Once all needed deltas are collected, events are applied in
 * chronological order through the fold engine (which deduplicates via
 * content-addressable hashing).
 */
export async function restoreFromDeltaChain(
  client: IMatrixClient,
  db: EoDb,
  latestMxc: string,
  feed?: Feed,
  keyring?: LocalKeyring,
): Promise<number> {
  const localSeq = await getCurrentSeq(db);
  const deltas: DeltaSnapshot[] = [];
  const seen = new Set<string>();

  // Fetch the head delta
  const head = await downloadDeltaSnapshot(client, latestMxc, keyring);
  seen.add(latestMxc);

  if (head.to_seq <= localSeq) return localSeq;

  deltas.push(head);

  // Keep fetching batches until we have continuity with local state
  let needMore = head.from_seq > localSeq;

  while (needMore) {
    const oldest = deltas[0];
    const toFetch = oldest.prev_mxcs.filter((mxc) => !seen.has(mxc));

    if (toFetch.length === 0) break;

    for (const mxc of toFetch) seen.add(mxc);
    const results = await Promise.allSettled(
      toFetch.map((mxc) => downloadDeltaSnapshot(client, mxc, keyring)),
    );
    const batch = results
      .filter((r): r is PromiseFulfilledResult<DeltaSnapshot> => r.status === 'fulfilled')
      .map(r => r.value);

    for (const delta of batch) {
      if (delta.to_seq <= localSeq) continue;
      deltas.push(delta);
    }

    deltas.sort((a, b) => a.from_seq - b.from_seq);
    needMore = deltas[0].from_seq > localSeq;
  }

  // Apply events chronologically through the fold engine
  let lastAppliedSeq = localSeq;
  for (const delta of deltas) {
    for (const event of delta.events) {
      if (event.seq <= localSeq) continue;
      const seq = await processEvent(db, event, feed);
      lastAppliedSeq = Math.max(lastAppliedSeq, seq);
    }
  }

  return lastAppliedSeq;
}

// ─── Import Snapshots (Grounded Imports) ──────────────────────────────────

/** Maximum events per grounded import chunk to bound memory. */
export const IMPORT_CHUNK_SIZE = 10_000;

/**
 * Create an import snapshot from a pre-collected array of folded events.
 *
 * Unlike `createDeltaSnapshot` (which reads from the log), this accepts
 * events directly — the caller has already folded them and knows the
 * seq range.
 */
export function createImportSnapshot(
  events: import('../db/types.js').EoEvent[],
  fromSeq: number,
  toSeq: number,
  createdBy: string,
  importMeta?: ImportMeta,
): DeltaSnapshot {
  const prevMxcs: string[] = []; // Caller fills in via linkImportToPrevChain
  return {
    version: 2,
    type: 'import',
    from_seq: fromSeq,
    to_seq: toSeq,
    prev_mxcs: prevMxcs,
    ts: new Date().toISOString(),
    created_by: createdBy,
    events,
    import_meta: importMeta,
  };
}

/**
 * Upload a grounded import snapshot to Matrix media and post a single
 * lightweight timeline event. Also updates snapshot room state so the
 * import is woven into the hydration chain.
 *
 * Returns the mxc URI of the uploaded binary.
 */
export async function uploadImportSnapshot(
  client: IMatrixClient,
  roomId: string,
  snapshot: DeltaSnapshot,
  snapshotKey?: { key: CryptoKey; key_id: string },
): Promise<string> {
  const plainBinary = pack(snapshot);

  const binary = snapshotKey
    ? await encryptSnapshot(snapshotKey.key, snapshotKey.key_id, plainBinary)
    : plainBinary;

  const uploadResult = await client.uploadContent(binary, {
    name: `eo-import-${snapshot.from_seq}-${snapshot.to_seq}.bin`,
    type: 'application/octet-stream',
  });

  const mxcUrl = uploadResult.content_uri;

  // Post one lightweight timeline event (the only Matrix "post" for this import)
  await client.sendEvent(roomId, EO_IMPORT_TYPE, {
    mxc: mxcUrl,
    seq: snapshot.to_seq,
    ts: snapshot.ts,
    size_bytes: binary.byteLength,
    version: snapshot.version,
    type: 'import',
    event_count: snapshot.events.length,
    import_meta: snapshot.import_meta,
    encrypted: !!snapshotKey,
  });

  // Update room state so hydration chain includes this import
  await setSnapshotStateEvent(client, roomId, mxcUrl, snapshot.to_seq, snapshotKey?.key_id);

  return mxcUrl;
}
