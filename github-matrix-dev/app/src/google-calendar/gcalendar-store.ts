/**
 * Zustand store for Google Calendar integration state.
 *
 * Holds only *metadata* about the calendar connection — the list of
 * calendars the user has access to, which one is active, last-sync
 * timestamps, and which calendars we've inferred are writable. Actual
 * event data lives in the EO-DB event-sourced store under the scope
 * `google_calendar.{sanitizedCalendarId}.{eventId}`.
 */

import { create } from 'zustand';
import type { CalendarListEntry } from './gcalendar-api';
import {
  calListCalendars,
  InsufficientCalendarScopeError,
} from './gcalendar-api';
import { getAccessToken, isConnected } from './gcalendar-oauth';

const LS_ACTIVE_CAL = 'eo-gcal-active-calendar-id';
const LS_LAST_SYNC_PREFIX = 'eo-gcal-last-sync-';

export interface GCalendarState {
  connected: boolean;
  calendars: CalendarListEntry[];
  activeCalendarId: string | null;
  /** ISO timestamp of the last completed sync, keyed by calendarId. */
  lastSyncAt: Record<string, string>;
  syncing: boolean;
  error: string | null;
  /** Calendars known to be writable (others are treated as read-only after a 403). */
  writableCalendars: Set<string>;
  /** True if the last API call indicated the scope is missing. */
  needsReauth: boolean;

  refreshCalendarList(): Promise<void>;
  setActiveCalendar(id: string | null): void;
  setLastSyncAt(id: string, iso: string): void;
  markCalendarReadOnly(id: string): void;
  setSyncing(syncing: boolean): void;
  setError(msg: string | null): void;
  setNeedsReauth(value: boolean): void;
  disconnect(): void;
}

function loadLastSyncAt(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LS_LAST_SYNC_PREFIX)) continue;
      const id = key.slice(LS_LAST_SYNC_PREFIX.length);
      const val = localStorage.getItem(key);
      if (val) out[id] = val;
    }
  } catch { /* ignore quota errors */ }
  return out;
}

export const useGCalendarStore = create<GCalendarState>((set, get) => ({
  connected: typeof window !== 'undefined' && isConnected(),
  calendars: [],
  activeCalendarId: typeof window !== 'undefined'
    ? localStorage.getItem(LS_ACTIVE_CAL)
    : null,
  lastSyncAt: typeof window !== 'undefined' ? loadLastSyncAt() : {},
  syncing: false,
  error: null,
  writableCalendars: new Set<string>(),
  needsReauth: false,

  async refreshCalendarList() {
    set({ error: null });
    try {
      const token = await getAccessToken();
      const calendars = await calListCalendars(token);
      // Any calendar whose accessRole is 'owner' or 'writer' is writable.
      const writable = new Set<string>();
      for (const c of calendars) {
        if (c.accessRole === 'owner' || c.accessRole === 'writer') {
          writable.add(c.id);
        }
      }
      set({
        calendars,
        writableCalendars: writable,
        connected: true,
        needsReauth: false,
      });
      // Auto-select the primary calendar on first successful fetch.
      if (!get().activeCalendarId) {
        const primary = calendars.find((c) => c.primary) ?? calendars[0];
        if (primary) get().setActiveCalendar(primary.id);
      }
    } catch (e) {
      if (e instanceof InsufficientCalendarScopeError) {
        set({ needsReauth: true, error: e.message });
      } else {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    }
  },

  setActiveCalendar(id: string | null) {
    set({ activeCalendarId: id });
    try {
      if (id) localStorage.setItem(LS_ACTIVE_CAL, id);
      else localStorage.removeItem(LS_ACTIVE_CAL);
    } catch { /* quota */ }
  },

  setLastSyncAt(id: string, iso: string) {
    set((s) => ({ lastSyncAt: { ...s.lastSyncAt, [id]: iso } }));
    try {
      localStorage.setItem(LS_LAST_SYNC_PREFIX + id, iso);
    } catch { /* quota */ }
  },

  markCalendarReadOnly(id: string) {
    set((s) => {
      if (!s.writableCalendars.has(id)) return s;
      const next = new Set(s.writableCalendars);
      next.delete(id);
      return { writableCalendars: next };
    });
  },

  setSyncing(syncing: boolean) {
    set({ syncing });
  },

  setError(msg: string | null) {
    set({ error: msg });
  },

  setNeedsReauth(value: boolean) {
    set({ needsReauth: value });
  },

  disconnect() {
    set({
      connected: false,
      calendars: [],
      activeCalendarId: null,
      syncing: false,
      error: null,
      writableCalendars: new Set<string>(),
      needsReauth: false,
    });
    try {
      localStorage.removeItem(LS_ACTIVE_CAL);
    } catch { /* ignore */ }
  },
}));
