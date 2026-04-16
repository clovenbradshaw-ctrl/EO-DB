import { useEffect, useMemo, useRef, useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import type { ColumnDef } from './filter-types';
import { COLUMN_TYPE_ICON_MAP } from './ColumnTypeSelector';
import { useTheme, type Theme } from '../theme';
import { usePanelPosition } from '../hooks/usePanelPosition';

interface FieldPickerProps {
  columns: ColumnDef[];
  value: string;
  onChange: (key: string) => void;
  placeholder?: string;
}

const GROUP_ORDER = ['Basic', 'Numeric', 'Select', 'Date & Time', 'Other', 'Computed', 'Metadata'];

type Row =
  | { kind: 'header'; label: string }
  | { kind: 'item'; col: ColumnDef };

export function FieldPicker({
  columns, value, onChange, placeholder = 'Select field\u2026',
}: FieldPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { anchorRef, panelRef, style: panelStyle } = usePanelPosition({
    open,
    placement: 'bottom-start',
    estimatedWidth: 320,
    estimatedHeight: 340,
  });

  const selected = value ? columns.find(c => c.key === value) : undefined;
  const selectedInfo = selected ? COLUMN_TYPE_ICON_MAP.get(selected.type) : undefined;

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      const byGroup = new Map<string, ColumnDef[]>();
      for (const c of columns) {
        const info = COLUMN_TYPE_ICON_MAP.get(c.type);
        const group = info?.group ?? 'Other';
        const arr = byGroup.get(group) || [];
        arr.push(c);
        byGroup.set(group, arr);
      }
      for (const arr of byGroup.values()) {
        arr.sort((a, b) => a.label.localeCompare(b.label));
      }
      const out: Row[] = [];
      for (const g of GROUP_ORDER) {
        const arr = byGroup.get(g);
        if (!arr || arr.length === 0) continue;
        out.push({ kind: 'header', label: g });
        for (const col of arr) out.push({ kind: 'item', col });
      }
      return out;
    }
    const matches = columns.filter(c => {
      const info = COLUMN_TYPE_ICON_MAP.get(c.type);
      const typeLabel = info?.label.toLowerCase() ?? '';
      return c.label.toLowerCase().includes(q)
        || c.key.toLowerCase().includes(q)
        || typeLabel.includes(q);
    });
    matches.sort((a, b) => a.label.localeCompare(b.label));
    return matches.map<Row>(col => ({ kind: 'item', col }));
  }, [columns, query]);

  const itemIndices = useMemo(
    () => rows.map((r, i) => (r.kind === 'item' ? i : -1)).filter(i => i >= 0),
    [rows],
  );

  useEffect(() => {
    if (!open) return;
    setHighlight(itemIndices[0] ?? 0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, itemIndices]);

  useEffect(() => {
    if (!open) return;
    if (!itemIndices.includes(highlight)) {
      setHighlight(itemIndices[0] ?? -1);
    }
  }, [highlight, itemIndices, open]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-idx="${highlight}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  function moveHighlight(delta: 1 | -1) {
    if (itemIndices.length === 0) return;
    const cur = itemIndices.indexOf(highlight);
    const nextPos = cur < 0
      ? (delta === 1 ? 0 : itemIndices.length - 1)
      : (cur + delta + itemIndices.length) % itemIndices.length;
    setHighlight(itemIndices[nextPos]);
  }

  function commit(col: ColumnDef) {
    onChange(col.key);
    setOpen(false);
    setQuery('');
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveHighlight(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveHighlight(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[highlight];
      if (row?.kind === 'item') commit(row.col);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      setOpen(false);
      setQuery('');
    }
  }

  const TriggerIcon = selectedInfo?.icon;

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={anchorRef as React.RefObject<HTMLButtonElement>}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-label="Filter field"
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          ...s.trigger,
          ...(value ? {} : s.triggerEmpty),
        }}
      >
        {TriggerIcon && selectedInfo ? (
          <TriggerIcon size={12} weight="bold" color={selectedInfo.color} style={{ flexShrink: 0 }} />
        ) : null}
        <span style={s.triggerLabel}>{selected?.label ?? placeholder}</span>
        <CaretDown size={10} weight="bold" style={{ flexShrink: 0, opacity: 0.6 }} />
      </button>

      {open && (
        <>
          <div style={s.backdrop} onClick={() => { setOpen(false); setQuery(''); }} />
          <div ref={panelRef} style={{ ...s.panel, ...panelStyle }} role="listbox">
            <div style={s.searchRow}>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Search fields or types\u2026"
                aria-label="Search fields"
                style={s.searchInput}
              />
            </div>
            <div ref={listRef} style={s.list}>
              {rows.length === 0 && (
                <div style={s.empty}>No matching fields</div>
              )}
              {rows.map((row, idx) => {
                if (row.kind === 'header') {
                  return (
                    <div key={`h-${row.label}-${idx}`} style={s.groupHeader}>{row.label}</div>
                  );
                }
                const info = COLUMN_TYPE_ICON_MAP.get(row.col.type);
                const Icon = info?.icon;
                const active = idx === highlight;
                const isSelected = row.col.key === value;
                return (
                  <div
                    key={row.col.key}
                    data-row-idx={idx}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => commit(row.col)}
                    style={{ ...s.item, ...(active ? s.itemActive : {}) }}
                  >
                    {Icon && info ? (
                      <Icon size={14} weight="bold" color={info.color} style={{ flexShrink: 0 }} />
                    ) : (
                      <span style={{ width: 14, flexShrink: 0 }} />
                    )}
                    <span style={s.itemLabel}>{row.col.label}</span>
                    {info && (
                      <span style={s.typeBadge(info.color)}>{info.label}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace('#', '').match(/^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return `rgba(127,127,127,${alpha})`;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function makeStyles(t: Theme) {
  return {
    trigger: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 8px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bg,
      color: t.text,
      cursor: 'pointer',
      minWidth: 140,
      maxWidth: 200,
    } as React.CSSProperties,
    triggerEmpty: {
      color: t.textMuted,
      fontStyle: 'italic' as const,
    } as React.CSSProperties,
    triggerLabel: {
      flex: 1,
      textAlign: 'left' as const,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    } as React.CSSProperties,
    backdrop: {
      position: 'fixed' as const,
      inset: 0,
      zIndex: 200,
    } as React.CSSProperties,
    panel: {
      position: 'fixed' as const,
      width: 320,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      boxShadow: `0 4px 16px ${t.shadow}`,
      zIndex: 201,
      display: 'flex',
      flexDirection: 'column' as const,
      maxHeight: 340,
    } as React.CSSProperties,
    searchRow: {
      padding: 8,
      borderBottom: `1px solid ${t.borderLight}`,
    } as React.CSSProperties,
    searchInput: {
      width: '100%',
      padding: '6px 8px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bg,
      color: t.text,
      outline: 'none',
      boxSizing: 'border-box' as const,
    } as React.CSSProperties,
    list: {
      overflowY: 'auto' as const,
      padding: '4px 0',
      flex: 1,
    } as React.CSSProperties,
    empty: {
      padding: '12px 16px',
      fontSize: 11,
      color: t.textMuted,
      fontStyle: 'italic' as const,
    } as React.CSSProperties,
    groupHeader: {
      padding: '6px 12px 2px',
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: 0.5,
      textTransform: 'uppercase' as const,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    } as React.CSSProperties,
    item: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 12px',
      cursor: 'pointer',
      fontSize: 12,
      color: t.text,
    } as React.CSSProperties,
    itemActive: {
      background: t.bgHover,
    } as React.CSSProperties,
    itemLabel: {
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    } as React.CSSProperties,
    typeBadge: (color: string): React.CSSProperties => ({
      fontSize: 8,
      fontWeight: 700,
      fontFamily: "'JetBrains Mono', monospace",
      textTransform: 'uppercase' as const,
      padding: '1px 5px',
      borderRadius: 3,
      background: hexToRgba(color, 0.12),
      color,
      flexShrink: 0,
    }),
  };
}
