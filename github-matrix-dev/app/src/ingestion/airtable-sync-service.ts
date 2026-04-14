/**
 * Airtable continuous sync service — browser-side.
 *
 * Coordinates via:
 *   - `eo.airtable.head` (Matrix state event, state_key = ""):
 *       Tracks the current primary syncer, last sync time, and hydration status.
 *       State events are deduplicated — no timeline spam.
 *   - To-device messages (ephemeral, never persisted to timeline):
 *       `com.eo-db.airtable.signal` — sync completion broadcasts
 *       `com.eo-db.airtable.lock`   — sync lock claim/release signals
 *
 * Only the elected primary syncer calls the Airtable API. Other clients receive
 * data through the normal EO changefeed / Google Drive snapshot chain.
 *
 * Primary syncer election:
 *   1. Read `eo.airtable.head` from room state
 *   2. If unclaimed or stale (>2 min) AND not actively syncing, claim
 *   3. If another client is active (<2 min) or syncing, defer
 *   4. On stop(), clear our claim
 *   5. On each sync, refresh `last_sync_at` to keep claim alive
 *   6. Device ID prevents same-user multi-tab races
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import { pack } from 'msgpackr';
import type { EoStore } from '../db/encrypted-store';
import { AirtableClient } from './airtable-client';
import {
  hydrationSync,
  updateSync,
  type SyncCustomization,
  type SyncProgress,
  type HydrationResult,
  type UpdateSyncResult,
  type RawImportBundle,
  type ProvenanceResult,
} from './airtable-sync';
import {
  useAirtableStore,
  DEFAULT_SYNC_SETTINGS,
  type AirtableSyncSettings,
  type SyncLogEntry,
  type CurrentSyncSnapshot,
} from './airtable-store';
import { saveContinuousEnabled, saveCurrentSync } from './airtable-persistence';
import { airtableSyncEventTypes } from '../lib/matrix-domain';
import type { GDriveSyncService } from '../google-drive/gdrive-sync';
import { createImportProgressListener } from '../store/eo-store';

// ─── Constants ──────────────────────────────────────────────────────────────

const MIN_SYNC_INTERVAL_SEC = 15;
const MAX_SYNC_INTERVAL_SEC = 600;
const STALE_THRESHOLD_MS = 2 * 60_000;   // 2 minutes — claim is stale after this
const FIRST_SYNC_DELAY_MS = 3_000;       // 3 seconds — let connections settle

const EO_AIRTABLE_HEAD = 'eo.airtable.head';
const EO_AIRTABLE_CONFIG = 'eo.airtable.config';

const SIGNAL_TYPE = airtableSyncEventTypes().signal;
const LOCK_TYPE = airtableSyncEventTypes().lock;

// ─── Types ──────────────────────────────────────────────────────────────────

interface AirtableHeadContent {
  syncer: string;          // Matrix user ID of the primary syncer
  device: string;          // Device ID (tab-specific, prevents same-user races)
  syncing: boolean;        // Whether a sync is currently in progress
  last_sync_at: string;    // ISO timestamp of last successful sync
  records_ingested: number;
  records_skipped: number;
  hydrated: boolean;       // Whether initial hydration has been completed
}

// ─── Service ────────────────────────────────────────────────────────────────

export class AirtableSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private syncing = false;
  private deviceId: string;

  /** Tracks whether a remote device holds the sync lock (via to-device signal). */
  private remoteLockHeld = false;

  constructor(
    private matrixClient: MatrixClient,
    private roomId: string,
    private store: EoStore,
    private agent: string,
    private getApiKey: () => string | null,
    private customization?: SyncCustomization,
    /**
     * Optional Google Drive sync reference. When supplied, bulk hydrations
     * upload the raw Airtable payload to Drive for provenance BEFORE any
     * records are folded, and then rewrite the on-Drive .eodb log with the
     * processed events when the sync finishes.
     */
    private gdriveSync?: GDriveSyncService,
  ) {
    this.deviceId = this.matrixClient.getDeviceId() ?? `browser-${Date.now()}`;
  }

  /** Get the effective sync interval in ms, clamped to [15s, 600s]. */
  private getSyncIntervalMs(): number {
    const sec = useAirtableStore.getState().syncSettings.syncIntervalSec;
    const clamped = Math.max(MIN_SYNC_INTERVAL_SEC, Math.min(MAX_SYNC_INTERVAL_SEC, sec));
    return clamped * 1000;
  }

  /** Begin the continuous sync loop at the configured interval. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Load sync settings from room state (shared config)
    this.loadSyncSettingsFromRoom();

    // Persist the enabled flag so a refresh can auto-resume. Fire-and-forget:
    // if the write fails we just lose the auto-resume once, nothing more.
    saveContinuousEnabled(this.store, true);

    // Listen for to-device sync signals from other clients
    this.matrixClient.on('toDeviceEvent' as any, this.handleToDeviceEvent);

    // Show the user "next check in Ns" immediately so they know we're
    // scheduled, even before the first tick fires.
    useAirtableStore.getState().setNextTickAt(Date.now() + FIRST_SYNC_DELAY_MS);

    // Initial claim attempt after a short delay
    setTimeout(async () => {
      if (!this.running) return;
      await this.tick();

      // Start the interval at configured rate
      this.restartTimer();
    }, FIRST_SYNC_DELAY_MS);
  }

  /** Restart the sync timer (call after settings change). */
  private restartTimer(): void {
    if (this.timer) clearInterval(this.timer);
    if (!this.running) return;
    const intervalMs = this.getSyncIntervalMs();
    this.timer = setInterval(() => this.tick(), intervalMs);
    useAirtableStore.getState().setNextTickAt(Date.now() + intervalMs);
  }

  /** Stop the sync loop and release the primary syncer claim. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Stop listening for to-device events
    this.matrixClient.removeListener('toDeviceEvent' as any, this.handleToDeviceEvent);

    await this.releasePrimarySyncer();
    useAirtableStore.getState().setPrimarySyncer(false);
    useAirtableStore.getState().setContinuousSync(false);
    useAirtableStore.getState().setNextTickAt(null);
    // Clear the persisted flag so the next mount doesn't auto-resume against
    // the user's explicit "off" action.
    saveContinuousEnabled(this.store, false);
  }

  /** Update the customization options for future syncs. */
  setCustomization(c: SyncCustomization | undefined) {
    this.customization = c;
  }

  // ─── To-device event handling ─────────────────────────────────────────────

  private handleToDeviceEvent = (event: MatrixEvent): void => {
    const type = event.getType();
    const content = event.getContent() as Record<string, any>;

    // Scope to this room only
    if (content.room_id !== this.roomId) return;

    if (type === SIGNAL_TYPE) {
      // Another device completed a sync — update local UI and log
      useAirtableStore.getState().setLastSyncAt(content.synced_at);
      const logEntry: SyncLogEntry = {
        ts: Date.now(),
        type: content.type === 'hydration_complete' ? 'hydration_complete' : 'sync_complete',
        source: 'remote',
        syncer: content.syncer,
        detail: `${content.records_ingested} ingested, ${content.records_skipped} unchanged`,
      };
      useAirtableStore.getState().addSyncLogEntry(logEntry);
    } else if (type === LOCK_TYPE) {
      // Another device acquired/released sync lock
      if (content.action === 'acquired') {
        this.remoteLockHeld = true;
        useAirtableStore.getState().setRemoteLockHeld(true);
        useAirtableStore.getState().addSyncLogEntry({
          ts: Date.now(),
          type: 'lock_acquired',
          source: 'remote',
          syncer: content.syncer,
          device: content.device,
        });
      } else if (content.action === 'released') {
        this.remoteLockHeld = false;
        useAirtableStore.getState().setRemoteLockHeld(false);
        useAirtableStore.getState().addSyncLogEntry({
          ts: Date.now(),
          type: 'lock_released',
          source: 'remote',
          syncer: content.syncer,
          device: content.device,
        });
      }
    }
  };

  // ─── To-device broadcast ──────────────────────────────────────────────────

  /** Send a to-device message to all room members (ephemeral, not persisted). */
  private async broadcastToMembers(type: string, content: Record<string, any>): Promise<void> {
    const room = this.matrixClient.getRoom(this.roomId);
    if (!room) return;
    const myUserId = this.matrixClient.getUserId();

    for (const member of room.getJoinedMembers()) {
      if (member.userId === myUserId) continue;
      try {
        const inner = new Map<string, Record<string, any>>([['*', content]]);
        const outer = new Map<string, Map<string, Record<string, any>>>([[member.userId, inner]]);
        await this.matrixClient.sendToDevice(type, outer);
      } catch {
        // Non-fatal — peer may be offline; next broadcast will retry.
      }
    }
  }

  // ─── Sync settings (room state persistence) ────────────────────────────────

  /**
   * Read sync settings from Matrix room state. Settings are shared across
   * all devices in the room so everyone uses the same interval/strategy.
   */
  private loadSyncSettingsFromRoom(): void {
    try {
      const room = this.matrixClient.getRoom(this.roomId);
      if (!room) return;
      const event = room.currentState.getStateEvents(EO_AIRTABLE_CONFIG, '');
      if (!event) return;
      const content = (event as any).getContent?.() ?? event;
      if (content && typeof content === 'object') {
        const partial: Partial<AirtableSyncSettings> = {};
        if (typeof content.syncIntervalSec === 'number') {
          partial.syncIntervalSec = Math.max(MIN_SYNC_INTERVAL_SEC, Math.min(MAX_SYNC_INTERVAL_SEC, content.syncIntervalSec));
        }
        if (content.syncStrategy === 'lastModified' || content.syncStrategy === 'fullDiff') {
          partial.syncStrategy = content.syncStrategy;
        }
        if (typeof content.preserveExisting === 'boolean') {
          partial.preserveExisting = content.preserveExisting;
        }
        if (typeof content.recordLimit === 'number') {
          partial.recordLimit = Math.max(0, content.recordLimit);
        }
        useAirtableStore.getState().setSyncSettings(partial);
      }
    } catch {
      // Fall back to defaults
    }
  }

  /**
   * Save sync settings to Matrix room state so all devices share them.
   * Also restarts the timer if the interval changed.
   */
  async saveSyncSettings(settings: Partial<AirtableSyncSettings>): Promise<void> {
    const current = useAirtableStore.getState().syncSettings;
    const merged = { ...current, ...settings };

    // Clamp interval
    merged.syncIntervalSec = Math.max(MIN_SYNC_INTERVAL_SEC, Math.min(MAX_SYNC_INTERVAL_SEC, merged.syncIntervalSec));

    try {
      await this.matrixClient.sendStateEvent(this.roomId, EO_AIRTABLE_CONFIG as any, merged, '');
      useAirtableStore.getState().setSyncSettings(merged);

      // Restart timer if interval changed
      if (settings.syncIntervalSec !== undefined && this.running) {
        this.restartTimer();
      }
    } catch (e) {
      console.warn('[EO-DB] Failed to save Airtable sync settings:', e);
    }
  }

  // ─── Primary syncer election ──────────────────────────────────────────────

  private readHead(): AirtableHeadContent | null {
    try {
      const room = this.matrixClient.getRoom(this.roomId);
      if (!room) return null;
      const event = room.currentState.getStateEvents(EO_AIRTABLE_HEAD, '');
      if (!event) return null;
      const content = (event as any).getContent?.() ?? event;
      if (content.syncer) return content as AirtableHeadContent;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Try to claim primary syncer role.
   * Returns true if we are (or became) the primary syncer.
   */
  private async claimPrimarySyncer(): Promise<boolean> {
    // Don't attempt to claim while a remote device holds the lock
    if (this.remoteLockHeld) return false;

    const head = this.readHead();

    if (head) {
      // Already us (same user + same device)
      if (head.syncer === this.agent && head.device === this.deviceId) return true;

      // Another client is actively syncing — never steal mid-sync
      if (head.syncing) {
        useAirtableStore.getState().setPrimarySyncer(false);
        useAirtableStore.getState().setLastSyncAt(head.last_sync_at);
        return false;
      }

      // Same user but different device (tab) — only steal if stale
      if (head.syncer === this.agent && head.device !== this.deviceId) {
        const age = Date.now() - new Date(head.last_sync_at).getTime();
        if (age < STALE_THRESHOLD_MS) {
          useAirtableStore.getState().setPrimarySyncer(false);
          useAirtableStore.getState().setLastSyncAt(head.last_sync_at);
          return false;
        }
        // Stale same-user tab — take over
      } else if (head.syncer !== this.agent) {
        // Different user — check staleness
        const age = Date.now() - new Date(head.last_sync_at).getTime();
        if (age < STALE_THRESHOLD_MS) {
          // Active syncer exists — defer
          useAirtableStore.getState().setPrimarySyncer(false);
          useAirtableStore.getState().setLastSyncAt(head.last_sync_at);
          return false;
        }
        // Stale — take over
      }
    }

    // Claim it
    try {
      await this.matrixClient.sendStateEvent(this.roomId, EO_AIRTABLE_HEAD as any, {
        syncer: this.agent,
        device: this.deviceId,
        syncing: false,
        last_sync_at: new Date().toISOString(),
        records_ingested: head?.records_ingested ?? 0,
        records_skipped: head?.records_skipped ?? 0,
        hydrated: head?.hydrated ?? false,
      }, '');
      useAirtableStore.getState().setPrimarySyncer(true);
      return true;
    } catch (e) {
      console.warn('[EO-DB] Failed to claim Airtable primary syncer:', e);
      return false;
    }
  }

  private async releasePrimarySyncer(): Promise<void> {
    const head = this.readHead();
    if (!head || head.syncer !== this.agent) return;

    try {
      await this.matrixClient.sendStateEvent(this.roomId, EO_AIRTABLE_HEAD as any, {
        ...head,
        syncer: '',
        device: '',
        syncing: false,
      }, '');
    } catch (e) {
      console.warn('[EO-DB] Failed to release Airtable primary syncer:', e);
    }

    // Broadcast lock release so other devices know immediately
    await this.broadcastToMembers(LOCK_TYPE, {
      room_id: this.roomId,
      action: 'released',
      syncer: this.agent,
      device: this.deviceId,
      ts: Date.now(),
    });
  }

  // ─── Sync cycle ───────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this.running || this.syncing) return;

    const apiKey = this.getApiKey();
    if (!apiKey) {
      console.warn('[EO-DB] Airtable sync tick: no API key available');
      return;
    }

    // Try to claim / verify primary syncer
    const isPrimary = await this.claimPrimarySyncer();
    if (!isPrimary) return;

    this.syncing = true;
    useAirtableStore.getState().setSyncing(true);

    // Broadcast lock acquired so other devices don't attempt to claim
    await this.broadcastToMembers(LOCK_TYPE, {
      room_id: this.roomId,
      action: 'acquired',
      syncer: this.agent,
      device: this.deviceId,
      ts: Date.now(),
    });
    useAirtableStore.getState().addSyncLogEntry({
      ts: Date.now(),
      type: 'lock_acquired',
      source: 'local',
      syncer: this.agent,
      device: this.deviceId,
    });

    // Mark syncing in room state
    const headBefore = this.readHead();
    if (headBefore && headBefore.syncer === this.agent) {
      try {
        await this.matrixClient.sendStateEvent(this.roomId, EO_AIRTABLE_HEAD as any, {
          ...headBefore,
          syncing: true,
        }, '');
      } catch { /* best-effort */ }
    }

    const tickStart = Date.now();
    try {
      const client = new AirtableClient(apiKey);
      const isHydrated = headBefore?.hydrated ?? false;

      // Merge sync settings into customization
      const { syncSettings } = useAirtableStore.getState();
      const effectiveCustomization: SyncCustomization = {
        ...this.customization,
        preserveExisting: syncSettings.preserveExisting,
        recordLimit: syncSettings.recordLimit > 0 ? syncSettings.recordLimit : undefined,
      };

      const plannedStrategy: 'hydration' | 'lastModified' | 'fullDiff' =
        !isHydrated ? 'hydration'
        : syncSettings.syncStrategy === 'fullDiff' ? 'fullDiff'
        : 'lastModified';

      // Initial snapshot — the UI flips from "idle — next in Ns" to "preparing"
      // the moment the tick claims the lock, so the user sees something even
      // before the first network round-trip.
      const initialSnapshot: CurrentSyncSnapshot = {
        startedAt: tickStart,
        phase: 'preparing',
        strategy: plannedStrategy,
        preserveExisting: !!effectiveCustomization.preserveExisting,
        recordsSoFar: 0,
        perTable: [],
      };
      useAirtableStore.getState().setCurrentSync(initialSnapshot);
      saveCurrentSync(this.store, initialSnapshot);

      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: 'sync_start',
        source: 'local',
        syncer: this.agent,
        device: this.deviceId,
        detail: plannedStrategy === 'hydration'
          ? 'Continuous tick — initial hydration'
          : plannedStrategy === 'fullDiff'
          ? 'Continuous tick — full field diff'
          : 'Continuous tick — LAST_MODIFIED_TIME',
        strategy: plannedStrategy,
        preserveExisting: !!effectiveCustomization.preserveExisting,
      });

      // SyncProgress → currentSync bridge. Accumulates per-table counters so
      // the UI can show a running tally and the completion banner can summarise
      // what happened without recomputing from sync_results.
      const onProgress = (p: SyncProgress) => this.applyProgress(p);

      let result: HydrationResult | UpdateSyncResult;
      let ranHydration = false;

      // Bridge per-event fold output into Zustand so subscribers like
      // TableView (which re-fetches on `lastSeq` change) refresh as the
      // continuous sync lands records. Without this the events fold into
      // the MemoryStore + OPFS log but the UI never repaints until reload.
      const progressListener = createImportProgressListener();
      try {
        if (!isHydrated) {
          result = await hydrationSync(this.store, client, this.agent, {
            customization: effectiveCustomization,
            onEvent: progressListener.onEvent,
            onProgress,
            onRawImport: (bundle) => this.persistBulkImportProvenance(bundle),
          });
          ranHydration = true;
        } else {
          // 'fullDiff' strategy: pass null cursor by re-hydrating with
          // preserveExisting=false, so every field is compared.
          // 'lastModified' strategy (default): incremental via LAST_MODIFIED_TIME cursor.
          if (syncSettings.syncStrategy === 'fullDiff') {
            result = await hydrationSync(this.store, client, this.agent, {
              customization: { ...effectiveCustomization, preserveExisting: false },
              onEvent: progressListener.onEvent,
              onProgress,
              onRawImport: (bundle) => this.persistBulkImportProvenance(bundle),
            });
            ranHydration = true;
          } else {
            result = await updateSync(this.store, client, this.agent, {
              customization: effectiveCustomization,
              onEvent: progressListener.onEvent,
              onProgress,
            });
          }
        }
      } finally {
        // Flush any pending throttled Zustand update so the UI sees the
        // final lastSeq even if the sync ended on an in-flight timer.
        progressListener.finalize();
      }

      // After a bulk hydration completes, rewrite the .eodb log file on
      // Drive so the cumulative log matches the freshly-folded state. This
      // is the "upload the content to google drive by rewriting the .eodb"
      // step of the provenance-first bulk import flow. Fire-and-forget: if
      // Drive is flaky, the normal rolling buffer + next bake will catch up.
      if (ranHydration && this.gdriveSync && result.total_records_ingested > 0) {
        this.gdriveSync.fullPushToGDrive().catch((e) =>
          console.warn('[EO-DB] post-hydration fullPushToGDrive failed:', e),
        );
      }

      useAirtableStore.getState().setLastSyncResult(result);

      await this.signalCompletion(result, !isHydrated, plannedStrategy);
    } catch (e: any) {
      console.error('[EO-DB] Airtable sync failed:', e);
      const snap = useAirtableStore.getState().currentSync;
      useAirtableStore.getState().setError(e.message);
      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: 'sync_error',
        source: 'local',
        syncer: this.agent,
        device: this.deviceId,
        detail: e.message,
        strategy: snap?.strategy,
        preserveExisting: snap?.preserveExisting,
        baseId: snap?.baseId,
        baseName: snap?.baseName,
        endpoint: snap?.endpoint,
        cursorUsed: snap?.cursorUsed,
        durationMs: Date.now() - tickStart,
      });

      // Update head to reflect sync failure (not syncing anymore)
      const headAfter = this.readHead();
      if (headAfter && headAfter.syncer === this.agent) {
        try {
          await this.matrixClient.sendStateEvent(this.roomId, EO_AIRTABLE_HEAD as any, {
            ...headAfter,
            syncing: false,
          }, '');
        } catch { /* best-effort */ }
      }
    } finally {
      this.syncing = false;
      useAirtableStore.getState().setSyncing(false);
      // Clear the live snapshot — the run is either finished or errored; the
      // persistent sync log captures what happened from here on.
      useAirtableStore.getState().setCurrentSync(null);
      saveCurrentSync(this.store, null);
      // Schedule the next tick marker so the idle countdown reappears
      // immediately instead of waiting for restartTimer's next setInterval.
      if (this.running) {
        useAirtableStore.getState().setNextTickAt(Date.now() + this.getSyncIntervalMs());
      }

      // Broadcast lock released
      await this.broadcastToMembers(LOCK_TYPE, {
        room_id: this.roomId,
        action: 'released',
        syncer: this.agent,
        device: this.deviceId,
        ts: Date.now(),
      });
      useAirtableStore.getState().addSyncLogEntry({
        ts: Date.now(),
        type: 'lock_released',
        source: 'local',
        syncer: this.agent,
        device: this.deviceId,
      });
    }
  }

  /**
   * Translate a SyncProgress event into a Zustand `currentSync` update and
   * accumulate per-table counters. Persists to IndexedDB at phase boundaries
   * so a mid-tick refresh can restore the snapshot.
   */
  private applyProgress(p: SyncProgress): void {
    const state = useAirtableStore.getState();
    const prev = state.currentSync;
    if (!prev) return;

    // Merge per-table roll-up — grow the array when we see a new table,
    // patch the existing entry on each update. Keep tableId as the match key
    // when available; fall back to table-name.
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

    const phase: CurrentSyncSnapshot['phase'] =
      p.phase === 'discovering' ? 'discovering'
      : p.phase === 'collecting' ? 'collecting'
      : p.phase === 'fetching' ? 'fetching'
      : p.phase === 'folding' ? 'folding'
      : p.phase === 'syncing' ? 'syncing'
      : p.phase === 'table_done' ? 'table_done'
      : prev.phase;

    const next: CurrentSyncSnapshot = {
      ...prev,
      phase,
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
    };

    useAirtableStore.getState().setCurrentSync(next);
    // Only persist on phase boundaries / table completion — not on every
    // pagination progress event — so we don't hammer the store.
    if (phase === 'table_done' || phase !== prev.phase) {
      saveCurrentSync(this.store, next);
    }
  }

  /**
   * Provenance step (1) of the bulk import flow — pack the raw bundle into a
   * binary blob and upload it to Drive BEFORE the fold runs. The returned
   * ProvenanceResult is handed back to processHydrationBundle which emits an
   * `import.airtable.<importId>` record linking to the Drive file, so future
   * UI can list imports and offer a one-click re-download.
   *
   * Throws if upload fails, which aborts the hydration (we only fold after
   * provenance is durably stored).
   */
  private async persistBulkImportProvenance(
    bundle: RawImportBundle,
  ): Promise<ProvenanceResult | void> {
    if (!this.gdriveSync) return;

    // Serialize the bundle exactly as collected — no field normalization,
    // no renaming, no flattening. Msgpack gives us a compact, deterministic
    // binary that round-trips through unpack() for later re-imports.
    const packed = pack(bundle) as Uint8Array;
    const rawBytes = new Uint8Array(
      packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength),
    );

    const totalRecords = bundle.tables.reduce((s, t) => s + t.records.length, 0);
    console.log(
      `[EO-DB] Airtable bulk import: uploading provenance (${totalRecords} records, ${rawBytes.byteLength} bytes)…`,
    );

    const result = await this.gdriveSync.uploadProvenance(rawBytes, {
      source: 'airtable',
      importId: bundle.importId,
      contentType: 'application/vnd.eo-db.airtable-import.msgpack',
      label: `airtable-${bundle.importId}`,
    });

    useAirtableStore.getState().addSyncLogEntry({
      ts: Date.now(),
      type: 'provenance_uploaded',
      source: 'local',
      syncer: this.agent,
      device: this.deviceId,
      detail: `${totalRecords} records → ${result.fileName} (${rawBytes.byteLength} B)`,
    });

    return result;
  }

  private async signalCompletion(
    result: HydrationResult | UpdateSyncResult,
    wasHydration: boolean,
    strategy: 'hydration' | 'lastModified' | 'fullDiff',
  ): Promise<void> {
    const now = new Date().toISOString();
    const snap = useAirtableStore.getState().currentSync;

    useAirtableStore.getState().setLastSyncAt(now);
    // Roll up per-table counts directly from sync_results — authoritative,
    // unlike the running perTable on the snapshot which may have been patched
    // mid-stream.
    const perTable = result.sync_results.map((r) => ({
      table: r.table_name,
      ingested: r.records_ingested,
      overwritten: r.records_overwritten,
      skipped: r.records_skipped_no_change + r.records_skipped_duplicate,
    }));
    const overwrittenStr = result.total_records_overwritten > 0
      ? `, ${result.total_records_overwritten} overwritten`
      : '';
    useAirtableStore.getState().addSyncLogEntry({
      ts: Date.now(),
      type: wasHydration ? 'hydration_complete' : 'sync_complete',
      source: 'local',
      syncer: this.agent,
      device: this.deviceId,
      detail: `${result.total_records_ingested} ingested${overwrittenStr}, ${result.total_records_skipped} unchanged`,
      strategy,
      preserveExisting: snap?.preserveExisting,
      perTable,
      durationMs: result.duration_ms,
      endpoint: snap?.endpoint,
      cursorUsed: snap?.cursorUsed,
      baseId: snap?.baseId,
      baseName: snap?.baseName,
    });

    // Update head state event (deduplicated, not spam)
    try {
      await this.matrixClient.sendStateEvent(this.roomId, EO_AIRTABLE_HEAD as any, {
        syncer: this.agent,
        device: this.deviceId,
        syncing: false,
        last_sync_at: now,
        records_ingested: result.total_records_ingested,
        records_skipped: result.total_records_skipped,
        hydrated: true,
      }, '');
    } catch (e) {
      console.warn('[EO-DB] Failed to update Airtable head state:', e);
    }

    // Broadcast sync completion via to-device (ephemeral, never hits timeline)
    await this.broadcastToMembers(SIGNAL_TYPE, {
      room_id: this.roomId,
      stream: 'airtable-sync',
      type: wasHydration ? 'hydration_complete' : 'sync_complete',
      syncer: this.agent,
      records_ingested: result.total_records_ingested,
      records_skipped: result.total_records_skipped,
      duration_ms: result.duration_ms,
      synced_at: now,
    });
  }
}
