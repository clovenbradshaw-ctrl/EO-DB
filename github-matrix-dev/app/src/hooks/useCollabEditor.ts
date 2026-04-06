/**
 * React hook for collaborative editing via Yjs + Matrix.
 *
 * Creates and manages a Y.Doc, YjsMatrixProvider, TipTap editor,
 * and debounced persistence. Cleans up on unmount.
 */

import { useEffect, useRef, useState, useMemo } from 'react';
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
  editable = true,
}: UseCollabEditorOpts) {
  const store = useEoStore((s) => s.store);
  const dispatch = useEoStore((s) => s.dispatch);
  const [state, setState] = useState<CollabEditorState>({
    transport: 'offline',
    peerCount: 0,
    loaded: false,
  });

  const docRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<YjsMatrixProvider | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

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

      // Set up debounced persistence
      const { trigger, cleanup } = createDebouncedSave(doc, target, fieldKey, dispatch);
      cleanupRef.current = cleanup;

      // Listen for local changes to trigger save
      const onUpdate = (_update: Uint8Array, origin: any) => {
        // Save on any update (local or remote) — the CRDT state is the merged result
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
      docRef.current?.destroy();
      docRef.current = null;
      setState({ transport: 'offline', peerCount: 0, loaded: false });
    };
  }, [store, target, fieldKey, documentId, matrixClient, roomId, dispatch]);

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
                  name: matrixClient?.getUserId() || 'Anonymous',
                  color: colorForUser(matrixClient?.getUserId() || 'anon'),
                },
              }),
            ]
          : []),
      ],
    },
    [state.loaded], // recreate editor when doc loads
  );

  return { editor, ...state };
}
