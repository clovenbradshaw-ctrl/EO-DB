import { useTheme } from '../../theme';
import type { BlockNode } from '../types';
import type { BuilderMode } from '../../store/builder-store';

interface Props {
  block: BlockNode;
  mode: BuilderMode;
}

export function DividerBlock({ block }: Props) {
  const { color, thickness = 1, margin = 16 } = block.props;
  const { theme } = useTheme();

  return (
    <hr style={{
      border: 'none',
      borderTop: `${thickness}px solid ${color || theme.borderDivider}`,
      margin: `${margin}px 0`,
    }} />
  );
}
