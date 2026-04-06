/**
 * Yjs persistence bridge — load/save Yjs document state from/to EO DEF operands.
 *
 * The Yjs binary state is base64-encoded and stored as a DEF operand with
 * `_yjs: true`. The fold treats it as a normal shallow merge. On load, the
 * base64 is decoded and applied to the Yjs document.
 *
 * Debounced save ensures the document is persisted after editing pauses,
 * not on every keystroke.
 */

import * as Y from 'yjs';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput } from '../db/types';
import { getState } from '../db/state';
import type { YjsDefOperand } from './types';

// --------------------------------------------------------------------------
// Encode / decode helpers
// --------------------------------------------------------------------------

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// --------------------------------------------------------------------------
// Load
// --------------------------------------------------------------------------

/**
 * Load a Yjs document from the EO store's DEF state.
 *
 * If the target has a `_yjs` operand, the base64 state is decoded and applied.
 * If no state exists, returns an empty doc (fresh document).
 */
export async function loadYjsDoc(
  store: EoStore,
  target: string,
  fieldKey: string,
): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const state = await getState(store, target);

  if (state?.value) {
    const fieldValue = state.value[fieldKey];
    if (fieldValue && fieldValue._yjs && fieldValue.state) {
      const update = base64ToUint8(fieldValue.state);
      Y.applyUpdate(doc, update);
    }
  }

  return doc;
}

// --------------------------------------------------------------------------
// Save
// --------------------------------------------------------------------------

/**
 * Build a DEF operand containing the full Yjs document state.
 */
export function buildYjsDefOperand(doc: Y.Doc): YjsDefOperand {
  const state = Y.encodeStateAsUpdate(doc);
  return {
    _yjs: true,
    state: uint8ToBase64(state),
    version: 1,
  };
}

/**
 * Save the current Yjs document state as a DEF event.
 *
 * @param doc - The Yjs document to snapshot
 * @param target - EO target path (e.g. `at.appXYZ.tblABC.rec001`)
 * @param fieldKey - Field key (e.g. `fldBody`)
 * @param dispatch - The eo-store dispatch function
 */
export async function saveYjsDoc(
  doc: Y.Doc,
  target: string,
  fieldKey: string,
  dispatch: (event: EoEventInput) => Promise<number>,
): Promise<void> {
  const operand: Record<string, any> = {};
  operand[fieldKey] = buildYjsDefOperand(doc);
  const now = new Date().toISOString();

  await dispatch({
    op: 'DEF',
    target,
    operand,
    agent: 'system',
    ts: now,
    acquired_ts: now,
  });
}

// --------------------------------------------------------------------------
// Debounced save
// --------------------------------------------------------------------------

/**
 * Create a debounced save function that persists the Yjs doc after a pause.
 * Returns a cleanup function that flushes any pending save and clears the timer.
 */
export function createDebouncedSave(
  doc: Y.Doc,
  target: string,
  fieldKey: string,
  dispatch: (event: EoEventInput) => Promise<number>,
  delayMs = 2000,
): { trigger: () => void; flush: () => Promise<void>; cleanup: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      pending = false;
      await saveYjsDoc(doc, target, fieldKey, dispatch);
    }
  };

  const trigger = () => {
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delayMs);
  };

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // Fire-and-forget final save
    if (pending) {
      pending = false;
      saveYjsDoc(doc, target, fieldKey, dispatch).catch(() => {});
    }
  };

  return { trigger, flush, cleanup };
}
