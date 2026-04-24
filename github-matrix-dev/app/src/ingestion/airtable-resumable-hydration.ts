/**
 * Resumable Airtable hydration — save-first, ingest-later.
 *
 * Contrast with the one-shot `hydrationSync()` in airtable-sync.ts: that
 * path holds the entire `RawImportBundle` in memory, optionally uploads a
 * provenance blob AFTER collection, and folds straight into the store. A
 * crash anywhere in the pipeline requires a full re-fetch from Airtable.
 *
 * This module splits the pipeline into two checkpointed phases:
 *
 *   Phase A (fetch) — Airtable → NDJSON bundle on Google Drive.
 *     Per-table: paginate records, append `page` lines to an in-memory
 *     writer. When a table's pages are complete, append a `table_end`
 *     sentinel, re-upload the bundle to Drive (overwrite), and checkpoint.
 *
 *   Phase B (fold)  — NDJSON bundle → EoStore.
 *     Per-table: invoke `processHydrationBundle()` against a bundle that
 *     only contains the unfolded tables. The underlying fold is
 *     idempotent on re-run (deterministic `client_event_id`s), so a crash
 *     simply leaves the checkpoint in a state that resumes from the first
 *     unfolded table.
 *
 * Recovery semantics:
 *   - A crash during fetch leaves the last fully-fetched table marked
 *     `complete` on both Drive and the checkpoint; partially-fetched
 *     tables are re-done from page 0. (Airtable's opaque page offsets
 *     expire too quickly to resume mid-table reliably.)
 *   - A crash during fold leaves folded tables marked `complete`; unfolded
 *     tables re-run on resume, hitting the fold's idempotency guards for
 *     any events already applied before the crash.
 *   - A signature change in the customization (different table selection,
 *     different field exclusions, etc.) invalidates the checkpoint —
 *     callers should start a new import rather than silently merge.
 *
 * Drive is optional. Without a Drive backend (e.g. the user hasn't
 * connected one yet) the bundle stays in memory; the user can still
 * download it via the tee'd blob, but a reload loses it. Drive is the
 * durable path and the only one that supports cross-session resume.
 */

import type { EoStore } from '../db/encrypted-store';
import type {
  AirtableClient,
  AirtableRecord,
} from './airtable-client';
import {
  discoverSchema,
  processHydrationBundle,
  type HydrationManifest,
  type HydrationResult,
  type RawImportBundle,
  type SyncCustomization,
  type SyncProgress,
  type SyncResult,
  type ProvenanceResult,
} from './airtable-sync';
import {
  HydrationBundleWriter,
  hydrationBundleFilename,
  parseHydrationBundle,
  type HydrationBundlePage,
} from './airtable-hydration-bundle';
import {
  customizationSignature,
  clearCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  type HydrationCheckpoint,
  type HydrationTableCheckpoint,
} from './airtable-hydration-checkpoint';

/**
 * Narrow interface a Drive backend must satisfy. Lets the orchestrator run
 * against a future durable backend in production and against an
 * in-memory fake in tests without coupling to the full Drive service.
 */
export interface HydrationBundleDrive {
  uploadHydrationBundle(
    bytes: Uint8Array,
    opts: { fileName: string; importId: string },
  ): Promise<{ fileName: string; driveFileId: string; byteSize: number }>;
  downloadHydrationBundle(fileName: string): Promise<Uint8Array | null>;
}

export interface ResumableHydrationProgress extends SyncProgress {
  /** Which checkpointed phase the orchestrator is currently driving. */
  checkpointPhase?: 'fetching' | 'uploading' | 'folding' | 'complete';
  /** 0-based index into `checkpoint.tables` for the currently-active table. */
  tableIndex?: number;
  totalTables?: number;
}

export interface ResumableHydrationOptions {
  customization?: SyncCustomization;
  /**
   * Require a fresh run even if a matching checkpoint exists. Callers use
   * this when the user has explicitly clicked "restart" rather than
   * "resume" — otherwise resume is the default.
   */
  forceRestart?: boolean;
  onProgress?: (p: ResumableHydrationProgress) => void;
  /**
   * Fires after every successful checkpoint write — the UI uses this to
   * mirror live progress into Zustand without polling the store.
   */
  onCheckpoint?: (cp: HydrationCheckpoint) => void;
  /**
   * Fires every time the NDJSON bundle grows (after each table in the
   * fetch phase). Receives a fresh `Blob` so the caller can update the
   * download button's href without racing the in-flight upload.
   */
  onBundleTee?: (blob: Blob, byteSize: number) => void;
  /** Forwarded straight to `processHydrationBundle()`. */
  onEvent?: (event: unknown) => void;
  /** Forwarded per fold-phase table-complete. */
  onTableComplete?: (result: SyncResult) => void;
}

