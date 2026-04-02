/**
 * Space discovery — scans Matrix rooms to find EO-DB spaces.
 *
 * There is no central space registry. The rooms themselves are the registry.
 * Any device that has joined the same rooms will discover the same spaces,
 * because Matrix replicates room state to all members.
 *
 * A new device logs in, the Matrix client syncs, and client.getRooms()
 * returns all joined rooms — including their current state events.
 * discoverSpacesFromMatrix() scans those rooms and finds every space
 * the user belongs to.
 */

import type { IMatrixClient } from './types.js';
import type { SpaceEntry, SpaceConfig } from './types.js';
import { EO_SPACE_CONFIG_TYPE } from './event-bridge.js';

/**
 * Extract a display name from a Matrix user ID.
 * "@alice:matrix.org" → "Alice"
 */
function userIdToName(userId: string): string {
  if (!userId) return 'Unknown';
  const local = userId.startsWith('@') ? userId.slice(1).split(':')[0] : userId;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/**
 * Discover EO-DB spaces from the user's joined Matrix rooms.
 *
 * Algorithm:
 * 1. For each room in client.getRooms():
 *    - Check for com.eo-db.space.config state event
 *    - If no config or missing name/rooms.main, skip
 * 2. Extract metadata: spaceTarget, creation time, owner, member count, last activity
 * 3. Deduplicate by spaceTarget (first match wins)
 * 4. Return sorted by lastActivity descending
 */
export function discoverSpacesFromMatrix(client: IMatrixClient): SpaceEntry[] {
  const rooms = client.getRooms();
  const spaceMap = new Map<string, SpaceEntry>();

  for (const room of rooms) {
    const state = room.currentState;

    const configEvent = state.getStateEvents(EO_SPACE_CONFIG_TYPE, '');
    if (!configEvent) continue;

    const config = configEvent.getContent() as SpaceConfig;
    if (!config?.name || !config?.rooms?.main) continue;

    const spaceTarget = `space_${config.name.toLowerCase().replace(/\s+/g, '_')}`;

    // Deduplicate by spaceTarget (first match wins)
    if (spaceMap.has(spaceTarget)) continue;

    // Creation time from m.room.create
    const createEvent = state.getStateEvents('m.room.create', '');
    const createdAt = createEvent ? createEvent.getTs() : 0;

    // Owner: first user with PL >= 100, or room creator
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

    const members = room.getJoinedMembers();

    spaceMap.set(spaceTarget, {
      spaceTarget,
      displayName: config.name,
      mainRoomId: config.rooms.main,
      createdAt,
      lastActivity,
      ownerUserId,
      ownerDisplayName: userIdToName(ownerUserId),
      memberCount: members.length,
    });
  }

  return Array.from(spaceMap.values()).sort((a, b) => b.lastActivity - a.lastActivity);
}
