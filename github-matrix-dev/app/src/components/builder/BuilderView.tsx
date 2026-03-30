import { useState, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useBuilderStore } from '../../store/builder-store';
import { createBlock, getRegistration } from '../../blocks/registry';
import { BlockRenderer } from '../../blocks/BlockRenderer';
import { BlockConfigPanel } from '../../blocks/BlockConfigPanel';
import { BlockPalette } from './BlockPalette';
import { BuilderToolbar } from './BuilderToolbar';
import { ViewList } from './ViewList';
import { useTheme, type Theme } from '../../theme';
import type { BlockType } from '../../blocks/types';

export function BuilderView() {
  const viewId = useBuilderStore((s) => s.viewId);
  const mode = useBuilderStore((s) => s.mode);
  const addBlock = useBuilderStore((s) => s.addBlock);
  const selectBlock = useBuilderStore((s) => s.selectBlock);
  const reset = useBuilderStore((s) => s.reset);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const [showViewList, setShowViewList] = useState(!viewId);
  const [activeDragType, setActiveDragType] = useState<BlockType | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleBack = useCallback(() => {
    reset();
    setShowViewList(true);
  }, [reset]);

  const handleSelectView = useCallback(() => {
    setShowViewList(false);
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current;
    if (data?.type === 'palette') {
      setActiveDragType(data.blockType as BlockType);
    }
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragType(null);
    const { active, over } = event;

    if (!over) return;

    const activeData = active.data.current;

    // Dragging from palette — add new block
    if (activeData?.type === 'palette') {
      const blockType = activeData.blockType as BlockType;
      // Determine drop target
      const overId = String(over.id);

      if (overId === 'root') {
        addBlock(blockType);
      } else if (overId.includes('-col-') || overId.startsWith('section-')) {
        // Dropping into a slot or section
        const parts = overId.split('-');
        if (overId.includes('-col-')) {
          // Format: parentId-col-N
          const colIdx = parts.pop()!;
          parts.pop(); // remove 'col'
          const parentId = parts.join('-');
          addBlock(blockType, parentId, `col-${colIdx}`);
        } else {
          // Format: section-parentId
          const parentId = overId.replace('section-', '');
          addBlock(blockType, parentId);
        }
      } else {
        // Drop at root level
        addBlock(blockType);
      }
      return;
    }

    // TODO: Reordering existing blocks via sortable — handled by @dnd-kit/sortable internally
  }, [addBlock]);

  // View list screen
  if (showViewList) {
    return <ViewList onSelectView={handleSelectView} />;
  }

  // Builder / Live mode
  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div style={s.container}>
        <BuilderToolbar onBack={handleBack} />

        <div style={s.body}>
          {/* Left panel — block palette (build mode only) */}
          {mode === 'build' && (
            <aside style={s.leftPanel}>
              <BlockPalette />
            </aside>
          )}

          {/* Center — canvas */}
          <main
            style={{
              ...s.canvas,
              ...(mode === 'live' ? { maxWidth: 960, margin: '0 auto' } : {}),
            }}
            onClick={() => mode === 'build' && selectBlock(null)}
          >
            <div style={s.canvasInner}>
              <BlockRenderer />
            </div>
          </main>

          {/* Right panel — config (build mode only) */}
          {mode === 'build' && (
            <aside style={s.rightPanel}>
              <BlockConfigPanel />
            </aside>
          )}
        </div>
      </div>

      {/* Drag overlay for palette items */}
      <DragOverlay dropAnimation={null}>
        {activeDragType && (
          <PaletteDragPreview type={activeDragType} theme={theme} />
        )}
      </DragOverlay>
    </DndContext>
  );
}

function PaletteDragPreview({ type, theme }: { type: BlockType; theme: Theme }) {
  const reg = getRegistration(type);
  return (
    <div style={{
      padding: '8px 16px',
      background: theme.bgCard,
      border: `2px solid ${theme.accent}`,
      borderRadius: 8,
      boxShadow: theme.shadow,
      fontSize: 13,
      fontWeight: 500,
      color: theme.text,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      opacity: 0.9,
    }}>
      <span>{reg?.icon}</span>
      <span>{reg?.label || type}</span>
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: t.bg,
    },
    body: {
      display: 'flex',
      flex: 1,
      overflow: 'hidden',
    },
    leftPanel: {
      width: 180,
      borderRight: `1px solid ${t.border}`,
      background: t.bgCard,
      overflowY: 'auto',
      flexShrink: 0,
    },
    canvas: {
      flex: 1,
      overflowY: 'auto',
      padding: 24,
    },
    canvasInner: {
      maxWidth: 900,
      margin: '0 auto',
      minHeight: 200,
    },
    rightPanel: {
      width: 240,
      borderLeft: `1px solid ${t.border}`,
      background: t.bgCard,
      overflowY: 'auto',
      flexShrink: 0,
    },
  };
}
