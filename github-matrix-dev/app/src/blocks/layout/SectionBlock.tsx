import { useState } from 'react';
import { useTheme, type Theme } from '../../theme';
import type { BlockNode } from '../types';
import type { BuilderMode } from '../../store/builder-store';
import { BlockList } from '../BlockRenderer';

interface Props {
  block: BlockNode;
  mode: BuilderMode;
}

export function SectionBlock({ block, mode }: Props) {
  const { title, collapsed: initialCollapsed, borderVisible = true, padding = 16 } = block.props;
  const [collapsed, setCollapsed] = useState(!!initialCollapsed);
  const { theme } = useTheme();
  const s = makeStyles(theme, borderVisible, padding);

  return (
    <div style={s.container}>
      {title && (
        <div style={s.header} onClick={() => setCollapsed(!collapsed)}>
          <span style={s.chevron}>{collapsed ? '▸' : '▾'}</span>
          <span style={s.title}>{title}</span>
        </div>
      )}
      {!collapsed && (
        <div style={s.body}>
          <BlockList
            blocks={block.children || []}
            mode={mode}
            droppableId={`section-${block.id}`}
          />
        </div>
      )}
    </div>
  );
}

function makeStyles(t: Theme, border: boolean, padding: number): Record<string, React.CSSProperties> {
  return {
    container: {
      background: t.bgCard,
      border: border ? `1px solid ${t.border}` : 'none',
      borderRadius: 8,
      overflow: 'hidden',
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '8px 12px',
      borderBottom: `1px solid ${t.borderLight}`,
      cursor: 'pointer',
      userSelect: 'none',
    },
    chevron: {
      fontSize: 12,
      color: t.textMuted,
      width: 14,
    },
    title: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.5px',
      color: t.textSecondary,
    },
    body: {
      padding,
    },
  };
}
