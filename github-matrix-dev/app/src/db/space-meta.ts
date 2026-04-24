/**
 * Space metadata persistence — saves space UUIDs and associated IDs to
 * localStorage so the app can reconnect to Google Drive without needing
 * Matrix for space discovery.
 *
 * Replaces the previous IDB-based implementation (root `eo-db` database,
 * `spacemeta:` key prefix).  localStorage is sufficient because space
 * metadata is small (a few fields per space) and does not need the
 * range-scan or encryption capabilities of the old IDB layer.
 */

export interface SpaceMeta {
  /** Internal space target, e.g. "space_amino" */
  spaceId: string;
  /** Human-readable name */
  spaceName: string;
  /** Matrix main room ID (for signaling) */
  mainRoomId: string;
  /** Last updated timestamp (ISO) */
  updatedAt: string;
}

const LS_PREFIX = 'eo-spacemeta:';

function lsKey(spaceId: string): string {
  return `${LS_PREFIX}${spaceId}`;
}

/**
 * Save (upsert) space metadata to localStorage.
 * Merges with any existing entry so callers can update individual fields.
 */
export function saveSpaceMeta(
  meta: Partial<SpaceMeta> & Pick<SpaceMeta, 'spaceId'>,
): void {
  const existing = getSpaceMeta(meta.spaceId);
  const merged: SpaceMeta = {
    spaceName: meta.spaceId,
    mainRoomId: '',
    ...existing,
    ...meta,
    updatedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(lsKey(meta.spaceId), JSON.stringify(merged));
  } catch {
    // quota exceeded — best effort
  }
}

/**
 * Read space metadata for a single space from localStorage.
 */
export function getSpaceMeta(spaceId: string): SpaceMeta | null {
  try {
    const raw = localStorage.getItem(lsKey(spaceId));
    if (!raw) return null;
    return JSON.parse(raw) as SpaceMeta;
  } catch {
    return null;
  }
}

/**
 * List all persisted space metadata entries from localStorage.
 */
export function listSpaceMeta(): SpaceMeta[] {
  const metas: SpaceMeta[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LS_PREFIX)) {
        const raw = localStorage.getItem(key);
        if (raw) {
          try { metas.push(JSON.parse(raw) as SpaceMeta); } catch { /* skip corrupt entry */ }
        }
      }
    }
  } catch {
    // localStorage unavailable
  }
  return metas;
}

/**
 * Delete space metadata for a single space from localStorage.
 */
export function removeSpaceMeta(spaceId: string): void {
  try { localStorage.removeItem(lsKey(spaceId)); } catch { /* best effort */ }
}

/**
 * Clear ALL space metadata entries from localStorage (e.g., on sign-out).
 */
export function clearAllSpaceMetas(): void {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LS_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch { /* best effort */ }
}

/**
 * Convenience wrapper kept for call-site compatibility.
 * Now synchronous — no IDB handle needed.
 */
export async function persistSpaceMeta(
  meta: Partial<SpaceMeta> & Pick<SpaceMeta, 'spaceId'>,
): Promise<void> {
  saveSpaceMeta(meta);
}
