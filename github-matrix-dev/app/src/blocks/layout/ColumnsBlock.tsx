import { useTheme, type Theme } from '../../theme';
import type { BlockNode } from '../types';
import type { BuilderMode } from '../../store/builder-store';
import { BlockList } from '../BlockRenderer';

interface Props {
  block: BlockNode;
  mode: BuilderMode;
}

export function ColumnsBlock({ block, mode }: Props) {
  const { ratios = [1, 1], gap = 16, verticalAlign = 'top' } = block.props;
  const { theme } = useTheme();
  const slots = block.slots || {};
  const totalRatio = ratios.reduce((a: number, b: number) => a + b, 0);

  const alignMap: Record<string, string> = {
    top: 'flex-start',
    center: 'center',
    bottom: 'flex-end',
  };

  return (
    <div style={{
      display: 'flex',
      gap,
      alignItems: alignMap[verticalAlign] || 'flex-start',
    }}>
      {ratios.map((ratio: number, i: number) => {
        const slotKey = `col-${i}`;
        const slotBlocks = slots[slotKey] || [];
        const width = `${(ratio / totalRatio) * 100}%`;

        return (
          <div key={slotKey} style={{ flex: `0 0 ${width}`, maxWidth: width, minWidth: 0 }}>
            <BlockList
              blocks={slotBlocks}
              mode={mode}
              droppableId={`${block.id}-${slotKey}`}
            />
          </div>
        );
      })}
    </div>
  );
}
