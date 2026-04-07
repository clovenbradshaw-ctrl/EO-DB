/**
 * Matrix manifest — the room's index of what data lives in n8n.
 *
 * Each stored blob gets a state event in the Matrix room:
 *   type      = "eo.n8n.manifest"
 *   state_key = data_id
 *   content   = ManifestEntry
 *
 * This is how the Matrix room "knows what data it's looking for":
 * any client joining the room can read the full manifest from room state,
 * see every blob's content_hash, encryption key_id, data type, and size,
 * then call GET on n8n to retrieve and decrypt exactly what it needs.
 *
 * Manifest entries are immutable — once written they are never updated.
 * To supersede a snapshot, write a new entry and optionally tombstone the old.
 */

import type { IMatrixClient, IRoom, IMatrixEvent } from '../matrix/types.js';
import type { ManifestEntry, ManifestDataType } from './types.js';

/** Matrix event type for manifest entries. */
export const MANIFEST_EVENT_TYPE = 'eo.n8n.manifest';

/** Matrix event type for the manifest index (latest-of-each-type pointers). */
export const MANIFEST_INDEX_TYPE = 'eo.n8n.manifest.index';

// ─── Publish ───────────────────────────────────────────────────────────────

/**
 * Publish a manifest entry as a Matrix room state event.
 * Called after a successful POST to n8n — this is what makes the data
 * discoverable to every device in the room.
 */
export async function publishManifest(
  client: IMatrixClient,
  roomId: string,
  entry: ManifestEntry,
): Promise<string> {
  const { event_id } = await client.sendStateEvent(
    roomId,
    MANIFEST_EVENT_TYPE,
    entry as unknown as Record<string, any>,
    entry.data_id, // state_key = data_id → one event per blob
  );

  // Update the "latest" index pointer for this data type
  await updateIndex(client, roomId, entry);

  return event_id;
}

/**
 * Update the per-type index pointer.
 * State key = data_type, content = { latest_data_id, latest_hash, updated_at }.
 * Clients bootstrapping can read just the index to find the newest snapshot
 * without scanning every manifest entry.
 */
async function updateIndex(
  client: IMatrixClient,
  roomId: string,
  entry: ManifestEntry,
): Promise<void> {
  await client.sendStateEvent(
    roomId,
    MANIFEST_INDEX_TYPE,
    {
      latest_data_id: entry.data_id,
      latest_hash: entry.content_hash,
      data_type: entry.data_type,
      key_id: entry.key_id,
      size: entry.size,
      seq_range: entry.seq_range ?? null,
      updated_at: entry.created_at,
    },
    entry.data_type, // state_key = data_type
  );
}

// ─── Read ──────────────────────────────────────────────────────────────────

/**
 * Read a single manifest entry from room state.
 */
export function getManifestEntry(
  room: IRoom,
  dataId: string,
): ManifestEntry | null {
  const ev = room.currentState.getStateEvents(MANIFEST_EVENT_TYPE, dataId);
  if (!ev) return null;
  return ev.getContent() as unknown as ManifestEntry;
}

/**
 * Read the latest manifest entry for a given data type (e.g. "snapshot").
 * Uses the index pointer so we don't need to scan all entries.
 */
export function getLatestManifest(
  room: IRoom,
  dataType: ManifestDataType,
): ManifestEntry | null {
  const indexEv = room.currentState.getStateEvents(MANIFEST_INDEX_TYPE, dataType);
  if (!indexEv) return null;

  const content = indexEv.getContent();
  const dataId = content.latest_data_id as string | undefined;
  if (!dataId) return null;

  return getManifestEntry(room, dataId);
}

/**
 * List ALL manifest entries in the room, optionally filtered by data type.
 * Reads from room state — no network calls needed.
 */
export function listManifestEntries(
  room: IRoom,
  filterType?: ManifestDataType,
): ManifestEntry[] {
  const stateMap = room.currentState.events;
  const manifestEvents: Map<string, IMatrixEvent> | Record<string, IMatrixEvent> | undefined =
    stateMap instanceof Map
      ? stateMap.get(MANIFEST_EVENT_TYPE)
      : stateMap[MANIFEST_EVENT_TYPE];

  if (!manifestEvents) return [];

  const entries: ManifestEntry[] = [];
  const iter =
    manifestEvents instanceof Map
      ? manifestEvents.values()
      : Object.values(manifestEvents);

  for (const ev of iter) {
    const content = ev.getContent() as unknown as ManifestEntry;
    if (!content.data_id) continue; // skip malformed
    if (filterType && content.data_type !== filterType) continue;
    entries.push(content);
  }

  // Sort newest first
  entries.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
  return entries;
}

/**
 * Tombstone (soft-delete) a manifest entry.
 * Writes a replacement state event with `{ tombstoned: true }`.
 * The blob remains in n8n until n8n's own retention policy cleans it up.
 */
export async function tombstoneManifest(
  client: IMatrixClient,
  roomId: string,
  dataId: string,
  reason?: string,
): Promise<void> {
  await client.sendStateEvent(
    roomId,
    MANIFEST_EVENT_TYPE,
    {
      tombstoned: true,
      tombstoned_at: new Date().toISOString(),
      tombstoned_by: client.getUserId(),
      reason: reason ?? 'superseded',
    },
    dataId,
  );
}
