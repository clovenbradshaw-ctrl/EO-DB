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
import type { EoStore } from '../db/encrypted-store';
import { AirtableClient } from './airtable-client';
import {
  hydrationSync,
  updateSync,
  type SyncCustomization,
  type HydrationResult,
  type UpdateSyncResult,
} from './airtable-sync';
import { useAirtableStore, DEFAULT_SYNC_SETTINGS, type AirtableSyncSettings } from './airtable-store';
import { airtableSyncEventTypes } from '../lib/matrix-domain';

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

    // Listen for to-device sync signals from other clients
    this.matrixClient.on('toDeviceEvent' as any, this.handleToDeviceEvent);

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
    this.timer = setInterval(() => this.tick(), this.getSyncIntervalMs());
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
      // Another device completed a sync — update local UI
      useAirtableStore.getState().setLastSyncAt(content.synced_at);
    } else if (type === LOCK_TYPE) {
      // Another device acquired/released sync lock
      if (content.action === 'acquired') {
        this.remoteLockHeld = true;
        useAirtableStore.getState().setRemoteLockHeld(true);
      } else if (content.action === 'released') {
        this.remoteLockHeld = false;
        useAirtableStore.getState().setRemoteLockHeld(false);
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

      let result: HydrationResult | UpdateSyncResult;

      if (!isHydrated) {
        result = await hydrationSync(this.store, client, this.agent, {
          customization: effectiveCustomization,
        });
      } else {
        // 'fullDiff' strategy: pass null cursor by re-hydrating with
        // preserveExisting=false, so every field is compared.
        // 'lastModified' strategy (default): incremental via LAST_MODIFIED_TIME cursor.
        if (syncSettings.syncStrategy === 'fullDiff') {
          result = await hydrationSync(this.store, client, this.agent, {
            customization: { ...effectiveCustomization, preserveExisting: false },
          });
        } else {
          result = await updateSync(this.store, client, this.agent, {
            customization: effectiveCustomization,
          });
        }
      }

      useAirtableStore.getState().setLastSyncResult(result);

      await this.signalCompletion(result, !isHydrated);
    } catch (e: any) {
      console.error('[EO-DB] Airtable sync failed:', e);
      useAirtableStore.getState().setError(e.message);

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

      // Broadcast lock released
      await this.broadcastToMembers(LOCK_TYPE, {
        room_id: this.roomId,
        action: 'released',
        syncer: this.agent,
        device: this.deviceId,
        ts: Date.now(),
      });
    }
  }

  private async signalCompletion(
    result: HydrationResult | UpdateSyncResult,
    wasHydration: boolean,
  ): Promise<void> {
    const now = new Date().toISOString();

    useAirtableStore.getState().setLastSyncAt(now);

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
