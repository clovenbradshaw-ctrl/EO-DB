import { useRef } from 'react';
import { useBuilderStore, type BuilderMode } from '../../store/builder-store';
import { useTheme } from '../../theme';
import type { BlockNode } from '../types';
import { CollabEditor } from '../../components/CollabEditor';
import type { MatrixClient } from 'matrix-js-sdk';

interface Props {
  block: BlockNode;
  mode: BuilderMode;
  /** Optional Matrix client for collaborative editing */
  matrixClient?: MatrixClient | null;
  /** Optional Matrix room ID for sync */
  roomId?: string | null;
  /** Optional EO target path for persistence */
  target?: string;
  /** Space ID for Filen folder resolution */
  spaceId?: string;
  /** Current user ID */
  userId?: string;
}

export function ParagraphBlock({ block, mode, matrixClient, roomId, target, spaceId, userId }: Props) {
  const { text = '', alignment = 'left', collabField } = block.props;
  const updateBlockProps = useBuilderStore((s) => s.updateBlockProps);
  const { theme } = useTheme();
  const ref = useRef<HTMLDivElement>(null);

  // Use collaborative editor when a target and field key are configured
  const useCollab = mode === 'build' && target && collabField;

  if (useCollab) {
    return (
      <div style={{ textAlign: alignment as any, padding: '4px 0' }}>
        <CollabEditor
          target={target}
          fieldKey={collabField}
          matrixClient={matrixClient ?? null}
          roomId={roomId ?? null}
          spaceId={spaceId ?? ''}
          userId={userId ?? ''}
          editable
          placeholder="Type something..."
        />
      </div>
    );
  }

  const handleBlur = () => {
    if (mode === 'build' && ref.current) {
      const newText = ref.current.textContent || '';
      if (newText !== text) {
        updateBlockProps(block.id, { text: newText });
      }
    }
  };

  return (
    <div
      ref={ref}
      contentEditable={mode === 'build'}
      suppressContentEditableWarning
      onBlur={handleBlur}
      style={{
        fontFamily: "'Outfit', sans-serif",
        fontSize: 14,
        lineHeight: 1.6,
        color: theme.text,
        textAlign: alignment as any,
        outline: 'none',
        padding: '4px 0',
        cursor: mode === 'build' ? 'text' : 'default',
        minHeight: mode === 'build' ? 24 : undefined,
      }}
    >
      {text || (mode === 'build' ? 'Type something...' : '')}
    </div>
  );
}
