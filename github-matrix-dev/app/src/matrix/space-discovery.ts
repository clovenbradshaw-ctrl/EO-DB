/**
 * Space discovery — scans Matrix rooms to find EO-DB spaces.
 *
 * Each space is represented by a governance room containing the
 * `com.eo-db.space.config` state event. This module enumerates the
 * user's joined rooms, identifies spaces, and extracts metadata
 * (creation date, last activity, owner, member count) for display
 * in the space browser.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import { EO_SPACE_CONFIG_TYPE } from './event-bridge';
import type { SpaceConfig } from '../permissions/types';
import {
  addArchivedSpace,
  removeArchivedSpace,
  getArchivedSpaces,
} from '../components/ArchivedSpaces';
import {
  addDeletedSpace,
  removeDeletedSpace,
  getDeletedSpaces,
} from '../components/RecycleBin';

export interface SpaceEntry {
  /** Internal space target, e.g. "space_amino" */
  spaceTarget: string;
  /** Human-readable name */
  displayName: string;
  /** The main Matrix room ID for this space */
  mainRoomId: string;
  /** Room creation timestamp (ms since epoch) */
  createdAt: number;
  /** Most recent activity timestamp (ms since epoch) */
  lastActivity: number;
  /** Owner's Matrix user ID */
  ownerUserId: string;
  /** Owner's display name (extracted from user ID if unavailable) */
  ownerDisplayName: string;
  /** Number of joined members */
  memberCount: number;
  /** Whether the current user is joined to this space (false for discovered public spaces). */
  joined?: boolean;
  /** Lifecycle status from SpaceConfig. Defaults to 'active'. */
  status?: 'active' | 'archived' | 'deleted';
  /** Epoch ms when status was last changed. */
  statusChangedAt?: number;
  /** Matrix user ID who changed the status. */
  statusChangedBy?: string;
}

/**
 * Extract a display name from a Matrix user ID.
 * "@alice:matrix.org" → "alice"
 */
