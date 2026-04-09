import { useState, useMemo } from 'react';
import { useTheme, type Theme } from '../theme';
import type { ColumnDef } from './filter-types';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ColumnManagerPanelProps {
  /** All possible columns (including currently hidden ones) */
  allColumns: ColumnDef[];
  /** Current ordered + visible column keys */
  columnOrder: string[];
  /** Set of hidden column keys */
  hiddenColumns: Set<string>;
  onToggleColumn: (key: string) => void;
  onReorder: (newOrder: string[]) => void;
  onShowAll: () => void;
  onHideAll: () => void;
  onClose: () => void;
  /** Open the "Add field" dialog */
  onAddColumn?: () => void;
}

// ---------------------------------------------------------------------------
// Main Panel
// ---------------------------------------------------------------------------

export function ColumnManagerPanel({
  allColumns,
  columnOrder,
  hiddenColumns,
  onToggleColumn,
  onReorder,
  onShowAll,
  onHideAll,
  onClose,
  onAddColumn,
}: ColumnManagerPanelProps) {
  const { theme } = useTheme();
  const [search, setSearch] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  // Build the full ordered list: saved order first, then any remaining columns
  const orderedAll = useMemo(() => {
    const byKey = new Map(allColumns.map((c) => [c.key, c]));
    const result: ColumnDef[] = [];
    for (const key of columnOrder) {
      const col = byKey.get(key);
      if (col) {
        result.push(col);
        byKey.delete(key);
      }
    }
    // Append columns not yet in the order
    for (const col of allColumns) {
      if (byKey.has(col.key)) result.push(col);
    }
    return result;
  }, [allColumns, columnOrder]);

  // Filter by search
  const filtered = useMemo(() => {
    if (!search) return orderedAll;
    const q = search.toLowerCase();
    return orderedAll.filter((c) => c.label.toLowerCase().includes(q));
  }, [orderedAll, search]);

  const visibleCount = allColumns.filter((c) => !hiddenColumns.has(c.key)).length;

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const keys = orderedAll.map((c) => c.key);
    const oldIndex = keys.indexOf(active.id as string);
    const newIndex = keys.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(keys, oldIndex, newIndex));
  }

  const s = styles(theme);

  return (
    <>
      {/* Backdrop */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={onClose} />

      {/* Panel */}
      <div style={s.panel}>
        <div style={s.header}>
          <span style={s.title}>Fields</span>
          <span style={s.badge}>{visibleCount}/{allColumns.length}</span>
        </div>

        {/* Search */}
        {allColumns.length > 6 && (
          <div style={s.searchWrap}>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search fields..."
              style={s.searchInput}
            />
          </div>
        )}

        {/* Column list */}
        <div style={s.list}>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={filtered.map((c) => c.key)} strategy={verticalListSortingStrategy}>
              {filtered.map((col) => (
                <SortableColumnRow
                  key={col.key}
                  col={col}
                  isVisible={!hiddenColumns.has(col.key)}
                  onToggle={() => onToggleColumn(col.key)}
                  theme={theme}
                  isDragDisabled={!!search}
                />
              ))}
            </SortableContext>
          </DndContext>
          {filtered.length === 0 && (
            <div style={{ padding: '12px 0', fontSize: 11, color: theme.textMuted, textAlign: 'center' as const }}>
              No matching fields
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div style={s.footer}>
          <button onClick={onShowAll} style={s.footerBtn}>
            Show all
          </button>
          <button onClick={onHideAll} style={{ ...s.footerBtn, color: theme.textMuted }}>
            Hide all
          </button>
          {onAddColumn && (
            <button onClick={onAddColumn} style={{ ...s.footerBtn, marginLeft: 'auto' }}>
              + Add field
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sortable Row
// ---------------------------------------------------------------------------

interface SortableColumnRowProps {
  col: ColumnDef;
  isVisible: boolean;
  onToggle: () => void;
  theme: Theme;
  isDragDisabled: boolean;
}

function SortableColumnRow({ col, isVisible, onToggle, theme, isDragDisabled }: SortableColumnRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: col.key, disabled: isDragDisabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform ? { ...transform, x: 0 } : null),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px',
    borderRadius: 4,
    cursor: isDragDisabled ? 'default' : 'grab',
    background: isDragging ? theme.bgHover : 'transparent',
  };

  const typeBadgeColors: Record<string, string> = {
    text: theme.textMuted,
    number: theme.accent,
    date: '#e67e22',
    select: '#9b59b6',
    boolean: '#27ae60',
    object: theme.textSecondary,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      {/* Drag handle */}
      <span
        {...(isDragDisabled ? {} : listeners)}
        style={{
          display: 'flex',
          alignItems: 'center',
          cursor: isDragDisabled ? 'default' : 'grab',
          color: theme.textMuted,
          fontSize: 11,
          flexShrink: 0,
          opacity: isDragDisabled ? 0.3 : 0.6,
          userSelect: 'none',
          lineHeight: 1,
        }}
        title="Drag to reorder"
      >
        ⠿
      </span>

      {/* Toggle switch */}
      <button
        onClick={onToggle}
        style={{
          width: 28,
          height: 16,
          borderRadius: 8,
          border: 'none',
          cursor: 'pointer',
          position: 'relative' as const,
          flexShrink: 0,
          background: isVisible ? theme.accent : theme.bgMuted,
          transition: 'background 0.15s ease',
        }}
        title={isVisible ? 'Hide column' : 'Show column'}
      >
        <span style={{
          position: 'absolute',
          top: 2,
          left: isVisible ? 14 : 2,
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: isVisible ? '#fff' : theme.textMuted,
          transition: 'left 0.15s ease',
        }} />
      </button>

      {/* Column name */}
      <span style={{
        fontSize: 12,
        color: isVisible ? theme.text : theme.textMuted,
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap' as const,
      }}>
        {col.label}
      </span>

      {/* Type badge */}
      <span style={{
        fontSize: 9,
        color: typeBadgeColors[col.type] || theme.textMuted,
        background: theme.bgMuted,
        padding: '1px 5px',
        borderRadius: 3,
        flexShrink: 0,
        textTransform: 'uppercase' as const,
        letterSpacing: '0.3px',
        fontWeight: 500,
      }}>
        {col.type}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function styles(t: Theme) {
  return {
    panel: {
      position: 'absolute' as const,
      top: '100%',
      right: 0,
      zIndex: 9999,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      boxShadow: `0 8px 30px ${t.shadow}`,
      minWidth: 260,
      maxWidth: 320,
      maxHeight: 420,
      display: 'flex',
      flexDirection: 'column' as const,
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 12px 6px',
    },
    title: {
      fontSize: 11,
      fontWeight: 600,
      color: t.textHeading,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.5px',
    },
    badge: {
      fontSize: 10,
      color: t.textMuted,
      background: t.bgMuted,
      padding: '1px 6px',
      borderRadius: 4,
    },
    searchWrap: {
      padding: '0 12px 6px',
    },
    searchInput: {
      width: '100%',
      height: 26,
      fontSize: 11,
      padding: '0 8px',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgCard,
      color: t.text,
      outline: 'none',
      boxSizing: 'border-box' as const,
    },
    list: {
      flex: 1,
      overflowY: 'auto' as const,
      padding: '0 4px',
    },
    footer: {
      display: 'flex',
      gap: 8,
      padding: '8px 12px',
      borderTop: `1px solid ${t.border}`,
    },
    footerBtn: {
      fontSize: 10,
      background: 'none',
      border: 'none',
      color: t.accent,
      cursor: 'pointer',
      padding: 0,
      fontWeight: 500,
    },
  };
}
