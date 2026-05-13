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
import type { EoEventInput } from '../db/types';
import type { EoStore } from '../db/encrypted-store';
import { publishEoEventBatch } from '../sync/publish-events';
import {
  discoverSchema,
  emitHydrationSchema,
  seedCursorsFromMap,
  smartSync,
  getSyncedTableIds,
  type SyncCustomization,
  type SyncProgress,
  type UpdateSyncResult,
} from './airtable-sync';
import {
  useAirtableStore,
  createAirtableClient,
  webhookHealthPatch,
  DEFAULT_SYNC_SETTINGS,
  AMINO_CONNECTION_ID,
  type AirtableSyncSettings,
  type SyncLogEntry,
  type CurrentSyncSnapshot,
} from './airtable-store';
import {
  saveContinuousEnabled,
  saveCurrentSync,
} from './airtable-persistence';
import { runAirtableSync, SyncBusyError } from './airtable-sync-runner';
import { airtableSyncEventTypes } from '../lib/matrix-domain';
import { createImportProgressListener, useEoStore } from '../store/eo-store';

// ─── Constants ──────────────────────────────────────────────────────────────

const MIN_SYNC_INTERVAL_SEC = 15;
const MAX_SYNC_INTERVAL_SEC = 600;
const STALE_THRESHOLD_MS = 2 * 60_000;   // 2 minutes — claim is stale after this
// Fire the first sync tick on the next macrotask after start() — the leader
// election + initial poll should happen on app-load, not after a polite delay.
// Kept as a queued setTimeout(..., 0) (rather than a direct call) so we don't
// inline the network round-trip in start() and so the existing nextTickAt UI
// indicator still gets a non-null timestamp before the tick begins.
const FIRST_SYNC_DELAY_MS = 0;

