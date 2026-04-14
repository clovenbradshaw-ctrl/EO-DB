import { useEffect, useMemo, useRef, useState } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import { useSliceStore } from '../store/slice-store';
import { useTheme, type Theme } from '../theme';
import {
  deriveColumns,
  buildFieldNameMap,
  buildFieldNameMapFromSchema,
  hasFieldsSubObject,
  getFieldValue,
  type ColumnDef,
} from './filter-types';
import { groupSchemaStates, extractColumnTypeOverrides } from '../db/schema-rules';
import { isDeleted } from '../db/tombstone';
import { resolveRecordName } from './TableView';
import type { ResolvedPermissions } from '../permissions/types';

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Parse any value to a local-time Date, or null if it can't be parsed. */
function parseDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Year-month-day key, local time. */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Returns the Date for the first cell of the month grid (Sunday on/before day 1). */
function monthGridStart(year: number, month: number): Date {
  const first = new Date(year, month, 1);
  const weekday = first.getDay(); // 0 = Sunday
  return new Date(year, month, 1 - weekday);
}

/** Build a 6-row × 7-col grid of Dates for the given month. */
function buildMonthGrid(year: number, month: number): Date[] {
  const start = monthGridStart(year, month);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CalendarViewProps {
  scope: string;
  onSelectRecord: (target: string) => void;
  activeRecord?: string | null;
  session: { userId: string };
  permissions?: ResolvedPermissions | null;
  sliceReadOnly?: boolean;
}

export function CalendarView({
  scope,
  onSelectRecord,
  activeRecord,
}: CalendarViewProps) {
  const { theme } = useTheme();
  const s = styles(theme);

  const getStateByPrefix = useEoStore((st) => st.getStateByPrefix);
  const getState = useEoStore((st) => st.getState);
  const ready = useEoStore((st) => st.ready);
  const lastSeq = useEoStore((st) => st.lastSeq);
  const sliceStore = useSliceStore();

  const config = sliceStore.getConfig(scope);
  const calendarField = config.calendarField;

  const [records, setRecords] = useState<EoState[]>([]);
  const [fieldNameMap, setFieldNameMap] = useState<Map<string, string>>(new Map());
  const [columnTypeOverrides, setColumnTypeOverrides] = useState<Map<string, any>>(new Map());

  // Month being displayed — initialized to today
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());

  const fetchGenRef = useRef(0);
  const scopeDepth = scope.split('.').length;

  useEffect(() => {
    if (!ready) return;
    const gen = ++fetchGenRef.current;

    function filterDirect(states: EoState[]): EoState[] {
      return states.filter((st) => {
        const parts = st.target.split('.');
        if (parts.length !== scopeDepth + 1 || st.value?._alias) return false;
        const segment = parts[parts.length - 1];
        if (segment.startsWith('_')) return false;
        if (isDeleted(st)) return false;
        return true;
      });
    }

    getStateByPrefix(scope + '.').then((states) => {
      if (gen !== fetchGenRef.current) return;
      setRecords(filterDirect(states));
    });

    getStateByPrefix(scope + '._schema.').then((allSchemaStates) => {
      if (gen !== fetchGenRef.current) return;
      const schemaPrefix = scope + '._schema.';
      const schemaDepth = scope.split('.').length + 2;
      const fieldStates = allSchemaStates.filter(
        (st) => st.target.split('.').length === schemaDepth && !st.value?._alias,
      );
      if (fieldStates.length > 0) {
        setFieldNameMap(buildFieldNameMapFromSchema(fieldStates));
      } else {
        getState(scope).then((scopeState) => {
          if (gen !== fetchGenRef.current) return;
          const fields = scopeState?.value?.fields;
          if (Array.isArray(fields)) {
            setFieldNameMap(buildFieldNameMap(fields));
          } else {
            setFieldNameMap(new Map());
          }
        });
      }
      const grouped = groupSchemaStates(allSchemaStates, schemaPrefix);
      setColumnTypeOverrides(extractColumnTypeOverrides(grouped));
    });
  }, [ready, lastSeq, getStateByPrefix, getState, scope, scopeDepth]);

  const useFieldsSub = useMemo(() => hasFieldsSubObject(records), [records]);
  const columns = useMemo<ColumnDef[]>(
    () => deriveColumns(records, fieldNameMap, columnTypeOverrides, false),
    [records, fieldNameMap, columnTypeOverrides],
  );

  const calendarColumn = useMemo<ColumnDef | null>(
    () => (calendarField ? columns.find((c) => c.key === calendarField) ?? null : null),
    [columns, calendarField],
  );

  const dateCandidates = useMemo(
    () => columns.filter(
      (c) => c.type === 'date' || c.type === 'createdTime' || c.type === 'lastModifiedTime',
    ),
    [columns],
  );

  // Bucket records by local-day key
  const recordsByDay = useMemo(() => {
    const map = new Map<string, { rec: EoState; date: Date }[]>();
    if (!calendarField) return map;
    for (const rec of records) {
      const raw = getFieldValue(rec, calendarField, useFieldsSub);
      const d = parseDate(raw);
      if (!d) continue;
      const key = dayKey(d);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({ rec, date: d });
    }
    // Sort each bucket by date ascending, then record name for stability
    for (const list of map.values()) {
      list.sort((a, b) => {
        const t = a.date.getTime() - b.date.getTime();
        if (t !== 0) return t;
        return a.rec.target.localeCompare(b.rec.target);
      });
    }
    return map;
  }, [records, calendarField, useFieldsSub]);

  const gridCells = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);
  const todayKey = useMemo(() => dayKey(new Date()), []);

  // --- Empty / error states ---

  if (!calendarField) {
    return (
      <div style={s.emptyWrap}>
        <div style={s.emptyIcon}>{'\u25F7'}</div>
        <div style={s.emptyTitle}>Pick a date field to place records on the calendar</div>
        <div style={s.emptySub}>
          Records with a valid date in the chosen field will appear on that day.
        </div>
        <FieldPicker
          options={dateCandidates}
          onPick={(key) => sliceStore.setCalendarField(scope, key)}
          theme={theme}
        />
      </div>
    );
  }

  if (!calendarColumn) {
    return (
      <div style={s.emptyWrap}>
        <div style={s.warningBanner}>
          Field <code>{calendarField}</code> was not found on the current records.
        </div>
        <FieldPicker
          options={dateCandidates}
          onPick={(key) => sliceStore.setCalendarField(scope, key)}
          theme={theme}
        />
      </div>
    );
  }

  const isDateType = calendarColumn.type === 'date'
    || calendarColumn.type === 'createdTime'
    || calendarColumn.type === 'lastModifiedTime';

  if (!isDateType) {
    return (
      <div style={s.emptyWrap}>
        <div style={s.warningBanner}>
          Field <code>{calendarColumn.label}</code> is a <code>{calendarColumn.type}</code>, not a date.
          Pick a date field to use the calendar.
        </div>
        <FieldPicker
          options={dateCandidates}
          onPick={(key) => sliceStore.setCalendarField(scope, key)}
          theme={theme}
        />
      </div>
    );
  }

  // --- Navigation handlers ---

  function prevMonth() {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  }

  function nextMonth() {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  function goToday() {
    const now = new Date();
    setViewYear(now.getFullYear());
    setViewMonth(now.getMonth());
  }

  // --- Render ---

  return (
    <div style={s.wrap}>
      <div style={s.toolbar}>
        <div style={s.toolbarLeft}>
          <button style={s.navBtn} onClick={prevMonth} title="Previous month">{'\u2039'}</button>
          <button style={s.navBtn} onClick={goToday}>Today</button>
          <button style={s.navBtn} onClick={nextMonth} title="Next month">{'\u203A'}</button>
        </div>
        <div style={s.toolbarTitle}>
          {MONTH_LABELS[viewMonth]} {viewYear}
        </div>
        <div style={s.toolbarRight}>
          <span style={s.toolbarLabel}>
            {'by '}
            <code style={s.fieldTag}>{calendarColumn.label}</code>
          </span>
          <button
            style={s.changeBtn}
            onClick={() => sliceStore.setCalendarField(scope, undefined)}
            title="Pick a different date field"
          >
            Change
          </button>
        </div>
      </div>
      <div style={s.weekdayRow}>
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} style={s.weekdayCell}>{w}</div>
        ))}
      </div>
      <div style={s.grid}>
        {gridCells.map((cell) => {
          const key = dayKey(cell);
          const inMonth = cell.getMonth() === viewMonth;
          const isToday = key === todayKey;
          const items = recordsByDay.get(key) || [];
          return (
            <CalendarDayCell
              key={key}
              date={cell}
              inMonth={inMonth}
              isToday={isToday}
              items={items}
              activeRecord={activeRecord ?? null}
              onSelectRecord={onSelectRecord}
              theme={theme}
              s={s}
            />
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day cell
// ---------------------------------------------------------------------------

interface CalendarDayCellProps {
  date: Date;
  inMonth: boolean;
  isToday: boolean;
  items: { rec: EoState; date: Date }[];
  activeRecord: string | null;
  onSelectRecord: (target: string) => void;
  theme: Theme;
  s: Record<string, React.CSSProperties>;
}

const MAX_VISIBLE_ITEMS = 3;

function CalendarDayCell({
  date,
  inMonth,
  isToday,
  items,
  activeRecord,
  onSelectRecord,
  theme,
  s,
}: CalendarDayCellProps) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, MAX_VISIBLE_ITEMS);
  const overflow = items.length - visible.length;

  const cellStyle: React.CSSProperties = {
    ...s.dayCell,
    background: inMonth ? theme.bgCard : theme.bgMuted,
    color: inMonth ? theme.text : theme.textMuted,
    borderColor: isToday ? theme.accent : theme.border,
    boxShadow: isToday ? `inset 0 0 0 1px ${theme.accent}` : undefined,
  };

  return (
    <div style={cellStyle}>
      <div style={s.dayHeader}>
        <span style={isToday ? s.dayNumToday : s.dayNum}>{date.getDate()}</span>
        {items.length > 0 && (
          <span style={s.dayCount}>{items.length}</span>
        )}
      </div>
      <div style={s.dayItems}>
        {visible.map(({ rec }) => {
          const name = resolveRecordName(rec) ?? (rec.target.split('.').pop() || rec.target);
          const isActive = rec.target === activeRecord;
          return (
            <button
              key={rec.target}
              style={{
                ...s.eventChip,
                borderColor: isActive ? theme.accent : theme.borderLight,
                background: isActive ? theme.accentBg : theme.bgCard,
                color: isActive ? theme.accent : theme.text,
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectRecord(rec.target);
              }}
              title={name}
            >
              {name}
            </button>
          );
        })}
        {overflow > 0 && (
          <button
            style={s.moreBtn}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(true);
            }}
          >
            +{overflow} more
          </button>
        )}
        {expanded && items.length > MAX_VISIBLE_ITEMS && (
          <button
            style={s.moreBtn}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(false);
            }}
          >
            show less
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field picker
// ---------------------------------------------------------------------------

interface FieldPickerProps {
  options: ColumnDef[];
  onPick: (key: string) => void;
  theme: Theme;
}

function FieldPicker({ options, onPick, theme }: FieldPickerProps) {
  if (options.length === 0) {
    return (
      <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 12 }}>
        No date fields found on this table.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12, justifyContent: 'center' }}>
      {options.map((col) => (
        <button
          key={col.key}
          onClick={() => onPick(col.key)}
          style={{
            padding: '6px 12px',
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            background: theme.bgCard,
            color: theme.text,
            border: `1px solid ${theme.border}`,
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          {col.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function styles(t: Theme): Record<string, React.CSSProperties> {
  return {
    wrap: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: t.bg,
    },
    toolbar: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 16px',
      borderBottom: `1px solid ${t.border}`,
      background: t.bgCard,
      gap: 12,
    },
    toolbarLeft: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
    toolbarTitle: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      fontWeight: 600,
      color: t.text,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    },
    toolbarRight: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    toolbarLabel: {
      fontSize: 11,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    fieldTag: {
      padding: '2px 6px',
      background: t.bgMuted,
      color: t.text,
      borderRadius: 3,
      fontSize: 10,
    },
    navBtn: {
      padding: '4px 10px',
      fontSize: 12,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.bgCard,
      color: t.text,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      cursor: 'pointer',
      lineHeight: 1.2,
    },
    changeBtn: {
      padding: '4px 10px',
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      background: 'transparent',
      color: t.textSecondary,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      cursor: 'pointer',
    },
    weekdayRow: {
      display: 'grid',
      gridTemplateColumns: 'repeat(7, 1fr)',
      borderBottom: `1px solid ${t.border}`,
      background: t.bgCard,
    },
    weekdayCell: {
      padding: '6px 8px',
      fontSize: 10,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
      textAlign: 'center',
    },
    grid: {
      flex: 1,
      display: 'grid',
      gridTemplateColumns: 'repeat(7, 1fr)',
      gridTemplateRows: 'repeat(6, 1fr)',
      gap: 1,
      background: t.border,
      padding: 1,
      overflow: 'auto',
    },
    dayCell: {
      display: 'flex',
      flexDirection: 'column',
      padding: 6,
      minHeight: 90,
      border: '1px solid transparent',
      overflow: 'hidden',
    },
    dayHeader: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 4,
    },
    dayNum: {
      fontSize: 11,
      fontWeight: 500,
      fontFamily: "'JetBrains Mono', monospace",
    },
    dayNumToday: {
      fontSize: 11,
      fontWeight: 700,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.accent,
      background: t.accentBg,
      padding: '1px 6px',
      borderRadius: 10,
    },
    dayCount: {
      fontSize: 9,
      padding: '0 6px',
      background: t.bgMuted,
      color: t.textMuted,
      borderRadius: 999,
      fontFamily: "'JetBrains Mono', monospace",
    },
    dayItems: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      overflow: 'hidden',
    },
    eventChip: {
      textAlign: 'left',
      padding: '3px 6px',
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      border: `1px solid ${t.borderLight}`,
      borderRadius: 3,
      cursor: 'pointer',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      transition: 'border-color .12s, background .12s',
    },
    moreBtn: {
      textAlign: 'left',
      padding: '2px 6px',
      fontSize: 9,
      fontFamily: "'JetBrains Mono', monospace",
      background: 'transparent',
      color: t.textMuted,
      border: 'none',
      cursor: 'pointer',
    },
    emptyWrap: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
      gap: 6,
      color: t.textMuted,
      background: t.bg,
    },
    emptyIcon: {
      fontSize: 36,
      opacity: 0.3,
      marginBottom: 4,
    },
    emptyTitle: {
      fontSize: 13,
      fontWeight: 500,
      color: t.text,
    },
    emptySub: {
      fontSize: 11,
      opacity: 0.75,
      textAlign: 'center',
      maxWidth: 340,
    },
    warningBanner: {
      padding: '10px 14px',
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.warningBg,
      color: t.warningText,
      border: `1px solid ${t.warningBorder}`,
      borderRadius: 4,
      maxWidth: 440,
      textAlign: 'center',
    },
  };
}
