/**
 * Room sync coordinator.
 *
 * Manages continuous Airtable → EO-DB sync for each active RoomSyncBinding.
 * Exactly ONE connected user per binding is elected as the "primary syncer"
 * who actually calls the Airtable API. All other users in the room receive
 * the data through the EO changefeed (WebSocket events) — zero extra
 * Airtable calls.
 *
 * Election rules:
 *   1. If `preferred_syncer` is set on the binding AND that user is online → they win.
 *   2. Otherwise, the first connected user in the room's user pool is elected.
 *   3. When the primary disconnects, the coordinator immediately promotes the
 *      next available user. Existing idempotency in the sync engine handles
 *      any brief overlap.
 *
 * The coordinator runs server-side timers — the primary user's identity is
 * recorded as the `agent` on ingested events, but the server itself drives
 * the schedule. This avoids relying on client-side timers and keeps Airtable
 * API key material server-side.
 *
 * Anti-spam:
 *   - Each binding has a configurable `sync_interval_sec` (min 30s, default 120s).
 *   - The Airtable client's built-in rate limiter (4 req/s) still applies.
 *   - Sync locks prevent concurrent syncs on the same table.
 *   - Incremental sync only fetches records modified since last cursor.
 */

import type { EoDb } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import { getApiKey, touchApiKey } from './api-keys.js';
import { AirtableClient } from './airtable-client.js';
import { updateSync } from './airtable-sync.js';
import {
  getAllBindings,
  getBinding,
  type RoomSyncBinding,
} from './room-sync-config.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Runtime state for a single active binding. */
interface BindingRuntime {
  binding: RoomSyncBinding;
  /** Users currently connected to this room (user_id set). */
  pool: Set<string>;
  /** The elected primary syncer's user_id, or null if no one is online. */
  primary: string | null;
  /** The interval timer handle, or null if paused/no users. */
  timer: ReturnType<typeof setInterval> | null;
  /** The initial delay timeout handle (cleared on timer restart/stop). */
  initialTimeout: ReturnType<typeof setTimeout> | null;
  /** True while a sync cycle is in progress (prevents overlapping ticks). */
  syncing: boolean;
  /** ISO timestamp of last successful sync. */
  lastSyncAt: string | null;
  /** Last sync error message (cleared on next success). */
  lastError: string | null;
}

/** Status snapshot for API responses. */
export interface BindingSyncStatus {
  binding_id: string;
  room_id: string;
  api_key_label: string;
  enabled: boolean;
  sync_interval_sec: number;
  primary_syncer: string | null;
  pool_size: number;
  pool_users: string[];
  syncing: boolean;
  last_sync_at: string | null;
  last_error: string | null;
}

// ─── Coordinator ────────────────────────────────────────────────────────────

export class RoomSyncCoordinator {
  private db: EoDb;
  private feed: Feed;
  private runtimes = new Map</* binding_id */ string, BindingRuntime>();
  private started = false;

  constructor(db: EoDb, feed: Feed) {
    this.db = db;
    this.feed = feed;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Load all bindings from DB and start timers for enabled ones with users. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const bindings = await getAllBindings(this.db);
    for (const binding of bindings) {
      this.ensureRuntime(binding);
    }
  }

  /** Stop all timers and clean up. */
  stop(): void {
    this.started = false;
    for (const rt of this.runtimes.values()) {
      this.clearTimer(rt);
    }
    this.runtimes.clear();
  }

  // ── Binding management (called when admin creates/updates/deletes) ─────

  /** Register a new or updated binding. Restarts its timer if needed. */
  async onBindingChanged(bindingId: string): Promise<void> {
    const binding = await getBinding(this.db, bindingId);
    if (!binding) {
      // Deleted — tear down runtime
      this.removeRuntime(bindingId);
      return;
    }

    const existing = this.runtimes.get(bindingId);
    if (existing) {
      // Update config, re-elect, restart timer
      existing.binding = binding;
      this.elect(existing);
      this.restartTimer(existing);
    } else {
      this.ensureRuntime(binding);
    }
  }

  /** Fully remove a binding's runtime (on delete). */
  removeRuntime(bindingId: string): void {
    const rt = this.runtimes.get(bindingId);
    if (rt) {
      this.clearTimer(rt);
      this.runtimes.delete(bindingId);
    }
  }

  // ── User presence (called from WebSocket sync route) ───────────────────

  /**
   * A user connected to a room. Add them to the sync pool for every
   * binding on that room. If no primary exists, elect them.
   */
  userJoined(roomId: string, userId: string): void {
    for (const rt of this.runtimes.values()) {
      if (rt.binding.room_id !== roomId) continue;
      rt.pool.add(userId);
      this.elect(rt);
      this.restartTimer(rt);
    }
  }

  /**
   * A user left a specific room. Remove them from pools for that room only.
   * More efficient than userLeft() when the user is still in other rooms.
   */
  userLeftRoom(roomId: string, userId: string): void {
    for (const rt of this.runtimes.values()) {
      if (rt.binding.room_id !== roomId) continue;
      if (!rt.pool.has(userId)) continue;
      rt.pool.delete(userId);
      if (rt.primary === userId) {
        rt.primary = null;
        this.elect(rt);
      }
      if (rt.pool.size === 0) {
        this.clearTimer(rt);
      }
    }
  }

