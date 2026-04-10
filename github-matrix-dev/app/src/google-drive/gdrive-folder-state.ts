/**
 * Matrix room state helpers for the Google Drive folder ID.
 *
 * The shared Drive folder ID for each space is stored as a Matrix state event
 * so that all space members can discover it without any additional coordination.
 *
 * Event type:  eo.gdrive.folder
 * State key:   '' (one per room)
 * Content:     { folder_id: string, space_id: string, created_at: string }
 *
 * Because the room already has m.room.encryption, this state event is
 * protected by Megolm E2EE — only room members can read it.
 */

import type { MatrixClient } from 'matrix-js-sdk';

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export const EO_GDRIVE_FOLDER_TYPE = 'eo.gdrive.folder';

interface FolderStateContent {
  folder_id: string;
  space_id: string;
  created_at: string;
}

// ──────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────

/**
 * Write the shared Drive folder ID to Matrix room state.
 * Should only be called by the space creator when setting up a new space folder.
 * All other members will read this value via readFolderState().
 */
export async function publishFolderState(
  client: MatrixClient,
  roomId: string,
  spaceId: string,
  folderId: string,
): Promise<void> {
  const content: FolderStateContent = {
    folder_id: folderId,
    space_id: spaceId,
    created_at: new Date().toISOString(),
  };
  await (client as any).sendStateEvent(roomId, EO_GDRIVE_FOLDER_TYPE, content, '');
  console.log('[EO-DB] Published Drive folder ID to Matrix room state:', folderId, 'room:', roomId);
}

/**
 * Read the shared Drive folder ID from Matrix room state.
 * Returns null if the state event has not been published yet (space creator
 * hasn't set up the folder, or the room has not yet synced this event).
 */
export function readFolderState(
  client: MatrixClient,
  roomId: string,
): string | null {
  try {
    const room = client.getRoom(roomId);
    if (!room) return null;
    const event = room.currentState.getStateEvents(EO_GDRIVE_FOLDER_TYPE, '');
    if (!event) return null;
    const content = (event as any).getContent?.() as FolderStateContent | undefined;
    return content?.folder_id ?? null;
  } catch (e) {
    console.warn('[EO-DB] Could not read Drive folder state:', e);
    return null;
  }
}
