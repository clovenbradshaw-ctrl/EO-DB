import { useState, useEffect } from 'react';
import { useTheme, type Theme } from '../theme';
import type { ColumnType } from './filter-types';
import {
  TextT,
  TextAlignLeft,
  Envelope,
  Globe,
  Phone,
  Hash,
  CurrencyDollar,
  Percent,
  Star,
  Timer,
  CaretCircleDown,
  ListChecks,
  Calendar,
  CheckSquare,
  Paperclip,
  ArrowSquareOut,
  LinkSimple,
  ShareNetwork,
  MathOperations,
  ArrowsClockwise,
  MagnifyingGlass,
  ListNumbers,
  NumberCircleOne,
  Clock,
  ClockCounterClockwise,
  UserCircle,
  UserCircleMinus,
  type Icon,
} from '@phosphor-icons/react';

// ─── Icon + color mapping (exported for column headers) ─────────────────────

export interface ColumnTypeInfo {
  value: ColumnType;
  label: string;
  icon: Icon;
  color: string;
  group: string;
}

export const COLUMN_TYPE_DEFS: ColumnTypeInfo[] = [
  // Basic
  { value: 'text',               label: 'Text',               icon: TextT,                  color: '#7a756d', group: 'Basic' },
  { value: 'richText',           label: 'Rich Text',           icon: TextAlignLeft,           color: '#7a756d', group: 'Basic' },
  { value: 'email',              label: 'Email',               icon: Envelope,                color: '#3b82f6', group: 'Basic' },
  { value: 'url',                label: 'URL',                 icon: Globe,                   color: '#3b82f6', group: 'Basic' },
  { value: 'phone',              label: 'Phone',               icon: Phone,                   color: '#3b82f6', group: 'Basic' },
  // Numeric
  { value: 'number',             label: 'Number',              icon: Hash,                    color: '#3b82f6', group: 'Numeric' },
  { value: 'currency',           label: 'Currency',            icon: CurrencyDollar,          color: '#16a34a', group: 'Numeric' },
  { value: 'percent',            label: 'Percent',             icon: Percent,                 color: '#3b82f6', group: 'Numeric' },
  { value: 'rating',             label: 'Rating',              icon: Star,                    color: '#f59e0b', group: 'Numeric' },
  { value: 'duration',           label: 'Duration',            icon: Timer,                   color: '#e67e22', group: 'Numeric' },
  // Select
  { value: 'select',             label: 'Select',              icon: CaretCircleDown,         color: '#9b59b6', group: 'Select' },
  { value: 'multiSelect',        label: 'Multi Select',        icon: ListChecks,              color: '#9b59b6', group: 'Select' },
  // Date & Time
  { value: 'date',               label: 'Date',                icon: Calendar,                color: '#e67e22', group: 'Date & Time' },
  // Other
  { value: 'boolean',            label: 'Boolean',             icon: CheckSquare,             color: '#27ae60', group: 'Other' },
  { value: 'attachment',         label: 'Attachment',           icon: Paperclip,               color: '#6b7280', group: 'Other' },
  { value: 'link',               label: 'Link',                icon: LinkSimple,               color: '#8b5cf6', group: 'Other' },
  { value: 'relationship',       label: 'Relationship',        icon: ShareNetwork,             color: '#06b6d4', group: 'Other' },
  { value: 'linkedRecord',       label: 'Linked Record (legacy)', icon: ArrowSquareOut,        color: '#8b5cf6', group: 'Other' },
  // Computed
  { value: 'formula',            label: 'Formula',             icon: MathOperations,          color: '#ef4444', group: 'Computed' },
  { value: 'rollup',             label: 'Rollup',              icon: ArrowsClockwise,         color: '#ef4444', group: 'Computed' },
  { value: 'lookup',             label: 'Lookup',              icon: MagnifyingGlass,         color: '#ef4444', group: 'Computed' },
  { value: 'count',              label: 'Count',               icon: ListNumbers,             color: '#ef4444', group: 'Computed' },
  // Metadata
  { value: 'autoNumber',         label: 'Auto Number',         icon: NumberCircleOne,         color: '#94a3b8', group: 'Metadata' },
  { value: 'createdTime',        label: 'Created Time',        icon: Clock,                   color: '#94a3b8', group: 'Metadata' },
  { value: 'lastModifiedTime',   label: 'Modified Time',       icon: ClockCounterClockwise,   color: '#94a3b8', group: 'Metadata' },
  { value: 'createdBy',          label: 'Created By',          icon: UserCircle,              color: '#94a3b8', group: 'Metadata' },
  { value: 'lastModifiedBy',     label: 'Modified By',         icon: UserCircleMinus,         color: '#94a3b8', group: 'Metadata' },
];

