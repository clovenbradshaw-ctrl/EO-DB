/**
 * Persistence helpers for the Airtable sync UI state.
 *
 * The Zustand store keeps `syncLog`, `currentSync`, and the continuous-sync
 * toggle in memory, which means a page refresh wipes them — leaving the user
 * with no evidence of what the previous session was doing. These helpers
 * stash the same state into the existing EoStore meta keyspace (alongside
 * `meta:at_cursor:*`) so the next mount can restore it.
 *
 * Keys:
 *   - `meta:at_synclog`           — JSON array of SyncLogEntry (cap 100).
 *   - `meta:at_current_sync`      — snapshot of CurrentSyncSnapshot or null.
 *   - `meta:at_continuous_enabled` — boolean mirror of the toggle.
 */

import type { EoStore } from '../db/encrypted-store';
import type { CurrentSyncSnapshot, SyncLogEntry } from './airtable-store';
import { airtableSnapshotRefKey } from './airtable-snapshot';

const KEY_SYNC_LOG = 'meta:at_synclog';
const KEY_CURRENT_SYNC = 'meta:at_current_sync';
const KEY_CONTINUOUS_ENABLED = 'meta:at_continuous_enabled';

/**
 * A `currentSync` snapshot older than this is treated as a crashed / orphan
 * run on restore. We still surface it to the user (so they know "the previous
 * session was syncing X and we don't know how it ended") but flag it rather
 * than pretending the sync is still in flight.
 */
export const ORPHAN_CURRENT_SYNC_MS = 5 * 60_000;

// ─── Sync log ───────────────────────────────────────────────────────────────

export async function loadSyncLog(store: EoStore): Promise<SyncLogEntry[]> {
  try {
    const raw = await store.get(KEY_SYNC_LOG);
    if (!raw) return [];
    // EoStore may round-trip either a string (IndexedDB JSON text) or a
    // pre-parsed object, depending on the backend. Handle both defensively.
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed as SyncLogEntry[];
  } catch {
    return [];
  }
}

export async function saveSyncLog(store: EoStore, entries: SyncLogEntry[]): Promise<void> {
  try {
    // Cap at 100 — matches the in-memory ring buffer in airtable-store.ts
    // so the persisted copy never drifts larger than the runtime copy.
    const capped = entries.slice(0, 100);
    await store.put(KEY_SYNC_LOG, JSON.stringify(capped));
  } catch {
    // Persistence is best-effort — a failed write shouldn't block the sync.
  }
}

// ─── Current sync snapshot ─────────────────────────────────────────────────

export async function loadCurrentSync(store: EoStore): Promise<CurrentSyncSnapshot | null> {
  try {
    const raw = await store.get(KEY_CURRENT_SYNC);
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as CurrentSyncSnapshot;
  } catch {
    return null;
  }
}

export async function saveCurrentSync(store: EoStore, snap: CurrentSyncSnapshot | null): Promise<void> {
  try {
    if (snap == null) {
      await store.del(KEY_CURRENT_SYNC);
    } else {
      await store.put(KEY_CURRENT_SYNC, JSON.stringify(snap));
    }
  } catch {
    /* best-effort */
  }
}

/**
 * True if the snapshot's `startedAt` is older than ORPHAN_CURRENT_SYNC_MS —
 * i.e. we should treat it as a previous session's crashed run rather than a
 * live in-flight sync.
 */
export function isOrphanSnapshot(snap: CurrentSyncSnapshot, now: number = Date.now()): boolean {
  return now - snap.startedAt > ORPHAN_CURRENT_SYNC_MS;
}

// ─── Continuous-sync toggle ────────────────────────────────────────────────

export async function loadContinuousEnabled(store: EoStore): Promise<boolean> {
  try {
    const raw = await store.get(KEY_CONTINUOUS_ENABLED);
    if (raw == null) return false;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') return raw === 'true' || raw === '1';
    return false;
  } catch {
    return false;
  }
}

export async function saveContinuousEnabled(store: EoStore, enabled: boolean): Promise<void> {
  try {
    await store.put(KEY_CONTINUOUS_ENABLED, enabled ? 'true' : 'false');
  } catch {
    /* best-effort */
  }
}

// ─── Published snapshot refs ───────────────────────────────────────────────

/**
 * Reference to a baked Airtable hydration snapshot on Google Drive. The
 * Drive file itself is the source of truth; this ref is a local hint so
 * the same device (or a device with access to the same Drive folder) can
 * skip a full re-hydration on bootstrap.
 *
 * `contentHash` is reserved for future integrity verification — today we
 * rely on the `.eodb` trailer's FNV-1a checksum, but a SHA-256 over the
 * whole file would let us detect silent Drive corruption before replay.
 */
export interface PublishedSnapshotRef {
  baseId: string;
  driveFileId: string;
  fileName: string;
  byteSize: number;
  publishedAt: string;
  eventCount: number;
  contentHash?: string;
}

export async function loadPublishedSnapshotRef(
  store: EoStore,
  baseId: string,
): Promise<PublishedSnapshotRef | null> {
  try {
    const raw = await store.get(airtableSnapshotRefKey(baseId));
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as PublishedSnapshotRef;
  } catch {
    return null;
  }
}

export async function savePublishedSnapshotRef(
  store: EoStore,
  ref: PublishedSnapshotRef,
): Promise<void> {
  try {
    await store.put(airtableSnapshotRefKey(ref.baseId), JSON.stringify(ref));
  } catch {
    /* best-effort */
  }
}
