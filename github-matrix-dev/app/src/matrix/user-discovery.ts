/**
 * User discovery — search the Matrix user directory to find users
 * who can be invited to EO-DB spaces.
 *
 * Uses the Matrix user directory search API which returns users
 * visible to the caller (same homeserver, shared rooms, or public
 * profiles depending on server configuration).
 */

import type { MatrixClient } from 'matrix-js-sdk';

export interface DiscoveredUser {
  /** Fully qualified Matrix user ID, e.g. "@alice:matrix.org" */
  userId: string;
  /** Display name (may be undefined) */
  displayName: string;
  /** Avatar MXC URL (may be undefined) */
  avatarUrl?: string;
}

/**
 * Search the Matrix user directory for users matching a query string.
 *
 * The homeserver returns users based on its directory configuration:
 * - Users on the same homeserver
 * - Users in shared rooms
 * - Users with public profiles (federation-dependent)
 *
 * @param client - Authenticated Matrix client
 * @param query  - Search term (username or display name fragment)
 * @param limit  - Maximum results to return (default 20)
 * @returns Array of discovered users, excluding the calling user
 */
export async function searchUsers(
  client: MatrixClient,
  query: string,
  limit = 20,
): Promise<DiscoveredUser[]> {
  if (!query || query.trim().length < 1) return [];

  try {
    const response = await client.searchUserDirectory({ term: query.trim(), limit });
    const results: DiscoveredUser[] = (response.results ?? []).map((r: any) => ({
      userId: r.user_id,
      displayName: r.display_name || extractLocalpart(r.user_id),
      avatarUrl: r.avatar_url || undefined,
    }));

    // Exclude the calling user from results
    const myUserId = client.getUserId();
    return results.filter((u) => u.userId !== myUserId);
  } catch (e: any) {
    // Some homeservers may not support user directory search or may
    // rate-limit aggressively — degrade gracefully.
    console.warn('[EO-DB] User directory search failed:', e.message || e);
    return [];
  }
}

/**
 * List homeserver users discoverable to the calling user.
 *
 * Tries two strategies in order:
 *   1. Empty-term directory search (`searchUserDirectory({ term: '' })`) —
 *      Synapse returns its top users list in this mode.
 *   2. Fallback: walk all joined rooms and collect unique joined members.
 *
 * Both results are merged (directory first, room members appended), deduped,
 * and the calling user is filtered out. Returns up to `limit` users.
 */
export async function listAllHomeserverUsers(
  client: MatrixClient,
  limit = 100,
): Promise<DiscoveredUser[]> {
  const myUserId = client.getUserId();
  const seen = new Set<string>();
  const out: DiscoveredUser[] = [];

  // Strategy 1: empty-term directory search
  try {
    const response = await client.searchUserDirectory({ term: '', limit });
    for (const r of (response.results ?? []) as any[]) {
      if (!r.user_id || r.user_id === myUserId || seen.has(r.user_id)) continue;
      seen.add(r.user_id);
      out.push({
        userId: r.user_id,
        displayName: r.display_name || extractLocalpart(r.user_id),
        avatarUrl: r.avatar_url || undefined,
      });
    }
  } catch (e: any) {
    console.warn('[EO-DB] listAllHomeserverUsers: directory search failed:', e.message || e);
  }

  // Strategy 2: walk joined rooms for known members
  if (out.length < limit) {
    try {
      const rooms = client.getRooms();
      for (const room of rooms) {
        const members = room.getJoinedMembers();
        for (const m of members) {
          if (!m.userId || m.userId === myUserId || seen.has(m.userId)) continue;
          seen.add(m.userId);
          out.push({
            userId: m.userId,
            displayName: m.name || extractLocalpart(m.userId),
            avatarUrl: (m as any).getMxcAvatarUrl?.() || undefined,
          });
          if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
      }
    } catch (e: any) {
      console.warn('[EO-DB] listAllHomeserverUsers: room member walk failed:', e.message || e);
    }
  }

  return out;
}

/**
 * Resolve a single Matrix user ID to a profile (display name + avatar).
 * Useful for showing profile info when the user types a full Matrix ID.
 */
export async function resolveUserProfile(
  client: MatrixClient,
  userId: string,
): Promise<DiscoveredUser | null> {
  try {
    const profile = await client.getProfileInfo(userId);
    return {
      userId,
      displayName: (profile as any).displayname || extractLocalpart(userId),
      avatarUrl: (profile as any).avatar_url || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Get the list of joined members for a specific room.
 * Returns their user IDs for filtering out existing members from search results.
 */
export function getRoomMemberIds(client: MatrixClient, roomId: string): string[] {
  const room = client.getRoom(roomId);
  if (!room) return [];
  return room.getJoinedMembers().map((m) => m.userId);
}

/** Extract localpart from a Matrix user ID: "@alice:matrix.org" -> "alice" */
function extractLocalpart(userId: string): string {
  if (!userId) return 'Unknown';
  const local = userId.startsWith('@') ? userId.slice(1).split(':')[0] : userId;
  return local.charAt(0).toUpperCase() + local.slice(1);
}
