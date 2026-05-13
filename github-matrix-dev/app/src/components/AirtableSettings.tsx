/**
 * Airtable integration settings panel.
 *
 * The Airtable API key is delivered via the n8n webhook (same one used for
 * Filen credentials) and held in-memory only. No key management UI — the
 * webhook handles authentication.
 *
 * Sync runs entirely in the browser — Airtable API calls go directly from
 * the browser, records fold into IndexedDB via processEvent.
 *
 * Continuous sync is coordinated via Matrix room state events
 * (eo.airtable.head) so only one client calls the Airtable API at a time.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { pack } from 'msgpackr';
import type { MatrixClient } from 'matrix-js-sdk';
import { useEoStore, createImportProgressListener } from '../store/eo-store';
import type { MatrixSession } from '../matrix/client';
import {
  discoverSchema,
  emitHydrationSchema,
  getSyncedTableIds,
  hydrationSync,
  smartSync,
  type HydrationManifest,
  type HydrationTableSchema,
  type SyncCustomization,
} from '../ingestion/airtable-sync';
import {
  encodeAirtableSnapshot,
  decodeAirtableSnapshot,
  replayAirtableSnapshot,
  airtableSnapshotFilename,
} from '../ingestion/airtable-snapshot';
import { createMemoryStore } from '../db/memory-store';
import { AirtableSyncTransparency } from './AirtableSyncTransparency';
import type { EoEventInput, Resolution } from '../db/types';
import { publishEoEventBatch } from '../sync/publish-events';
import { useAirtableStore, createAirtableClient, webhookHealthPatch, DEFAULT_SYNC_SETTINGS, type SyncLogEntry, type CurrentSyncSnapshot } from '../ingestion/airtable-store';
import { AirtableSyncService } from '../ingestion/airtable-sync-service';
import {
  loadSyncLog,
  saveSyncLog,
  loadCurrentSync,
  saveCurrentSync,
  loadContinuousEnabled,
  isOrphanSnapshot,
} from '../ingestion/airtable-persistence';
import {
  loadCheckpoint as loadHydrationCheckpoint,
  clearCheckpoint as clearHydrationCheckpoint,
  saveCheckpoint as saveHydrationCheckpoint,
  summarizeCheckpoint,
  customizationSignature,
  type HydrationCheckpoint,
  type HydrationTableCheckpoint,
} from '../ingestion/airtable-hydration-checkpoint';
import { resumableHydrationSync } from '../ingestion/airtable-resumable-hydration';
import { runAirtableSync, SyncBusyError } from '../ingestion/airtable-sync-runner';
import {
  hydrationBundleFilename,
  HYDRATION_BUNDLE_FORMAT,
  type HydrationBundleHeader,
} from '../ingestion/airtable-hydration-bundle';
import { createHydrationBundleDrive } from '../ingestion/airtable-hydration-bundle-drive';
import { loadSpaceKeyring } from '../crypto/keyring-store';
import { isAminoHomeserver } from '../lib/matrix-domain';
import { useTheme, type Theme } from '../theme';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SyncStatus {
  state: 'idle' | 'syncing' | 'discovering' | 'done' | 'error';
  message?: string;
  detail?: string;
}

interface AirtableSettingsProps {
  session: MatrixSession;
  onClose: () => void;
  matrixClient?: MatrixClient | null;
  roomId?: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function guessNameField(fields: Array<{ id: string; name: string; type: string }>): string | undefined {
  const namePatterns = [
    /^name$/i,
    /^full[\s_-]?name$/i,
    /^display[\s_-]?name$/i,
    /^title$/i,
    /^label$/i,
    /^client[\s_-]?name$/i,
    /^company[\s_-]?name$/i,
    /^project[\s_-]?name$/i,
    /^subject$/i,
    /name/i,
    /title/i,
  ];
  for (const pattern of namePatterns) {
    const match = fields.find(f => pattern.test(f.name) && (f.type === 'singleLineText' || f.type === 'multilineText' || f.type === 'richText'));
    if (match) return match.id;
  }
  for (const pattern of namePatterns) {
    const match = fields.find(f => pattern.test(f.name));
    if (match) return match.id;
  }
  return undefined;
}

/**
 * Trigger a regular browser file download for an in-memory byte array.
 * Used by the manual "Download from Airtable" snapshot flow so the user
 * ends up with a `.eodb` on disk that can be re-imported (or shared)
 * without re-hitting Airtable.
 */
