import { useTheme } from '../../theme';
import type { BlockNode } from '../types';
import type { BuilderMode } from '../../store/builder-store';

export interface MetricBlockProps {
  title?: string;
  formula: 'COUNT' | 'SUM';
  field?: string;         // field to SUM (ignored for COUNT)
  color?: string;
  prefix?: string;        // e.g. "$"
  scope?: string;
}

interface Props {
  block: BlockNode;
  mode: BuilderMode;
}

export function MetricBlock({ block, mode }: Props) {
  const { theme } = useTheme();
  const props = block.props as MetricBlockProps;
  const { title = 'Metric', formula = 'COUNT', color, prefix = '', scope } = props;

  // In build mode we show a placeholder value; live mode would resolve via data binding
  const displayValue = mode === 'build' ? (formula === 'COUNT' ? '—' : '0') : '—';

  return (
    <div style={{
      padding: '20px 24px',
      border: `1px solid ${theme.border}`,
      borderRadius: 6,
    }}>
      <div style={{
        fontSize: 10,
        color: theme.textMuted,
        fontFamily: "'JetBrains Mono', monospace",
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        marginBottom: 8,
      }}>
        {title}
        {mode === 'build' && !scope && (
          <span style={{ fontWeight: 400, fontStyle: 'italic', textTransform: 'none', marginLeft: 6 }}>
            — configure a data binding
          </span>
        )}
      </div>
      <div style={{
        fontSize: 32,
        fontWeight: 700,
        fontFamily: "'JetBrains Mono', monospace",
        color: color || theme.text,
      }}>
        {prefix}{displayValue}
      </div>
    </div>
  );
}
