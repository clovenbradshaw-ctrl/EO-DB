/**
 * 27-cell picker — renders the EO Mode × Domain × Object grid as colored
 * buttons. Emits the chosen cell_id to the parent.
 *
 * Layout: one row per Object level (Condition / Entity / Pattern), each
 * row is a 3×3 grid of operators colored via OP_COLORS. The nine operators
 * double as the row label because each operator sits at a fixed (mode,
 * domain) position.
 */

import { useMemo } from 'react';
import { useTheme } from '../theme';
import { OP_COLORS } from './LogView';
import { EO_CELLS, type EOCell } from '../nl/eo-cells';

interface EOCellPickerProps {
  /** Currently selected cell_id, rendered with an accent ring. */
  selected?: string | null;
  /** Cell_ids the user cannot re-pick (e.g. already the "from" cell). */
  disabled?: string[];
  onPick: (cell: EOCell) => void;
}

export function EOCellPicker({ selected, disabled, onPick }: EOCellPickerProps) {
  const { theme } = useTheme();
  const disabledSet = useMemo(() => new Set(disabled ?? []), [disabled]);
  const byObject = useMemo(() => {
    const buckets: Record<string, EOCell[]> = { Condition: [], Entity: [], Pattern: [] };
    for (const c of EO_CELLS) buckets[c.object]?.push(c);
    return buckets;
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {(['Condition', 'Entity', 'Pattern'] as const).map((obj) => (
        <div key={obj}>
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: theme.textMuted,
              marginBottom: 4,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {obj}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: 4,
            }}
          >
            {byObject[obj].map((cell) => {
              const c = OP_COLORS[cell.operator] ?? OP_COLORS.SIG;
              const isSelected = selected === cell.cell_id;
              const isDisabled = disabledSet.has(cell.cell_id);
              return (
                <button
                  key={cell.cell_id}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => onPick(cell)}
                  title={`${cell.cell_key} · ${cell.mode} · ${cell.domain}`}
                  style={{
                    padding: '6px 8px',
                    borderRadius: 4,
                    background: isSelected ? c.fill : c.bg,
                    color: isSelected ? '#fff' : c.text,
                    border: `1px solid ${isSelected ? c.border : `${c.border}40`}`,
                    opacity: isDisabled ? 0.4 : 1,
                    cursor: isDisabled ? 'not-allowed' : 'pointer',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    fontWeight: 600,
                    textAlign: 'left',
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{cell.operator}</div>
                  <div style={{ fontSize: 9, opacity: 0.8 }}>
                    {cell.resolution}/{cell.site}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