/** Quick lookup: ColumnType → icon + color info. */
export const COLUMN_TYPE_ICON_MAP = new Map<ColumnType, ColumnTypeInfo>(
  COLUMN_TYPE_DEFS.map(d => [d.value, d]),
);

// ─── Group ordering ─────────────────────────────────────────────────────────

const GROUP_ORDER = ['Basic', 'Numeric', 'Select', 'Date & Time', 'Other', 'Computed', 'Metadata'];

// ─── Select option chip colors ───────────────────────────────────────────────

const OPTION_COLORS: Array<{ bg: string; color: string; dot: string }> = [
  { bg: '#e8f0fe', color: '#1a56b0', dot: '#4285f4' }, // blue
  { bg: '#fce8f3', color: '#9b2c70', dot: '#e91e8c' }, // pink
  { bg: '#e6f4ea', color: '#1a6632', dot: '#34a853' }, // green
  { bg: '#fef3e2', color: '#8a5a00', dot: '#fbbc04' }, // yellow
  { bg: '#f3e8fd', color: '#6b21a8', dot: '#9b59b6' }, // purple
  { bg: '#fde8e8', color: '#9b1c1c', dot: '#ef4444' }, // red
  { bg: '#e8fdf5', color: '#065f46', dot: '#10b981' }, // teal
  { bg: '#fff3e0', color: '#7c3900', dot: '#f97316' }, // orange
];

function groupedTypes(): Array<{ group: string; items: ColumnTypeInfo[] }> {
  const map = new Map<string, ColumnTypeInfo[]>();
  for (const def of COLUMN_TYPE_DEFS) {
    const arr = map.get(def.group) || [];
    arr.push(def);
    map.set(def.group, arr);
  }
  return GROUP_ORDER.filter(g => map.has(g)).map(g => ({ group: g, items: map.get(g)! }));
}

// ─── Component ──────────────────────────────────────────────────────────────

interface ColumnTypeSelectorProps {
  currentType: string;
  isDefined: boolean;
  selectOptions?: string[];
  onSelect: (type: string) => void;
  onSaveOptions?: (options: string[]) => void;
  onClear: () => void;
  onClose: () => void;
}

