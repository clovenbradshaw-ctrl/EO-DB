/**
 * React hook for collaborative editing via Yjs + Matrix.
 *
 * Creates and manages a Y.Doc, YjsMatrixProvider, TipTap editor,
 * and debounced persistence. Cleans up on unmount.
 *
 * Persistence flow:
 * - Debounced auto-save writes to IndexedDB only (silent, fast)
 * - Explicit saveNow() (on blur/click-out) writes to IndexedDB + Filen
 *   and returns whether the Filen upload succeeded (for toast)
 */

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import * as Y from 'yjs';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import type { MatrixClient } from 'matrix-js-sdk';
import { YjsMatrixProvider } from '../collab/yjs-matrix-provider';
import { loadYjsDoc, createDebouncedSave } from '../collab/yjs-persistence';
import { colorForUser } from '../collab/awareness-colors';
import type { CollabTransport } from '../collab/types';
import { useEoStore } from '../store/eo-store';

export interface UseCollabEditorOpts {
  /** EO target path, e.g. `at.appXYZ.tblABC.rec001` */
  target: string;
  /** Field key within the target, e.g. `fldBody` */
  fieldKey: string;
  /** Matrix client (null if not connected or in local mode) */
  matrixClient: MatrixClient | null;
  /** Matrix room ID for sync */
  roomId: string | null;
  /** Space ID for Filen folder resolution */
  spaceId: string;
  /** Current user ID */
  userId: string;
  /** Whether the editor should be editable */
  editable?: boolean;
}

export interface CollabEditorState {
  /** Current transport type */
  transport: CollabTransport;
  /** Number of connected peers */
  peerCount: number;
  /** Whether the doc has been loaded from persistence */
  loaded: boolean;
}

export function useCollabEditor({
  target,
  fieldKey,
  matrixClient,
  roomId,
  spaceId,
  userId,
  editable = true,
}: UseCollabEditorOpts) {
  const store = useEoStore((s) => s.store);
  const [state, setState] = useState<CollabEditorState>({
    transport: 'offline',
    peerCount: 0,
    loaded: false,
  });

  const docRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<YjsMatrixProvider | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const flushRef = useRef<(() => Promise<boolean>) | null>(null);

  // Stable document ID for the provider
  const documentId = useMemo(() => `${target}.${fieldKey}`, [target, fieldKey]);

  // Create Y.Doc and load persisted state
  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (!store) return;

      const doc = await loadYjsDoc(store, target, fieldKey);
      if (cancelled) {
        doc.destroy();
        return;
      }

      docRef.current = doc;

      // Set up debounced persistence (IndexedDB auto-save + Filen on flush)
      const { trigger, flush, cleanup } = createDebouncedSave(
        doc, store, target, fieldKey, spaceId, userId,
      );
      cleanupRef.current = cleanup;
      flushRef.current = flush;

      // Listen for local changes to trigger auto-save — remote updates don't
      // need a save from this device (the originating device saves its own)
      const onUpdate = (_update: Uint8Array, origin: any) => {
        if (origin === providerRef.current) return; // remote update — skip
        trigger();
      };
      doc.on('update', onUpdate);

      // Connect to Matrix if available
      if (matrixClient && roomId) {
        const provider = new YjsMatrixProvider(matrixClient, roomId, documentId, doc);
        providerRef.current = provider;

        provider.on('transport', (args: any[]) => {
          const t = args[0] as CollabTransport;
          setState((s) => ({ ...s, transport: t }));
        });

        provider.on('status', () => {
          setState((s) => ({
            ...s,
            peerCount: provider.peerCount,
          }));
        });

        await provider.connect();
      }

      if (!cancelled) {
        setState((s) => ({ ...s, loaded: true }));
      }
    }

    init();

    return () => {
      cancelled = true;
      providerRef.current?.destroy();
      providerRef.current = null;
      cleanupRef.current?.();
      cleanupRef.current = null;
      flushRef.current = null;
      docRef.current?.destroy();
      docRef.current = null;
      setState({ transport: 'offline', peerCount: 0, loaded: false });
    };
  }, [store, target, fieldKey, documentId, matrixClient, roomId, spaceId, userId]);

  /**
   * Immediately save to IndexedDB + upload to Filen.
   * Returns 'filen' if Filen upload succeeded, 'local' if only local, false if nothing dirty.
   */
  const saveNow = useCallback(async (): Promise<'filen' | 'local' | false> => {
    if (!flushRef.current) return false;
    const filenOk = await flushRef.current();
    return filenOk ? 'filen' : 'local';
  }, []);

  // Create TipTap editor — depends on doc being loaded
  const editor = useEditor(
    {
      editable,
      extensions: [
        StarterKit.configure({
          history: false, // Yjs handles undo/redo
        }),
        ...(docRef.current
          ? [
              Collaboration.configure({
                document: docRef.current,
              }),
              CollaborationCursor.configure({
                provider: providerRef.current ?? undefined,
                user: {
                  name: matrixClient?.getUserId() || userId || 'Anonymous',
                  color: colorForUser(matrixClient?.getUserId() || userId || 'anon'),
                },
              }),
            ]
          : []),
      ],
    },
    [state.loaded], // recreate editor when doc loads
  );

  return { editor, saveNow, ...state };
}