function userIdToName(userId: string): string {
  if (!userId) return 'Unknown';
  const local = userId.startsWith('@') ? userId.slice(1).split(':')[0] : userId;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/**
 * Discover EO-DB spaces from the user's joined Matrix rooms.
 *
 * Scans all rooms for the `com.eo-db.space.config` state event,
 * extracts metadata, and returns one SpaceEntry per unique space.
 */
export function discoverSpacesFromMatrix(client: MatrixClient): SpaceEntry[] {
  const rooms = client.getRooms();
  const spaceMap = new Map<string, SpaceEntry>();

  for (const room of rooms) {
    const state = room.currentState;

    // Check for EO-DB space config state event
    const configEvent = state.getStateEvents(EO_SPACE_CONFIG_TYPE, '');
    if (!configEvent) continue;

    const config = configEvent.getContent() as SpaceConfig;
    if (!config?.name || !config?.rooms?.main) continue;

    const spaceTarget = `space_${config.name.toLowerCase().replace(/\s+/g, '_')}`;

    // Deduplicate: when multiple rooms claim the same space, keep the one
    // with the lexicographically smallest mainRoomId so ALL clients converge
    // on the same room regardless of getRooms() iteration order.
    const existing = spaceMap.get(spaceTarget);
    if (existing && existing.mainRoomId <= config.rooms.main) continue;

    // Creation time from m.room.create
    const createEvent = state.getStateEvents('m.room.create', '');
    const createdAt = createEvent
      ? (createEvent as any).getTs?.() || createEvent.getContent()?.origin_server_ts || 0
      : 0;

    // Owner from power levels (user with PL 100) or room creator
    let ownerUserId = '';
    const plEvent = state.getStateEvents('m.room.power_levels', '');
    if (plEvent) {
      const users = plEvent.getContent()?.users || {};
      for (const [uid, level] of Object.entries(users)) {
        if ((level as number) >= 100) {
          ownerUserId = uid;
          break;
        }
      }
    }
    if (!ownerUserId && createEvent) {
      ownerUserId = createEvent.getContent()?.creator || createEvent.getSender?.() || '';
    }

    // Last activity from latest timeline event
    const timeline = room.getLiveTimeline().getEvents();
    const lastEvent = timeline.length > 0 ? timeline[timeline.length - 1] : null;
    const lastActivity = lastEvent ? lastEvent.getTs() : createdAt;

    // Member count
    const members = room.getJoinedMembers();
    const memberCount = members.length;

    spaceMap.set(spaceTarget, {
      spaceTarget,
      displayName: config.name,
      mainRoomId: config.rooms.main,
      createdAt,
      lastActivity,
      ownerUserId,
      ownerDisplayName: userIdToName(ownerUserId),
      memberCount,
      joined: true,
      status: config.status ?? 'active',
      statusChangedAt: config.status_changed_at,
      statusChangedBy: config.status_changed_by,
    });
  }

  // Reconcile localStorage caches with Matrix state (source of truth)
  reconcileLocalStorageFromMatrix(Array.from(spaceMap.values()));

  // Sort by last activity (most recent first)
  return Array.from(spaceMap.values()).sort((a, b) => b.lastActivity - a.lastActivity);
}

/**
 * Reconcile localStorage archive/delete caches with Matrix state.
 * Matrix is the source of truth; localStorage is a synchronous read cache.
 */
function reconcileLocalStorageFromMatrix(entries: SpaceEntry[]): void {
  const archivedLocal = new Set(getArchivedSpaces().map((s) => s.target));
  const deletedLocal = new Set(getDeletedSpaces().map((s) => s.target));

  for (const entry of entries) {
    const status = entry.status ?? 'active';

    if (status === 'archived') {
      if (!archivedLocal.has(entry.spaceTarget)) {
        addArchivedSpace({
          target: entry.spaceTarget,
          name: entry.displayName,
          archivedAt: entry.statusChangedAt ?? Date.now(),
          archivedBy: entry.statusChangedBy ?? '',
          memberCount: entry.memberCount,
        });
      }
      // Ensure it's not in the deleted cache
      if (deletedLocal.has(entry.spaceTarget)) {
        removeDeletedSpace(entry.spaceTarget);
      }
    } else if (status === 'deleted') {
      if (!deletedLocal.has(entry.spaceTarget)) {
        addDeletedSpace({
          target: entry.spaceTarget,
          name: entry.displayName,
          deletedAt: entry.statusChangedAt ?? Date.now(),
          deletedBy: entry.statusChangedBy ?? '',
          memberCount: entry.memberCount,
        });
      }
      // Ensure it's not in the archived cache
      if (archivedLocal.has(entry.spaceTarget)) {
        removeArchivedSpace(entry.spaceTarget);
      }
    } else {
      // status === 'active': clear from both caches if present
      if (archivedLocal.has(entry.spaceTarget)) {
        removeArchivedSpace(entry.spaceTarget);
      }
      if (deletedLocal.has(entry.spaceTarget)) {
        removeDeletedSpace(entry.spaceTarget);
      }
    }
  }
}

/**
 * Discover EO-DB spaces from the homeserver's public room directory.
 *
 * Queries `client.publicRooms()` and attempts to read the EO-DB space config
 * state event for each. Rooms without a valid EO-DB space config (or not
 * peekable) are skipped. Returns entries for spaces the user has NOT joined.
 */
export async function discoverPublicSpaces(client: MatrixClient): Promise<SpaceEntry[]> {
  const myUserId = client.getUserId();
  const joinedRoomIds = new Set<string>(
    client.getRooms()
      .filter((r) => {
        const m = r.getMyMembership?.();
        return m === 'join' || m === 'invite';
      })
      .map((r) => r.roomId),
  );

  let response: any;
  try {
    response = await (client as any).publicRooms({ limit: 200 });
  } catch (e: any) {
    console.warn('[EO-DB] discoverPublicSpaces: publicRooms failed:', e.message || e);
    return [];
  }

  const chunk: any[] = response?.chunk ?? [];
  const out: SpaceEntry[] = [];

  for (const room of chunk) {
    const roomId = room.room_id;
    if (!roomId || joinedRoomIds.has(roomId)) continue;

    // Try to peek at the space config state event
    let config: SpaceConfig | null = null;
    try {
      config = (await (client as any).getStateEvent(roomId, EO_SPACE_CONFIG_TYPE, '')) as SpaceConfig;
    } catch {
      continue; // not peekable or not an EO-DB space
    }
    if (!config?.name || !config?.rooms?.main) continue;
    if (config.status === 'archived' || config.status === 'deleted') continue;

    const spaceTarget = `space_${config.name.toLowerCase().replace(/\s+/g, '_')}`;

    out.push({
      spaceTarget,
      displayName: config.name,
      mainRoomId: config.rooms.main,
      createdAt: 0,
      lastActivity: 0,
      ownerUserId: '',
      ownerDisplayName: room.canonical_alias || userIdToName(myUserId || ''),
      memberCount: room.num_joined_members || 0,
      joined: false,
    });
  }

  return out;
}
