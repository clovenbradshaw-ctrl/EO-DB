/**
 * Space metadata persistence — saves space UUIDs and associated IDs to the
 * root IndexedDB so the app can reconnect to Google Drive without needing
 * Matrix for space discovery.
 *
 * Stored under the `kv` object store of the root `eo-db` database using
 * keys prefixed with `spacemeta:`. Values are JSON-encoded Uint8Arrays.
 */

import { createIdb, idbGet, idbPut, idbIterator, type EoIdb } from './idb';

export interface SpaceMeta {
  /** Internal space target, e.g. "space_amino" */
  spaceId: string;
  /** Human-readable name */
  spaceName: string;
  /** Matrix main room ID (for signaling) */
  mainRoomId: string;
  /** Google Drive folder ID (if known) */
  gdriveFolderId?: string;
  /** Last updated timestamp (ISO) */
  updatedAt: string;
}

const PREFIX = 'spacemeta:';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeJson(obj: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(obj));
}

function decodeJson<T>(buf: Uint8Array): T {
  return JSON.parse(decoder.decode(buf));
}

/**
 * Save (upsert) space metadata to the root IDB.
 * Merges with any existing entry so callers can update individual fields.
 */
export async function saveSpaceMeta(
  rootIdb: EoIdb,
  meta: Partial<SpaceMeta> & Pick<SpaceMeta, 'spaceId'>,
): Promise<void> {
  const key = `${PREFIX}${meta.spaceId}`;
  const existing = await idbGet(rootIdb, key);
  let merged: SpaceMeta;
  if (existing) {
    const prev = decodeJson<SpaceMeta>(existing);
    merged = { ...prev, ...meta, updatedAt: new Date().toISOString() };
  } else {
    merged = {
      spaceName: meta.spaceId,
      mainRoomId: '',
      ...meta,
      updatedAt: new Date().toISOString(),
    } as SpaceMeta;
  }
  await idbPut(rootIdb, key, encodeJson(merged));
}

/**
 * Read space metadata for a single space from the root IDB.
 */
export async function getSpaceMeta(
  rootIdb: EoIdb,
  spaceId: string,
): Promise<SpaceMeta | null> {
  const raw = await idbGet(rootIdb, `${PREFIX}${spaceId}`);
  if (!raw) return null;
  return decodeJson<SpaceMeta>(raw);
}

/**
 * List all persisted space metadata entries from the root IDB.
 */
export async function listSpaceMeta(rootIdb: EoIdb): Promise<SpaceMeta[]> {
  const rows = await idbIterator(rootIdb, PREFIX);
  return rows.map(([, buf]) => decodeJson<SpaceMeta>(buf));
}

/**
 * Convenience: open the root IDB, save, then close.
 * Use when you don't already have a root IDB handle.
 */
export async function persistSpaceMeta(
  meta: Partial<SpaceMeta> & Pick<SpaceMeta, 'spaceId'>,
): Promise<void> {
  const rootIdb = await createIdb();
  try {
    await saveSpaceMeta(rootIdb, meta);
  } finally {
    rootIdb.close();
  }
}