export interface ResumableHydrationResult {
  checkpoint: HydrationCheckpoint;
  /** The downloadable bundle. Always present once fetch has completed. */
  bundleBlob: Blob;
  bundleBytes: Uint8Array;
  bundleFileName: string;
  /** Populated when the fold phase ran. */
  fold?: HydrationResult;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

export async function resumableHydrationSync(
  store: EoStore,
  client: AirtableClient,
  agent: string,
  drive: HydrationBundleDrive | null,
  opts?: ResumableHydrationOptions,
): Promise<ResumableHydrationResult> {
  const customization = opts?.customization;
  const sig = customizationSignature(customization);

  // ── Load / initialise checkpoint ────────────────────────────────────────
  const existing = opts?.forceRestart ? null : await loadCheckpoint(store);
  let checkpoint: HydrationCheckpoint;

  if (existing && existing.customizationSig === sig && existing.phase !== 'complete') {
    checkpoint = existing;
  } else {
    if (existing) {
      // Signature mismatch or explicit restart — wipe before starting fresh.
      await clearCheckpoint(store);
    }
    checkpoint = await bootstrapCheckpoint(client, sig, opts);
    await saveCheckpoint(store, checkpoint);
  }
  opts?.onCheckpoint?.(checkpoint);

  // ── Seed the bundle writer ─────────────────────────────────────────────
  let writer: HydrationBundleWriter;
  if (checkpoint.bundle?.fileName && drive) {
    const existingBytes = await drive
      .downloadHydrationBundle(checkpoint.bundle.fileName)
      .catch(() => null);
    writer = existingBytes
      ? HydrationBundleWriter.fromBytes(existingBytes)
      : await freshWriter(checkpoint);
  } else {
    writer = await freshWriter(checkpoint);
  }
  emitTee(writer, opts);

  // ── Phase A: fetch ──────────────────────────────────────────────────────
  if (checkpoint.phase === 'fetching' || checkpoint.phase === 'error') {
    await runFetchPhase(store, client, drive, writer, checkpoint, opts);
    checkpoint.phase = 'fetched';
    await saveCheckpoint(store, checkpoint);
    opts?.onCheckpoint?.(checkpoint);
  }

  // ── Phase B: fold ───────────────────────────────────────────────────────
  let foldResult: HydrationResult | undefined;
  if (checkpoint.phase === 'fetched' || checkpoint.phase === 'folding') {
    checkpoint.phase = 'folding';
    await saveCheckpoint(store, checkpoint);
    opts?.onCheckpoint?.(checkpoint);

    foldResult = await runFoldPhase(store, agent, writer, checkpoint, opts);

    checkpoint.phase = 'complete';
    await saveCheckpoint(store, checkpoint);
    opts?.onCheckpoint?.(checkpoint);
  }

  opts?.onProgress?.({
    phase: 'table_done',
    checkpointPhase: 'complete',
  });

  return {
    checkpoint,
    bundleBlob: writer.toBlob(),
    bundleBytes: writer.toBytes(),
    bundleFileName: checkpoint.bundle?.fileName ?? hydrationBundleFilename(checkpoint.importId),
    fold: foldResult,
  };
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

async function bootstrapCheckpoint(
  client: AirtableClient,
  customizationSig: string,
  opts: ResumableHydrationOptions | undefined,
): Promise<HydrationCheckpoint> {
  opts?.onProgress?.({ phase: 'discovering', checkpointPhase: 'fetching' });
  const manifest = await discoverSchema(client);
  const selected = opts?.customization?.selectedTables;
  const tables: HydrationTableCheckpoint[] = [];

  for (const base of manifest.bases) {
    const baseTables = selected?.[base.id];
    if (selected && !baseTables?.length) continue;
    for (const table of base.tables) {
      if (baseTables && !baseTables.includes(table.id)) continue;
      tables.push({
        baseId: base.id,
        baseName: base.name,
        tableId: table.id,
        tableName: table.name,
        useFieldIds: table.fields.length > 0,
        recordsFetched: 0,
        pagesFetched: 0,
        fetch: 'pending',
        recordsFolded: 0,
        fold: 'pending',
      });
    }
  }

  const importId = generateImportId();
  return {
    importId,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'fetching',
    customizationSig,
    manifest,
    bundle: { fileName: hydrationBundleFilename(importId) },
    tables,
  };
}

function generateImportId(): string {
  try {
    const id = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
    if (id) return id;
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function freshWriter(
  checkpoint: HydrationCheckpoint,
): Promise<HydrationBundleWriter> {
  const w = new HydrationBundleWriter();
  if (!checkpoint.manifest) throw new Error('checkpoint missing manifest');
  w.appendLine({
    type: 'header',
    format: 'eo-hydration-bundle',
    version: 1,
    source: 'airtable',
    importId: checkpoint.importId,
    collectedAt: new Date(checkpoint.startedAt).toISOString(),
    manifest: checkpoint.manifest,
  });
  return w;
}

function emitTee(
  writer: HydrationBundleWriter,
  opts: ResumableHydrationOptions | undefined,
): void {
  if (!opts?.onBundleTee) return;
  try {
    opts.onBundleTee(writer.toBlob(), writer.byteLength);
  } catch {
    /* tee is advisory — never blocks the fetch */
  }
}

// ─── Phase A: fetch ────────────────────────────────────────────────────────

async function runFetchPhase(
  store: EoStore,
  client: AirtableClient,
  drive: HydrationBundleDrive | null,
  writer: HydrationBundleWriter,
  checkpoint: HydrationCheckpoint,
  opts: ResumableHydrationOptions | undefined,
): Promise<void> {
  const recordLimit = opts?.customization?.recordLimit;
  const limit = recordLimit && recordLimit > 0 ? recordLimit : Infinity;

  for (let i = 0; i < checkpoint.tables.length; i++) {
    const t = checkpoint.tables[i];
    if (t.fetch === 'complete') continue;

    // A partial table from a prior crash: reset counters; the bundle's
    // table slice will be rewritten because Drive overwrites the whole
    // file on upload. (Any prior partial pages in the in-memory writer
    // can't be surgically removed, but because we only upload after full
    // tables, Drive never saw the partial.)
    t.fetch = 'in_progress';
    t.recordsFetched = 0;
    t.pagesFetched = 0;
    await saveCheckpoint(store, checkpoint);
    opts?.onCheckpoint?.(checkpoint);
    opts?.onProgress?.({
      phase: 'collecting',
      checkpointPhase: 'fetching',
      base: t.baseName,
      baseName: t.baseName,
      baseId: t.baseId,
      table: t.tableName,
      tableId: t.tableId,
      records_so_far: 0,
      tableIndex: i,
      totalTables: checkpoint.tables.length,
    });

    let pageIndex = 0;
    let reachedLimit = false;
    for await (const page of client.paginateRecords(t.baseId, t.tableId, {
      returnFieldsByFieldId: t.useFieldIds,
    })) {
      let records: AirtableRecord[] = page;
      if (t.recordsFetched + records.length > limit) {
        records = records.slice(0, Math.max(0, limit - t.recordsFetched));
        reachedLimit = true;
      }
      if (records.length > 0) {
        const line: HydrationBundlePage = {
          type: 'page',
          baseId: t.baseId,
          baseName: t.baseName,
          tableId: t.tableId,
          tableName: t.tableName,
          useFieldIds: t.useFieldIds,
          pageIndex,
          records,
        };
        writer.appendLine(line);
        t.recordsFetched += records.length;
        t.pagesFetched = pageIndex + 1;
        pageIndex++;
      }
      opts?.onProgress?.({
        phase: 'collecting',
        checkpointPhase: 'fetching',
        base: t.baseName,
        baseName: t.baseName,
        baseId: t.baseId,
        table: t.tableName,
        tableId: t.tableId,
        records_so_far: t.recordsFetched,
        tableIndex: i,
        totalTables: checkpoint.tables.length,
      });
      if (reachedLimit) break;
    }

    writer.appendLine({
      type: 'table_end',
      baseId: t.baseId,
      tableId: t.tableId,
      recordCount: t.recordsFetched,
    });
    t.fetch = 'complete';

    // Upload at every table boundary — that's our recovery granularity.
    if (drive) {
      opts?.onProgress?.({
        phase: 'syncing',
        checkpointPhase: 'uploading',
        base: t.baseName,
        baseName: t.baseName,
        baseId: t.baseId,
        table: t.tableName,
        tableId: t.tableId,
        tableIndex: i,
        totalTables: checkpoint.tables.length,
      });
      const bytes = writer.toBytes();
      try {
        const upload = await drive.uploadHydrationBundle(bytes, {
          fileName: checkpoint.bundle?.fileName ?? hydrationBundleFilename(checkpoint.importId),
          importId: checkpoint.importId,
        });
        checkpoint.bundle = {
          fileName: upload.fileName,
          driveFileId: upload.driveFileId,
          byteSize: upload.byteSize,
          uploadedAt: new Date().toISOString(),
        };
      } catch (e) {
        // An upload failure is recoverable: the user can retry, and the
        // table's data is still in the in-memory writer. We persist the
        // checkpoint (marking the table fetched) so a page reload still
        // picks up where we left off — but only after the NEXT successful
        // upload, since that's the only way Drive knows about the data.
        // For now, surface the error and bail so the user sees it.
        checkpoint.error = `bundle upload failed after table "${t.tableName}": ${(e as Error).message}`;
        checkpoint.phase = 'error';
        t.fetch = 'in_progress';
        await saveCheckpoint(store, checkpoint);
        opts?.onCheckpoint?.(checkpoint);
        throw e;
      }
    }

    await saveCheckpoint(store, checkpoint);
    opts?.onCheckpoint?.(checkpoint);
    emitTee(writer, opts);
  }

  const totalRecords = checkpoint.tables.reduce((s, t) => s + t.recordsFetched, 0);
  writer.appendLine({
    type: 'end',
    importId: checkpoint.importId,
    completedAt: new Date().toISOString(),
    tableCount: checkpoint.tables.length,
    recordCount: totalRecords,
  });

  if (drive) {
    const bytes = writer.toBytes();
    const upload = await drive.uploadHydrationBundle(bytes, {
      fileName: checkpoint.bundle?.fileName ?? hydrationBundleFilename(checkpoint.importId),
      importId: checkpoint.importId,
    });
    checkpoint.bundle = {
      fileName: upload.fileName,
      driveFileId: upload.driveFileId,
      byteSize: upload.byteSize,
      uploadedAt: new Date().toISOString(),
    };
  }
  emitTee(writer, opts);
}

// ─── Phase B: fold ─────────────────────────────────────────────────────────

async function runFoldPhase(
  store: EoStore,
  agent: string,
  writer: HydrationBundleWriter,
  checkpoint: HydrationCheckpoint,
  opts: ResumableHydrationOptions | undefined,
): Promise<HydrationResult> {
  const parsed = parseHydrationBundle(writer.toBytes());
  if (!checkpoint.manifest) {
    checkpoint.manifest = parsed.header.manifest;
  }

  // Build a RawImportBundle containing ONLY tables that still need folding.
  // Idempotent client_event_ids mean re-running folded tables is safe, but
  // skipping saves work and keeps the UI's "records remaining" honest.
  const pendingTables = checkpoint.tables.filter((t) => t.fold !== 'complete');
  const pendingKeys = new Set(pendingTables.map((t) => `${t.baseId}:${t.tableId}`));
  const bundleTables = parsed.tables
    .filter((pt) => pendingKeys.has(`${pt.baseId}:${pt.tableId}`))
    .map((pt) => ({
      baseId: pt.baseId,
      baseName: pt.baseName,
      tableId: pt.tableId,
      tableName: pt.tableName,
      useFieldIds: pt.useFieldIds,
      records: pt.pages.flatMap((p) => p.records),
    }));

  const rawBundle: RawImportBundle = {
    source: 'airtable',
    importId: checkpoint.importId,
    collectedAt: parsed.header.collectedAt,
    manifest: parsed.header.manifest,
    tables: bundleTables,
  };

  // Provenance link: bundle file is the source of truth for this import.
  let provenance: ProvenanceResult | undefined;
  if (checkpoint.bundle?.driveFileId) {
    provenance = {
      fileName: checkpoint.bundle.fileName,
      driveFileId: checkpoint.bundle.driveFileId,
      byteSize: checkpoint.bundle.byteSize ?? writer.byteLength,
    };
  }

  const result = await processHydrationBundle(store, rawBundle, agent, {
    customization: opts?.customization,
    onProgress: (p) => {
      opts?.onProgress?.({
        ...p,
        checkpointPhase: 'folding',
      });
    },
    onEvent: opts?.onEvent,
    onTableComplete: async (r) => {
      // Mark fold complete for this table in the checkpoint. Persist so a
      // crash after this point doesn't force re-folding done tables.
      const cpTable = checkpoint.tables.find(
        (t) => t.baseId === r.base_id && t.tableId === r.table_id,
      );
      if (cpTable) {
        cpTable.fold = 'complete';
        cpTable.recordsFolded = r.records_ingested;
      }
      await saveCheckpoint(store, checkpoint);
      opts?.onCheckpoint?.(checkpoint);
      opts?.onTableComplete?.(r);
    },
    provenance,
  });

  return result;
}
