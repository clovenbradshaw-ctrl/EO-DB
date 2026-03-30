import { useTheme, type Theme } from '../../theme';
import type { BlockNode } from '../types';
import type { BuilderMode } from '../../store/builder-store';

interface Props {
  block: BlockNode;
  mode: BuilderMode;
}

export function ButtonBlock({ block, mode }: Props) {
  const {
    label = 'Button',
    style: btnStyle = 'primary',
    size = 'default',
    icon,
  } = block.props;
  const { theme } = useTheme();
  const s = makeStyles(theme, btnStyle, size);

  const handleClick = () => {
    if (mode === 'build') return; // No-op in build mode
    // Action handling will be implemented with the builder action system
  };

  return (
    <button
      style={s.button}
      onClick={handleClick}
      disabled={mode === 'build'}
    >
      {icon && <span style={{ marginRight: 6 }}>{icon}</span>}
      {label}
    </button>
  );
}

function makeStyles(
  t: Theme,
  variant: string,
  size: string,
): Record<string, React.CSSProperties> {
  const sizeStyles: Record<string, React.CSSProperties> = {
    small: { padding: '4px 12px', fontSize: 12 },
    default: { padding: '8px 18px', fontSize: 13 },
    large: { padding: '10px 24px', fontSize: 15 },
  };

  const variantStyles: Record<string, React.CSSProperties> = {
    primary: {
      background: t.accent,
      color: '#fff',
      border: `1px solid ${t.accent}`,
    },
    secondary: {
      background: 'transparent',
      color: t.text,
      border: `1px solid ${t.border}`,
    },
    danger: {
      background: t.danger,
      color: '#fff',
      border: `1px solid ${t.danger}`,
    },
    ghost: {
      background: 'transparent',
      color: t.accent,
      border: '1px solid transparent',
    },
  };

  return {
    button: {
      ...sizeStyles[size] || sizeStyles.default,
      ...variantStyles[variant] || variantStyles.primary,
      borderRadius: 6,
      fontFamily: "'Outfit', sans-serif",
      fontWeight: 500,
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      transition: 'opacity 0.15s ease',
    },
  };
}
