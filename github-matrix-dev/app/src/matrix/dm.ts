/**
 * Direct message helper — find or create a 1:1 Matrix room with another user.
 *
 * Uses the `m.direct` account data map to track DM rooms, consistent with
 * how Element and other Matrix clients coordinate DMs.
 */

import type { MatrixClient } from 'matrix-js-sdk';

/** Shape of the `m.direct` account-data map: { userId: [roomId, ...] } */
type DirectMap = Record<string, string[]>;

/**
 * Find an existing DM room with `otherUserId`, or create one.
 *
 * Returns the Matrix room ID. On failure to create, throws.
 */
export async function findOrCreateDirectMessage(
  client: MatrixClient,
  otherUserId: string,
): Promise<string> {
  // 1. Read existing m.direct map
  let directMap: DirectMap = {};
  try {
    const ev = client.getAccountData('m.direct');
    if (ev) directMap = (ev.getContent() as DirectMap) ?? {};
  } catch {
    // no existing map — treat as empty
  }

  // 2. Check for a joined room with that user
  const existing = directMap[otherUserId] ?? [];
  for (const roomId of existing) {
    const room = client.getRoom(roomId);
    if (!room) continue;
    const myMembership = room.getMyMembership();
    if (myMembership === 'join') {
      return roomId;
    }
  }

  // 3. Create a new 1:1 room with E2EE enabled from the start.
  //    trusted_private_chat sets member power levels so the invitee is promoted,
  //    and the initial_state below flips on megolm encryption at room creation.
  const result = await client.createRoom({
    is_direct: true,
    preset: 'trusted_private_chat' as any,
    invite: [otherUserId],
    visibility: 'private' as any,
    initial_state: [
      {
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      },
    ],
  });
  const roomId = result.room_id;

  // 4. Update m.direct account data
  const updated: DirectMap = { ...directMap };
  const prior = updated[otherUserId] ?? [];
  updated[otherUserId] = [...prior, roomId];
  try {
    await client.setAccountData('m.direct', updated);
  } catch (e) {
    console.warn('[EO-DB] failed to update m.direct account data', e);
  }

  return roomId;
}
