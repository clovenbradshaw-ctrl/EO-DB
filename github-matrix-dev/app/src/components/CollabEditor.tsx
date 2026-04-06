/**
 * CollabEditor — collaborative richtext editor backed by Yjs + Matrix.
 *
 * Wraps TipTap with collaboration and cursor extensions.
 * Shows a status indicator with transport type and peer count.
 */

import { EditorContent } from '@tiptap/react';
import type { MatrixClient } from 'matrix-js-sdk';
import { useCollabEditor } from '../hooks/useCollabEditor';
import { useTheme } from '../theme';

interface Props {
  /** EO target path, e.g. `at.appXYZ.tblABC.rec001` */
  target: string;
  /** Field key within the target, e.g. `fldBody` */
  fieldKey: string;
  /** Matrix client (null for local-only mode) */
  matrixClient: MatrixClient | null;
  /** Matrix room ID */
  roomId: string | null;
  /** Whether the field is editable */
  editable?: boolean;
  /** Placeholder text when empty */
  placeholder?: string;
}

const TRANSPORT_LABELS: Record<string, string> = {
  webrtc: 'P2P',
  todevice: 'relay',
  offline: 'local',
};

const TRANSPORT_COLORS: Record<string, string> = {
  webrtc: '#4caf50',
  todevice: '#ff9800',
  offline: '#9e9e9e',
};

export function CollabEditor({
  target,
  fieldKey,
  matrixClient,
  roomId,
  editable = true,
  placeholder = 'Start typing...',
}: Props) {
  const { editor, transport, peerCount, loaded } = useCollabEditor({
    target,
    fieldKey,
    matrixClient,
    roomId,
    editable,
  });
  const { theme } = useTheme();

  if (!loaded) {
    return (
      <div style={{ padding: '8px 0', color: theme.textSecondary, fontSize: 13 }}>
        Loading...
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <EditorContent
        editor={editor}
        style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: 14,
          lineHeight: 1.6,
          color: theme.text,
          outline: 'none',
          minHeight: 24,
        }}
      />

      {/* Status indicator */}
      {matrixClient && (
        <div
          style={{
            position: 'absolute',
            top: -18,
            right: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 10,
            color: theme.textSecondary,
            opacity: 0.7,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              backgroundColor: TRANSPORT_COLORS[transport],
              display: 'inline-block',
            }}
          />
          <span>{TRANSPORT_LABELS[transport]}</span>
          {peerCount > 0 && (
            <span style={{ marginLeft: 2 }}>
              {peerCount} peer{peerCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
