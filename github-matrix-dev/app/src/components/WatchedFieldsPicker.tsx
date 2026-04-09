/**
 * WatchedFieldsPicker — floating panel for configuring which fields a
 * `lastModifiedTime` column watches.
 *
 * Stores the selection as `{ type: 'lastModifiedTime', watchedFields: string[] }`
 * via a DEF dispatch on `scope._schema.{fieldKey}.type`.
 */

import { useState, useEffect } from 'react';
import { useTheme } from '../theme';
import { usePanelPosition } from '../hooks/usePanelPosition';
import type { ColumnDef } from './filter-types';

export interface WatchedFieldsPickerProps {
  x: number;
  y: number;
  /** The lastModifiedTime column being configured. */
  fieldKey: string;
  /** All other columns to pick from (system cols excluded by caller). */
  allColumns: ColumnDef[];
  /** Already-saved watchedFields from the schema (empty = watch all). */
  currentWatched: string[];
  onSave: (selected: string[]) => void;
  onClose: () => void;
}

export function WatchedFieldsPicker({
  x, y, allColumns, currentWatched, onSave, onClose,
}: WatchedFieldsPickerProps) {
  const { theme: t } = useTheme();
  const [selected, setSelected] = useState<Set<string>>(new Set(currentWatched));

  const { panelRef, style: panelStyle } = usePanelPosition({
    open: true,
    placement: 'bottom-start',
    virtualAnchor: { x, y },
    estimatedWidth: 260,
    estimatedHeight: Math.min(400, 80 + allColumns.length * 30),
  });

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  function toggle(key: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <>
      {/* Backdrop */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        ref={panelRef}
        style={{
          ...panelStyle,
          position: 'fixed',
          zIndex: 9999,
          background: t.bgCard,
          border: `1px solid ${t.border}`,
          borderRadius: 8,
          boxShadow: `0 8px 30px ${t.shadow}, 0 2px 8px ${t.shadow}`,
          minWidth: 240,
          maxWidth: 300,
          padding: '12px 0 8px',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '0 12px 8px',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase' as const,
          letterSpacing: '0.05em',
          color: t.textMuted,
          borderBottom: `1px solid ${t.border}`,
          marginBottom: 4,
        }}>
          Watched fields for last modified
        </div>

        {/* Helper text */}
        <div style={{ padding: '6px 12px 4px', fontSize: 11, color: t.textSecondary }}>
          {selected.size === 0
            ? 'All fields watched (select specific fields to narrow)'
            : `${selected.size} field${selected.size !== 1 ? 's' : ''} selected`}
        </div>

        {/* Field list */}
        <div style={{ maxHeight: 280, overflowY: 'auto' as const, padding: '2px 0' }}>
          {allColumns.length === 0 && (
            <div style={{ padding: '8px 12px', fontSize: 12, color: t.textMuted }}>No fields available</div>
          )}
          {allColumns.map(col => (
            <label
              key={col.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 12px',
                cursor: 'pointer',
                fontSize: 12,
                color: t.text,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = t.bgHover ?? t.bgMuted)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <input
                type="checkbox"
                checked={selected.has(col.key)}
                onChange={() => toggle(col.key)}
                style={{ margin: 0, accentColor: t.accent }}
              />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                {col.label}
              </span>
              <span style={{ fontSize: 10, color: t.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>
                {col.type}
              </span>
            </label>
          ))}
        </div>

        {/* Footer buttons */}
        <div style={{
          display: 'flex',
          gap: 6,
          padding: '8px 12px 4px',
          borderTop: `1px solid ${t.border}`,
          marginTop: 4,
        }}>
          <button
            style={{
              flex: 1,
              padding: '5px 10px',
              fontSize: 12,
              fontWeight: 600,
              border: `1px solid ${t.accent}`,
              borderRadius: 5,
              background: t.accent,
              color: '#fff',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
            onClick={() => { onSave([...selected]); onClose(); }}
          >
            Save
          </button>
          <button
            style={{
              flex: 1,
              padding: '5px 10px',
              fontSize: 12,
              border: `1px solid ${t.border}`,
              borderRadius: 5,
              background: 'transparent',
              color: t.text,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
