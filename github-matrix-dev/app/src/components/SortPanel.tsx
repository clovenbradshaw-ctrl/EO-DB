import { useState } from 'react';
import type { ColumnDef } from './filter-types';
import { useTheme, type Theme } from '../theme';
import { usePanelPosition } from '../hooks/usePanelPosition';

export interface SortRule {
  id: string;
  field: string;
  direction: 'asc' | 'desc';
}

interface SortPanelProps {
  columns: ColumnDef[];
  sorts: SortRule[];
  onSortsChange: (sorts: SortRule[]) => void;
}

export function SortPanel({ columns, sorts, onSortsChange }: SortPanelProps) {
  const [open, setOpen] = useState(false);
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const { anchorRef, panelRef, style: panelStyle } = usePanelPosition({
    open,
    placement: 'bottom-end',
    estimatedWidth: 440,
    estimatedHeight: 320,
  });

  function addSort() {
    // Pick the first column not already sorted, or fall back to first column
    const usedFields = new Set(sorts.map((s) => s.field));
    const available = columns.find((c) => !usedFields.has(c.key));
    const field = available?.key || columns[0]?.key || '';
    onSortsChange([
      ...sorts,
      { id: crypto.randomUUID(), field, direction: 'asc' },
    ]);
  }

  function updateSort(id: string, patch: Partial<SortRule>) {
    onSortsChange(sorts.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function removeSort(id: string) {
    onSortsChange(sorts.filter((s) => s.id !== id));
  }

  const activeCount = sorts.length;

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={anchorRef as React.RefObject<HTMLButtonElement>}
        style={{
          ...s.sortBtn,
          ...(activeCount > 0 ? s.sortBtnActive : {}),
        }}
        onClick={() => setOpen(!open)}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M2 4h12M4 8h8M6 12h4" />
        </svg>
        Sort
        {activeCount > 0 && (
          <span style={s.badge}>{activeCount}</span>
        )}
      </button>

      {open && (
        <>
          <div style={s.backdrop} onClick={() => setOpen(false)} />
          <div ref={panelRef} style={{ ...s.panel, ...panelStyle }}>
            <div style={s.panelHeader}>
              <span style={s.panelTitle}>Sort</span>
              <button style={s.closeBtn} onClick={() => setOpen(false)}>&times;</button>
            </div>

            {sorts.length === 0 && (
              <div style={s.emptyMsg}>No active sorts. Add one to reorder your view.</div>
            )}

            {sorts.map((sort, idx) => (
              <div key={sort.id} style={s.sortRow}>
                <span style={s.orderLabel}>
                  {idx === 0 ? 'Sort by' : 'then by'}
                </span>

                <select
                  value={sort.field}
                  onChange={(e) => updateSort(sort.id, { field: e.target.value })}
                  style={s.select}
                >
                  {columns.map((c) => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </select>

                <button
                  style={{
                    ...s.dirBtn,
                    ...(sort.direction === 'asc' ? s.dirBtnActive : {}),
                  }}
                  onClick={() => updateSort(sort.id, { direction: 'asc' })}
                >
                  A → Z
                </button>
                <button
                  style={{
                    ...s.dirBtn,
                    ...(sort.direction === 'desc' ? s.dirBtnActive : {}),
                  }}
                  onClick={() => updateSort(sort.id, { direction: 'desc' })}
                >
                  Z → A
                </button>

                <button
                  style={s.removeBtn}
                  onClick={() => removeSort(sort.id)}
                >
                  &times;
                </button>
              </div>
            ))}

            <div style={s.panelFooter}>
              <button style={s.addBtn} onClick={addSort}>
                + Add sort
              </button>
              {sorts.length > 0 && (
                <button
                  style={s.clearBtn}
                  onClick={() => onSortsChange([])}
                >
                  Clear all
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    sortBtn: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 28,
      padding: '0 12px',
      fontSize: 12,
      fontWeight: 500,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: t.bgCard,
      color: t.text,
      cursor: 'pointer',
      whiteSpace: 'nowrap' as const,
      boxSizing: 'border-box' as const,
    },
    sortBtnActive: {
      borderColor: t.accent,
      color: t.accent,
      background: t.accentBg,
    },
    badge: {
      fontSize: 10,
      fontWeight: 600,
      background: t.accent,
      color: '#fff',
      borderRadius: 8,
      padding: '0 5px',
      lineHeight: '16px',
    },
    backdrop: {
      position: 'fixed' as const,
      inset: 0,
      zIndex: 99,
    },
    panel: {
      position: 'fixed' as const,
      width: 440,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      boxShadow: `0 4px 16px ${t.shadow}`,
      zIndex: 100,
    },
    panelHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '12px 16px',
      borderBottom: `1px solid ${t.borderLight}`,
    },
    panelTitle: {
      fontSize: 12,
      fontWeight: 600,
      color: t.textHeading,
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 18,
      color: t.textMuted,
      cursor: 'pointer',
      padding: 0,
      lineHeight: 1,
    },
    emptyMsg: {
      padding: '16px',
      fontSize: 12,
      color: t.textMuted,
    },
    sortRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '8px 16px',
      borderBottom: `1px solid ${t.borderLight}`,
    },
    orderLabel: {
      fontSize: 11,
      fontWeight: 500,
      color: t.textMuted,
      width: 52,
      flexShrink: 0,
      textAlign: 'right' as const,
    },
    select: {
      padding: '6px 8px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bg,
      color: t.text,
      outline: 'none',
      flex: 1,
      minWidth: 80,
    },
    dirBtn: {
      padding: '5px 8px',
      fontSize: 10,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
      whiteSpace: 'nowrap' as const,
    },
    dirBtnActive: {
      background: t.accent,
      color: '#fff',
      borderColor: t.accent,
    },
    removeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 16,
      color: t.textMuted,
      cursor: 'pointer',
      padding: '0 4px',
      lineHeight: 1,
      flexShrink: 0,
    },
    panelFooter: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 16px',
    },
    addBtn: {
      fontSize: 12,
      fontWeight: 500,
      color: t.accent,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: 0,
    },
    clearBtn: {
      fontSize: 12,
      fontWeight: 500,
      color: t.textMuted,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: 0,
    },
  };
}
