/**
 * CalendarBlock — renders a set of records as a month / week / day /
 * agenda calendar view. Works on any scope whose records have a date
 * field; sync-installed Google Calendar scopes get this automatically.
 *
 * Clicking an event opens an inline edit modal that dispatches DEFs via
 * the EO-DB store — the existing write-back listener picks those up and
 * syncs them to Google Calendar.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTheme, type Theme } from '../../theme';
import { useEoStore } from '../../store/eo-store';
import { Modal } from '../../components/Modal';
import type { BlockNode, CalendarBlockProps } from '../types';
import type { BuilderMode } from '../../store/builder-store';
import type { EoState } from '../../db/types';

interface Props {
  block: BlockNode;
  mode: BuilderMode;
}

interface CalendarEvent {
  target: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  color?: string;
  raw: Record<string, unknown>;
}

type ViewMode = 'month' | 'week' | 'day' | 'agenda';

// ──────────────────────────────────────────────────────────────
// Date helpers — native Date math, no libraries
// ──────────────────────────────────────────────────────────────

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

function startOfMonth(d: Date): Date {
  const r = startOfDay(d);
  r.setDate(1);
  return r;
}

function startOfWeek(d: Date, weekStart: 0 | 1): Date {
  const r = startOfDay(d);
  const day = r.getDay(); // 0 = Sun
  const diff = (day - weekStart + 7) % 7;
  return addDays(r, -diff);
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function minutesSinceMidnight(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function formatMonth(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatDay(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function parseDateLoose(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

const DAY_LABELS_SUN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LABELS_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ──────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────

export function CalendarBlock({ block, mode }: Props) {
  const { theme } = useTheme();
  const props = block.props as CalendarBlockProps;
  const {
    scope = '',
    binding,
    dateField = 'start',
    endDateField = 'end',
    titleField = 'summary',
    colorField,
    viewMode: initialViewMode = 'month',
    startDay = 0,
    emptyText = 'No events',
  } = props;

  const effectiveScope = binding?.target || scope;

  const getStateByPrefix = useEoStore((st) => st.getStateByPrefix);
  const dispatchEvent = useEoStore((st) => st.dispatch);
  const ready = useEoStore((st) => st.ready);
  const lastSeq = useEoStore((st) => st.lastSeq);

  const [records, setRecords] = useState<EoState[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);

  // Fetch records when ready or when the store sequence advances (re-fetch
  // on edits so the calendar stays live).
  useEffect(() => {
    if (!ready || !effectiveScope) {
      setRecords([]);
      return;
    }
    let cancelled = false;
    getStateByPrefix(effectiveScope + '.')
      .then((rows) => {
        if (cancelled) return;
        // Skip schema and display-config records
        const filtered = rows.filter(
          (r) => !r.target.includes('._schema.') && !r.target.endsWith('._displayField'),
        );
        setRecords(filtered);
      })
      .catch((e) => console.warn('[CalendarBlock] fetch failed:', e));
    return () => { cancelled = true; };
  }, [ready, effectiveScope, getStateByPrefix, lastSeq]);

  // Parse records into calendar events
  const events = useMemo<CalendarEvent[]>(() => {
    const out: CalendarEvent[] = [];
    for (const r of records) {
      const val = r.value as Record<string, unknown> | null;
      if (!val || typeof val !== 'object') continue;
      // Support both flat and {fields: {...}} shapes
      const fields = (val as { fields?: unknown }).fields && typeof (val as { fields?: unknown }).fields === 'object'
        ? (val as { fields: Record<string, unknown> }).fields
        : (val as Record<string, unknown>);
      const start = parseDateLoose(fields[dateField]);
      if (!start) continue;
      const end = parseDateLoose(fields[endDateField ?? '']) ?? new Date(start.getTime() + 60 * 60 * 1000);
      const title = String(fields[titleField] ?? fields['_name'] ?? r.target.split('.').pop() ?? 'Event');
      const color = colorField ? String(fields[colorField] ?? '') : undefined;
      const allDay = Boolean(fields['all_day']);
      out.push({
        target: r.target,
        title,
        start,
        end,
        allDay,
        color: color || undefined,
        raw: fields,
      });
    }
    // Sort chronologically for stable rendering
    out.sort((a, b) => a.start.getTime() - b.start.getTime());
    return out;
  }, [records, dateField, endDateField, titleField, colorField]);

  const selectedEvent = useMemo(
    () => events.find((e) => e.target === selectedTarget) ?? null,
    [events, selectedTarget],
  );

  // Navigation
  const goPrev = useCallback(() => {
    setAnchor((a) => {
      switch (viewMode) {
        case 'month':  return addMonths(a, -1);
        case 'week':   return addDays(a, -7);
        case 'day':    return addDays(a, -1);
        case 'agenda': return addDays(a, -14);
      }
    });
  }, [viewMode]);

  const goNext = useCallback(() => {
    setAnchor((a) => {
      switch (viewMode) {
        case 'month':  return addMonths(a, 1);
        case 'week':   return addDays(a, 7);
        case 'day':    return addDays(a, 1);
        case 'agenda': return addDays(a, 14);
      }
    });
  }, [viewMode]);

  const goToday = useCallback(() => setAnchor(startOfDay(new Date())), []);

  // Build-mode placeholder when no scope configured
  if (!effectiveScope && mode === 'build') {
    return (
      <div style={{
        padding: 16,
        border: `1px dashed ${theme.border}`,
        borderRadius: 8,
        background: theme.bgCard,
        color: theme.textMuted,
        fontSize: 12,
      }}>
        Calendar Block — configure a data source in the config panel
      </div>
    );
  }

  const s = makeStyles(theme);
  const headerTitle = formatHeaderTitle(viewMode, anchor);

  return (
    <div style={s.container}>
      {/* Toolbar */}
      <div style={s.toolbar}>
        <div style={s.navGroup}>
          <button style={s.navBtn} onClick={goPrev} aria-label="Previous">&lsaquo;</button>
          <button style={s.navBtnTdy} onClick={goToday}>Today</button>
          <button style={s.navBtn} onClick={goNext} aria-label="Next">&rsaquo;</button>
        </div>
        <div style={s.headerTitle}>{headerTitle}</div>
        <div style={s.viewSwitcher}>
          {(['month', 'week', 'day', 'agenda'] as ViewMode[]).map((v) => (
            <button
              key={v}
              style={v === viewMode ? s.viewBtnActive : s.viewBtn}
              onClick={() => setViewMode(v)}
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      {events.length === 0 ? (
        <div style={s.empty}>{emptyText}</div>
      ) : viewMode === 'month' ? (
        <MonthView anchor={anchor} events={events} startDay={startDay} theme={theme} onSelect={setSelectedTarget} />
      ) : viewMode === 'week' ? (
        <TimeGridView anchor={anchor} events={events} days={7} startDay={startDay} theme={theme} onSelect={setSelectedTarget} />
      ) : viewMode === 'day' ? (
        <TimeGridView anchor={anchor} events={events} days={1} startDay={startDay} theme={theme} onSelect={setSelectedTarget} />
      ) : (
        <AgendaView anchor={anchor} events={events} theme={theme} onSelect={setSelectedTarget} />
      )}

      {/* Edit modal */}
      <EventEditModal
        open={!!selectedEvent}
        event={selectedEvent}
        onClose={() => setSelectedTarget(null)}
        onSave={async (changes) => {
          if (!selectedEvent) return;
          try {
            await dispatchEvent({
              op: 'DEF',
              target: selectedEvent.target,
              operand: changes,
              agent: 'user:calendar-block',
              ts: new Date().toISOString(),
              acquired_ts: new Date().toISOString(),
            });
          } catch (e) {
            console.warn('[CalendarBlock] save failed:', e);
          }
          setSelectedTarget(null);
        }}
        titleField={titleField}
        dateField={dateField}
        endDateField={endDateField ?? 'end'}
      />
    </div>
  );
}

function formatHeaderTitle(viewMode: ViewMode, anchor: Date): string {
  switch (viewMode) {
    case 'month': return formatMonth(anchor);
    case 'week': {
      const ws = startOfWeek(anchor, 0);
      const we = addDays(ws, 6);
      return `${formatDay(ws)} – ${formatDay(we)}`;
    }
    case 'day': return formatDay(anchor);
    case 'agenda': {
      const e = addDays(anchor, 13);
      return `${formatDay(anchor)} – ${formatDay(e)}`;
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Month view
// ──────────────────────────────────────────────────────────────

interface ViewProps {
  anchor: Date;
  events: CalendarEvent[];
  theme: Theme;
  onSelect: (target: string) => void;
}

function MonthView({ anchor, events, startDay, theme, onSelect }: ViewProps & { startDay: 0 | 1 }) {
  const s = makeStyles(theme);
  const monthStart = startOfMonth(anchor);
  const gridStart = startOfWeek(monthStart, startDay);
  const today = startOfDay(new Date());

  const days: Date[] = [];
  for (let i = 0; i < 42; i++) days.push(addDays(gridStart, i));

  const labels = startDay === 0 ? DAY_LABELS_SUN : DAY_LABELS_MON;

  return (
    <div style={s.monthWrapper}>
      <div style={s.monthHeader}>
        {labels.map((l) => (
          <div key={l} style={s.monthHeaderCell}>{l}</div>
        ))}
      </div>
      <div style={s.monthGrid}>
        {days.map((day, i) => {
          const dayStart = startOfDay(day);
          const dayEnd = addDays(dayStart, 1);
          const dayEvents = events.filter(
            (e) => e.start < dayEnd && e.end >= dayStart,
          );
          const isToday = isSameDay(day, today);
          const inMonth = isSameMonth(day, anchor);
          return (
            <div
              key={i}
              style={{
                ...s.monthCell,
                ...(isToday ? s.monthCellToday : {}),
                ...(inMonth ? {} : s.monthCellFaded),
              }}
            >
              <div style={s.monthCellDate}>{day.getDate()}</div>
              {dayEvents.slice(0, 3).map((e) => (
                <button
                  key={e.target + i}
                  style={{
                    ...s.monthChip,
                    ...(e.color ? { background: e.color, borderColor: e.color } : {}),
                  }}
                  onClick={() => onSelect(e.target)}
                  title={e.title}
                >
                  {!e.allDay && (
                    <span style={s.chipTime}>{formatTime(e.start)}</span>
                  )}
                  <span style={s.chipTitle}>{e.title}</span>
                </button>
              ))}
              {dayEvents.length > 3 && (
                <div style={s.monthMore}>+{dayEvents.length - 3} more</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Week / Day (time-grid) view
// ──────────────────────────────────────────────────────────────

interface TimeGridProps extends ViewProps {
  days: number; // 1 for day, 7 for week
  startDay: 0 | 1;
}

function TimeGridView({ anchor, events, days, startDay, theme, onSelect }: TimeGridProps) {
  const s = makeStyles(theme);
  const gridStart = days === 7 ? startOfWeek(anchor, startDay) : startOfDay(anchor);
  const today = startOfDay(new Date());

  const dayDates: Date[] = [];
  for (let i = 0; i < days; i++) dayDates.push(addDays(gridStart, i));

  const HOURS = 24;
  const ROW_HEIGHT = 32; // px per hour

  return (
    <div style={s.timeGridWrap}>
      {/* Column headers */}
      <div style={{ ...s.timeGridHeader, gridTemplateColumns: `48px repeat(${days}, 1fr)` }}>
        <div />
        {dayDates.map((d) => (
          <div
            key={d.toISOString()}
            style={{
              ...s.timeGridHeaderCell,
              ...(isSameDay(d, today) ? s.monthCellToday : {}),
            }}
          >
            {formatDay(d)}
          </div>
        ))}
      </div>

      {/* Body */}
      <div style={{ ...s.timeGridBody, gridTemplateColumns: `48px repeat(${days}, 1fr)` }}>
        {/* Hour labels */}
        <div style={s.hourColumn}>
          {Array.from({ length: HOURS }, (_, h) => (
            <div key={h} style={{ ...s.hourLabel, height: ROW_HEIGHT }}>
              {h === 0 ? '' : `${h}:00`}
            </div>
          ))}
        </div>
        {dayDates.map((d) => {
          const dayStart = startOfDay(d);
          const dayEnd = addDays(dayStart, 1);
          const dayEvents = events.filter(
            (e) => e.start < dayEnd && e.end > dayStart && !e.allDay,
          );
          return (
            <div key={d.toISOString()} style={s.dayColumn}>
              {/* Hour grid lines */}
              {Array.from({ length: HOURS }, (_, h) => (
                <div key={h} style={{ ...s.hourSlot, height: ROW_HEIGHT }} />
              ))}
              {/* Events absolutely positioned */}
              {dayEvents.map((e) => {
                // Clamp to day boundaries
                const start = e.start < dayStart ? dayStart : e.start;
                const end = e.end > dayEnd ? dayEnd : e.end;
                const top = (minutesSinceMidnight(start) / 60) * ROW_HEIGHT;
                const height = Math.max(
                  16,
                  ((end.getTime() - start.getTime()) / 3_600_000) * ROW_HEIGHT,
                );
                return (
                  <button
                    key={e.target}
                    style={{
                      ...s.timeEvent,
                      top,
                      height,
                      ...(e.color ? { background: e.color, borderColor: e.color } : {}),
                    }}
                    onClick={() => onSelect(e.target)}
                  >
                    <div style={s.timeEventTitle}>{e.title}</div>
                    <div style={s.timeEventTime}>
                      {formatTime(e.start)}{e.end.getTime() !== e.start.getTime() ? ` – ${formatTime(e.end)}` : ''}
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Agenda view
// ──────────────────────────────────────────────────────────────

function AgendaView({ anchor, events, theme, onSelect }: ViewProps) {
  const s = makeStyles(theme);
  const rangeStart = startOfDay(anchor);
  const rangeEnd = addDays(rangeStart, 14);
  const inRange = events.filter((e) => e.start >= rangeStart && e.start < rangeEnd);

  // Group by day
  const byDay = new Map<string, CalendarEvent[]>();
  for (const e of inRange) {
    const key = startOfDay(e.start).toISOString();
    const arr = byDay.get(key) ?? [];
    arr.push(e);
    byDay.set(key, arr);
  }
  const sortedKeys = Array.from(byDay.keys()).sort();

  if (sortedKeys.length === 0) {
    return <div style={s.empty}>No events in this range</div>;
  }

  return (
    <div style={s.agendaWrap}>
      {sortedKeys.map((k) => {
        const day = new Date(k);
        const dayEvents = byDay.get(k) ?? [];
        return (
          <div key={k} style={s.agendaGroup}>
            <div style={s.agendaDayHeader}>{formatDay(day)}</div>
            {dayEvents.map((e) => (
              <button
                key={e.target}
                style={s.agendaItem}
                onClick={() => onSelect(e.target)}
              >
                <div style={s.agendaTime}>
                  {e.allDay ? 'All day' : formatTime(e.start)}
                </div>
                <div style={s.agendaTitle}>{e.title}</div>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Inline edit modal
// ──────────────────────────────────────────────────────────────

interface EditModalProps {
  open: boolean;
  event: CalendarEvent | null;
  titleField: string;
  dateField: string;
  endDateField: string;
  onClose: () => void;
  onSave: (changes: Record<string, unknown>) => Promise<void> | void;
}

function EventEditModal({ open, event, titleField, dateField, endDateField, onClose, onSave }: EditModalProps) {
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');

  useEffect(() => {
    if (!event) return;
    setTitle(event.title);
    setStart(toLocalInput(event.start));
    setEnd(toLocalInput(event.end));
    setDescription(String(event.raw['description'] ?? ''));
    setLocation(String(event.raw['location'] ?? ''));
  }, [event]);

  const handleSave = () => {
    const changes: Record<string, unknown> = {};
    if (title !== event?.title) changes[titleField] = title;
    const origStart = event ? toLocalInput(event.start) : '';
    const origEnd = event ? toLocalInput(event.end) : '';
    if (start !== origStart) changes[dateField] = fromLocalInput(start);
    if (end !== origEnd) changes[endDateField] = fromLocalInput(end);
    if (description !== String(event?.raw['description'] ?? '')) changes['description'] = description;
    if (location !== String(event?.raw['location'] ?? '')) changes['location'] = location;
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    void onSave(changes);
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit event" width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 4 }}>
        <Field label="Title">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            style={modalInputStyle}
          />
        </Field>
        <Field label="Start">
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            style={modalInputStyle}
          />
        </Field>
        <Field label="End">
          <input
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            style={modalInputStyle}
          />
        </Field>
        <Field label="Location">
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            style={modalInputStyle}
          />
        </Field>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{ ...modalInputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button onClick={onClose} style={modalBtnStyle}>Cancel</button>
          <button onClick={handleSave} style={{ ...modalBtnStyle, fontWeight: 600 }}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.7, textTransform: 'uppercase' }}>{label}</span>
      {children}
    </label>
  );
}

const modalInputStyle: React.CSSProperties = {
  padding: '6px 8px',
  fontSize: 13,
  border: '1px solid #ccc',
  borderRadius: 4,
  background: 'inherit',
  color: 'inherit',
};

const modalBtnStyle: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: 13,
  border: '1px solid #ccc',
  borderRadius: 4,
  background: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
};

/** Convert a Date to the YYYY-MM-DDTHH:mm format required by datetime-local. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert a datetime-local string back to an ISO string with timezone. */
function fromLocalInput(s: string): string {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString();
}

// ──────────────────────────────────────────────────────────────
// Styles
// ──────────────────────────────────────────────────────────────

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      overflow: 'hidden',
      fontSize: 12,
    },
    toolbar: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 12px',
      borderBottom: `1px solid ${t.border}`,
      background: t.bgMuted,
      gap: 12,
    },
    navGroup: {
      display: 'flex',
      gap: 4,
    },
    navBtn: {
      width: 28,
      height: 28,
      border: `1px solid ${t.border}`,
      background: t.bgCard,
      color: t.text,
      borderRadius: 4,
      cursor: 'pointer',
      fontSize: 16,
      lineHeight: '1',
    },
    navBtnTdy: {
      padding: '0 10px',
      height: 28,
      border: `1px solid ${t.border}`,
      background: t.bgCard,
      color: t.text,
      borderRadius: 4,
      cursor: 'pointer',
      fontSize: 12,
    },
    headerTitle: {
      fontSize: 14,
      fontWeight: 600,
      color: t.textHeading,
      flex: 1,
      textAlign: 'center',
    },
    viewSwitcher: {
      display: 'flex',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      overflow: 'hidden',
    },
    viewBtn: {
      padding: '4px 10px',
      height: 28,
      border: 'none',
      background: t.bgCard,
      color: t.text,
      cursor: 'pointer',
      fontSize: 11,
    },
    viewBtnActive: {
      padding: '4px 10px',
      height: 28,
      border: 'none',
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
      fontSize: 11,
      fontWeight: 600,
    },
    empty: {
      padding: '32px 16px',
      textAlign: 'center',
      color: t.textMuted,
      fontSize: 12,
      fontStyle: 'italic',
    },
    // Month view
    monthWrapper: {
      display: 'flex',
      flexDirection: 'column',
    },
    monthHeader: {
      display: 'grid',
      gridTemplateColumns: 'repeat(7, 1fr)',
      background: t.bgMuted,
      borderBottom: `1px solid ${t.border}`,
    },
    monthHeaderCell: {
      padding: '6px 8px',
      fontSize: 11,
      fontWeight: 600,
      color: t.textSecondary,
      textAlign: 'center',
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
    },
    monthGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(7, 1fr)',
      gridAutoRows: 'minmax(84px, 1fr)',
    },
    monthCell: {
      borderRight: `1px solid ${t.borderLight}`,
      borderBottom: `1px solid ${t.borderLight}`,
      padding: 4,
      minHeight: 84,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      background: t.bgCard,
    },
    monthCellToday: {
      background: t.accentBg,
    },
    monthCellFaded: {
      background: t.bgMuted,
      color: t.textMuted,
    },
    monthCellDate: {
      fontSize: 11,
      fontWeight: 600,
      color: t.textSecondary,
    },
    monthChip: {
      display: 'flex',
      gap: 4,
      alignItems: 'center',
      padding: '2px 6px',
      border: `1px solid ${t.accentBorder}`,
      background: t.accentBg,
      color: t.accent,
      borderRadius: 3,
      fontSize: 10,
      cursor: 'pointer',
      textAlign: 'left',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis',
    },
    chipTime: {
      fontWeight: 600,
      opacity: 0.8,
    },
    chipTitle: {
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
    monthMore: {
      fontSize: 10,
      color: t.textMuted,
      fontStyle: 'italic',
      paddingLeft: 4,
    },
    // Time grid (week/day)
    timeGridWrap: {
      display: 'flex',
      flexDirection: 'column',
      maxHeight: 600,
      overflow: 'hidden',
    },
    timeGridHeader: {
      display: 'grid',
      background: t.bgMuted,
      borderBottom: `1px solid ${t.border}`,
    },
    timeGridHeaderCell: {
      padding: '8px 4px',
      fontSize: 11,
      fontWeight: 600,
      color: t.textSecondary,
      textAlign: 'center',
    },
    timeGridBody: {
      display: 'grid',
      overflow: 'auto',
      position: 'relative',
    },
    hourColumn: {
      borderRight: `1px solid ${t.borderLight}`,
      background: t.bgMuted,
    },
    hourLabel: {
      fontSize: 10,
      color: t.textMuted,
      padding: '0 4px',
      textAlign: 'right',
      borderBottom: `1px solid ${t.borderLight}`,
    },
    dayColumn: {
      position: 'relative',
      borderRight: `1px solid ${t.borderLight}`,
    },
    hourSlot: {
      borderBottom: `1px solid ${t.borderLight}`,
    },
    timeEvent: {
      position: 'absolute',
      left: 2,
      right: 2,
      background: t.accentBg,
      border: `1px solid ${t.accentBorder}`,
      color: t.accent,
      borderRadius: 3,
      padding: '2px 4px',
      fontSize: 10,
      cursor: 'pointer',
      overflow: 'hidden',
      textAlign: 'left',
    },
    timeEventTitle: {
      fontWeight: 600,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
    timeEventTime: {
      fontSize: 9,
      opacity: 0.8,
    },
    // Agenda
    agendaWrap: {
      display: 'flex',
      flexDirection: 'column',
      padding: 8,
      gap: 8,
    },
    agendaGroup: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    },
    agendaDayHeader: {
      fontSize: 11,
      fontWeight: 600,
      color: t.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
      paddingBottom: 4,
      borderBottom: `1px solid ${t.borderLight}`,
    },
    agendaItem: {
      display: 'flex',
      gap: 12,
      alignItems: 'center',
      padding: '6px 8px',
      background: 'transparent',
      border: 'none',
      borderRadius: 4,
      cursor: 'pointer',
      textAlign: 'left',
      color: t.text,
      fontSize: 12,
    },
    agendaTime: {
      color: t.textMuted,
      fontSize: 11,
      width: 80,
      fontFamily: "'JetBrains Mono', monospace",
    },
    agendaTitle: {
      flex: 1,
      color: t.text,
    },
  };
}
