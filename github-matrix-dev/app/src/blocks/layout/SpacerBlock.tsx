import type { BlockNode } from '../types';
import type { BuilderMode } from '../../store/builder-store';
import { useTheme } from '../../theme';

interface Props {
  block: BlockNode;
  mode: BuilderMode;
}

export function SpacerBlock({ block, mode }: Props) {
  const { height = 24 } = block.props;
  const { theme } = useTheme();

  return (
    <div style={{
      height,
      ...(mode === 'build' ? {
        background: `repeating-linear-gradient(45deg, transparent, transparent 4px, ${theme.borderLight} 4px, ${theme.borderLight} 5px)`,
        borderRadius: 4,
        opacity: 0.4,
      } : {}),
    }} />
  );
}