  /**
   * A user disconnected. Remove them from all pools.
   * If they were the primary, elect a replacement.
   */
  userLeft(userId: string): void {
    for (const rt of this.runtimes.values()) {
      if (!rt.pool.has(userId)) continue;
      rt.pool.delete(userId);
      if (rt.primary === userId) {
        rt.primary = null;
        this.elect(rt);
      }
      // If pool is now empty, stop the timer
      if (rt.pool.size === 0) {
        this.clearTimer(rt);
      }
    }
  }

  /**
   * Bulk-set the user pool for a room (e.g., on coordinator start when
   * users are already connected).
   */
  setRoomUsers(roomId: string, userIds: string[]): void {
    for (const rt of this.runtimes.values()) {
      if (rt.binding.room_id !== roomId) continue;
      rt.pool = new Set(userIds);
      this.elect(rt);
      this.restartTimer(rt);
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────

  /** Get sync status for all bindings. */
  getAllStatus(): BindingSyncStatus[] {
    return Array.from(this.runtimes.values()).map(rt => this.toStatus(rt));
  }

  /** Get sync status for a specific binding. */
  getStatus(bindingId: string): BindingSyncStatus | null {
    const rt = this.runtimes.get(bindingId);
    return rt ? this.toStatus(rt) : null;
  }

  /** Get sync status for all bindings in a room. */
  getRoomStatus(roomId: string): BindingSyncStatus[] {
    return Array.from(this.runtimes.values())
      .filter(rt => rt.binding.room_id === roomId)
      .map(rt => this.toStatus(rt));
  }

  private toStatus(rt: BindingRuntime): BindingSyncStatus {
    return {
      binding_id: rt.binding.binding_id,
      room_id: rt.binding.room_id,
      api_key_label: rt.binding.api_key_label,
      enabled: rt.binding.enabled,
      sync_interval_sec: rt.binding.sync_interval_sec,
      primary_syncer: rt.primary,
      pool_size: rt.pool.size,
      pool_users: Array.from(rt.pool),
      syncing: rt.syncing,
      last_sync_at: rt.lastSyncAt,
      last_error: rt.lastError,
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private ensureRuntime(binding: RoomSyncBinding): BindingRuntime {
    let rt = this.runtimes.get(binding.binding_id);
    if (!rt) {
      rt = {
        binding,
        pool: new Set(),
        primary: null,
        timer: null,
        initialTimeout: null,
        syncing: false,
        lastSyncAt: null,
        lastError: null,
      };
      this.runtimes.set(binding.binding_id, rt);
    }
    return rt;
  }

  /**
   * Elect a primary syncer for a binding.
   *
   * Priority:
   *   1. preferred_syncer if online
   *   2. Current primary if still online (stability)
   *   3. First user in the pool
   */
  private elect(rt: BindingRuntime): void {
    if (!rt.binding.enabled) {
      rt.primary = null;
      return;
    }

    // Preferred syncer wins if online
    if (rt.binding.preferred_syncer && rt.pool.has(rt.binding.preferred_syncer)) {
      rt.primary = rt.binding.preferred_syncer;
      return;
    }

    // Current primary still online — keep them (avoids churn)
    if (rt.primary && rt.pool.has(rt.primary)) {
      return;
    }

    // Elect first available
    const first = rt.pool.values().next();
    rt.primary = first.done ? null : first.value;
  }

  private clearTimer(rt: BindingRuntime): void {
    if (rt.initialTimeout) {
      clearTimeout(rt.initialTimeout);
      rt.initialTimeout = null;
    }
    if (rt.timer) {
      clearInterval(rt.timer);
      rt.timer = null;
    }
  }

  private restartTimer(rt: BindingRuntime): void {
    this.clearTimer(rt);

    // Don't start if disabled, no users, or no primary
    if (!rt.binding.enabled || rt.pool.size === 0 || !rt.primary) return;

    const intervalMs = rt.binding.sync_interval_sec * 1000;

    // Run first sync soon (5s delay to let connections settle)
    rt.initialTimeout = setTimeout(() => {
      rt.initialTimeout = null;
      this.tick(rt);
    }, 5_000);

    // Then run on interval
    rt.timer = setInterval(() => {
      this.tick(rt);
    }, intervalMs);
  }

  /** Execute one sync cycle for a binding. */
  private async tick(rt: BindingRuntime): Promise<void> {
    // Guards: skip if disabled, no primary, already syncing, or coordinator stopped
    if (!this.started) return;
    if (!rt.binding.enabled) return;
    if (!rt.primary) return;
    if (rt.syncing) return;

    rt.syncing = true;
    try {
      const keyEntry = await getApiKey(this.db, rt.binding.api_key_label);
      if (!keyEntry) {
        rt.lastError = `API key "${rt.binding.api_key_label}" not found`;
        return;
      }

      const client = new AirtableClient(keyEntry.api_key);
      const agent = rt.primary; // Attribute events to the primary syncer

      await updateSync(this.db, this.feed, client, agent, {
        baseIds: rt.binding.base_ids.length > 0 ? rt.binding.base_ids : undefined,
        tableIds: rt.binding.table_ids.length > 0 ? rt.binding.table_ids : undefined,
      });

      await touchApiKey(this.db, rt.binding.api_key_label);
      rt.lastSyncAt = new Date().toISOString();
      rt.lastError = null;
    } catch (e: any) {
      rt.lastError = e.message || String(e);
    } finally {
      rt.syncing = false;
    }
  }
}
