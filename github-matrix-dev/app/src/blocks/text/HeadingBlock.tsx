import { useRef } from 'react';
import { useBuilderStore, type BuilderMode } from '../../store/builder-store';
import { useTheme, type Theme } from '../../theme';
import type { BlockNode } from '../types';

interface Props {
  block: BlockNode;
  mode: BuilderMode;
}

export function HeadingBlock({ block, mode }: Props) {
  const { level = 2, text = 'Heading', alignment = 'left' } = block.props;
  const updateBlockProps = useBuilderStore((s) => s.updateBlockProps);
  const { theme } = useTheme();
  const ref = useRef<HTMLDivElement>(null);

  const sizes: Record<number, React.CSSProperties> = {
    1: { fontSize: 28, fontWeight: 700, fontFamily: "'Source Serif 4', serif" },
    2: {
      fontSize: 14,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
    },
    3: { fontSize: 14, fontWeight: 600, fontFamily: "'Outfit', sans-serif" },
  };

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
        ...sizes[level] || sizes[2],
        color: theme.textHeading,
        textAlign: alignment as any,
        outline: 'none',
        padding: '4px 0',
        cursor: mode === 'build' ? 'text' : 'default',
      }}
    >
      {text}
    </div>
  );
}
