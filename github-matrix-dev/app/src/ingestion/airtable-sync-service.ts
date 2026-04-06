/**
 * Airtable continuous sync service — browser-side.
 *
 * Coordinates via Matrix room state events:
 *   - `eo.airtable.head` (state event, state_key = ""):
 *       Tracks the current primary syncer, last sync time, and hydration status.
 *   - `eo.airtable.signal` (timeline event):
 *       Notifies other clients of sync completions.
 *
 * Only the elected primary syncer calls the Airtable API. Other clients receive
 * data through the normal EO changefeed / Filen snapshot chain.
 *
 * Primary syncer election:
 *   1. Read `eo.airtable.head` from room state
 *   2. If unclaimed or stale (>2 min), claim by writing our userId
 *   3. If another client is active (<2 min), defer
 *   4. On stop(), clear our claim
 *   5. On each sync, refresh `last_sync_at` to keep claim alive
 */

import type { MatrixClient } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import { AirtableClient } from './airtable-client';
import {
  hydrationSync,
  updateSync,
  type SyncCustomization,
  type HydrationResult,
  type UpdateSyncResult,
} from './airtable-sync';
import { useAirtableStore } from './airtable-store';

// ─── Constants ──────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = 30_000;          // 30 seconds
const STALE_THRESHOLD_MS = 2 * 60_000;   // 2 minutes — claim is stale after this
const FIRST_SYNC_DELAY_MS = 3_000;       // 3 seconds — let connections settle

const EO_AIRTABLE_HEAD = 'eo.airtable.head';
const EO_AIRTABLE_SIGNAL = 'eo.airtable.signal';

// ─── Types ──────────────────────────────────────────────────────────────────

interface AirtableHeadContent {
  syncer: string;          // Matrix user ID of the primary syncer
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

  constructor(
    private matrixClient: MatrixClient,
    private roomId: string,
    private store: EoStore,
    private agent: string,
    private getApiKey: () => string | null,
    private customization?: SyncCustomization,
  ) {}

  /** Begin the 30-second continuous sync loop. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Initial claim attempt after a short delay
    setTimeout(async () => {
      if (!this.running) return;
      await this.tick();

      // Start the interval
      this.timer = setInterval(() => this.tick(), SYNC_INTERVAL_MS);
    }, FIRST_SYNC_DELAY_MS);
  }

  /** Stop the sync loop and release the primary syncer claim. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.releasePrimarySyncer();
    useAirtableStore.getState().setPrimarySyncer(false);
    useAirtableStore.getState().setContinuousSync(false);
  }

  /** Update the customization options for future syncs. */
  setCustomization(c: SyncCustomization | undefined) {
    this.customization = c;
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
    const head = this.readHead();

    if (head) {
      // Already us
      if (head.syncer === this.agent) return true;

      // Another client is actively syncing — check staleness
      const lastSync = new Date(head.last_sync_at).getTime();
      const age = Date.now() - lastSync;
      if (age < STALE_THRESHOLD_MS) {
        // Active syncer exists — defer
        useAirtableStore.getState().setPrimarySyncer(false);
        useAirtableStore.getState().setLastSyncAt(head.last_sync_at);
        return false;
      }
      // Stale — take over
    }

    // Claim it
    try {
      await this.matrixClient.sendStateEvent(this.roomId, EO_AIRTABLE_HEAD as any, {
        syncer: this.agent,
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
        syncing: false,
      }, '');
    } catch (e) {
      console.warn('[EO-DB] Failed to release Airtable primary syncer:', e);
    }
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

      let result: HydrationResult | UpdateSyncResult;

      if (!isHydrated) {
        result = await hydrationSync(this.store, client, this.agent, {
          customization: this.customization,
        });
      } else {
        result = await updateSync(this.store, client, this.agent, {
          customization: this.customization,
        });
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
    }
  }

  private async signalCompletion(
    result: HydrationResult | UpdateSyncResult,
    wasHydration: boolean,
  ): Promise<void> {
    const now = new Date().toISOString();

    useAirtableStore.getState().setLastSyncAt(now);

    // Update head state event
    try {
      await this.matrixClient.sendStateEvent(this.roomId, EO_AIRTABLE_HEAD as any, {
        syncer: this.agent,
        syncing: false,
        last_sync_at: now,
        records_ingested: result.total_records_ingested,
        records_skipped: result.total_records_skipped,
        hydrated: true,
      }, '');
    } catch (e) {
      console.warn('[EO-DB] Failed to update Airtable head state:', e);
    }

    // Send timeline signal
    try {
      await this.matrixClient.sendEvent(this.roomId, EO_AIRTABLE_SIGNAL as any, {
        stream: 'airtable-sync',
        type: wasHydration ? 'hydration_complete' : 'sync_complete',
        syncer: this.agent,
        records_ingested: result.total_records_ingested,
        records_skipped: result.total_records_skipped,
        duration_ms: result.duration_ms,
        synced_at: now,
      });
    } catch (e) {
      console.warn('[EO-DB] Failed to send Airtable signal:', e);
    }
  }
}
