import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { useBuilderStore, type BuilderMode } from '../store/builder-store';
import { BlockWrapper } from './BlockWrapper';
import type { BlockNode, BlockId } from './types';

// Block component imports
import { SectionBlock } from './layout/SectionBlock';
import { ColumnsBlock } from './layout/ColumnsBlock';
import { DividerBlock } from './layout/DividerBlock';
import { SpacerBlock } from './layout/SpacerBlock';
import { HeadingBlock } from './text/HeadingBlock';
import { ParagraphBlock } from './text/ParagraphBlock';
import { TableBlock } from './data/TableBlock';
import { MetricBlock } from './data/MetricBlock';
import { ListBlock } from './data/ListBlock';
import { RecordBlock } from './data/RecordBlock';
import { CalendarBlock } from './data/CalendarBlock';
import { ButtonBlock } from './form/ButtonBlock';

// ---------------------------------------------------------------------------
// Component resolver
// ---------------------------------------------------------------------------

const BLOCK_COMPONENTS: Record<string, React.ComponentType<{ block: BlockNode; mode: BuilderMode }>> = {
  section: SectionBlock,
  columns: ColumnsBlock,
  divider: DividerBlock,
  spacer: SpacerBlock,
  heading: HeadingBlock,
  paragraph: ParagraphBlock,
  table: TableBlock,
  metric: MetricBlock,
  list: ListBlock,
  record: RecordBlock,
  calendar: CalendarBlock,
  button: ButtonBlock,
};

// ---------------------------------------------------------------------------
// Single block renderer
// ---------------------------------------------------------------------------

interface BlockItemProps {
  block: BlockNode;
  mode: BuilderMode;
}

function BlockItem({ block, mode }: BlockItemProps) {
  const Component = BLOCK_COMPONENTS[block.type];
  if (!Component) {
    return (
      <div style={{ padding: 8, color: '#999', fontSize: 12, fontStyle: 'italic' }}>
        Unknown block: {block.type}
      </div>
    );
  }
  return <Component block={block} mode={mode} />;
}

// ---------------------------------------------------------------------------
// Block list renderer (handles sortable context in build mode)
// ---------------------------------------------------------------------------

interface BlockListProps {
  blocks: BlockNode[];
  mode: BuilderMode;
  droppableId: string;
}

export function BlockList({ blocks, mode, droppableId }: BlockListProps) {
  const { setNodeRef } = useDroppable({ id: droppableId });
  const ids = blocks.map((b) => b.id);

  if (mode === 'build') {
    return (
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} style={{ minHeight: 40, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {blocks.length === 0 && (
            <div style={{
              padding: '12px 16px',
              border: '1px dashed #ccc',
              borderRadius: 6,
              textAlign: 'center',
              color: '#aaa',
              fontSize: 12,
            }}>
              Drop blocks here
            </div>
          )}
          {blocks.map((block) => (
            <BlockWrapper key={block.id} id={block.id}>
              <BlockItem block={block} mode={mode} />
            </BlockWrapper>
          ))}
        </div>
      </SortableContext>
    );
  }

  // Live mode — no wrappers
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {blocks.map((block) => (
        <BlockItem key={block.id} block={block} mode={mode} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level renderer — used by BuilderView
// ---------------------------------------------------------------------------

export function BlockRenderer() {
  const blocks = useBuilderStore((s) => s.blocks);
  const mode = useBuilderStore((s) => s.mode);

  return <BlockList blocks={blocks} mode={mode} droppableId="root" />;
}