function triggerBrowserDownload(fileName: string, bytes: Uint8Array): void {
  // Wrap in Blob — Uint8Array is not assignable to BodyInit/BlobPart
  // directly under our strict TS config.
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Revoke on the next tick — some browsers race the click handler.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Standalone Airtable settings section (no overlay wrapper).
 * Used inside the Settings page.
 */
export function AirtableSettingsSection({
  session,
  matrixClient,
  roomId,
}: {
  session: MatrixSession;
  matrixClient?: MatrixClient | null;
  roomId?: string | null;
}) {
  const store = useEoStore((s) => s.store);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  // ── Airtable store ──
  const connected = useAirtableStore((st) => st.connected);
  const connecting = useAirtableStore((st) => st.connecting);
  const apiKey = useAirtableStore((st) => st.apiKey);
  const storeError = useAirtableStore((st) => st.error);
  const isSyncing = useAirtableStore((st) => st.isSyncing);
  const isPrimarySyncer = useAirtableStore((st) => st.isPrimarySyncer);
  const lastSyncAt = useAirtableStore((st) => st.lastSyncAt);
  const continuousSyncEnabled = useAirtableStore((st) => st.continuousSyncEnabled);
  const syncSettings = useAirtableStore((st) => st.syncSettings);
  const manifest = useAirtableStore((st) => st.manifest);
  const syncLog = useAirtableStore((st) => st.syncLog);
  const currentSync = useAirtableStore((st) => st.currentSync);
  const nextTickAt = useAirtableStore((st) => st.nextTickAt);

  // ── Live 1s ticker so relative timestamps / countdowns update even when
  //    no sync events are firing. Cheap: one setState per second.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Sync state ──
  const [syncStatus, setSyncStatus] = useState<Record<string, SyncStatus>>({});

  // ── Table selection: { baseId: [tableId, ...] } ──
  const [tableSelections, setTableSelections] = useState<Record<string, string[]>>({});

  // ── Previously-synced tables loaded from IndexedDB cursors ──
  const [syncedTableIds, setSyncedTableIds] = useState<Record<string, string[]>>({});

  // ── Preserve existing toggle (initialized from sync settings) ──
  const [preserveExisting, setPreserveExisting] = useState(syncSettings.preserveExisting);

  // ── Record limit (0 = no limit) ──
  const [recordLimit, setRecordLimit] = useState(syncSettings.recordLimit);

  // ── Display field per table: { tableId: fieldId } ──
  const [displayFieldSelections, setDisplayFieldSelections] = useState<Record<string, string>>({});

  // ── Batch-level import resolution stance (Phase A.6/4) ──
  // Stamped onto every record INS event constructed during this import,
  // encoding the caller's declared stance on how rows are coming into
  // existence. 'unspecified' (the default) means no stance is recorded —
  // INS events carry nibble 0 on the lattice's resolution axis.
  const [importResolution, setImportResolution] = useState<Resolution>('unspecified');

  // ── Expanded tables (for field preview): Set of tableId ──
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());

  // ── Amino auto-sync gate ──
  // Amino users get continuous sync turned on by default — the toggle is
  // hidden and the service starts as soon as an API key is available.
  const isAmino = isAminoHomeserver(session.homeserver);

  // ── Sync service ref ──
  const syncServiceRef = useRef<AirtableSyncService | null>(null);

  // ── Cleanup sync service on unmount ──
  useEffect(() => {
    return () => {
      syncServiceRef.current?.stop();
    };
  }, []);

  // ── Load previously-synced table IDs from IndexedDB cursors ──
  useEffect(() => {
    if (!store) return;
    getSyncedTableIds(store).then(setSyncedTableIds);
  }, [store]);

  // ── Orphan-run banner: set by the persistence hydrate effect when the
  //    previous session had a currentSync snapshot older than the orphan
  //    threshold. Cleared once the next successful sync completes.
  const [orphanSnapshot, setOrphanSnapshot] = useState<
    { phase: string; table?: string; strategy: string; startedAt: number } | null
  >(null);

  // ── Resumable hydration (save-first) state ──
  //
  // Holds whatever is known about the current or most-recent run of the
  // "Airtable → Drive NDJSON bundle → fold" pipeline. The checkpoint is
  // the source of truth for phase / per-table progress and is persisted to
  // IndexedDB so a reload resumes cleanly. `bundleBlob` is the tee'd local
  // copy of the bundle bytes — populated as the fetch progresses so the
  // "Download" button can serve without a Drive round-trip.
  const [hydrationCheckpoint, setHydrationCheckpoint] = useState<HydrationCheckpoint | null>(null);
  const bundleBlobRef = useRef<Blob | null>(null);
  const [bundleBlobSize, setBundleBlobSize] = useState<number>(0);

  // ── Drive backend for hydration bundles ─────────────────────────────────
  //
  // Wires the same `/webhook/eo-store` proxy the EoStore uses into the
  // resumable-hydration orchestrator. Bundles are encrypted with the space
  // keyring, chunked at 32 MB plaintext boundaries, and stored as one Drive
  // file per chunk plus a small encrypted manifest. Without this the
  // orchestrator's Drive parameter would be `null` and bundles would only
  // live in the in-memory tee — i.e. lost on reload.
  const hydrationDrive = useMemo(() => {
    if (!session.accessToken || !roomId) return null;
    return createHydrationBundleDrive({
      matrixToken: session.accessToken,
      spaceRoomId: roomId,
      loadKeyring: () => loadSpaceKeyring(roomId),
    });
  }, [session.accessToken, roomId]);

  // Load any persisted checkpoint on mount so the "Resume" CTA appears
  // immediately after a reload without waiting for the user to click anything.
  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    (async () => {
      const cp = await loadHydrationCheckpoint(store);
      if (!cancelled) setHydrationCheckpoint(cp);
    })();
    return () => { cancelled = true; };
  }, [store]);

  // ── Rehydrate persisted sync state on mount ──
  //   1. Synclog → Zustand so the Activity Log panel has context immediately.
  //   2. currentSync → if recent, restore as live; if older than the orphan
  //      threshold, surface as a "previous session may have been interrupted"
  //      banner instead of pretending the sync is still in flight.
  //   3. continuous-enabled flag → auto-restart the AirtableSyncService so the
  //      background loop resumes after a refresh without the user having to
  //      toggle the checkbox manually.
  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    (async () => {
      const [logEntries, current, enabled] = await Promise.all([
        loadSyncLog(store),
        loadCurrentSync(store),
        loadContinuousEnabled(store),
      ]);
      if (cancelled) return;

      if (logEntries.length > 0) {
        useAirtableStore.getState().hydrateSyncLog(logEntries);
      }

      if (current) {
        if (isOrphanSnapshot(current)) {
          setOrphanSnapshot({
            phase: current.phase,
            table: current.table,
            strategy: current.strategy,
            startedAt: current.startedAt,
          });
          // Stale — drop it so it doesn't keep showing as live.
          await saveCurrentSync(store, null);
        } else {
          useAirtableStore.getState().setCurrentSync(current);
        }
      }

      // Auto-resume continuous sync if the user had it on pre-refresh.
      if (enabled && useAirtableStore.getState().apiKey && matrixClient && roomId) {
        if (!syncServiceRef.current) {
          const service = new AirtableSyncService(
            matrixClient,
            roomId,
            store,
            session.userId,
            () => useAirtableStore.getState().apiKey,
            buildCustomization(),
          );
          syncServiceRef.current = service;
          useAirtableStore.getState().setContinuousSync(true);
          service.start();
        }
      }
    })();
    return () => { cancelled = true; };
    // Only re-run when the underlying identity pieces change — we don't want
    // to re-hydrate every time a log entry is added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, matrixClient, roomId, session.userId]);

  // ── Amino auto-start ──
  // For Amino users we skip the manual toggle: as soon as the apiKey,
  // Matrix client, and store are all in hand, spin up the sync service.
  // The service's `running` guard prevents duplicate starts, and the
  // unmount cleanup effect above handles stop().
  useEffect(() => {
    if (!isAmino) return;
    if (!store || !matrixClient || !roomId) return;
    if (!apiKey) return;
    if (syncServiceRef.current) return;
    const service = new AirtableSyncService(
      matrixClient,
      roomId,
      store,
      session.userId,
      () => useAirtableStore.getState().apiKey,
      buildCustomization(),
    );
    syncServiceRef.current = service;
    useAirtableStore.getState().setContinuousSync(true);
    service.start();
    // buildCustomization closes over per-render state (manifest, table
    // selections); we deliberately re-build only when the identity-level
    // deps change so we don't tear down a running service every time the
    // user toggles a checkbox in the table picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAmino, store, matrixClient, roomId, session.userId, apiKey]);

  // ── Persist sync log to IndexedDB (debounced) whenever it changes ──
  useEffect(() => {
    if (!store) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Subscribe directly to avoid taking a dependency on `syncLog` in
    // useEffect, which would allocate a new timer per log append.
    const unsub = useAirtableStore.subscribe((state, prev) => {
      if (state.syncLog === prev.syncLog) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => saveSyncLog(store, state.syncLog), 500);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [store]);

  // ── Connect via webhook ──
  async function handleConnect() {
    try {
      await useAirtableStore.getState().connectFromWebhook(session.accessToken);
    } catch {
      // Error is set in the store
    }
  }

  // ── Disconnect ──
  function handleDisconnect() {
    syncServiceRef.current?.stop();
    syncServiceRef.current = null;
    useAirtableStore.getState().disconnect();
  }

  // ── Resolve which display field to use for a table ──
  function resolveDisplayField(
    table: { id: string; primaryFieldId?: string; fields: Array<{ id: string; name: string; type: string }> },
  ): string | undefined {
    const override = displayFieldSelections[table.id];
    if (override) return override;
    return guessNameField(table.fields) || table.primaryFieldId;
  }

  // ── Toggle expanded table for field preview ──
  function toggleExpandedTable(tableId: string) {
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (next.has(tableId)) next.delete(tableId);
      else next.add(tableId);
      return next;
    });
  }

  // ── Set display field for a table ──
  function setDisplayField(tableId: string, fieldId: string) {
    setDisplayFieldSelections((prev) => ({ ...prev, [tableId]: fieldId }));
  }

  // ── Build customization from current UI state ──
  function buildCustomization(): SyncCustomization {
    const hasSelection = Object.values(tableSelections).some(t => t.length > 0);
    const hasSyncedIds = Object.keys(syncedTableIds).some(b => (syncedTableIds[b]?.length ?? 0) > 0);

    const selectedTables = hasSelection
      ? tableSelections
      : hasSyncedIds
      ? syncedTableIds
      : undefined;

    const displayFieldsMap: Record<string, string> = {};
    if (manifest) {
      for (const base of manifest.bases) {
        for (const table of base.tables) {
          const resolved = resolveDisplayField(table);
          if (resolved) displayFieldsMap[table.id] = resolved;
        }
      }
    }

    return {
      selectedTables,
      preserveExisting,
      recordLimit: recordLimit > 0 ? recordLimit : undefined,
      displayFields: Object.keys(displayFieldsMap).length > 0 ? displayFieldsMap : undefined,
      defaultResolution: importResolution !== 'unspecified' ? importResolution : undefined,
    };
  }

  // ── Toggle table selection ──
  function toggleTable(baseId: string, tableId: string) {
    setTableSelections((prev) => {
      const baseTables = [...(prev[baseId] || [])];
      const idx = baseTables.indexOf(tableId);
      if (idx >= 0) baseTables.splice(idx, 1);
      else baseTables.push(tableId);
      return { ...prev, [baseId]: baseTables };
    });
  }

  // ── Select/deselect all tables in a base ──
  function toggleAllTablesInBase(baseId: string, allTableIds: string[]) {
    setTableSelections((prev) => {
      const current = prev[baseId] || [];
      return { ...prev, [baseId]: current.length === allTableIds.length ? [] : [...allTableIds] };
    });
  }

  // ── Discover schema ──
  // Fetches the Airtable manifest AND immediately persists every discovered
  // base / table / field to the EO-DB store as EO operators. "Discovering"
  // and "importing the schema" are conceptually the same user-facing action,
  // so we don't gate the import on a second button click. emitHydrationSchema
  // is idempotent (stable client_event_ids dedupe), so re-running Discover is
  // a no-op when nothing has changed.
  async function handleDiscover() {
    if (!apiKey) return;
    setSyncStatus((prev) => ({ ...prev, discover: { state: 'discovering', message: 'Discovering bases & tables...' } }));

    try {
      const client = createAirtableClient();
      const disc = await discoverSchema(client);

      useAirtableStore.getState().setManifest(disc);

      // Pre-select previously-synced tables; fall back to all on first-ever discovery
      const hasSynced = Object.keys(syncedTableIds).some(b => (syncedTableIds[b]?.length ?? 0) > 0);
      const selection: Record<string, string[]> = {};
      for (const base of disc.bases) {
        if (hasSynced) {
          const syncedSet = new Set(syncedTableIds[base.id] ?? []);
          selection[base.id] = base.tables.filter(t => syncedSet.has(t.id)).map(t => t.id);
        } else {
          selection[base.id] = base.tables.map(t => t.id);
        }
      }
      setTableSelections(selection);

      // Refresh the synced index in case cursors were added since mount
      if (store) getSyncedTableIds(store).then(setSyncedTableIds);

      // Immediately persist the discovered schema to EO-DB as EO operators
      // AND publish them to the Matrix room so peers see the schema without
      // having to re-discover. Bridge onEvent through createImportProgressListener
      // so HolonNav, TableView, and friends repaint as DEF / INS events land —
      // finalize() is required after the loop because the listener batches on
      // a 100ms flush timer; without it the final batch never bumps `lastSeq`
      // and the left-side nav stays empty until the next unrelated event.
      // Inputs are collected in parallel and handed to publishEoEventBatch,
      // which decides per-table whether to send each event inline as
      // `m.eo.event` or to seal the batch into a media-store block + send a
      // single `m.eo.block` pointer. Failure is non-fatal: discovery already
      // succeeded; the local store has the schema even if room publish fails.
      let tablesEmitted = 0;
      let fieldsEmitted = 0;
      let blocksSpilled = 0;
      if (store) {
        const progressListener = createImportProgressListener();
        try {
          for (const base of disc.bases) {
            for (const table of base.tables) {
              const inputs: EoEventInput[] = [];
              await emitHydrationSchema(
                store,
                { id: base.id, name: base.name },
                {
                  id: table.id,
                  name: table.name,
                  primaryFieldId: table.primaryFieldId,
                  fieldCount: table.fieldCount,
                  fields: table.fields,
                },
                session.userId,
                displayFieldSelections[table.id],
                (event) => {
                  progressListener.onEvent(event);
                  const { seq: _seq, ...input } = event;
                  void _seq;
                  inputs.push(input as EoEventInput);
                },
              );
              if (matrixClient && roomId && inputs.length > 0) {
                try {
                  const res = await publishEoEventBatch(matrixClient, roomId, inputs);
                  if (res.mode === 'block') blocksSpilled += 1;
                } catch (e) {
                  console.warn(`[EO-DB] Publish schema events to room failed for ${base.name}/${table.name}:`, e);
                }
              }
              tablesEmitted += 1;
              fieldsEmitted += table.fields.length;
            }
          }
          if (tablesEmitted > 0) {
            const spillNote = blocksSpilled > 0
              ? `, ${blocksSpilled} table${blocksSpilled !== 1 ? 's' : ''} spilled to media-store block${blocksSpilled !== 1 ? 's' : ''}`
              : '';
            useAirtableStore.getState().addSyncLogEntry({
              ts: Date.now(),
              type: 'sync_complete',
              source: 'local',
              syncer: session.userId,
              detail: `Schema imported on discover: ${tablesEmitted} table${tablesEmitted !== 1 ? 's' : ''}, ${fieldsEmitted} field${fieldsEmitted !== 1 ? 's' : ''}${spillNote}`,
            });
          }
        } catch (e) {
          console.warn('[EO-DB] Auto-persist schema after discover failed:', e);
        } finally {
          progressListener.finalize();
        }
      }

      const baseCount = disc.bases.length;
      const tableCount = disc.bases.reduce((t, b) => t + b.tables.length, 0);

      setSyncStatus((prev) => ({
        ...prev,
        discover: {
          state: 'done',
          message: tablesEmitted > 0
            ? `Found ${baseCount} base${baseCount !== 1 ? 's' : ''}, ${tableCount} table${tableCount !== 1 ? 's' : ''} — schema imported (${fieldsEmitted} field${fieldsEmitted !== 1 ? 's' : ''})`
            : `Found ${baseCount} base${baseCount !== 1 ? 's' : ''}, ${tableCount} table${tableCount !== 1 ? 's' : ''}`,
        },
      }));
    } catch (e: any) {
      setSyncStatus((prev) => ({ ...prev, discover: { state: 'error', message: e.message || 'Discovery failed' } }));
    }
  }

  // ── Explicitly sync the Airtable schema ──
  // Re-fetches bases/tables/fields from Airtable and persists them to the
  // EO-DB store as proper EO operators (base/table/field DEF + INS events)
  // so the schema lives in Matrix room state alongside record data — not
  // just in the client-side manifest. Only emits for tables the user has
  // selected; new tables surface in the picker but stay unselected.
  async function handleSyncSchema() {
    if (!apiKey || !store) return;
    setSyncStatus((prev) => ({ ...prev, schemaSync: { state: 'discovering', message: 'Refreshing Airtable schema…' } }));

    try {
      const client = createAirtableClient();
      const disc = await discoverSchema(client);
      useAirtableStore.getState().setManifest(disc);

      // Preserve the user's existing table selections; add newly-discovered
      // tables as unselected so we don't suddenly start syncing them.
      const nextSelections: Record<string, string[]> = { ...tableSelections };
      for (const base of disc.bases) {
        if (!(base.id in nextSelections)) nextSelections[base.id] = [];
      }
      setTableSelections(nextSelections);

      // Emit base / table / field schema events to the EO-DB store AND
      // publish them to the Matrix room so peers can see schema changes
      // without re-discovering. Each table's events are collected into an
      // input array (via the `onEvent` bridge) and handed to
      // publishEoEventBatch, which auto-decides between sending each event
      // inline as `m.eo.event` or sealing the batch into a media-store block
      // + `m.eo.block` pointer when the payload exceeds Matrix's per-event
      // size limit. progressListener.finalize() is mandatory — it batches
      // on a 100 ms flush timer and HolonNav only repaints when `lastSeq`
      // bumps.
      const progressListener = createImportProgressListener();
      let tablesEmitted = 0;
      let fieldsEmitted = 0;
      let blocksSpilled = 0;
      try {
        for (const base of disc.bases) {
          const selected = new Set(nextSelections[base.id] ?? []);
          for (const table of base.tables) {
            if (!selected.has(table.id)) continue;
            const tblSchema: HydrationTableSchema = {
              id: table.id,
              name: table.name,
              primaryFieldId: table.primaryFieldId,
              fieldCount: table.fieldCount,
              fields: table.fields,
            };
            setSyncStatus((prev) => ({
              ...prev,
              schemaSync: { state: 'discovering', message: `Writing schema for ${base.name} › ${table.name}…` },
            }));
            const inputs: EoEventInput[] = [];
            await emitHydrationSchema(
              store,
              { id: base.id, name: base.name },
              tblSchema,
              session.userId,
              displayFieldSelections[table.id],
              (event) => {
                progressListener.onEvent(event);
                const { seq: _seq, ...input } = event;
                void _seq;
                inputs.push(input as EoEventInput);
              },
            );
            if (matrixClient && roomId && inputs.length > 0) {
              try {
                const res = await publishEoEventBatch(matrixClient, roomId, inputs);
                if (res.mode === 'block') blocksSpilled += 1;
              } catch (e) {
                console.warn(`[EO-DB] Publish schema events to room failed for ${base.name}/${table.name}:`, e);
              }
            }
            tablesEmitted += 1;
            fieldsEmitted += table.fields.length;
          }
        }
      } finally {
        progressListener.finalize();
      }

      const spillNote = blocksSpilled > 0
        ? `, ${blocksSpilled} table${blocksSpilled !== 1 ? 's' : ''} spilled to media-store block${blocksSpilled !== 1 ? 's' : ''}`
        : '';
      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: 'sync_complete',
        source: 'local',
        syncer: session.userId,
        detail: `Schema sync: ${tablesEmitted} table${tablesEmitted !== 1 ? 's' : ''}, ${fieldsEmitted} field${fieldsEmitted !== 1 ? 's' : ''}${spillNote}`,
      });

      const baseCount = disc.bases.length;
      const tableCount = disc.bases.reduce((t, b) => t + b.tables.length, 0);
      const summary = tablesEmitted === 0
        ? `Schema discovered: ${baseCount} base${baseCount !== 1 ? 's' : ''}, ${tableCount} table${tableCount !== 1 ? 's' : ''} (no tables selected — nothing persisted)`
        : `Schema saved to EO-DB & room: ${tablesEmitted} table${tablesEmitted !== 1 ? 's' : ''}, ${fieldsEmitted} field${fieldsEmitted !== 1 ? 's' : ''}${spillNote}`;
      setSyncStatus((prev) => ({
        ...prev,
        schemaSync: { state: 'done', message: summary },
      }));
    } catch (e: any) {
      setSyncStatus((prev) => ({ ...prev, schemaSync: { state: 'error', message: e.message || 'Schema sync failed' } }));
    }
  }

  // ── Trigger one-shot sync ──
  async function handleSync(mode: 'hydrate' | 'sync') {
    if (!apiKey || !store) return;

    const statusKey = mode;
    const modeLabel = mode === 'hydrate' ? 'Full Sync' : 'Update Sync';
    const strategy: 'hydration' | 'lastModified' =
      mode === 'hydrate' ? 'hydration' : 'lastModified';
    const tickStart = Date.now();
    setSyncStatus((prev) => ({ ...prev, [statusKey]: { state: 'syncing', message: `Starting ${modeLabel}...` } }));

    try {
      // Mirror the response observer the continuous-sync service installs,
      // so the manual "Run test sync" / "Run Update Sync" path also feeds
      // the Webhook Health panel. Mirror all webhook-endpoint calls (not
      // just /payloads) so setup failures like 403 INVALID_PERMISSIONS
      // appear immediately; mirror non-webhook failures only.
      const client = createAirtableClient({
        onResponse: (info) => {
          if (info.url.includes('/webhooks')) {
            useAirtableStore.getState().setWebhookHealth(webhookHealthPatch(info));
          } else if (!info.ok) {
            useAirtableStore.getState().setWebhookHealth(webhookHealthPatch(info));
          }
        },
      });
      // Manual sync clicks also count toward the session cycle counter.
      useAirtableStore.getState().incCycle();
      const customization = buildCustomization();

      // Honour the "Sync schema to EO-DB on each sync" setting: refresh the
      // manifest from Airtable and persist base/table/field schema events to
      // the store as EO operators for every selected table, before the record
      // sync runs. emitHydrationSchema is idempotent (stable client_event_ids
      // dedupe), so this is safe to call on every tick. Failure is non-fatal.
      if (useAirtableStore.getState().syncSettings.syncSchemaOnEachSync) {
        const preSyncListener = createImportProgressListener();
        try {
          const manifest = await discoverSchema(client);
          useAirtableStore.getState().setManifest(manifest);
          for (const base of manifest.bases) {
            const selected = new Set(tableSelections[base.id] ?? []);
            for (const table of base.tables) {
              if (!selected.has(table.id)) continue;
              const inputs: EoEventInput[] = [];
              await emitHydrationSchema(
                store,
                { id: base.id, name: base.name },
                {
                  id: table.id,
                  name: table.name,
                  primaryFieldId: table.primaryFieldId,
                  fieldCount: table.fieldCount,
                  fields: table.fields,
                },
                session.userId,
                displayFieldSelections[table.id],
                (event) => {
                  preSyncListener.onEvent(event);
                  const { seq: _seq, ...input } = event;
                  void _seq;
                  inputs.push(input as EoEventInput);
                },
              );
              if (matrixClient && roomId && inputs.length > 0) {
                try {
                  await publishEoEventBatch(matrixClient, roomId, inputs);
                } catch (e) {
                  console.warn(`[EO-DB] Publish pre-sync schema to room failed for ${base.name}/${table.name}:`, e);
                }
              }
            }
          }
        } catch (e) {
          console.warn('[EO-DB] Pre-sync schema emission failed:', e);
        } finally {
          preSyncListener.finalize();
        }
      }

      // Seed the live snapshot so the status card / global badge / toast
      // can show "preparing" immediately, before any network I/O starts.
      useAirtableStore.getState().setCurrentSync({
        startedAt: tickStart,
        phase: 'preparing',
        strategy,
        preserveExisting,
        recordsSoFar: 0,
        perTable: [],
      });
      saveCurrentSync(store, useAirtableStore.getState().currentSync);

      const onProgress = (p: any /* SyncProgress */) => {
        // Drive the local status strip …
        const msg = p.table
          ? `Syncing ${p.table}${p.records_so_far ? ` (${p.records_so_far} records)` : ''}...`
          : p.phase === 'discovering' ? 'Discovering schema...'
          : p.phase === 'collecting'  ? 'Collecting records...'
          : p.phase === 'folding'     ? 'Folding into local store...'
          : p.phase === 'fetching'    ? 'Fetching from Airtable...'
          : 'Working...';
        setSyncStatus((prev) => ({ ...prev, [statusKey]: { state: 'syncing', message: msg } }));

        // … and the global live snapshot so the header badge + status card
        // see the same information as the continuous service.
        const prev = useAirtableStore.getState().currentSync;
        if (!prev) return;
        const nextPerTable = [...prev.perTable];
        if (p.table) {
          const key = p.tableId ?? p.table;
          const idx = nextPerTable.findIndex((t) => (t.tableId ?? t.table) === key);
          const base = idx >= 0 ? nextPerTable[idx] : {
            table: p.table,
            tableId: p.tableId,
            ingested: 0,
            overwritten: 0,
            skipped: 0,
          };
          const patched = {
            ...base,
            table: p.table,
            tableId: p.tableId ?? base.tableId,
            ingested: p.ingested ?? base.ingested,
            overwritten: p.overwritten ?? base.overwritten,
            skipped: p.skipped ?? base.skipped,
          };
          if (idx >= 0) nextPerTable[idx] = patched;
          else nextPerTable.push(patched);
        }
        useAirtableStore.getState().setCurrentSync({
          ...prev,
          phase: p.phase === 'discovering' ? 'discovering'
            : p.phase === 'collecting' ? 'collecting'
            : p.phase === 'fetching' ? 'fetching'
            : p.phase === 'folding' ? 'folding'
            : p.phase === 'syncing' ? 'syncing'
            : p.phase === 'table_done' ? 'table_done'
            : prev.phase,
          strategy: p.strategy ?? prev.strategy,
          preserveExisting: p.preserveExisting ?? prev.preserveExisting,
          baseId: p.baseId ?? prev.baseId,
          baseName: p.baseName ?? p.base ?? prev.baseName,
          table: p.table ?? prev.table,
          tableId: p.tableId ?? prev.tableId,
          recordsSoFar: p.records_so_far ?? prev.recordsSoFar,
          endpoint: p.endpoint ?? prev.endpoint,
          cursorUsed: p.cursor ?? prev.cursorUsed,
          perTable: nextPerTable,
        });
      };

      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: 'sync_start',
        source: 'local',
        syncer: session.userId,
        detail: modeLabel,
        strategy,
        preserveExisting,
      });

      // Bridge per-event fold output into Zustand so subscribers like
      // TableView (which re-fetches on `lastSeq` change) refresh as records
      // land. Without this, hydration / update-sync write straight to the
      // MemoryStore + OPFS log but the UI never knows anything moved.
      const progressListener = createImportProgressListener();

      let result;
      try {
        // Gate the actual network + fold work behind the in-process sync
        // runner so a manual click can't interleave with the continuous
        // tick or a resumable hydration on this same tab.
        result = await runAirtableSync(
          mode === 'hydrate' ? 'manual-hydrate' : 'manual-update',
          () => mode === 'hydrate'
            ? hydrationSync(store, client, session.userId, {
                onProgress,
                onEvent: progressListener.onEvent,
                customization,
              })
            // "Update Sync" is now smartSync: per-table hydrate-or-incremental,
            // so a newly-selected table that's never been hydrated gets its
            // baseline pulled on the same click instead of sitting blank until
            // the user finds and presses "Full Sync".
            : smartSync(store, client, session.userId, {
              onProgress,
              onEvent: progressListener.onEvent,
              customization,
              // Surface per-record diffs to the "Recent changes" panel —
              // mirrors the wiring in AirtableSyncService so manually-
              // triggered "Run test sync" lights up the same UI as the
              // continuous loop.
              onChange: (report) => {
                useAirtableStore.getState().addRecentChange({
                  ts: Date.now(),
                  baseId: report.baseId,
                  tableId: report.tableId,
                  tableName: report.tableName ?? report.tableId,
                  recordId: report.recordId,
                  recordLabel: report.recordLabel,
                  diffs: report.diffs,
                });
                useAirtableStore.getState().addSyncLogEntry({
                  ts: Date.now(),
                  type: 'change_detected',
                  source: 'local',
                  syncer: session.userId,
                  detail: `${report.diffs.length} field${report.diffs.length === 1 ? '' : 's'}: ${report.diffs.map((d) => d.field).join(', ')}`,
                  baseId: report.baseId,
                  tableName: report.tableName,
                  recordId: report.recordId,
                  diffs: report.diffs,
                  recordsChanged: 1,
                });
              },
            }),
        );
      } finally {
        // Flush any pending throttled update so the UI sees the final
        // lastSeq even if the sync ended on an in-flight timer.
        progressListener.finalize();
      }

      if (result.total_records_ingested > 0) {
        try {
          await useEoStore.getState().flushToOpfs();
        } catch (e) {
          console.warn('[EO-DB] post-sync flushToOpfs failed:', e);
        }
      }

      const ingested = result.total_records_ingested;
      const overwritten = result.total_records_overwritten;
      const skipped = result.total_records_skipped;
      const duration = `${(result.duration_ms / 1000).toFixed(1)}s`;

      useAirtableStore.getState().setLastSyncResult(result);
      useAirtableStore.getState().setLastSyncAt(new Date().toISOString());
      const snap = useAirtableStore.getState().currentSync;
      const perTable = result.sync_results.map((r) => ({
        table: r.table_name,
        ingested: r.records_ingested,
        overwritten: r.records_overwritten,
        skipped: r.records_skipped_no_change + r.records_skipped_duplicate,
      }));
      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: mode === 'hydrate' ? 'hydration_complete' : 'sync_complete',
        source: 'local',
        syncer: session.userId,
        detail: overwritten > 0
          ? `${ingested} ingested, ${overwritten} overwritten, ${skipped} unchanged, ${duration}`
          : `${ingested} ingested, ${skipped} unchanged, ${duration}`,
        strategy,
        preserveExisting,
        perTable,
        durationMs: result.duration_ms,
        endpoint: snap?.endpoint,
        cursorUsed: snap?.cursorUsed,
        baseId: snap?.baseId,
        baseName: snap?.baseName,
      });
      // Clear the live snapshot — the run is over.
      useAirtableStore.getState().setCurrentSync(null);
      saveCurrentSync(store, null);
      // Once a successful sync completes, any stale "orphan run" banner is
      // obsolete — clear it.
      setOrphanSnapshot(null);

      setSyncStatus((prev) => ({
        ...prev,
        [statusKey]: {
          state: 'done',
          message: `${ingested} records synced`,
          detail: overwritten > 0
            ? `${overwritten} overwritten, ${skipped} unchanged, ${duration}`
            : `${skipped} unchanged, ${duration}`,
        },
      }));
    } catch (e: any) {
      const busy = e instanceof SyncBusyError;
      const snap = useAirtableStore.getState().currentSync;
      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: busy ? 'sync_skipped' : 'sync_error',
        source: 'local',
        syncer: session.userId,
        detail: busy
          ? `${modeLabel} deferred — ${e.active} already running`
          : (e.message || 'Sync failed'),
        strategy,
        preserveExisting,
        baseId: snap?.baseId,
        baseName: snap?.baseName,
        endpoint: snap?.endpoint,
        cursorUsed: snap?.cursorUsed,
        durationMs: Date.now() - tickStart,
      });
      useAirtableStore.getState().setCurrentSync(null);
      saveCurrentSync(store, null);
      setSyncStatus((prev) => ({
        ...prev,
        [statusKey]: {
          state: 'error',
          message: busy
            ? 'Another sync is running — wait for it to finish, then try again'
            : (e.message || 'Sync failed'),
        },
      }));
    }
  }

  // ── Initial hydration: download .eodb to disk (no fold into local DB) ──
  //
  // Runs the full Airtable pull against an in-memory scratch store so the
  // local DB stays untouched until the user explicitly imports the file.
  // The captured event stream + cursor map are encoded as a v2 .eodb
  // snapshot and triggered as a browser download.
  //
  // Why two manual steps? It isolates the Airtable network failure mode
  // from the local fold step: if the pull fails you get a clear error
  // here; if it succeeds you have a reusable artifact you can re-import
  // any number of times (or copy to another device) without re-hitting
  // Airtable.
  async function handleDownloadAirtableSnapshot() {
    if (!apiKey) return;
    setSyncStatus((prev) => ({
      ...prev,
      snapshotDownload: { state: 'syncing', message: 'Pulling from Airtable…' },
    }));
    const startedAt = Date.now();
    try {
      // Scratch in-memory EoStore — events fold into it, but it gets
      // garbage-collected the moment this handler returns. Nothing
      // touches the user's real local DB.
      const scratch = createMemoryStore();
      // Wire the same response-info hook used by continuous sync so the
      // Webhook Health panel reflects this manual pull too.
      const client = createAirtableClient({
        onResponse: (info) => {
          // Mirror failures into the panel even for non-/payloads URLs so
          // the user sees "401 on listBases" instead of a silent spinner.
          if (info.ok) return;
          useAirtableStore.getState().setWebhookHealth(webhookHealthPatch(info));
        },
      });

      const customization = buildCustomization();

      let downloadedBytes = 0;
      let baseCount = 0;
      let eventCount = 0;

      const result = await hydrationSync(scratch, client, session.userId, {
        customization,
        onProgress: (p: any) => {
          const msg = p.table
            ? `Pulling ${p.table}${p.records_so_far ? ` (${p.records_so_far} records)` : ''}…`
            : p.phase === 'discovering' ? 'Discovering schema…'
            : p.phase === 'collecting'  ? 'Collecting records…'
            : 'Working…';
          setSyncStatus((prev) => ({
            ...prev,
            snapshotDownload: { state: 'syncing', message: msg },
          }));
        },
        // After the scratch fold completes, encode + trigger one download
        // per base. We fan out per-base so a multi-base account still
        // produces self-contained files that can be imported individually.
        onSnapshotReady: async (payload) => {
          baseCount = payload.baseIds.length;
          eventCount = payload.events.length;

          for (const baseId of payload.baseIds) {
            const events = payload.events.filter((ev: any) => {
              const ref = ev?.operand?._airtable?.base_id;
              if (!ref) return true; // shared records (import bundle) → replicate per base
              return ref === baseId;
            });
            const cursors = payload.cursors[baseId]
              ? { [baseId]: payload.cursors[baseId] }
              : {};
            const fileName = airtableSnapshotFilename(baseId);
            const bytes = await encodeAirtableSnapshot(events, cursors, {
              collectionId: `airtable-hydration-${baseId}`,
              name: `Airtable hydration snapshot for ${baseId}`,
              // Surface encoding progress so the button doesn't look frozen
              // while msgpack packs large event arrays. Throttled implicitly
              // by the chunk size in encodeAirtableSnapshot.
              onProgress: (encoded, total) => {
                setSyncStatus((prev) => ({
                  ...prev,
                  snapshotDownload: {
                    state: 'syncing',
                    message: `Encoding ${baseId} snapshot… ${encoded}/${total} events`,
                  },
                }));
              },
            });
            downloadedBytes += bytes.byteLength;
            triggerBrowserDownload(fileName, bytes);
          }
        },
      });

      const ingested = result.total_records_ingested;
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: 'snapshot_downloaded',
        source: 'local',
        syncer: session.userId,
        detail: `${ingested} records → ${baseCount} file(s), ${eventCount} events, ${downloadedBytes} B, ${seconds}s`,
        durationMs: Date.now() - startedAt,
        recordsScanned: ingested,
      });
      setSyncStatus((prev) => ({
        ...prev,
        snapshotDownload: {
          state: 'done',
          message: `Saved ${baseCount} snapshot file${baseCount === 1 ? '' : 's'} (${ingested} records, ${seconds}s)`,
          detail: 'Use "Import snapshot file" to fold into the local DB.',
        },
      }));
    } catch (e: any) {
      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: 'sync_error',
        source: 'local',
        syncer: session.userId,
        detail: `Snapshot download failed: ${e.message || e}`,
        durationMs: Date.now() - startedAt,
      });
      setSyncStatus((prev) => ({
        ...prev,
        snapshotDownload: { state: 'error', message: e.message || 'Snapshot download failed' },
      }));
    }
  }

  // ── Initial hydration step 2: import an .eodb file into the local DB ──
  //
  // Reads the file the user picks, validates it's a v2 .eodb, and replays
  // every event through `processEvent` so the local store ends up in the
  // same state as if it had run the full hydration itself. Cursors get
  // seeded so the next continuous sync only pulls deltas after the
  // snapshot was captured.
  async function handleImportSnapshotFile(file: File) {
    if (!store) return;
    setSyncStatus((prev) => ({
      ...prev,
      snapshotImport: { state: 'syncing', message: `Reading ${file.name}…` },
    }));
    const startedAt = Date.now();
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      setSyncStatus((prev) => ({
        ...prev,
        snapshotImport: { state: 'syncing', message: 'Decoding snapshot…' },
      }));
      const snapshot = await decodeAirtableSnapshot(bytes);

      setSyncStatus((prev) => ({
        ...prev,
        snapshotImport: {
          state: 'syncing',
          message: `Replaying ${snapshot.events.length} events…`,
        },
      }));
      const progressListener = createImportProgressListener();
      let replay;
      try {
        replay = await replayAirtableSnapshot(store, snapshot, progressListener.onEvent);
      } finally {
        progressListener.finalize();
      }

      // (Airtable webhook subscription removed — sync is polling-only via
      // the per-table LAST_MODIFIED_TIME filter. The next continuous tick
      // picks up any edits the user made in Airtable between import and now.)

      // Bake the replayed state into the local KV snapshot so a refresh lands
      // on the post-import snapshot instead of the stale pre-import one.
      setSyncStatus((prev) => ({
        ...prev,
        snapshotImport: {
          state: 'syncing',
          message: `Baking local snapshot of ${replay.eventsReplayed} events…`,
        },
      }));
      try {
        await useEoStore.getState().manualSnapshot();
      } catch (e: any) {
        console.warn('[EO-DB] snapshot import: local bake failed:', e);
      }

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const skippedSuffix = replay.insSkippedExisting > 0
        ? `, ${replay.insSkippedExisting} existing target(s) skipped`
        : '';
      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: 'snapshot_imported',
        source: 'local',
        syncer: session.userId,
        detail: `${file.name}: replayed ${replay.eventsReplayed} events${skippedSuffix}, seeded ${replay.tablesSeeded} table cursor(s), ${seconds}s`,
        durationMs: Date.now() - startedAt,
        recordsScanned: replay.eventsReplayed,
      });
      // Refresh the synced index so the table picker reflects what just landed.
      getSyncedTableIds(store).then(setSyncedTableIds);
      setSyncStatus((prev) => ({
        ...prev,
        snapshotImport: {
          state: 'done',
          message: `Imported ${replay.eventsReplayed} events from ${file.name}`,
          detail: replay.insSkippedExisting > 0
            ? `${replay.tablesSeeded} table cursor(s) seeded; ${replay.insSkippedExisting} target(s) already existed locally (new content folded in).`
            : `${replay.tablesSeeded} table cursor(s) seeded — Update Sync will pull post-snapshot deltas.`,
        },
      }));
    } catch (e: any) {
      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: 'sync_error',
        source: 'local',
        syncer: session.userId,
        detail: `Snapshot import failed: ${e.message || e}`,
        durationMs: Date.now() - startedAt,
      });
      setSyncStatus((prev) => ({
        ...prev,
        snapshotImport: { state: 'error', message: e.message || 'Snapshot import failed' },
      }));
    }
  }

  // ── Initial hydration alt: import an externally-generated NDJSON bundle ──
  //
  // Reads a `.ndjson` hydration bundle (produced by either an offline export
  // tool or a previous "Hydrate via Drive" run), encrypts + chunks it onto
  // Drive via the same proxy the EoStore uses, then runs the fold path so
  // the local store ends up populated. The Drive copy is the durable
  // bootstrap — a future session can resume from it without re-uploading.
  //
  // Why upload before folding: the resumable orchestrator's contract is
  // "Drive is the source of truth"; storing first means a reload mid-fold
  // can recover from Drive instead of asking the user for the file again.
  async function handleImportHydrationBundleFile(file: File): Promise<void> {
    if (!store) return;
    if (!hydrationDrive) {
      setSyncStatus((prev) => ({
        ...prev,
        bundleImport: {
          state: 'error',
          message: 'Drive backend unavailable — connect a space first.',
        },
      }));
      return;
    }
    setSyncStatus((prev) => ({
      ...prev,
      bundleImport: { state: 'syncing', message: `Reading ${file.name}…` },
    }));
    const startedAt = Date.now();
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // Validate the header before doing anything Drive-bound — a malformed
      // file shouldn't burn upload quota.
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) throw new Error('Bundle has no header line');
      let header: HydrationBundleHeader;
      try {
        header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, newline))) as HydrationBundleHeader;
      } catch (e) {
        throw new Error(`Bundle header is not JSON: ${(e as Error).message}`);
      }
      if (header.format !== HYDRATION_BUNDLE_FORMAT) {
        throw new Error(`Unexpected bundle format: ${String(header.format)}`);
      }

      const sizeMB = (bytes.byteLength / (1024 * 1024)).toFixed(1);
      setSyncStatus((prev) => ({
        ...prev,
        bundleImport: { state: 'syncing', message: `Encrypting + uploading ${sizeMB} MB to Drive…` },
      }));

      const fileName = hydrationBundleFilename(header.importId);
      const upload = await hydrationDrive.uploadHydrationBundle(bytes, {
        fileName,
        importId: header.importId,
      });

      // Synthesize a checkpoint that puts the orchestrator straight into
      // Phase B (fold). Every table in the manifest is marked
      // `fetch:'complete'` since the bundle already contains every page;
      // `fold:'pending'` so processHydrationBundle actually does the work.
      const customization = buildCustomization();
      const tables: HydrationTableCheckpoint[] = [];
      for (const base of header.manifest.bases) {
        for (const table of base.tables) {
          tables.push({
            baseId: base.id,
            baseName: base.name,
            tableId: table.id,
            tableName: table.name,
            useFieldIds: table.fields.length > 0,
            recordsFetched: 0,
            pagesFetched: 0,
            fetch: 'complete',
            recordsFolded: 0,
            fold: 'pending',
          });
        }
      }
      const checkpoint: HydrationCheckpoint = {
        importId: header.importId,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        phase: 'fetched',
        customizationSig: customizationSignature(customization),
        manifest: header.manifest,
        bundle: {
          fileName,
          driveFileId: upload.driveFileId,
          byteSize: upload.byteSize,
          uploadedAt: new Date().toISOString(),
        },
        tables,
      };
      await saveHydrationCheckpoint(store, checkpoint);
      setHydrationCheckpoint({ ...checkpoint });

      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: 'snapshot_imported',
        source: 'local',
        syncer: session.userId,
        detail: `${file.name}: uploaded ${sizeMB} MB to Drive (${tables.length} table(s)) — folding…`,
        durationMs: Date.now() - startedAt,
      });

      setSyncStatus((prev) => ({
        ...prev,
        bundleImport: {
          state: 'syncing',
          message: 'Folding bundle into local store…',
        },
      }));

      // Hand off to the standard resumable orchestrator. With phase='fetched'
      // it skips Phase A entirely, downloads the bundle from Drive, and runs
      // the fold. The Drive download is redundant for THIS session (we still
      // have `bytes` in memory), but it exercises the same code path a
      // resume-after-reload would take, so any breakage shows up here on the
      // happy path instead of weeks later.
      const client = createAirtableClient({});
      const result = await runAirtableSync('resumable-hydrate', () =>
        resumableHydrationSync(store, client, session.userId, hydrationDrive, {
          customization,
          forceRestart: false,
          onCheckpoint: (cp) => setHydrationCheckpoint({ ...cp }),
        }),
      );

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const ingested = result.fold?.total_records_ingested ?? 0;
      try {
        await useEoStore.getState().manualSnapshot();
      } catch (e: unknown) {
        console.warn('[EO-DB] bundle import: local bake failed:', e);
      }
      try {
        getSyncedTableIds(store).then(setSyncedTableIds);
      } catch { /* advisory */ }

      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: 'hydration_complete',
        source: 'local',
        syncer: session.userId,
        detail: `Bundle import: ${ingested} records via Drive bundle, ${seconds}s`,
        durationMs: Date.now() - startedAt,
        recordsScanned: ingested,
      });
      setSyncStatus((prev) => ({
        ...prev,
        bundleImport: {
          state: 'done',
          message: `Imported ${ingested} records from ${file.name}`,
          detail: `Bundle persisted to Drive as ${fileName}; ${tables.length} table(s) folded.`,
        },
      }));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: 'sync_error',
        source: 'local',
        syncer: session.userId,
        detail: `Bundle import failed: ${message}`,
        durationMs: Date.now() - startedAt,
      });
      setSyncStatus((prev) => ({
        ...prev,
        bundleImport: { state: 'error', message },
      }));
    }
  }

  // ── Resumable hydration (save-first via Drive, then fold) ──
  //
  // Three-way entry:
  //   - No checkpoint → start a fresh run.
  //   - Incomplete checkpoint matching current customization → resume where
  //     we left off (skip fully-fetched and fully-folded tables).
  //   - `restart` flag → wipe the checkpoint and start over from scratch.
  //
  // The Drive bundle is the durable artifact — once a table's pages are
  // appended and uploaded, a reload can re-download and resume without
  // re-hitting Airtable. The in-memory `bundleBlobRef` is a fast path for
  // the "Download" button that avoids the Drive round-trip when the user
  // is still on the same session.
  async function handleResumableHydrate(restart: boolean): Promise<void> {
    if (!apiKey || !store) return;
    setSyncStatus((prev) => ({
      ...prev,
      resumableHydrate: {
        state: 'syncing',
        message: restart ? 'Starting fresh hydration…' : 'Resuming hydration…',
      },
    }));
    const startedAt = Date.now();

    const client = createAirtableClient({
      onResponse: (info) => {
        if (info.ok) return;
        useAirtableStore.getState().setWebhookHealth(webhookHealthPatch(info));
      },
    });

    const customization = buildCustomization();
    useAirtableStore.getState().addSyncLogEntry({
      ts: Date.now(),
      type: 'sync_start',
      source: 'local',
      syncer: session.userId,
      detail: restart ? 'Resumable hydration (fresh)' : 'Resumable hydration (resume)',
    });

    try {
      const result = await runAirtableSync('resumable-hydrate', () =>
        resumableHydrationSync(store, client, session.userId, hydrationDrive, {
          customization,
          forceRestart: restart,
          onCheckpoint: (cp) => {
            // Fresh object so React's referential equality notices.
            setHydrationCheckpoint({ ...cp });
          },
          onBundleTee: (blob, size) => {
            bundleBlobRef.current = blob;
            setBundleBlobSize(size);
          },
          onProgress: (p) => {
            if (p.skipReason === 'no_last_modified_field' && p.table) {
              useAirtableStore.getState().addSyncLogEntry({
                ts: Date.now(),
                type: 'table_skipped',
                source: 'local',
                syncer: session.userId,
                baseId: p.baseId,
                baseName: p.baseName ?? p.base,
                tableName: p.table,
                detail: `${p.table}: no Last Modified Time field — add one in Airtable to enable sync`,
              });
              return;
            }
            const parts: string[] = [];
            if (p.checkpointPhase === 'fetching') parts.push('Fetching');
            else if (p.checkpointPhase === 'uploading') parts.push('Saving to Drive');
            else if (p.checkpointPhase === 'folding') parts.push('Ingesting');
            if (p.table) parts.push(p.table);
            if (p.records_so_far) parts.push(`${p.records_so_far} records`);
            if (p.totalTables && p.tableIndex != null) {
              parts.push(`[${p.tableIndex + 1}/${p.totalTables}]`);
            }
            setSyncStatus((prev) => ({
              ...prev,
              resumableHydrate: {
                state: 'syncing',
                message: parts.join(' · ') || 'Working…',
              },
            }));
          },
        }),
      );

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const ingested = result.fold?.total_records_ingested ?? 0;
      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: 'hydration_complete',
        source: 'local',
        syncer: session.userId,
        detail: `${ingested} records via Drive bundle, ${seconds}s`,
        durationMs: Date.now() - startedAt,
        recordsScanned: ingested,
      });
      setSyncStatus((prev) => ({
        ...prev,
        resumableHydrate: {
          state: 'done',
          message: `${ingested} records ingested via bundle`,
          detail: `Bundle ${(result.bundleBytes.byteLength / 1024).toFixed(1)} KB · ${seconds}s`,
        },
      }));
      // Keep the checkpoint visible in 'complete' state so the user has a
      // record of the last successful run (and can download its bundle).
      setHydrationCheckpoint({ ...result.checkpoint });
    } catch (e: any) {
      const busy = e instanceof SyncBusyError;
      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: busy ? 'sync_skipped' : 'sync_error',
        source: 'local',
        syncer: session.userId,
        detail: busy
          ? `Resumable hydration deferred — ${e.active} already running`
          : `Resumable hydration failed: ${e.message || e}`,
        durationMs: Date.now() - startedAt,
      });
      setSyncStatus((prev) => ({
        ...prev,
        resumableHydrate: {
          state: 'error',
          message: busy
            ? 'Another sync is running — wait for it to finish, then try again'
            : (e.message || 'Resumable hydration failed'),
          detail: busy ? undefined : 'Checkpoint preserved — click "Resume" to continue.',
        },
      }));
      // Refresh checkpoint so the UI reflects whatever progress was saved
      // before the failure.
      const cp = await loadHydrationCheckpoint(store);
      setHydrationCheckpoint(cp);
    }
  }

  // Download the hydration bundle from the in-memory tee of the active (or
  // just-completed) run. Without a durable backend the bundle does not
  // survive a page reload.
  async function handleDownloadHydrationBundle(): Promise<void> {
    const fileName = hydrationCheckpoint?.bundle?.fileName
      ?? (hydrationCheckpoint
        ? hydrationBundleFilename(hydrationCheckpoint.importId)
        : 'airtable-hydration.ndjson');
    setSyncStatus((prev) => ({
      ...prev,
      resumableBundleDownload: { state: 'syncing', message: 'Preparing download…' },
    }));
    try {
      const blob = bundleBlobRef.current;
      if (!blob) {
        throw new Error('No bundle available — start a hydration to produce one.');
      }
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setSyncStatus((prev) => ({
        ...prev,
        resumableBundleDownload: {
          state: 'done',
          message: `Saved ${fileName}`,
          detail: `${(blob.size / 1024).toFixed(1)} KB`,
        },
      }));
    } catch (e: any) {
      setSyncStatus((prev) => ({
        ...prev,
        resumableBundleDownload: {
          state: 'error',
          message: e.message || 'Download failed',
        },
      }));
    }
  }

  // Wipe the checkpoint so the next hydration starts fresh. Does NOT delete
  // the Drive file — the user can always re-download the bundle separately
  // if they want the raw bytes. Idempotent on repeated clicks.
  async function handleClearHydrationCheckpoint(): Promise<void> {
    if (!store) return;
    await clearHydrationCheckpoint(store);
    setHydrationCheckpoint(null);
    bundleBlobRef.current = null;
    setBundleBlobSize(0);
    setSyncStatus((prev) => ({
      ...prev,
      resumableHydrate: { state: 'idle', message: '' },
      resumableBundleDownload: { state: 'idle', message: '' },
    }));
  }

  // ── Toggle continuous sync ──
  function handleToggleContinuousSync() {
    if (continuousSyncEnabled) {
      // Stop
      syncServiceRef.current?.stop();
      syncServiceRef.current = null;
    } else {
      // Start
      if (!matrixClient || !roomId || !store) return;
      const service = new AirtableSyncService(
        matrixClient,
        roomId,
        store,
        session.userId,
        () => useAirtableStore.getState().apiKey,
        buildCustomization(),
      );
      syncServiceRef.current = service;
      useAirtableStore.getState().setContinuousSync(true);
      service.start();
    }
  }

  return (
    <div>
      {/* Connection status */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Airtable Integration</div>

        {!connected ? (
          <div>
            <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 10 }}>
              Connect to Airtable using your organization credentials. The API key is
              fetched securely and held in memory only — it is never stored.
            </div>
            {storeError && <div style={s.error}>{storeError}</div>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                onClick={handleConnect}
                disabled={connecting}
                style={{ ...s.connectBtn, opacity: connecting ? 0.5 : 1 }}
              >
                {connecting ? 'Connecting...' : 'Connect to Airtable'}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div style={s.connectedRow}>
              <div style={s.connectedDot} />
              <span style={{ fontSize: 12, color: theme.successText }}>Connected</span>
              <button onClick={handleDisconnect} style={{ ...s.disconnectBtn, marginLeft: 'auto' }}>Disconnect</button>
            </div>

            {lastSyncAt && (
              <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4 }}>
                Last sync: {new Date(lastSyncAt).toLocaleString()}
                {isPrimarySyncer && <span style={{ marginLeft: 8, color: theme.accent }}>(this device is syncing)</span>}
              </div>
            )}

            {/* ── Orphan-run banner — previous session crashed mid-sync ── */}
            {orphanSnapshot && (
              <div style={{
                marginTop: 8,
                padding: '8px 10px',
                borderRadius: 6,
                background: theme.warningBg,
                border: `1px solid ${theme.warningBorder}`,
                color: theme.warningText ?? theme.warning,
                fontSize: 11,
              }}>
                Previous session may have been interrupted — it was{' '}
                <strong>{orphanSnapshot.phase}</strong>
                {orphanSnapshot.table ? ` ${orphanSnapshot.table}` : ''}
                {' '}(strategy: {orphanSnapshot.strategy}, started{' '}
                {relativeTime(orphanSnapshot.startedAt, nowMs)}). The next
                successful sync will clear this notice.
                <button
                  onClick={() => setOrphanSnapshot(null)}
                  style={{
                    marginLeft: 8,
                    padding: '1px 6px',
                    fontSize: 10,
                    border: `1px solid ${theme.warningBorder}`,
                    background: 'transparent',
                    color: 'inherit',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                >dismiss</button>
              </div>
            )}

            {/* ── Live sync status card — what is this tick actually doing? ── */}
            {currentSync && (
              <LiveSyncCard
                snap={currentSync}
                startedAgo={Math.max(0, Math.round((nowMs - currentSync.startedAt) / 1000))}
                theme={theme}
              />
            )}

            {/* ── Idle countdown — only when continuous sync is on ── */}
            {!currentSync && continuousSyncEnabled && nextTickAt && (
              <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 6 }}>
                Next automatic check in{' '}
                <strong>{Math.max(0, Math.round((nextTickAt - nowMs) / 1000))}s</strong>
                {' '}(every {syncSettings.syncIntervalSec}s)
              </div>
            )}

            {/* Actions */}
            <div style={{ ...s.keyActions, marginTop: 10 }}>
              <button
                onClick={handleDiscover}
                disabled={syncStatus.discover?.state === 'discovering'}
                style={s.actionBtn}
              >
                Discover
              </button>
              <button
                onClick={handleSyncSchema}
                disabled={!apiKey || syncStatus.schemaSync?.state === 'discovering' || syncStatus.discover?.state === 'discovering'}
                style={s.actionBtn}
                title="Re-fetch bases / tables / fields from Airtable and persist them to the EO-DB store as base / table / field DEF + INS events"
              >
                Sync schema
              </button>
            </div>

            {/* Discovery status */}
            {(() => {
              const status = syncStatus.discover;
              if (!status || status.state === 'idle') return null;
              return (
                <div style={{
                  ...s.statusMsg,
                  color: status.state === 'error' ? theme.dangerText : status.state === 'done' ? theme.successText : theme.textSecondary,
                }}>
                  {status.state === 'discovering' && <span style={s.spinner} />}
                  {status.message}
                </div>
              );
            })()}

            {/* Schema sync status */}
            {(() => {
              const status = syncStatus.schemaSync;
              if (!status || status.state === 'idle') return null;
              return (
                <div style={{
                  ...s.statusMsg,
                  color: status.state === 'error' ? theme.dangerText : status.state === 'done' ? theme.successText : theme.textSecondary,
                }}>
                  {status.state === 'discovering' && <span style={s.spinner} />}
                  {status.message}
                </div>
              );
            })()}

            {/* Table picker (shown after discovery) */}
            {manifest && (
              <div style={s.tablePickerSection}>
                <div style={s.tablePickerTitle}>Select tables to sync</div>
                {manifest.bases.map((base) => {
                  const selection = tableSelections[base.id] || [];
                  const allIds = base.tables.map(t => t.id);
                  const allSelected = allIds.length > 0 && selection.length === allIds.length;
                  return (
                    <div key={base.id} style={s.baseGroup}>
                      <div style={s.baseHeader}>
                        <label style={s.checkLabel}>
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={() => toggleAllTablesInBase(base.id, allIds)}
                          />
                          <span style={s.baseName}>{base.name}</span>
                        </label>
                        <span style={s.baseCount}>{base.tables.length} tables</span>
                      </div>
                      <div style={s.tableList}>
                        {base.tables.map((table) => {
                          const isExpanded = expandedTables.has(table.id);
                          const resolvedField = resolveDisplayField(table);
                          const resolvedFieldName = table.fields.find(f => f.id === resolvedField)?.name;

                          return (
                            <div key={table.id}>
                              <div style={s.tableItem}>
                                <input
                                  type="checkbox"
                                  checked={selection.includes(table.id)}
                                  onChange={() => toggleTable(base.id, table.id)}
                                />
                                <span
                                  style={{ ...s.tableName, cursor: 'pointer' }}
                                  onClick={() => toggleExpandedTable(table.id)}
                                >
                                  <span style={{ marginRight: 4, fontSize: 10, opacity: 0.6 }}>
                                    {isExpanded ? '\u25BE' : '\u25B8'}
                                  </span>
                                  {table.name}
                                </span>
                                <span style={s.fieldCount}>{table.fieldCount} fields</span>
                                {resolvedFieldName && (
                                  <span style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    fontSize: 10,
                                    color: theme.accent,
                                    marginLeft: 8,
                                    opacity: 0.9,
                                  }}>
                                    name: {resolvedFieldName}
                                    {displayFieldSelections[table.id] && (
                                      <span style={{
                                        background: theme.accentBg,
                                        color: theme.accent,
                                        border: `1px solid ${theme.accent}`,
                                        borderRadius: 4,
                                        padding: '0px 5px',
                                        fontSize: 9,
                                        fontWeight: 700,
                                        letterSpacing: '0.03em',
                                        lineHeight: '16px',
                                      }}>manual</span>
                                    )}
                                  </span>
                                )}
                              </div>

                              {/* Expanded field preview + name field picker */}
                              {isExpanded && (
                                <div style={s.fieldPreview}>
                                  <div style={s.nameFieldPicker}>
                                    <span style={s.nameFieldLabel}>Display name field:</span>
                                    <select
                                      value={displayFieldSelections[table.id] || '_auto'}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        if (val === '_auto') {
                                          setDisplayFieldSelections((prev) => {
                                            const next = { ...prev };
                                            delete next[table.id];
                                            return next;
                                          });
                                        } else if (val === '_first') {
                                          if (table.fields.length > 0) {
                                            setDisplayField(table.id, table.fields[0].id);
                                          }
                                        } else {
                                          setDisplayField(table.id, val);
                                        }
                                      }}
                                      style={s.nameFieldSelect}
                                    >
                                      <option value="_auto">Auto-guess{guessNameField(table.fields) ? ` (${table.fields.find(f => f.id === guessNameField(table.fields))?.name})` : ''}</option>
                                      <option value="_first">First column ({table.fields[0]?.name || '?'})</option>
                                      <optgroup label="Manual select">
                                        {table.fields.map((f) => (
                                          <option key={f.id} value={f.id}>
                                            {f.name} ({f.type})
                                          </option>
                                        ))}
                                      </optgroup>
                                    </select>
                                  </div>
                                  <div style={s.fieldList}>
                                    {table.fields.map((f) => (
                                      <div key={f.id} style={{
                                        ...s.fieldItem,
                                        ...(f.id === resolvedField ? { background: theme.bgHover, fontWeight: 600 } : {}),
                                      }}>
                                        <span style={s.fieldItemName}>{f.name}</span>
                                        <span style={s.fieldItemType}>{f.type}</span>
                                        {f.id === resolvedField && (
                                          <span style={{ fontSize: 10, color: theme.accent, marginLeft: 'auto' }}>name field</span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* Preserve existing toggle */}
                <div style={s.preserveRow}>
                  <label style={s.checkLabel}>
                    <input
                      type="checkbox"
                      checked={preserveExisting}
                      onChange={(e) => {
                        setPreserveExisting(e.target.checked);
                        useAirtableStore.getState().setSyncSettings({ preserveExisting: e.target.checked });
                        syncServiceRef.current?.saveSyncSettings({ preserveExisting: e.target.checked });
                      }}
                    />
                    <span>Preserve existing data in EO-DB</span>
                  </label>
                  <span style={s.preserveHint}>
                    {preserveExisting
                      ? 'Airtable only fills new records and empty fields; existing EO-DB values are kept'
                      : 'Airtable values overwrite EO-DB values on every sync'}
                  </span>
                </div>

                {/* Sync schema to EO-DB on each sync toggle */}
                <div style={s.preserveRow}>
                  <label style={s.checkLabel}>
                    <input
                      type="checkbox"
                      checked={syncSettings.syncSchemaOnEachSync}
                      onChange={(e) => {
                        useAirtableStore.getState().setSyncSettings({ syncSchemaOnEachSync: e.target.checked });
                        syncServiceRef.current?.saveSyncSettings({ syncSchemaOnEachSync: e.target.checked });
                      }}
                    />
                    <span>Sync Airtable schema to EO-DB on each sync</span>
                  </label>
                  <span style={s.preserveHint}>
                    {syncSettings.syncSchemaOnEachSync
                      ? 'Before every manual or continuous sync, bases / tables / fields are re-fetched from Airtable and persisted to the EO-DB store as base, table, and field DEF / INS events'
                      : 'Schema is only persisted when you click "Sync schema" or as part of a hydration / update sync'}
                  </span>
                </div>

                {/* Record limit */}
                <div style={s.recordLimitRow}>
                  <label style={s.recordLimitLabel}>
                    Record limit per table
                  </label>
                  <div style={s.recordLimitInputRow}>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      placeholder="No limit"
                      value={recordLimit || ''}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        const limit = isNaN(val) ? 0 : Math.max(0, val);
                        setRecordLimit(limit);
                        useAirtableStore.getState().setSyncSettings({ recordLimit: limit });
                        syncServiceRef.current?.saveSyncSettings({ recordLimit: limit });
                      }}
                      style={s.recordLimitInput}
                    />
                    {recordLimit > 0 && (
                      <button
                        onClick={() => setRecordLimit(0)}
                        style={s.recordLimitClear}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <span style={s.recordLimitHint}>
                    {recordLimit > 0
                      ? `Import up to ${recordLimit} records from each selected table`
                      : 'Import all records from each selected table'}
                  </span>
                </div>

                {/* Import resolution stance (Phase A.6/4) */}
                <div style={s.resolutionRow}>
                  <label style={s.resolutionLabel}>
                    Import stance
                  </label>
                  <div style={s.resolutionOptions}>
                    {([
                      { value: 'unspecified', label: 'No stance', hint: 'Record INS events carry no declared stance (default)' },
                      { value: 'Making',     label: 'Making',    hint: 'Fresh rows brought into existence for the first time' },
                      { value: 'Composing',  label: 'Composing', hint: 'Rows assembled from multiple upstream sources' },
                      { value: 'Binding',    label: 'Binding',   hint: 'Rows instantiated as concrete realizations of a specification' },
                    ] as const).map((opt) => (
                      <label
                        key={opt.value}
                        style={{
                          ...s.resolutionOption,
                          ...(importResolution === opt.value ? s.resolutionOptionActive : {}),
                        }}
                      >
                        <input
                          type="radio"
                          name="import-resolution"
                          value={opt.value}
                          checked={importResolution === opt.value}
                          onChange={() => setImportResolution(opt.value)}
                          style={s.resolutionRadio}
                        />
                        <span style={s.resolutionOptionLabel}>{opt.label}</span>
                        <span style={s.resolutionOptionHint}>{opt.hint}</span>
                      </label>
                    ))}
                  </div>
                  <span style={s.resolutionFooter}>
                    Stamped onto every record INS event in this import. DEF
                    events carrying field values remain unstamped — the stance
                    is about how rows come into existence, not individual
                    value assertions.
                  </span>
                </div>

                {/* Sync transparency panel — header strip, webhook health,
                    recent diffs, and rolling sync log. Sourced entirely from
                    the airtable Zustand store, so it stays accurate even when
                    the sync is being driven by the continuous-sync service
                    rather than a manual click. */}
                <AirtableSyncTransparency
                  theme={theme}
                  nowMs={nowMs}
                  onRunTestSync={() => handleSync('sync')}
                  onTogglePause={handleToggleContinuousSync}
                  canToggleContinuous={!!matrixClient && !!roomId}
                />

                {/* Sync mode buttons */}
                <div style={s.syncModes}>
                  <div style={s.syncModeCard}>
                    <div style={s.syncModeTitle}>
                      Initial hydration
                      <span style={{
                        fontSize: 9,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: theme.textMuted,
                        background: theme.bgMuted,
                        border: `1px solid ${theme.borderLight}`,
                        padding: '2px 6px',
                        borderRadius: 4,
                        marginLeft: 6,
                      }}>2 STEPS</span>
                    </div>
                    <div style={s.syncModeDesc}>
                      One-time bootstrap. <strong>Step 1</strong> pulls every record from
                      the selected tables and saves a binary <code style={{ fontSize: 10 }}>.eodb</code>{' '}
                      snapshot to your machine. <strong>Step 2</strong> imports that file
                      into the local DB. Splitting the steps isolates the Airtable
                      pull (visible failure if it fails) from the local fold.
                    </div>

                    {/* Step 1 — pull from Airtable to disk */}
                    <button
                      onClick={handleDownloadAirtableSnapshot}
                      disabled={syncStatus.snapshotDownload?.state === 'syncing'}
                      style={s.syncModeBtn}
                    >
                      {syncStatus.snapshotDownload?.state === 'syncing'
                        ? 'Downloading…'
                        : '1. Download from Airtable (.eodb)'}
                    </button>
                    {(() => {
                      const status = syncStatus.snapshotDownload;
                      if (!status || status.state === 'idle') return null;
                      return (
                        <div style={{
                          ...s.statusMsg,
                          color: status.state === 'error' ? theme.dangerText : status.state === 'done' ? theme.successText : theme.textSecondary,
                        }}>
                          {status.state === 'syncing' && <span style={s.spinner} />}
                          {status.message}
                          {status.detail && <span style={s.statusDetail}> {status.detail}</span>}
                        </div>
                      );
                    })()}

                    {/* Step 2 — import the file into the local DB */}
                    <label style={{ ...s.syncModeBtn, marginTop: 6, display: 'inline-block', textAlign: 'center', cursor: 'pointer' }}>
                      {syncStatus.snapshotImport?.state === 'syncing'
                        ? 'Importing…'
                        : '2. Import snapshot file…'}
                      <input
                        type="file"
                        accept=".eodb,application/octet-stream"
                        style={{ display: 'none' }}
                        disabled={syncStatus.snapshotImport?.state === 'syncing'}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleImportSnapshotFile(file);
                          // Reset the input so re-picking the same file fires onChange.
                          e.target.value = '';
                        }}
                      />
                    </label>
                    {(() => {
                      const status = syncStatus.snapshotImport;
                      if (!status || status.state === 'idle') return null;
                      return (
                        <div style={{
                          ...s.statusMsg,
                          color: status.state === 'error' ? theme.dangerText : status.state === 'done' ? theme.successText : theme.textSecondary,
                        }}>
                          {status.state === 'syncing' && <span style={s.spinner} />}
                          {status.message}
                          {status.detail && <span style={s.statusDetail}> {status.detail}</span>}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Resumable hydration — save Airtable data to Drive as an
                      NDJSON bundle, then fold from the saved copy. Per-table
                      checkpoints mean a crashed fetch/fold resumes without
                      re-hitting Airtable. */}
                  <div style={s.syncModeCard}>
                    <div style={s.syncModeTitle}>
                      Hydrate via Drive
                      <span style={{
                        fontSize: 9,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: theme.textMuted,
                        background: theme.bgMuted,
                        border: `1px solid ${theme.borderLight}`,
                        padding: '2px 6px',
                        borderRadius: 4,
                        marginLeft: 6,
                      }}>RESUMABLE</span>
                    </div>
                    <div style={s.syncModeDesc}>
                      Airtable → Google Drive NDJSON bundle → local DB. Per-table
                      checkpoints survive reloads so an interrupted run resumes
                      without re-fetching. The same bundle backs the{' '}
                      <strong>Download</strong> button, so you always have a
                      portable copy of what was ingested.
                    </div>

                    {hydrationCheckpoint && hydrationCheckpoint.phase !== 'complete' && (() => {
                      const sum = summarizeCheckpoint(hydrationCheckpoint);
                      return (
                        <div style={{
                          fontSize: 11,
                          color: theme.textSecondary,
                          background: theme.bgMuted,
                          border: `1px solid ${theme.borderLight}`,
                          borderRadius: 4,
                          padding: '6px 8px',
                          margin: '6px 0',
                        }}>
                          <strong>Checkpoint:</strong> phase {hydrationCheckpoint.phase} ·{' '}
                          fetched {sum.tablesFetched}/{sum.tables} tables ({sum.recordsFetched} records) ·{' '}
                          folded {sum.tablesFolded}/{sum.tables} tables
                          {hydrationCheckpoint.error && (
                            <div style={{ color: theme.dangerText, marginTop: 4 }}>
                              Last error: {hydrationCheckpoint.error}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Primary action: resume if a matching checkpoint exists
                        and is unfinished, otherwise start fresh. */}
                    <button
                      onClick={() => handleResumableHydrate(false)}
                      disabled={syncStatus.resumableHydrate?.state === 'syncing' || !apiKey}
                      style={s.syncModeBtn}
                    >
                      {syncStatus.resumableHydrate?.state === 'syncing'
                        ? 'Working…'
                        : hydrationCheckpoint && hydrationCheckpoint.phase !== 'complete'
                          ? 'Resume hydration'
                          : 'Start hydration'}
                    </button>

                    {/* Secondary controls: force-restart and clear checkpoint.
                        Only shown when there's a checkpoint to act on. */}
                    {hydrationCheckpoint && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        <button
                          onClick={() => handleResumableHydrate(true)}
                          disabled={syncStatus.resumableHydrate?.state === 'syncing'}
                          style={{ ...s.syncModeBtn, flex: 1 }}
                          title="Discard checkpoint and re-fetch everything from Airtable"
                        >
                          Restart
                        </button>
                        <button
                          onClick={handleClearHydrationCheckpoint}
                          disabled={syncStatus.resumableHydrate?.state === 'syncing'}
                          style={{ ...s.syncModeBtn, flex: 1 }}
                          title="Clear local checkpoint (leaves the Drive file in place)"
                        >
                          Clear checkpoint
                        </button>
                      </div>
                    )}

                    {/* Download the current bundle — tee'd from memory when
                        available, otherwise fetched from Drive. */}
                    <button
                      onClick={handleDownloadHydrationBundle}
                      disabled={syncStatus.resumableBundleDownload?.state === 'syncing' || (!bundleBlobRef.current && !hydrationCheckpoint?.bundle?.fileName)}
                      style={{ ...s.syncModeBtn, marginTop: 6 }}
                      title={bundleBlobRef.current
                        ? 'Download the in-memory copy (no Drive round-trip)'
                        : 'Download the bundle from Drive'}
                    >
                      {syncStatus.resumableBundleDownload?.state === 'syncing'
                        ? 'Downloading…'
                        : bundleBlobSize > 0
                          ? `Download bundle (${(bundleBlobSize / 1024).toFixed(1)} KB)`
                          : 'Download bundle'}
                    </button>

                    {(() => {
                      const status = syncStatus.resumableHydrate;
                      if (!status || status.state === 'idle') return null;
                      return (
                        <div style={{
                          ...s.statusMsg,
                          color: status.state === 'error' ? theme.dangerText : status.state === 'done' ? theme.successText : theme.textSecondary,
                        }}>
                          {status.state === 'syncing' && <span style={s.spinner} />}
                          {status.message}
                          {status.detail && <span style={s.statusDetail}> {status.detail}</span>}
                        </div>
                      );
                    })()}
                    {(() => {
                      const status = syncStatus.resumableBundleDownload;
                      if (!status || status.state === 'idle') return null;
                      return (
                        <div style={{
                          ...s.statusMsg,
                          color: status.state === 'error' ? theme.dangerText : status.state === 'done' ? theme.successText : theme.textSecondary,
                        }}>
                          {status.state === 'syncing' && <span style={s.spinner} />}
                          {status.message}
                          {status.detail && <span style={s.statusDetail}> {status.detail}</span>}
                        </div>
                      );
                    })()}

                    {/* Import an existing NDJSON bundle (e.g. produced by an
                        offline export tool) and persist it to Drive as the
                        durable bootstrap. */}
                    <label
                      style={{
                        ...s.syncModeBtn,
                        marginTop: 6,
                        display: 'inline-block',
                        textAlign: 'center',
                        cursor: hydrationDrive ? 'pointer' : 'not-allowed',
                        opacity: hydrationDrive ? 1 : 0.6,
                      }}
                      title={hydrationDrive
                        ? 'Encrypt + upload a .ndjson bundle to Drive, then fold into the local store.'
                        : 'Connect a space to enable Drive-backed import.'}
                    >
                      {syncStatus.bundleImport?.state === 'syncing'
                        ? 'Importing…'
                        : 'Import .ndjson bundle (Drive)'}
                      <input
                        type="file"
                        accept=".ndjson,application/x-ndjson,application/octet-stream"
                        style={{ display: 'none' }}
                        disabled={!hydrationDrive || syncStatus.bundleImport?.state === 'syncing'}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handleImportHydrationBundleFile(file);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    {(() => {
                      const status = syncStatus.bundleImport;
                      if (!status || status.state === 'idle') return null;
                      return (
                        <div style={{
                          ...s.statusMsg,
                          color: status.state === 'error' ? theme.dangerText : status.state === 'done' ? theme.successText : theme.textSecondary,
                        }}>
                          {status.state === 'syncing' && <span style={s.spinner} />}
                          {status.message}
                          {status.detail && <span style={s.statusDetail}> {status.detail}</span>}
                        </div>
                      );
                    })()}
                  </div>

                  <div style={s.syncModeCard}>
                    <div style={s.syncModeTitle}>
                      Update Sync
                      <OverwritePill preserveExisting={preserveExisting} theme={theme} />
                    </div>
                    <div style={s.syncModeDesc}>
                      Pull only records that changed since last sync via the{' '}
                      <code style={{ fontSize: 10 }}>/bases/&#123;id&#125;/webhooks/&#123;id&#125;/payloads</code>{' '}
                      endpoint on <code style={{ fontSize: 10 }}>api.airtable.com</code> — Airtable's
                      authoritative change feed. Requires a prior Full Sync
                      {preserveExisting ? '. Never overwrites existing data' : ''}.
                    </div>
                    <button
                      onClick={() => handleSync('sync')}
                      disabled={syncStatus.sync?.state === 'syncing'}
                      style={s.syncModeBtn}
                    >
                      {syncStatus.sync?.state === 'syncing' ? 'Syncing...' : 'Run Update Sync'}
                    </button>
                    {(() => {
                      const status = syncStatus.sync;
                      if (!status || status.state === 'idle') return null;
                      return (
                        <div style={{
                          ...s.statusMsg,
                          color: status.state === 'error' ? theme.dangerText : status.state === 'done' ? theme.successText : theme.textSecondary,
                        }}>
                          {status.state === 'syncing' && <span style={s.spinner} />}
                          {status.message}
                          {status.detail && <span style={s.statusDetail}> {status.detail}</span>}
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* Continuous sync toggle — hidden for Amino users, who have
                    sync auto-started without needing to flip a checkbox. */}
                {matrixClient && roomId && !isAmino && (
                  <div style={s.continuousSyncSection}>
                    <div style={s.continuousSyncRow}>
                      <label style={s.checkLabel}>
                        <input
                          type="checkbox"
                          checked={continuousSyncEnabled}
                          onChange={handleToggleContinuousSync}
                          disabled={isSyncing && !continuousSyncEnabled}
                        />
                        <span>Continuous sync (every 30s)</span>
                      </label>
                      {continuousSyncEnabled && (
                        <span style={{
                          fontSize: 10,
                          padding: '2px 8px',
                          borderRadius: 10,
                          background: isPrimarySyncer ? theme.successBg : theme.bgMuted,
                          color: isPrimarySyncer ? theme.successText : theme.textMuted,
                          border: `1px solid ${isPrimarySyncer ? theme.successBorder : theme.borderLight}`,
                        }}>
                          {isPrimarySyncer ? 'active syncer' : 'standby'}
                        </span>
                      )}
                    </div>
                    <span style={s.continuousSyncHint}>
                      {continuousSyncEnabled
                        ? `This device will automatically pull changes from Airtable every ${syncSettings.syncIntervalSec}s. Only one device syncs at a time — others receive data via the shared data store.`
                        : `Enable to automatically pull Airtable changes every ${syncSettings.syncIntervalSec} seconds`}
                    </span>
                  </div>
                )}

                {/* ── Sync Settings ── */}
                <div style={s.syncSettingsSection}>
                  <div style={s.syncSettingsTitle}>Sync Settings</div>

                  {/* Poll interval */}
                  <div style={s.settingRow}>
                    <label style={s.settingLabel}>Poll interval (seconds)</label>
                    <div style={s.settingInputRow}>
                      <input
                        type="number"
                        min={15}
                        max={600}
                        step={5}
                        value={syncSettings.syncIntervalSec}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          if (!isNaN(val)) {
                            const clamped = Math.max(15, Math.min(600, val));
                            useAirtableStore.getState().setSyncSettings({ syncIntervalSec: clamped });
                            syncServiceRef.current?.saveSyncSettings({ syncIntervalSec: clamped });
                          }
                        }}
                        style={s.settingInput}
                      />
                      <span style={s.settingHint}>
                        How often to check Airtable for changes (15–600s)
                      </span>
                    </div>
                  </div>

                  {/* Strategy is auto-decided per tick: if any selected
                      (base, table) is missing a cursor, the next sync is a
                      full hydration; otherwise it's an incremental update.
                      No user-facing setting — cursor presence is the truth. */}

                  {/* Last sync info */}
                  {lastSyncAt && (
                    <div style={s.settingRow}>
                      <label style={s.settingLabel}>Last sync</label>
                      <div style={s.lastSyncInfo}>
                        <span style={s.lastSyncTime}>{new Date(lastSyncAt).toLocaleString()}</span>
                        <span style={s.lastSyncAgo}>
                          ({Math.round((Date.now() - new Date(lastSyncAt).getTime()) / 1000)}s ago)
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* ── Sync Activity Log ── */}
                {syncLog.length > 0 && (
                  <div style={s.syncLogSection}>
                    <div style={s.syncLogHeader}>
                      <span style={s.syncLogTitle}>
                        Sync Activity
                        <span style={{ marginLeft: 6, color: theme.textMuted, fontWeight: 400 }}>
                          (persisted — survives refresh)
                        </span>
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          style={s.syncLogClear}
                          onClick={() => {
                            const json = JSON.stringify(syncLog, null, 2);
                            const blob = new Blob([json], { type: 'application/json' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `airtable-sync-log-${new Date().toISOString().slice(0,10)}.json`;
                            a.click();
                            setTimeout(() => URL.revokeObjectURL(url), 1000);
                          }}
                        >
                          Export
                        </button>
                        <button
                          style={s.syncLogClear}
                          onClick={() => {
                            useAirtableStore.getState().clearSyncLog();
                            if (store) saveSyncLog(store, []);
                          }}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                    <div style={s.syncLogList}>
                      {syncLog.map((entry, i) => (
                        <SyncLogRow key={`${entry.ts}-${i}`} entry={entry} userId={session.userId} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sync log row ────────────────────────────────────────────────────────────

function SyncLogRow({ entry, userId }: { entry: SyncLogEntry; userId: string }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const isLocal = entry.source === 'local';
  const isMe = entry.syncer === userId;

  const icon: Record<SyncLogEntry['type'], string> = {
    lock_acquired:      '🔒',
    lock_released:      '🔓',
    sync_complete:      '✓',
    hydration_complete: '✓',
    sync_error:         '✗',
    sync_start:         '▶',
    provenance_uploaded:'↑',
    webhook_poll:       '↻',
    change_detected:    '✎',
    snapshot_downloaded:'⬇',
    snapshot_imported:  '⬆',
    table_skipped:      '·',
    sync_skipped:       '⏭',
  };

  const label: Record<SyncLogEntry['type'], string> = {
    lock_acquired:      'acquired lock',
    lock_released:      'released lock',
    sync_complete:      'sync complete',
    hydration_complete: 'full sync complete',
    sync_error:         'sync error',
    sync_start:         'started sync',
    provenance_uploaded:'uploaded provenance',
    webhook_poll:       'webhook poll',
    change_detected:    'change detected',
    snapshot_downloaded:'snapshot downloaded',
    snapshot_imported:  'snapshot imported',
    table_skipped:      'table skipped',
    sync_skipped:       'sync deferred',
  };

  const color: Partial<Record<SyncLogEntry['type'], string>> = {
    sync_complete:     theme.successText,
    hydration_complete:theme.successText,
    sync_error:        theme.dangerText,
  };

  const shortId = isMe ? 'you' : entry.syncer.split(':')[1]?.split('.')[0] ?? entry.syncer;
  const ago = Math.round((Date.now() - entry.ts) / 1000);
  const agoStr = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.round(ago / 60)}m ago` : `${Math.round(ago / 3600)}h ago`;

  // Rich context appears inline under the header row for completion/start
  // entries — gives the user the "what API, what cursor, what mode?" answer
  // without having to open the dev tools or pull up the settings panel.
  const showsContext = entry.strategy || entry.endpoint || entry.cursorUsed || entry.preserveExisting !== undefined;
  const showsPerTable = !!entry.perTable && entry.perTable.length > 0;

  return (
    <div style={{ ...s.syncLogRow, flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ ...s.syncLogIcon, color: color[entry.type] ?? theme.textSecondary }}>
          {icon[entry.type]}
        </span>
        <span style={s.syncLogBody}>
          <span style={{ ...s.syncLogSyncer, fontWeight: isLocal ? 600 : 400 }}>
            {isLocal ? (isMe ? 'this device' : `local`) : shortId}
          </span>
          {' '}
          <span style={{ color: color[entry.type] ?? theme.text }}>{label[entry.type]}</span>
          {entry.detail && (
            <span style={s.syncLogDetail}> — {entry.detail}</span>
          )}
        </span>
        <span style={s.syncLogAgo}>{agoStr}</span>
      </div>

      {showsContext && (
        <div style={{
          marginLeft: 22,
          marginTop: 2,
          fontSize: 10,
          color: theme.textMuted,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
        }}>
          {entry.strategy && (
            <span title="Sync strategy">
              <strong style={{ color: theme.textSecondary }}>strategy:</strong> {entry.strategy}
            </span>
          )}
          {entry.preserveExisting !== undefined && (
            <span
              title={entry.preserveExisting ? 'Existing EO-DB values were preserved' : 'Existing EO-DB values may have been overwritten'}
              style={{
                color: entry.preserveExisting ? theme.successText : theme.warningText ?? theme.warning,
              }}
            >
              {entry.preserveExisting ? 'preserve' : 'overwrite'}
            </span>
          )}
          {entry.baseName && (
            <span><strong style={{ color: theme.textSecondary }}>base:</strong> {entry.baseName}</span>
          )}
          {entry.cursorUsed && (
            <span title={`LAST_MODIFIED_TIME cursor used for this run`}>
              <strong style={{ color: theme.textSecondary }}>since:</strong> {new Date(entry.cursorUsed).toLocaleTimeString()}
            </span>
          )}
          {entry.endpoint && (
            <span title={entry.endpoint} style={{
              maxWidth: 260,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap' as const,
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              <strong style={{ color: theme.textSecondary }}>GET</strong> {hostOnly(entry.endpoint)}
            </span>
          )}
        </div>
      )}

      {showsPerTable && (
        <div style={{
          marginLeft: 22,
          marginTop: 4,
          fontSize: 10,
          color: theme.text,
          border: `1px solid ${theme.borderLight ?? theme.border}`,
          borderRadius: 4,
          overflow: 'hidden',
        }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 60px 60px 60px',
            background: theme.bgMuted ?? 'transparent',
            padding: '2px 6px',
            color: theme.textMuted,
            fontSize: 9,
          }}>
            <span>table</span>
            <span style={{ textAlign: 'right' }}>ingest</span>
            <span style={{ textAlign: 'right' }}>overwrite</span>
            <span style={{ textAlign: 'right' }}>unchanged</span>
          </div>
          {entry.perTable!.map((pt) => (
            <div
              key={pt.table}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 60px 60px 60px',
                padding: '1px 6px',
                borderTop: `1px solid ${theme.borderLight ?? theme.border}`,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                {pt.table}
              </span>
              <span style={{ textAlign: 'right' }}>{pt.ingested}</span>
              <span style={{
                textAlign: 'right',
                color: pt.overwritten > 0 ? (theme.warningText ?? theme.warning) : undefined,
              }}>
                {pt.overwritten}
              </span>
              <span style={{ textAlign: 'right', color: theme.textMuted }}>{pt.skipped}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Extract just the host+path (no query string) for compact endpoint display. */
function hostOnly(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return `${u.host}${u.pathname}`;
  } catch {
    return endpoint;
  }
}

/** Rough relative-time formatter — avoids pulling in date-fns for one string. */
function relativeTime(then: number, now: number): string {
  const delta = Math.max(0, Math.round((now - then) / 1000));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

// ─── Overwrite pill ────────────────────────────────────────────────────────

function OverwritePill({ preserveExisting, theme }: { preserveExisting: boolean; theme: Theme }) {
  const bg = preserveExisting ? (theme.successBg ?? 'rgba(42,170,120,0.15)') : (theme.warningBg ?? 'rgba(210,140,20,0.18)');
  const border = preserveExisting ? (theme.successBorder ?? theme.success ?? '#2a7') : (theme.warningBorder ?? theme.warning ?? '#c80');
  const color = preserveExisting ? (theme.successText ?? theme.success ?? '#2a7') : (theme.warningText ?? theme.warning ?? '#a80');
  return (
    <span
      title={
        preserveExisting
          ? 'Existing EO-DB field values will NOT be overwritten — only missing fields get filled in.'
          : 'This run may overwrite existing EO-DB field values with Airtable values.'
      }
      style={{
        marginLeft: 8,
        padding: '1px 6px',
        fontSize: 9,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        borderRadius: 10,
        background: bg,
        border: `1px solid ${border}`,
        color,
      }}
    >
      {preserveExisting ? 'Preserve' : 'May overwrite'}
    </span>
  );
}

// ─── Live sync status card ────────────────────────────────────────────────

function LiveSyncCard({
  snap,
  startedAgo,
  theme,
}: {
  snap: CurrentSyncSnapshot;
  startedAgo: number;
  theme: Theme;
}) {
  const phaseLabel =
    snap.phase === 'preparing'    ? 'Preparing'
    : snap.phase === 'discovering'  ? 'Discovering schema'
    : snap.phase === 'collecting'   ? 'Collecting records'
    : snap.phase === 'fetching'     ? 'Fetching from Airtable'
    : snap.phase === 'folding'      ? 'Folding into local store'
    : snap.phase === 'syncing'      ? 'Syncing'
    : snap.phase === 'table_done'   ? 'Finishing table'
    : String(snap.phase);

  const strategyLabel =
    snap.strategy === 'hydration'    ? 'Full hydration (no cursor)'
    : snap.strategy === 'lastModified' ? 'Incremental (LAST_MODIFIED_TIME)'
    : snap.strategy;

  return (
    <div style={{
      marginTop: 10,
      padding: 10,
      borderRadius: 8,
      border: `1px solid ${theme.borderLight ?? theme.border}`,
      background: theme.bgMuted ?? 'transparent',
      fontSize: 11,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          aria-hidden
          style={{
            width: 8, height: 8, borderRadius: '50%',
            background: theme.successText ?? theme.success ?? '#2a7',
            animation: 'eo-at-livecard-pulse 1.2s infinite',
          }}
        />
        <strong style={{ fontSize: 12 }}>{phaseLabel}</strong>
        {snap.table && <span style={{ color: theme.textSecondary }}>— {snap.table}</span>}
        <span style={{ marginLeft: 'auto', color: theme.textMuted, fontSize: 10 }}>
          started {startedAgo}s ago
        </span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        <StrategyPill strategyLabel={strategyLabel} theme={theme} />
        <OverwritePill preserveExisting={snap.preserveExisting} theme={theme} />
        {snap.recordsSoFar > 0 && (
          <span style={{
            padding: '1px 6px',
            fontSize: 9,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            borderRadius: 10,
            background: theme.bgCard,
            border: `1px solid ${theme.borderLight ?? theme.border}`,
            color: theme.text,
          }}>
            {snap.recordsSoFar} records
          </span>
        )}
      </div>

      {/* Endpoint — collapsed single line with hover reveal via title. */}
      {snap.endpoint && (
        <div style={{
          marginTop: 8,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          color: theme.textSecondary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' as const,
        }} title={snap.endpoint}>
          <strong style={{ color: theme.textMuted }}>GET</strong> {snap.endpoint}
        </div>
      )}

      {/* Cursor / rehydrate note. */}
      <div style={{ marginTop: 4, fontSize: 10, color: theme.textMuted }}>
        {snap.cursorUsed
          ? <>Checking changes since <strong>{new Date(snap.cursorUsed).toLocaleString()}</strong></>
          : <>Full rehydrate — no cursor (every record compared)</>}
      </div>

      {/* Live per-table progress — only rows that have been touched. */}
      {snap.perTable.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 10 }}>
          {snap.perTable.map((pt) => (
            <div key={pt.tableId ?? pt.table} style={{ display: 'flex', gap: 8 }}>
              <span style={{ flex: 1 }}>{pt.table}</span>
              <span style={{ color: theme.textSecondary }}>{pt.ingested} ingested</span>
              {pt.overwritten > 0 && (
                <span style={{ color: theme.warningText ?? theme.warning }}>
                  {pt.overwritten} overwritten
                </span>
              )}
              <span style={{ color: theme.textMuted }}>{pt.skipped} unchanged</span>
            </div>
          ))}
        </div>
      )}

      <style>{`
        @keyframes eo-at-livecard-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(42, 170, 120, 0.5); }
          70%  { box-shadow: 0 0 0 6px rgba(42, 170, 120, 0);   }
          100% { box-shadow: 0 0 0 0 rgba(42, 170, 120, 0);     }
        }
      `}</style>
    </div>
  );
}

function StrategyPill({ strategyLabel, theme }: { strategyLabel: string; theme: Theme }) {
  return (
    <span
      title="Sync strategy used for this run"
      style={{
        padding: '1px 6px',
        fontSize: 9,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        borderRadius: 10,
        background: theme.bgCard,
        border: `1px solid ${theme.borderLight ?? theme.border}`,
        color: theme.textSecondary,
      }}
    >
      {strategyLabel}
    </span>
  );
}

/**
 * Overlay wrapper for backward compatibility.
 * Opens AirtableSettingsSection in a slide-out panel.
 */
export function AirtableSettings({ session, onClose, matrixClient, roomId }: AirtableSettingsProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.panel} onClick={(e) => e.stopPropagation()}>
        <div style={s.panelHeader}>
          <div>
            <div style={s.panelTitle}>Airtable Integration</div>
            <div style={s.panelSubtitle}>Connect and sync data from Airtable bases</div>
          </div>
          <button onClick={onClose} style={s.closeBtn}>&times;</button>
        </div>
        <AirtableSettingsSection session={session} matrixClient={matrixClient} roomId={roomId} />
      </div>
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    overlay: {
      position: 'fixed',
      inset: 0,
      background: t.shadowOverlay,
      display: 'flex',
      justifyContent: 'flex-end',
      zIndex: 1000,
    },
    panel: {
      width: 480,
      maxWidth: '100vw',
      height: '100vh',
      background: t.bgCard,
      borderLeft: `1px solid ${t.border}`,
      overflowY: 'auto',
      boxShadow: t.shadowPanel,
      fontFamily: "'Outfit', system-ui, -apple-system, sans-serif",
    },
    panelHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      padding: '24px 24px 16px',
      borderBottom: `1px solid ${t.border}`,
    },
    panelTitle: {
      fontFamily: "'Source Serif 4', Georgia, serif",
      fontSize: 18,
      fontWeight: 600,
      color: t.textHeading,
    },
    panelSubtitle: {
      fontSize: 12,
      color: t.textSecondary,
      marginTop: 2,
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 22,
      color: t.textSecondary,
      cursor: 'pointer',
      padding: '0 4px',
      lineHeight: 1,
    },

    section: {
      padding: '20px 24px',
      borderBottom: `1px solid ${t.borderLight}`,
    },
    sectionTitle: {
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.06em',
      color: t.textMuted,
      marginBottom: 12,
    },

    error: {
      color: t.dangerText,
      fontSize: 12,
      padding: '2px 0',
      marginBottom: 8,
    },
    connectBtn: {
      padding: '10px 20px',
      fontSize: 13,
      fontWeight: 600,
      border: 'none',
      borderRadius: 6,
      background: '#2563eb',
      color: '#fff',
      cursor: 'pointer',
    },
    connectedRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    connectedDot: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: t.success,
    },
    disconnectBtn: {
      padding: '4px 10px',
      fontSize: 10,
      fontWeight: 500,
      border: `1px solid ${t.dangerBorder}`,
      borderRadius: 5,
      background: t.bgCard,
      color: t.dangerText,
      cursor: 'pointer',
      marginLeft: 'auto',
    },

    keyActions: {
      display: 'flex',
      gap: 6,
      flexWrap: 'wrap' as const,
    },
    actionBtn: {
      padding: '6px 12px',
      fontSize: 11,
      fontWeight: 500,
      border: `1px solid ${t.border}`,
      borderRadius: 5,
      background: t.bgCard,
      color: t.text,
      cursor: 'pointer',
    },

    statusMsg: {
      fontSize: 11,
      marginTop: 8,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
    statusDetail: {
      color: t.textMuted,
    },
    spinner: {
      display: 'inline-block',
      width: 10,
      height: 10,
      border: `2px solid ${t.border}`,
      borderTopColor: '#2563eb',
      borderRadius: '50%',
      animation: 'spin 0.6s linear infinite',
    },

    // ── Table picker ──
    tablePickerSection: {
      marginTop: 12,
      borderTop: `1px solid ${t.borderLight}`,
      paddingTop: 12,
    },
    tablePickerTitle: {
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.06em',
      color: t.textMuted,
      marginBottom: 8,
    },
    baseGroup: {
      marginBottom: 8,
    },
    baseHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 4,
    },
    checkLabel: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 12,
      color: t.text,
      cursor: 'pointer',
    },
    baseName: {
      fontWeight: 600,
      fontSize: 12,
    },
    baseCount: {
      fontSize: 10,
      color: t.textMuted,
    },
    tableList: {
      paddingLeft: 20,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 3,
    },
    tableItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 11,
      color: t.text,
      cursor: 'pointer',
    },
    tableName: {
      flex: 1,
    },
    fieldCount: {
      fontSize: 10,
      color: t.textMuted,
    },

    // ── Field preview (expanded table) ──
    fieldPreview: {
      marginLeft: 22,
      marginBottom: 6,
      padding: '6px 8px',
      background: t.bgMuted,
      borderRadius: 4,
      border: `1px solid ${t.borderLight}`,
    },
    nameFieldPicker: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 6,
      paddingBottom: 6,
      borderBottom: `1px solid ${t.borderLight}`,
    },
    nameFieldLabel: {
      fontSize: 10,
      fontWeight: 600,
      color: t.textSecondary,
      whiteSpace: 'nowrap' as const,
    },
    nameFieldSelect: {
      flex: 1,
      fontSize: 11,
      padding: '2px 4px',
      borderRadius: 3,
      border: `1px solid ${t.border}`,
      background: t.bg,
      color: t.text,
    },
    fieldList: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 1,
      maxHeight: 160,
      overflowY: 'auto' as const,
    },
    fieldItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '2px 4px',
      borderRadius: 2,
      fontSize: 10,
      color: t.text,
    },
    fieldItemName: {
      fontFamily: "'JetBrains Mono', monospace",
    },
    fieldItemType: {
      color: t.textMuted,
      fontSize: 9,
    },

    preserveRow: {
      marginTop: 10,
      padding: '8px 0',
      borderTop: `1px solid ${t.borderLight}`,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 4,
    },
    preserveHint: {
      fontSize: 10,
      color: t.textMuted,
      paddingLeft: 22,
    },

    // ── Record limit ──
    recordLimitRow: {
      marginTop: 10,
      padding: '8px 0',
      borderTop: `1px solid ${t.borderLight}`,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 6,
    },
    recordLimitLabel: {
      fontSize: 11,
      fontWeight: 600,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.06em',
    },
    recordLimitInputRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
    recordLimitInput: {
      width: 120,
      padding: '6px 10px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 5,
      background: t.bg,
      color: t.text,
      outline: 'none',
      fontFamily: "'JetBrains Mono', monospace",
    },
    recordLimitClear: {
      padding: '5px 10px',
      fontSize: 10,
      fontWeight: 500,
      border: `1px solid ${t.border}`,
      borderRadius: 5,
      background: t.bgCard,
      color: t.textSecondary,
      cursor: 'pointer',
    },
    recordLimitHint: {
      fontSize: 10,
      color: t.textMuted,
    },

    // ── Import resolution stance (Phase A.6/4) ──
    resolutionRow: {
      marginTop: 10,
      padding: '8px 0',
      borderTop: `1px solid ${t.borderLight}`,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 6,
    },
    resolutionLabel: {
      fontSize: 11,
      fontWeight: 600,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.06em',
    },
    resolutionOptions: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 4,
    },
    resolutionOption: {
      display: 'grid',
      gridTemplateColumns: 'auto auto 1fr',
      alignItems: 'center',
      gap: 8,
      padding: '6px 10px',
      border: `1px solid ${t.border}`,
      borderRadius: 5,
      background: t.bgCard,
      cursor: 'pointer',
    },
    resolutionOptionActive: {
      borderColor: t.accent,
      background: t.accentBg,
    },
    resolutionRadio: {
      margin: 0,
      cursor: 'pointer',
    },
    resolutionOptionLabel: {
      fontSize: 12,
      fontWeight: 600,
      color: t.text,
    },
    resolutionOptionHint: {
      fontSize: 10,
      color: t.textMuted,
      lineHeight: 1.3,
    },
    resolutionFooter: {
      fontSize: 10,
      color: t.textMuted,
      lineHeight: 1.4,
    },

    // ── Sync modes ──
    syncModes: {
      display: 'flex',
      gap: 8,
      marginTop: 10,
    },
    syncModeCard: {
      flex: 1,
      padding: 10,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: t.bgCard,
    },
    syncModeTitle: {
      fontSize: 12,
      fontWeight: 600,
      color: t.textHeading,
      marginBottom: 4,
    },
    syncModeDesc: {
      fontSize: 10,
      color: t.textMuted,
      marginBottom: 8,
      lineHeight: 1.4,
    },
    syncModeBtn: {
      width: '100%',
      padding: '7px 0',
      fontSize: 11,
      fontWeight: 600,
      border: `1px solid ${t.border}`,
      borderRadius: 5,
      background: t.bg,
      color: t.text,
      cursor: 'pointer',
    },

    // ── Continuous sync ──
    continuousSyncSection: {
      marginTop: 12,
      padding: '10px 0',
      borderTop: `1px solid ${t.borderLight}`,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 6,
    },
    continuousSyncRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    continuousSyncHint: {
      fontSize: 10,
      color: t.textMuted,
      paddingLeft: 22,
      lineHeight: 1.4,
    },

    // ── Sync settings ──
    syncSettingsSection: {
      marginTop: 16,
      padding: '12px 0',
      borderTop: `1px solid ${t.borderLight}`,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 12,
    },
    syncSettingsTitle: {
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.06em',
      color: t.textMuted,
    },
    settingRow: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 4,
    },
    settingLabel: {
      fontSize: 12,
      fontWeight: 500,
      color: t.text,
    },
    settingInputRow: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 3,
    },
    settingInput: {
      width: 80,
      padding: '4px 8px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgCard,
      color: t.text,
    },
    settingSelect: {
      padding: '4px 8px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgCard,
      color: t.text,
      maxWidth: 280,
    },
    settingHint: {
      fontSize: 10,
      color: t.textMuted,
      lineHeight: 1.4,
    },
    lastSyncInfo: {
      display: 'flex',
      gap: 6,
      alignItems: 'center',
    },
    lastSyncTime: {
      fontSize: 12,
      color: t.text,
    },
    lastSyncAgo: {
      fontSize: 10,
      color: t.textMuted,
    },

    // ── Sync activity log ──
    syncLogSection: {
      marginTop: 16,
      padding: '10px 0 0',
      borderTop: `1px solid ${t.borderLight}`,
    },
    syncLogHeader: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 6,
    },
    syncLogTitle: {
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.06em',
      color: t.textMuted,
    },
    syncLogClear: {
      fontSize: 10,
      padding: '2px 7px',
      border: `1px solid ${t.borderLight}`,
      borderRadius: 4,
      background: 'none',
      color: t.textMuted,
      cursor: 'pointer',
    },
    syncLogList: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 1,
      maxHeight: 200,
      overflowY: 'auto' as const,
      fontFamily: "'JetBrains Mono', monospace",
    },
    syncLogRow: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 6,
      padding: '3px 0',
      borderBottom: `1px solid ${t.borderLight}`,
      fontSize: 10,
    },
    syncLogIcon: {
      width: 14,
      flexShrink: 0,
      textAlign: 'center' as const,
    },
    syncLogBody: {
      flex: 1,
      lineHeight: 1.4,
      color: t.text,
    },
    syncLogSyncer: {
      color: t.textSecondary,
    },
    syncLogDetail: {
      color: t.textMuted,
    },
    syncLogAgo: {
      flexShrink: 0,
      color: t.textMuted,
      fontSize: 9,
      paddingTop: 1,
    },
  };
}