export function ColumnTypeSelector({
  currentType,
  isDefined,
  selectOptions,
  onSelect,
  onSaveOptions,
  onClear,
  onClose,
}: ColumnTypeSelectorProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const groups = groupedTypes();
  const isSelectType = currentType === 'select' || currentType === 'multiSelect';
  const [localOptions, setLocalOptions] = useState<string[]>(isSelectType ? (selectOptions ?? []) : []);
  const [newOption, setNewOption] = useState('');

  useEffect(() => {
    setLocalOptions(isSelectType ? (selectOptions ?? []) : []);
  }, [selectOptions, isSelectType]);

  return (
    <div style={s.container}>
      <div style={s.header}>
        <span style={s.title}>⊢ COLUMN TYPE</span>
        <button style={s.closeBtn} onClick={onClose}>&times;</button>
      </div>
      <div style={s.scrollArea}>
        {groups.map(({ group, items }) => (
          <div key={group}>
            <div style={s.groupLabel}>{group}</div>
            {items.map((ct) => {
              const isActive = currentType === ct.value;
              const IconComp = ct.icon;
              return (
                <button
                  key={ct.value}
                  onClick={() => onSelect(ct.value)}
                  style={{
                    ...s.typeBtn,
                    background: isActive ? `${ct.color}15` : 'transparent',
                    borderColor: isActive ? ct.color : 'transparent',
                    color: isActive ? ct.color : theme.text,
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) (e.currentTarget as HTMLElement).style.background = theme.bgHover;
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent';
                  }}
                >
                  <IconComp size={14} weight="regular" color={isActive ? ct.color : theme.textMuted} />
                  <span style={{ flex: 1 }}>{ct.label}</span>
                  {isActive && (
                    <span style={s.sourceLabel}>
                      {isDefined ? 'defined' : 'inferred'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {isSelectType && onSaveOptions && (
        <div style={s.optionsSection}>
          <div style={s.optionsSectionTitle}>OPTIONS</div>
          {localOptions.map((opt, i) => {
            const chip = OPTION_COLORS[i % OPTION_COLORS.length];
            return (
              <div key={i} style={s.optionRow}>
                <div style={{ ...s.optionChip, background: chip.bg, color: chip.color }}>
                  <span style={{ ...s.optionDot, background: chip.dot }} />
                  <span style={s.optionChipText}>{opt}</span>
                </div>
                <button
                  style={s.optionDeleteBtn}
                  onClick={() => {
                    const next = localOptions.filter((_, j) => j !== i);
                    setLocalOptions(next);
                    onSaveOptions(next);
                  }}
                  title={`Remove "${opt}"`}
                >&times;</button>
              </div>
            );
          })}
          <div style={s.addOptionRow}>
            <input
              style={{ ...s.addOptionInput, color: theme.text }}
              placeholder="Add option…"
              value={newOption}
              onChange={e => setNewOption(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newOption.trim()) {
                  const next = [...localOptions, newOption.trim()];
                  setLocalOptions(next);
                  onSaveOptions(next);
                  setNewOption('');
                }
              }}
            />
            <button
              style={{
                ...s.addOptionBtn,
                opacity: newOption.trim() ? 1 : 0.4,
                cursor: newOption.trim() ? 'pointer' : 'default',
              }}
              disabled={!newOption.trim()}
              onClick={() => {
                if (!newOption.trim()) return;
                const next = [...localOptions, newOption.trim()];
                setLocalOptions(next);
                onSaveOptions(next);
                setNewOption('');
              }}
            >+</button>
          </div>
        </div>
      )}
      {isDefined && (
        <button style={s.clearBtn} onClick={onClear}>
          Clear definition
        </button>
      )}
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      padding: 12,
      minWidth: 200,
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    title: {
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.08em',
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 16,
      color: t.textMuted,
      cursor: 'pointer',
      padding: '0 2px',
      lineHeight: 1,
    },
    scrollArea: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      maxHeight: 400,
      overflowY: 'auto',
    },
    groupLabel: {
      fontSize: 8,
      fontWeight: 700,
      letterSpacing: '0.1em',
      textTransform: 'uppercase' as const,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
      padding: '6px 10px 2px',
      marginTop: 4,
    },
    typeBtn: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      padding: '5px 10px',
      border: '1px solid transparent',
      borderRadius: 6,
      cursor: 'pointer',
      fontSize: 12,
      fontFamily: 'inherit',
      textAlign: 'left' as const,
      transition: 'background 0.1s',
    },
    sourceLabel: {
      fontSize: 9,
      fontWeight: 500,
      opacity: 0.6,
      fontFamily: "'JetBrains Mono', monospace",
    },
    clearBtn: {
      display: 'block',
      width: '100%',
      padding: '5px 10px',
      marginTop: 8,
      paddingTop: 8,
      borderTop: `1px solid ${t.border}`,
      fontSize: 11,
      border: 'none',
      borderRadius: 4,
      background: 'transparent',
      color: t.danger,
      cursor: 'pointer',
      textAlign: 'left' as const,
      fontFamily: 'inherit',
    },
    optionsSection: {
      marginTop: 8,
      paddingTop: 8,
      borderTop: `1px solid ${t.border}`,
    },
    optionsSectionTitle: {
      fontSize: 8,
      fontWeight: 700,
      letterSpacing: '0.1em',
      textTransform: 'uppercase' as const,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
      padding: '4px 10px 6px',
    },
    optionRow: {
      display: 'flex',
      alignItems: 'center',
      padding: '3px 10px',
      gap: 6,
    },
    optionChip: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      flex: 1,
      minWidth: 0,
      padding: '2px 7px 2px 5px',
      borderRadius: 10,
      fontSize: 11,
      fontWeight: 500,
      overflow: 'hidden',
    },
    optionDot: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      flexShrink: 0,
    },
    optionChipText: {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    optionDeleteBtn: {
      background: 'none',
      border: 'none',
      fontSize: 14,
      color: t.textMuted,
      cursor: 'pointer',
      padding: '0 2px',
      lineHeight: 1,
      flexShrink: 0,
      opacity: 0.6,
    },
    addOptionRow: {
      display: 'flex',
      alignItems: 'center',
      padding: '4px 10px 2px',
      gap: 4,
    },
    addOptionInput: {
      flex: 1,
      fontSize: 11,
      padding: '3px 6px',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgCard,
      fontFamily: 'inherit',
      outline: 'none',
    },
    addOptionBtn: {
      background: 'none',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      fontSize: 14,
      color: t.textMuted,
      padding: '2px 6px',
      lineHeight: 1,
      fontFamily: 'inherit',
    },
  };
}
