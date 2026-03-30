import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useBuilderStore } from '../store/builder-store';
import { useTheme, type Theme } from '../theme';
import type { BlockId } from './types';

interface BlockWrapperProps {
  id: BlockId;
  children: React.ReactNode;
}

export function BlockWrapper({ id, children }: BlockWrapperProps) {
  const selectedBlockId = useBuilderStore((s) => s.selectedBlockId);
  const selectBlock = useBuilderStore((s) => s.selectBlock);
  const removeBlock = useBuilderStore((s) => s.removeBlock);
  const { theme } = useTheme();
  const isSelected = selectedBlockId === id;
  const s = makeStyles(theme, isSelected);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    ...s.wrapper,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={(e) => { e.stopPropagation(); selectBlock(id); }}
    >
      <div style={s.toolbar}>
        <div {...attributes} {...listeners} style={s.dragHandle} title="Drag to reorder">
          ⠿
        </div>
        <button
          style={s.deleteBtn}
          onClick={(e) => { e.stopPropagation(); removeBlock(id); }}
          title="Remove block"
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

function makeStyles(t: Theme, selected: boolean): Record<string, React.CSSProperties> {
  return {
    wrapper: {
      position: 'relative',
      border: selected ? `2px solid ${t.accent}` : `1px dashed ${t.borderLight}`,
      borderRadius: 6,
      padding: 2,
      cursor: 'pointer',
      transition: 'border-color 0.15s ease',
    },
    toolbar: {
      position: 'absolute',
      top: -1,
      right: -1,
      display: 'flex',
      gap: 2,
      zIndex: 10,
      opacity: selected ? 1 : 0,
      transition: 'opacity 0.15s ease',
      pointerEvents: selected ? 'auto' : 'none',
    },
    dragHandle: {
      cursor: 'grab',
      padding: '2px 6px',
      fontSize: 14,
      lineHeight: 1,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      color: t.textMuted,
      userSelect: 'none',
    },
    deleteBtn: {
      cursor: 'pointer',
      padding: '2px 6px',
      fontSize: 11,
      lineHeight: 1,
      background: t.dangerBg,
      border: `1px solid ${t.dangerBorder}`,
      borderRadius: 4,
      color: t.danger,
    },
  };
}
