/**
 * Checkpoint persistence for the resumable Airtable hydration flow.
 *
 * The checkpoint is a single IndexedDB meta key that survives page reloads.
 * It records which tables have been fully fetched, which have been fully
 * folded, and where the saved NDJSON bundle lives on Drive so a later
 * session (on the same device) can resume without re-fetching Airtable
 * pages that are already safely saved.
 *
 * Per-table granularity — if a fetch crashes mid-table the whole table is
 * re-fetched from page 0 on resume, because Airtable's paginator offsets
 * expire quickly and are not reliably resumable across reloads. Tables
 * marked `fetch: 'complete'` are skipped entirely.
 */

import type { EoStore } from '../db/encrypted-store';
import type { HydrationManifest, SyncCustomization } from './airtable-sync';
import { AMINO_CONNECTION_ID } from './airtable-store';

/**
 * Keyspace for the single-connection legacy Amino hydration checkpoint.
 * Kept for backward compatibility — on-disk data written before the
 * multi-connection refactor uses this exact key. New code paths read/write
 * through `checkpointKey(cid)`, which returns this same string when
 * `cid === AMINO_CONNECTION_ID`.
 */
export const HYDRATION_CHECKPOINT_KEY = 'meta:at_hydration_checkpoint';

/**
 * Per-connection checkpoint key. The Amino flow stays on the legacy
 * (unprefixed) key so existing on-disk checkpoints continue to load
 * without migration; any other connection id gets a cid-suffixed key
 * so two BYOPAT hydrations can run side-by-side without collision.
 */
function checkpointKey(connectionId: string): string {
  return connectionId === AMINO_CONNECTION_ID
    ? HYDRATION_CHECKPOINT_KEY
    : `${HYDRATION_CHECKPOINT_KEY}:${connectionId}`;
}

export type HydrationPhase =
  | 'fetching'
  | 'fetched'
  | 'folding'
  | 'complete'
  | 'error';

export type TableStatus = 'pending' | 'in_progress' | 'complete';

export interface HydrationTableCheckpoint {
  baseId: string;
  baseName: string;
  tableId: string;
  tableName: string;
  useFieldIds: boolean;
  recordsFetched: number;
  pagesFetched: number;
  fetch: TableStatus;
  recordsFolded: number;
  fold: TableStatus;
}

export interface HydrationBundleRef {
  fileName: string;
  driveFileId?: string;
  byteSize?: number;
  uploadedAt?: string;
}

export interface HydrationCheckpoint {
  importId: string;
  startedAt: number;
  updatedAt: number;
  phase: HydrationPhase;
  /**
   * Stable signature of the SyncCustomization used when this run started.
   * Resumes refuse to proceed if the current customization doesn't match —
   * a user who narrowed/widened the table selection should start a new run
   * rather than silently merge against stale rows.
   */
  customizationSig: string;
  manifest?: HydrationManifest;
  bundle?: HydrationBundleRef;
  tables: HydrationTableCheckpoint[];
  error?: string;
}

// ─── Signatures ────────────────────────────────────────────────────────────

/**
 * Deterministic signature used to detect "same customization" on resume.
 * Intentionally conservative: any change (including reordering selected
 * tables) produces a new signature so the UI can force a fresh import.
 */
export function customizationSignature(
  customization: SyncCustomization | undefined,
): string {
  if (!customization) return '{}';
  const normalized = {
    selectedTables: normalizeSelectedTables(customization.selectedTables),
    fieldExclusions: customization.fieldExclusions
      ? Object.keys(customization.fieldExclusions)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            const v = customization.fieldExclusions![k];
            acc[k] = {
              fields: [...(v.fields ?? [])].sort(),
              patterns: [...(v.patterns ?? [])].sort(),
            };
            return acc;
          }, {})
      : undefined,
    preserveExisting: customization.preserveExisting ?? false,
    recordLimit: customization.recordLimit ?? 0,
    displayFields: customization.displayFields
      ? Object.keys(customization.displayFields)
          .sort()
          .reduce<Record<string, string>>((acc, k) => {
            acc[k] = customization.displayFields![k];
            return acc;
          }, {})
      : undefined,
    defaultResolution: customization.defaultResolution ?? 'unspecified',
  };
  return JSON.stringify(normalized);
}

function normalizeSelectedTables(
  selected: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!selected) return undefined;
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(selected).sort()) {
    out[k] = [...selected[k]].sort();
  }
  return out;
}

// ─── Store I/O ─────────────────────────────────────────────────────────────

export async function loadCheckpoint(
  store: EoStore,
  opts: { connectionId?: string } = {},
): Promise<HydrationCheckpoint | null> {
  const cid = opts.connectionId ?? AMINO_CONNECTION_ID;
  try {
    const raw = await store.get(checkpointKey(cid));
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    const cp = parsed as HydrationCheckpoint;
    if (!cp.importId || !Array.isArray(cp.tables)) return null;
    return cp;
  } catch {
    return null;
  }
}

export async function saveCheckpoint(
  store: EoStore,
  checkpoint: HydrationCheckpoint,
  opts: { connectionId?: string } = {},
): Promise<void> {
  const cid = opts.connectionId ?? AMINO_CONNECTION_ID;
  checkpoint.updatedAt = Date.now();
  try {
    await store.put(checkpointKey(cid), JSON.stringify(checkpoint));
  } catch {
    /* best-effort — an ephemeral write failure shouldn't abort the run */
  }
}

export async function clearCheckpoint(
  store: EoStore,
  opts: { connectionId?: string } = {},
): Promise<void> {
  const cid = opts.connectionId ?? AMINO_CONNECTION_ID;
  try {
    await store.del(checkpointKey(cid));
  } catch {
    /* best-effort */
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

export function summarizeCheckpoint(cp: HydrationCheckpoint): {
  tables: number;
  tablesFetched: number;
  tablesFolded: number;
  recordsFetched: number;
  recordsFolded: number;
} {
  let tablesFetched = 0;
  let tablesFolded = 0;
  let recordsFetched = 0;
  let recordsFolded = 0;
  for (const t of cp.tables) {
    if (t.fetch === 'complete') tablesFetched++;
    if (t.fold === 'complete') tablesFolded++;
    recordsFetched += t.recordsFetched;
    recordsFolded += t.recordsFolded;
  }
  return {
    tables: cp.tables.length,
    tablesFetched,
    tablesFolded,
    recordsFetched,
    recordsFolded,
  };
}
