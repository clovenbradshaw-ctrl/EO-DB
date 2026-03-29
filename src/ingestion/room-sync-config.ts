/**
 * Room-level Airtable sync configuration.
 *
 * An admin binds an Airtable API key (by label) + base/table selection
 * to a logical "room" (identified by room_id or alias). Any user
 * connected to that room participates in the sync pool: one device
 * is elected as primary syncer, the rest receive data via EO events
 * propagated through the changefeed.
 *
 * Storage keys:
 *   `room-sync:config:{bindingId}` — a single RoomSyncBinding
 *   `room-sync:index:{roomId}`     — list of binding IDs for a room
 *   `room-sync:all`                — list of all binding IDs (for startup enumeration)
 */

import type { EoDb } from '../db/level.js';
import { encode, decode } from '../db/level.js';
import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RoomSyncBinding {
  /** Unique ID for this binding. */
  binding_id: string;

  /** Logical room this binding serves (Matrix room ID or alias). */
  room_id: string;

  /** Label of the stored Airtable API key to use. */
  api_key_label: string;

  /** Base IDs to sync (empty = all accessible). */
  base_ids: string[];

  /** Table IDs to sync within each base (empty = all). */
  table_ids: string[];

  /** Seconds between incremental syncs. Minimum 30, default 120. */
  sync_interval_sec: number;

  /** If set, this Matrix user ID is always the primary syncer (sticky assignment). */
  preferred_syncer?: string;

  /** Admin who created this binding. */
  created_by: string;
  created_at: string;
  updated_at: string;

  /** Whether this binding is active (admin can pause/resume). */
  enabled: boolean;
}

export interface CreateBindingInput {
  room_id: string;
  api_key_label: string;
  base_ids?: string[];
  table_ids?: string[];
  sync_interval_sec?: number;
  preferred_syncer?: string;
  enabled?: boolean;
}

// ─── Storage keys ───────────────────────────────────────────────────────────

const CONFIG_PREFIX = 'room-sync:config:';
const INDEX_PREFIX = 'room-sync:index:';
const ALL_KEY = 'room-sync:all';

function configKey(bindingId: string): string {
  return `${CONFIG_PREFIX}${bindingId}`;
}

function indexKey(roomId: string): string {
  return `${INDEX_PREFIX}${roomId}`;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/** Create a new room sync binding. Returns the created binding. */
export async function createBinding(
  db: EoDb,
  input: CreateBindingInput,
  agent: string,
): Promise<RoomSyncBinding> {
  const interval = Math.max(30, input.sync_interval_sec ?? 120);

  const binding: RoomSyncBinding = {
    binding_id: randomUUID(),
    room_id: input.room_id,
    api_key_label: input.api_key_label,
    base_ids: input.base_ids ?? [],
    table_ids: input.table_ids ?? [],
    sync_interval_sec: interval,
    preferred_syncer: input.preferred_syncer,
    created_by: agent,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    enabled: input.enabled ?? true,
  };

  // Persist the binding
  await db.put(configKey(binding.binding_id), encode(binding));

  // Add to room index
  const roomBindings = await getBindingIdsForRoom(db, input.room_id);
  if (!roomBindings.includes(binding.binding_id)) {
    roomBindings.push(binding.binding_id);
    await db.put(indexKey(input.room_id), encode(roomBindings));
  }

  // Add to global index
  const allIds = await getAllBindingIds(db);
  if (!allIds.includes(binding.binding_id)) {
    allIds.push(binding.binding_id);
    await db.put(ALL_KEY, encode(allIds));
  }

  return binding;
}

/** Get a binding by ID. */
export async function getBinding(db: EoDb, bindingId: string): Promise<RoomSyncBinding | null> {
  try {
    const buf = await db.get(configKey(bindingId));
    return decode(buf) as RoomSyncBinding;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}

/** Update a binding (partial update). Returns updated binding or null if not found. */
export async function updateBinding(
  db: EoDb,
  bindingId: string,
  updates: Partial<Pick<RoomSyncBinding,
    'api_key_label' | 'base_ids' | 'table_ids' | 'sync_interval_sec' |
    'preferred_syncer' | 'enabled'
  >>,
): Promise<RoomSyncBinding | null> {
  const existing = await getBinding(db, bindingId);
  if (!existing) return null;

  if (updates.api_key_label !== undefined) existing.api_key_label = updates.api_key_label;
  if (updates.base_ids !== undefined) existing.base_ids = updates.base_ids;
  if (updates.table_ids !== undefined) existing.table_ids = updates.table_ids;
  if (updates.sync_interval_sec !== undefined) {
    existing.sync_interval_sec = Math.max(30, updates.sync_interval_sec);
  }
  if (updates.preferred_syncer !== undefined) existing.preferred_syncer = updates.preferred_syncer;
  if (updates.enabled !== undefined) existing.enabled = updates.enabled;
  existing.updated_at = new Date().toISOString();

  await db.put(configKey(bindingId), encode(existing));
  return existing;
}

/** Delete a binding. Returns true if it existed. */
export async function deleteBinding(db: EoDb, bindingId: string): Promise<boolean> {
  const existing = await getBinding(db, bindingId);
  if (!existing) return false;

  // Remove from storage
  await db.del(configKey(bindingId));

  // Remove from room index
  const roomBindings = await getBindingIdsForRoom(db, existing.room_id);
  const filtered = roomBindings.filter(id => id !== bindingId);
  if (filtered.length > 0) {
    await db.put(indexKey(existing.room_id), encode(filtered));
  } else {
    try { await db.del(indexKey(existing.room_id)); } catch { /* ignore */ }
  }

  // Remove from global index
  const allIds = await getAllBindingIds(db);
  const filteredAll = allIds.filter(id => id !== bindingId);
  await db.put(ALL_KEY, encode(filteredAll));

  return true;
}

// ─── Queries ────────────────────────────────────────────────────────────────

/** Get all binding IDs for a room. */
async function getBindingIdsForRoom(db: EoDb, roomId: string): Promise<string[]> {
  try {
    const buf = await db.get(indexKey(roomId));
    return decode(buf) as string[];
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return [];
    throw e;
  }
}

/** Get all binding IDs across all rooms. */
export async function getAllBindingIds(db: EoDb): Promise<string[]> {
  try {
    const buf = await db.get(ALL_KEY);
    return decode(buf) as string[];
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return [];
    throw e;
  }
}

/** Get all bindings for a room. */
export async function getBindingsForRoom(db: EoDb, roomId: string): Promise<RoomSyncBinding[]> {
  const ids = await getBindingIdsForRoom(db, roomId);
  const bindings: RoomSyncBinding[] = [];
  for (const id of ids) {
    const b = await getBinding(db, id);
    if (b) bindings.push(b);
  }
  return bindings;
}

/** Get all bindings (for coordinator startup). */
export async function getAllBindings(db: EoDb): Promise<RoomSyncBinding[]> {
  const ids = await getAllBindingIds(db);
  const bindings: RoomSyncBinding[] = [];
  for (const id of ids) {
    const b = await getBinding(db, id);
    if (b) bindings.push(b);
  }
  return bindings;
}
