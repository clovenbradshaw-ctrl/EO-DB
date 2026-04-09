/**
 * Yjs persistence — local IndexedDB cache.
 *
 * The Yjs binary state is stored directly in IndexedDB (via EoStore) as a
 * key-value blob under `yjs:{target}:{fieldKey}`. No DEF, no fold, no
 * Matrix timeline event. The CRDT state is its own world — the fold is
 * for structured record-level transformations.
 *
 * Debounced auto-save writes to IndexedDB on change.
 * Explicit save (blur) also writes to IndexedDB.
 */

import * as Y from 'yjs';
import type { EoStore } from '../db/encrypted-store';

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
// Save to IndexedDB (local only)
// --------------------------------------------------------------------------

/**
 * Save the current Yjs document state to IndexedDB.
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
// Combined save (kept for API compatibility)
// --------------------------------------------------------------------------

/**
 * Save to IndexedDB. Returns true on success.
 * The spaceId and userId parameters are kept for API compatibility.
 */
export async function saveYjsDocFull(
  doc: Y.Doc,
  store: EoStore,
  target: string,
  fieldKey: string,
  _spaceId: string,
  _userId: string,
): Promise<boolean> {
  try {
    await saveYjsDocLocal(doc, store, target, fieldKey);
    return true;
  } catch (err) {
    console.warn('[EO-DB] Local save failed for Yjs doc:', err);
    return false;
  }
}

// --------------------------------------------------------------------------
// Debounced local save
// --------------------------------------------------------------------------

/**
 * Create a debounced save that writes to IndexedDB.
 * The spaceId and userId parameters are kept for API compatibility.
 */
export function createDebouncedSave(
  doc: Y.Doc,
  store: EoStore,
  target: string,
  fieldKey: string,
  _spaceId: string,
  _userId: string,
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
    return saveYjsDocFull(doc, store, target, fieldKey, _spaceId, _userId);
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
