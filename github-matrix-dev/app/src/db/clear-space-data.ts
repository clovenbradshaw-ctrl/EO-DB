/**
 * Wipe every local-only artifact for a single space.
 *
 * Called when the user leaves a space (switch, permanent-delete) so the
 * space's cached state does not leak back into future sessions. This is a
 * *genuine reset* — the next time the space is entered, it starts from a
 * fresh sync with Matrix.
 *
 * Best-effort: individual failures are swallowed so a stuck OPFS handle or
 * a corrupt localStorage entry cannot strand the user mid-switch.
 *
 * NOT cleared (intentionally global):
 *   - eo-selected-space (the caller reassigns this next)
 *   - Matrix session / device keys
 */

import { removeSpaceMeta } from './space-meta';
import { useSliceStore } from '../store/slice-store';

export async function clearSpaceLocalData(spaceId: string): Promise<void> {
  // 1. Slice-store: drop in-memory SIGs + persisted open/pinned scopes +
  //    saved slices whose scope is rooted in this space. The action is
  //    responsible for mirroring its changes to localStorage.
  try {
    useSliceStore.getState().clearSpaceScopes(spaceId);
  } catch (e) {
    console.warn('[clear-space-data] clearSpaceScopes failed:', e);
  }

  // 2. Space metadata entry
  try {
    removeSpaceMeta(spaceId);
  } catch (e) {
    console.warn('[clear-space-data] removeSpaceMeta failed:', e);
  }

  // 3. OPFS subdirectory — holds the full log, snapshot, and KV state
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(`space.${spaceId}`, { recursive: true });
  } catch (e) {
    // Missing entry is fine; other errors get logged for visibility
    if ((e as DOMException)?.name !== 'NotFoundError') {
      console.warn('[clear-space-data] OPFS removeEntry failed:', e);
    }
  }
}
