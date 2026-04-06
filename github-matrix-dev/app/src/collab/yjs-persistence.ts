/**
 * Yjs persistence — local IndexedDB cache + Filen remote backup.
 *
 * The Yjs binary state is stored directly in IndexedDB (via EoStore) as a
 * key-value blob under `yjs:{target}:{fieldKey}`. No DEF, no fold, no
 * Matrix timeline event. The CRDT state is its own world — the fold is
 * for structured record-level transformations.
 *
 * On click-out (blur), the state is flushed to local storage and uploaded
 * to Filen. The Filen upload is the durable persistence event — the toast
 * confirms that.
 *
 * Debounced auto-save writes to IndexedDB only (fast, silent).
 * Explicit save (blur) writes to IndexedDB + Filen (shows toast).
 */

import * as Y from 'yjs';
import type { EoStore } from '../db/encrypted-store';
import { useFilenStore } from '../filen/filen-store';
import { filenUploadFile } from '../filen/filen-api';
import { packEodb, type EodbFile } from '../filen/eodb-format';

// --------------------------------------------------------------------------
// IndexedDB key format
// --------------------------------------------------------------------------

function yjsKey(target: string, fieldKey: string): string {
  return `yjs:${target}:${fieldKey}`;
}

// --------------------------------------------------------------------------
// Load
// --------------------------------------------------------------------------

/**
 * Load a Yjs document from IndexedDB.
 *
 * If state exists, it's applied as a Yjs update. Otherwise returns an empty doc.
 */
export async function loadYjsDoc(
  store: EoStore,
  target: string,
  fieldKey: string,
): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const saved = await store.get(yjsKey(target, fieldKey));

  if (saved && saved instanceof Uint8Array) {
    Y.applyUpdate(doc, saved);
  } else if (saved && saved.state) {
    // Legacy format: { _yjs: true, state: base64 }
    const binary = atob(saved.state);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    Y.applyUpdate(doc, bytes);
  }

  return doc;
}

// --------------------------------------------------------------------------
// Save to IndexedDB (local only, fast, silent)
// --------------------------------------------------------------------------

/**
 * Save the current Yjs document state to IndexedDB.
 * This is the fast local-only path — no network, no toast.
 */
export async function saveYjsDocLocal(
  doc: Y.Doc,
  store: EoStore,
  target: string,
  fieldKey: string,
): Promise<void> {
  const state = Y.encodeStateAsUpdate(doc);
  await store.put(yjsKey(target, fieldKey), state);
}

// --------------------------------------------------------------------------
// Save to Filen (remote, durable)
// --------------------------------------------------------------------------

/**
 * Upload the Yjs document state to Filen as an .eodb file.
 * Returns true if the upload succeeded, false if Filen is not connected.
 */
export async function saveYjsDocToFilen(
  doc: Y.Doc,
  target: string,
  fieldKey: string,
  spaceId: string,
  userId: string,
): Promise<boolean> {
  const { auth, masterKeys, spaceFolders } = useFilenStore.getState();
  if (!auth) return false;

  const spaceFolderUuid = spaceFolders[spaceId];
  if (!spaceFolderUuid) return false;

  const state = Y.encodeStateAsUpdate(doc);
  const filename = `yjs-${target}-${fieldKey}-${Date.now()}.bin`;

  await filenUploadFile(
    auth.apiKey,
    spaceFolderUuid,
    filename,
    state,
    masterKeys[0],
  );

  return true;
}

// --------------------------------------------------------------------------
// Combined save (local + Filen)
// --------------------------------------------------------------------------

/**
 * Save to IndexedDB and upload to Filen.
 * Returns true if the Filen upload succeeded.
 */
export async function saveYjsDocFull(
  doc: Y.Doc,
  store: EoStore,
  target: string,
  fieldKey: string,
  spaceId: string,
  userId: string,
): Promise<boolean> {
  // Always save locally first
  await saveYjsDocLocal(doc, store, target, fieldKey);

  // Then try Filen
  try {
    return await saveYjsDocToFilen(doc, target, fieldKey, spaceId, userId);
  } catch (err) {
    console.warn('[EO-DB] Filen upload failed for Yjs doc:', err);
    return false;
  }
}

// --------------------------------------------------------------------------
// Debounced local save
// --------------------------------------------------------------------------

/**
 * Create a debounced save that writes to IndexedDB only (fast, silent).
 * The explicit `flush()` does IndexedDB + Filen and returns whether Filen succeeded.
 */
export function createDebouncedSave(
  doc: Y.Doc,
  store: EoStore,
  target: string,
  fieldKey: string,
  spaceId: string,
  userId: string,
  delayMs = 5000,
): { trigger: () => void; flush: () => Promise<boolean>; cleanup: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  const autoSave = async () => {
    if (dirty) {
      dirty = false;
      await saveYjsDocLocal(doc, store, target, fieldKey);
    }
  };

  const flush = async (): Promise<boolean> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return false; // nothing changed since last save
    dirty = false;
    return saveYjsDocFull(doc, store, target, fieldKey, spaceId, userId);
  };

  const trigger = () => {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      autoSave();
    }, delayMs);
  };

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (dirty) {
      dirty = false;
      saveYjsDocLocal(doc, store, target, fieldKey).catch(() => {});
    }
  };

  return { trigger, flush, cleanup };
}
