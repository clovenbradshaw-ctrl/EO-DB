/**
 * CollabEditor — collaborative richtext editor backed by Yjs + Matrix.
 *
 * Wraps TipTap with collaboration and cursor extensions.
 * Shows a status indicator with transport type and peer count.
 * On blur (click out of field), flushes pending save and shows a brief toast.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
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
  /** Space ID for Filen folder resolution */
  spaceId: string;
  /** Current user ID */
  userId: string;
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

const TOAST_DISPLAY_MS = 2000;

export function CollabEditor({
  target,
  fieldKey,
  matrixClient,
  roomId,
  spaceId,
  userId,
  editable = true,
  placeholder = 'Start typing...',
}: Props) {
  const { editor, saveNow, transport, peerCount, loaded } = useCollabEditor({
    target,
    fieldKey,
    matrixClient,
    roomId,
    spaceId,
    userId,
    editable,
  });
  const { theme } = useTheme();

  // Toast state: 'filen' | 'local' | null
  const [toastType, setToastType] = useState<'filen' | 'local' | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  // Clean up toast timer on unmount
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const handleBlur = useCallback(async () => {
    const result = await saveNow();
    if (result) {
      setToastType(result);
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToastType(null), TOAST_DISPLAY_MS);
    }
  }, [saveNow]);

  if (!loaded) {
    return (
      <div style={{ padding: '8px 0', color: theme.textSecondary, fontSize: 13 }}>
        Loading...
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }} onBlur={handleBlur}>
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

      {/* Transport status indicator */}
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

      {/* Save toast — appears briefly on click-out */}
      {toastType && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            bottom: -28,
            right: 0,
            padding: '4px 10px',
            borderRadius: 6,
            border: `1px solid ${toastType === 'filen' ? theme.successBorder : theme.warningBorder}`,
            background: toastType === 'filen' ? theme.successBg : theme.warningBg,
            color: toastType === 'filen'
              ? (theme.successText ?? theme.success)
              : (theme.warningText ?? theme.warning),
            fontSize: 11,
            fontWeight: 500,
            fontFamily: "'JetBrains Mono', monospace",
            pointerEvents: 'none',
            boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
          }}
        >
          {toastType === 'filen' ? 'Saved to Filen' : 'Saved locally'}
        </div>
      )}
    </div>
  );
}
