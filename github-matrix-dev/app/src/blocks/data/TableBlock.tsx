import { useTheme } from '../../theme';
import type { BlockNode, TableBlockProps } from '../types';
import type { BuilderMode } from '../../store/builder-store';

interface Props {
  block: BlockNode;
  mode: BuilderMode;
}

export function TableBlock({ block, mode }: Props) {
  const { theme } = useTheme();
  const props = block.props as TableBlockProps;
  const { scope = '', emptyText = 'No data' } = props;

  return (
    <div
      style={{
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        overflow: 'hidden',
        fontSize: 13,
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          background: theme.bgMuted,
          borderBottom: `1px solid ${theme.border}`,
          color: theme.textSecondary,
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}
      >
        {scope || 'Table'}
        {mode === 'build' && !scope && (
          <span style={{ fontWeight: 400, fontStyle: 'italic', textTransform: 'none' }}>
            {' '}— configure a data binding
          </span>
        )}
      </div>
      <div
        style={{
          padding: '24px 16px',
          textAlign: 'center',
          color: theme.textMuted,
          fontSize: 12,
        }}
      >
        {emptyText}
      </div>
    </div>
  );
}
