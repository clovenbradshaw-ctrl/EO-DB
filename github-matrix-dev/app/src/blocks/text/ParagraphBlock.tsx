import { useRef } from 'react';
import { useBuilderStore, type BuilderMode } from '../../store/builder-store';
import { useTheme } from '../../theme';
import type { BlockNode } from '../types';

interface Props {
  block: BlockNode;
  mode: BuilderMode;
}

export function ParagraphBlock({ block, mode }: Props) {
  const { text = '', alignment = 'left' } = block.props;
  const updateBlockProps = useBuilderStore((s) => s.updateBlockProps);
  const { theme } = useTheme();
  const ref = useRef<HTMLDivElement>(null);

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