const EO_AIRTABLE_HEAD = 'eo.airtable.head';
const EO_AIRTABLE_CONFIG = 'eo.airtable.config';
// Per-table cursor mirror. Each (baseId, tableId) pair gets its own state
// event with state_key = "${baseId}/${tableId}", so writes are independent
// and a leader handoff can read the entire set in one room-state scan.
const EO_AIRTABLE_CURSOR = 'eo.airtable.cursor';

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

  /**
   * Tables already logged as skipped — keyed by `${baseId}/${tableId}`. Each
   * skipped table emits one `table_skipped` log entry per process lifetime,
   * not one per tick, so the log doesn't fill with duplicates every 30s.
   */
  private skippedLogged = new Set<string>();

  constructor(
    private matrixClient: MatrixClient,
    private roomId: string,
    private store: EoStore,
    private agent: string,
    private getApiKey: () => string | null,
    private customization?: SyncCustomization,
    /**
     * Connection id this service instance is bound to. Defaults to
     * `AMINO_CONNECTION_ID` so the existing single-connection Amino flow
     * works unchanged. Phase 4's ApiConnectionsView routing will pass a
     * per-connection id (one per `ApiConnectionConfig`) so multiple
     * services can coexist without colliding on the in-process runner
     * gate or other per-cid state.
     */
    private connectionId: string = AMINO_CONNECTION_ID,
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
        if (typeof content.preserveExisting === 'boolean') {
          partial.preserveExisting = content.preserveExisting;
        }
        if (typeof content.recordLimit === 'number') {
          partial.recordLimit = Math.max(0, content.recordLimit);
        }
        if (typeof content.syncSchemaOnEachSync === 'boolean') {
          partial.syncSchemaOnEachSync = content.syncSchemaOnEachSync;
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

  // ─── Per-table cursor mirror (Matrix room state) ─────────────────────────
  //
  // IndexedDB cursors don't survive a leader handoff to a different device.
  // We mirror each per-table cursor to a `eo.airtable.cursor` state event
  // (state_key = `${baseId}/${tableId}`) so the next leader can pick up
  // where the previous one left off. seedCursorsFromMap() takes the max of
  // (room, local) so a regression is impossible.

  private readAllCursorsFromRoom(): Map<string, string> {
    const out = new Map<string, string>();
    try {
      const room = this.matrixClient.getRoom(this.roomId);
      if (!room) return out;
      const events = room.currentState.getStateEvents(EO_AIRTABLE_CURSOR);
      const list = Array.isArray(events) ? events : (events ? [events] : []);
      for (const ev of list) {
        const stateKey = (ev as any).getStateKey?.() ?? '';
        const content = (ev as any).getContent?.() ?? ev;
        const cursor = content?.lastModifiedSeen;
        if (typeof stateKey === 'string' && stateKey && typeof cursor === 'string' && cursor) {
          out.set(stateKey, cursor);
        }
      }
    } catch {
      // Fall through with whatever we collected — best-effort read.
    }
    return out;
  }

  private async writeCursorToRoom(baseId: string, tableId: string, cursor: string): Promise<void> {
    const stateKey = `${baseId}/${tableId}`;
    await this.matrixClient.sendStateEvent(this.roomId, EO_AIRTABLE_CURSOR as any, {
      lastModifiedSeen: cursor,
      updatedBy: this.agent,
      device: this.deviceId,
      updatedAt: new Date().toISOString(),
    }, stateKey);
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

    // Defer if a manual button (handleSync / handleResumableHydrate) is
    // mid-flight on this same device — the in-process gate is the only
    // thing protecting us from interleaving two whole hydrations against
    // the same EoStore. We try-await once instead of rejecting because the
    // continuous tick is a passive surface; the next interval will retry.
    try {
      await runAirtableSync(
        'continuous-tick',
        () => this.runTickBody(apiKey),
        { connectionId: this.connectionId },
      );
    } catch (e) {
      if (e instanceof SyncBusyError) {
        useAirtableStore.getState().addSyncLogEntry({
          ts: Date.now(),
          type: 'sync_skipped',
          source: 'local',
          syncer: this.agent,
          device: this.deviceId,
          detail: `Deferred — ${e.active} already running`,
        });
        return;
      }
      throw e;
    }
  }

  /** The actual tick body — wrapped by the in-process gate. */
  private async runTickBody(_apiKey: string): Promise<void> {
    void _apiKey;

    // Seed local cursors from room state BEFORE marking syncing — picks up
    // any advances written by a previous leader on a different device. The
    // max-merge in seedCursorsFromMap guarantees a stale state event can't
    // regress a cursor we already advanced locally.
    try {
      await seedCursorsFromMap(this.store, this.readAllCursorsFromRoom());
    } catch (e) {
      console.warn('[EO-DB] cursor seed from room state failed:', e);
    }

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
      // Wire response observation into the store so the Webhook Health panel
      // surfaces the last webhook call's HTTP status + cursor in real time.
      // We mirror every /webhooks endpoint (list, create, refresh, /payloads)
      // so setup failures like 403 INVALID_PERMISSIONS surface immediately,
      // not only when /payloads finally runs.
      const client = createAirtableClient({
        onResponse: (info) => {
          if (!info.url.includes('/webhooks')) return;
          useAirtableStore.getState().setWebhookHealth(webhookHealthPatch(info));
        },
      });
      // Every tick that gets past the lock counts as a cycle for the header
      // strip's "N cycles this session" indicator. Errors below still count
      // — a failed cycle is still a cycle the user wants to see.
      useAirtableStore.getState().incCycle();
      // Auto-decide hydration vs cursor sync from per-table cursor presence.
      // A cursor only exists if a previous hydrationSync wrote one, so its
      // absence is the ground-truth signal that this device needs to hydrate.
      // This survives a fresh device install (no cursors locally), a leader
      // handoff (seedCursorsFromMap above just imported any room-state
      // cursors), and never trusts head.hydrated — which could lie if the
      // remote flag was set by another room member whose data we don't have.
      const syncedTableIds = await getSyncedTableIds(this.store);
      const needsHydration = !Object.values(syncedTableIds).some((tables) => tables.length > 0);
      void headBefore;

      // Merge sync settings into customization
      const { syncSettings } = useAirtableStore.getState();
      const effectiveCustomization: SyncCustomization = {
        ...this.customization,
        preserveExisting: syncSettings.preserveExisting,
        recordLimit: syncSettings.recordLimit > 0 ? syncSettings.recordLimit : undefined,
      };

      // When the user has opted in, persist Airtable schema to the EO-DB
      // store as EO operators (base/table/field DEF + INS events) before each
      // sync. emitHydrationSchema is idempotent (stable client_event_ids
      // dedupe), so unchanged schema produces no new events. Restricted to
      // tables that already have cursors — i.e. the ones updateSync would
      // touch anyway. Failure is non-fatal: sync proceeds with the previously
      // cached manifest and any existing on-disk schema.
      if (syncSettings.syncSchemaOnEachSync) {
        const preSyncListener = createImportProgressListener();
        try {
          const manifest = await discoverSchema(client);
          useAirtableStore.getState().setManifest(manifest);
          for (const base of manifest.bases) {
            const baseSyncedTables = new Set(syncedTableIds[base.id] ?? []);
            for (const table of base.tables) {
              if (!baseSyncedTables.has(table.id)) continue;
              const inputs: EoEventInput[] = [];
              await emitHydrationSchema(
                this.store,
                { id: base.id, name: base.name },
                {
                  id: table.id,
                  name: table.name,
                  primaryFieldId: table.primaryFieldId,
                  fieldCount: table.fieldCount,
                  fields: table.fields,
                },
                this.agent,
                undefined,
                (event) => {
                  preSyncListener.onEvent(event);
                  const { seq: _seq, ...input } = event;
                  void _seq;
                  inputs.push(input as EoEventInput);
                },
              );
              if (inputs.length > 0) {
                try {
                  await publishEoEventBatch(this.matrixClient, this.roomId, inputs);
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

      const plannedStrategy: 'hydration' | 'lastModified' =
        needsHydration ? 'hydration' : 'lastModified';

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
          : 'Continuous tick — LAST_MODIFIED_TIME',
        strategy: plannedStrategy,
        preserveExisting: !!effectiveCustomization.preserveExisting,
      });

      // SyncProgress → currentSync bridge. Accumulates per-table counters so
      // the UI can show a running tally and the completion banner can summarise
      // what happened without recomputing from sync_results.
      const onProgress = (p: SyncProgress) => this.applyProgress(p);

      let result: UpdateSyncResult;

      // Bridge per-event fold output into Zustand so subscribers like
      // TableView (which re-fetches on `lastSeq` change) refresh as the
      // continuous sync lands records. Without this the events fold into
      // the MemoryStore + OPFS log but the UI never repaints until reload.
      const progressListener = createImportProgressListener();
      try {
        // smartSync routes per table: hydrates ones without a cursor,
        // runs incremental LAST_MODIFIED_TIME() on the rest. A single tick
        // therefore handles a fresh device, a newly-selected table mixed
        // with already-hydrated ones, and the steady state — without the
        // caller needing to pick a strategy up front.
        result = await smartSync(this.store, client, this.agent, {
          customization: effectiveCustomization,
          onEvent: progressListener.onEvent,
          onProgress,
          onCursorAdvance: (baseId, tableId, cursor) =>
            this.writeCursorToRoom(baseId, tableId, cursor),
          // Surface per-record diffs to the "Recent changes" UI panel.
          // ingestRecord only fires this for actual mutations (not
          // skip-no-change), so the buffer reflects real edits.
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
              syncer: this.agent,
              device: this.deviceId,
              detail: `${report.diffs.length} field${report.diffs.length === 1 ? '' : 's'}: ${report.diffs.map((d) => d.field).join(', ')}`,
              baseId: report.baseId,
              tableName: report.tableName,
              recordId: report.recordId,
              diffs: report.diffs,
              recordsChanged: 1,
            });
          },
        });
      } finally {
        // Flush any pending throttled Zustand update so the UI sees the
        // final lastSeq even if the sync ended on an in-flight timer.
        progressListener.finalize();
      }

      useAirtableStore.getState().setLastSyncResult(result);

      if (result.total_records_ingested > 0) {
        try {
          await useEoStore.getState().flushToOpfs();
        } catch (e) {
          console.warn('[EO-DB] post-sync flushToOpfs failed:', e);
        }
      }

      await this.signalCompletion(result, needsHydration, plannedStrategy);
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

    if (p.skipReason === 'no_last_modified_field' && p.table) {
      const key = `${p.baseId ?? ''}/${p.tableId ?? p.table}`;
      if (!this.skippedLogged.has(key)) {
        this.skippedLogged.add(key);
        useAirtableStore.getState().addSyncLogEntry({
          ts: Date.now(),
          type: 'table_skipped',
          source: 'local',
          syncer: this.agent,
          device: this.deviceId,
          baseId: p.baseId,
          baseName: p.baseName ?? p.base,
          tableName: p.table,
          detail: `${p.table}: no Last Modified Time field — add one in Airtable to enable sync`,
        });
      }
      return;
    }

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

  private async signalCompletion(
    result: UpdateSyncResult,
    wasHydration: boolean,
    strategy: 'hydration' | 'lastModified',
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
