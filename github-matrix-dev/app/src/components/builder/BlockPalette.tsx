import { useDraggable } from '@dnd-kit/core';
import { getAllRegistrations, type BlockRegistration } from '../../blocks/registry';
import type { BlockCategory } from '../../blocks/types';
import { useTheme, type Theme } from '../../theme';

const CATEGORY_ORDER: BlockCategory[] = ['layout', 'text', 'data', 'form', 'interaction', 'media', 'reference'];

const CATEGORY_LABELS: Record<BlockCategory, string> = {
  layout: 'Layout',
  text: 'Text',
  data: 'Data',
  form: 'Input',
  media: 'Media',
  interaction: 'Interaction',
  reference: 'Reference',
};

export function BlockPalette() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const allRegs = getAllRegistrations();

  // Group by category
  const grouped = new Map<BlockCategory, BlockRegistration[]>();
  for (const reg of allRegs) {
    const list = grouped.get(reg.category) || [];
    list.push(reg);
    grouped.set(reg.category, list);
  }

  return (
    <div style={s.palette}>
      <div style={s.title}>Blocks</div>
      {CATEGORY_ORDER.map((cat) => {
        const regs = grouped.get(cat);
        if (!regs || regs.length === 0) return null;
        return (
          <div key={cat}>
            <div style={s.categoryLabel}>{CATEGORY_LABELS[cat]}</div>
            <div style={s.grid}>
              {regs.map((reg) => (
                <PaletteItem key={reg.type} reg={reg} theme={theme} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PaletteItem({ reg, theme }: { reg: BlockRegistration; theme: Theme }) {
  const s = makeItemStyles(theme);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${reg.type}`,
    data: { type: 'palette', blockType: reg.type },
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        ...s.item,
        opacity: isDragging ? 0.5 : 1,
      }}
      title={reg.label}
    >
      <span style={s.icon}>{reg.icon}</span>
      <span style={s.label}>{reg.label}</span>
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    palette: {
      padding: '8px 0',
      overflowY: 'auto',
      flex: 1,
    },
    title: {
      padding: '4px 12px 8px',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
      color: t.textSecondary,
    },
    categoryLabel: {
      padding: '8px 12px 4px',
      fontSize: 10,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    grid: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 4,
      padding: '0 8px',
    },
  };
}

function makeItemStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    item: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 4,
      padding: '8px 4px',
      borderRadius: 6,
      border: `1px solid ${t.borderLight}`,
      background: t.bgCard,
      cursor: 'grab',
      transition: 'border-color 0.15s ease',
      userSelect: 'none',
    },
    icon: {
      fontSize: 16,
      lineHeight: 1,
    },
    label: {
      fontSize: 10,
      color: t.textSecondary,
      textAlign: 'center',
      lineHeight: 1.2,
    },
  };
}
