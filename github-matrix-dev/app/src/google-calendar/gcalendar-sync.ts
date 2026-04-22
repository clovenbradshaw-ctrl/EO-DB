/**
 * Google Calendar sync engine.
 *
 * Pull: fetches events from a Google calendar, flattens them into EO-DB
 * records under the scope `google_calendar.{sanitizedCalId}.{eventId}`,
 * and idempotently writes schema DEFs so TableView auto-discovers the
 * columns with correct types.
 *
 * Push: registers a listener on useEoStore.setOnDispatch that debounces
 * DEFs made under `google_calendar.*` scopes and batches them into
 * PATCH calls against Google Calendar.
 */

import { useEoStore } from '../store/eo-store';
import type { EoEventInput } from '../db/types';
import { getAccessToken } from './gcalendar-oauth';
import {
  calListEvents,
  calPatchEvent,
  CalendarForbiddenError,
  InsufficientCalendarScopeError,
  type GCalDateTime,
  type GCalEvent,
} from './gcalendar-api';
import { useGCalendarStore } from './gcalendar-store';

export const GCAL_SCOPE_PREFIX = 'google_calendar';

/**
 * Sanitize a Google calendar ID into a dot-safe segment usable in EO-DB
 * hierarchical targets. Replaces `.` and `@` with `_`.
 */
export function sanitizeCalendarId(calendarId: string): string {
  return calendarId.replace(/[.@]/g, '_');
}

/** Compute the EO-DB scope target for a calendar. */
export function scopeForCalendar(calendarId: string): string {
  return `${GCAL_SCOPE_PREFIX}.${sanitizeCalendarId(calendarId)}`;
}

/** Compute the EO-DB record target for an event on a calendar. */
export function targetForEvent(calendarId: string, eventId: string): string {
  // Google event IDs are alphanumeric (base32hex for recurring), safe.
  return `${scopeForCalendar(calendarId)}.${eventId}`;
}

// ──────────────────────────────────────────────────────────────
// Pull-side: guard against write-back while we dispatch schema DEFs
// ──────────────────────────────────────────────────────────────

let _isPulling = false;
function isPulling(): boolean { return _isPulling; }

// ──────────────────────────────────────────────────────────────
// Google date envelope ⟷ flat ISO string helpers
// ──────────────────────────────────────────────────────────────

export interface FlatDate {
  iso: string | null;      // ISO string (datetime) or YYYY-MM-DD (all-day), null if absent
  tz: string | null;       // timezone id (e.g. 'America/Los_Angeles'), null for all-day
  allDay: boolean;
}

/** Flatten a Google start/end envelope into a plain ISO string + tz + allDay flag. */
export function flattenGCalDate(gcal: GCalDateTime | undefined): FlatDate {
  if (!gcal) return { iso: null, tz: null, allDay: false };
  if (gcal.date) return { iso: gcal.date, tz: null, allDay: true };
  if (gcal.dateTime) return { iso: gcal.dateTime, tz: gcal.timeZone ?? null, allDay: false };
  return { iso: null, tz: null, allDay: false };
}

/** Reconstruct a Google start/end envelope from flat fields (for PATCH). */
export function reconstructGCalDate(iso: string | null, tz: string | null): GCalDateTime | undefined {
  if (!iso) return undefined;
  // Heuristic: a bare YYYY-MM-DD with no time component is all-day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return { date: iso };
  }
  return { dateTime: iso, timeZone: tz ?? undefined };
}

// ──────────────────────────────────────────────────────────────
// Schema bootstrap — idempotent field-type declarations
// ──────────────────────────────────────────────────────────────

interface SchemaField {
  key: string;
  type: string;
  options?: string[];
}

const GCAL_SCHEMA_FIELDS: SchemaField[] = [
  { key: 'summary',     type: 'text' },
  { key: 'description', type: 'longText' },
  { key: 'location',    type: 'text' },
  { key: 'start',       type: 'date' },
  { key: 'end',         type: 'date' },
  { key: 'start_tz',    type: 'text' },
  { key: 'end_tz',      type: 'text' },
  { key: 'all_day',     type: 'checkbox' },
  { key: 'htmlLink',    type: 'url' },
  { key: 'status',      type: 'singleSelect', options: ['confirmed', 'tentative', 'cancelled'] },
];

/**
 * Ensure all schema DEFs exist for the calendar scope. Idempotent — reads
 * each schema target first and only dispatches a DEF if absent.
 */
async function ensureSchema(scope: string): Promise<void> {
  const store = useEoStore.getState();
  for (const field of GCAL_SCHEMA_FIELDS) {
    const schemaTarget = `${scope}._schema.${field.key}.type`;
    try {
      const existing = await store.getState(schemaTarget);
      if (existing && existing.value && (existing.value as { type?: string }).type === field.type) {
        continue;
      }
    } catch { /* fall through to write */ }
    const operand: { type: string; options?: string[] } = { type: field.type };
    if (field.options) operand.options = field.options;
    try {
      await store.dispatch({
        op: 'DEF',
        target: schemaTarget,
        operand,
        agent: 'system:gcalendar',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
    } catch (e) {
      console.warn('[EO-DB] gcalendar schema DEF failed:', field.key, e);
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Pull
// ──────────────────────────────────────────────────────────────

export interface PullResult {
  calendarId: string;
  scope: string;
  eventCount: number;
  completedAt: string;
}

/**
 * Pull events from Google Calendar into EO-DB as records.
 *
 * Incremental sync by `updatedMin` — pass the last-sync timestamp from the
 * store. On first run pass `undefined` to get all events.
 */
export async function pullCalendarEvents(calendarId: string): Promise<PullResult> {
  const scope = scopeForCalendar(calendarId);
  const gcalStore = useGCalendarStore.getState();
  const eoStore = useEoStore.getState();

  gcalStore.setSyncing(true);
  gcalStore.setError(null);
  _isPulling = true;

  let eventCount = 0;
  try {
    await ensureSchema(scope);

    const updatedMin = gcalStore.lastSyncAt[calendarId];
    let pageToken: string | undefined;
    const token = await getAccessToken();

    do {
      const page = await calListEvents(token, calendarId, {
        updatedMin,
        pageToken,
        maxResults: 250,
      });
      for (const evt of page.items) {
        if (!evt.id) continue;
        // Cancelled events: still ingest but with status='cancelled' so users
        // can see the tombstone. Skipping entirely would leak into "orphans".
        const record = gcalEventToRecord(evt);
        try {
          await eoStore.dispatch({
            op: 'DEF',
            target: targetForEvent(calendarId, evt.id),
            operand: record,
            agent: 'system:gcalendar',
            ts: new Date().toISOString(),
            acquired_ts: new Date().toISOString(),
          });
          eventCount++;
        } catch (e) {
          console.warn('[EO-DB] gcalendar event DEF failed:', evt.id, e);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    const completedAt = new Date().toISOString();
    gcalStore.setLastSyncAt(calendarId, completedAt);
    return { calendarId, scope, eventCount, completedAt };
  } catch (e) {
    if (e instanceof InsufficientCalendarScopeError) {
      gcalStore.setNeedsReauth(true);
    }
    gcalStore.setError(e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    _isPulling = false;
    gcalStore.setSyncing(false);
  }
}

/** Convert a Google event into a flat EO-DB record operand. */
function gcalEventToRecord(evt: GCalEvent): Record<string, unknown> {
  const start = flattenGCalDate(evt.start);
  const end = flattenGCalDate(evt.end);
  return {
    _type: 'google_calendar_event',
    _name: evt.summary ?? '(untitled)',
    summary: evt.summary ?? '',
    description: evt.description ?? '',
    location: evt.location ?? '',
    start: start.iso,
    end: end.iso,
    start_tz: start.tz,
    end_tz: end.tz,
    all_day: start.allDay,
    htmlLink: evt.htmlLink ?? '',
    status: evt.status ?? 'confirmed',
  };
}

// ──────────────────────────────────────────────────────────────
// Push (write-back listener)
// ──────────────────────────────────────────────────────────────

interface PendingPatch {
  calendarId: string;
  eventId: string;
  fields: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout> | null;
}

const _pending = new Map<string, PendingPatch>();
const DEBOUNCE_MS = 500;

function pendingKey(calendarId: string, eventId: string): string {
  return `${calendarId}::${eventId}`;
}

function queuePatch(
  calendarId: string,
  eventId: string,
  fields: Record<string, unknown>,
): void {
  const gcalStore = useGCalendarStore.getState();
  if (!gcalStore.writableCalendars.has(calendarId)) {
    // Silently drop — calendar is read-only or list hasn't been refreshed.
    return;
  }

  const key = pendingKey(calendarId, eventId);
  let entry = _pending.get(key);
  if (!entry) {
    entry = { calendarId, eventId, fields: {}, timer: null };
    _pending.set(key, entry);
  }
  Object.assign(entry.fields, fields);
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { void flushPatch(key); }, DEBOUNCE_MS);
}

async function flushPatch(key: string): Promise<void> {
  const entry = _pending.get(key);
  if (!entry) return;
  _pending.delete(key);

  const { calendarId, eventId, fields } = entry;
  const patch = buildGCalPatch(fields);
  if (Object.keys(patch).length === 0) return;

  try {
    const token = await getAccessToken();
    await calPatchEvent(token, calendarId, eventId, patch);
  } catch (e) {
    if (e instanceof CalendarForbiddenError) {
      useGCalendarStore.getState().markCalendarReadOnly(calendarId);
      console.warn('[EO-DB] gcalendar write forbidden — marking read-only:', calendarId);
      return;
    }
    if (e instanceof InsufficientCalendarScopeError) {
      useGCalendarStore.getState().setNeedsReauth(true);
      return;
    }
    console.warn('[EO-DB] gcalendar PATCH failed:', e);
  }
}

/**
 * Translate a flat EO-DB field patch into a Google Calendar PATCH body.
 * Reconstructs nested start/end envelopes from flat iso + tz fields.
 */
function buildGCalPatch(fields: Record<string, unknown>): Partial<GCalEvent> {
  const patch: Partial<GCalEvent> = {};

  if ('summary' in fields) patch.summary = String(fields.summary ?? '');
  if ('description' in fields) patch.description = String(fields.description ?? '');
  if ('location' in fields) patch.location = String(fields.location ?? '');
  if ('htmlLink' in fields) { /* read-only from Google, skip */ }
  if ('status' in fields) {
    const s = String(fields.status ?? '');
    if (s === 'confirmed' || s === 'tentative' || s === 'cancelled') {
      patch.status = s;
    }
  }

  // Start/end: reconstruct envelope if either the iso or the tz changed.
  if ('start' in fields || 'start_tz' in fields) {
    const iso = typeof fields.start === 'string' ? fields.start : null;
    const tz = typeof fields.start_tz === 'string' ? fields.start_tz : null;
    const envelope = reconstructGCalDate(iso, tz);
    if (envelope) patch.start = envelope;
  }
  if ('end' in fields || 'end_tz' in fields) {
    const iso = typeof fields.end === 'string' ? fields.end : null;
    const tz = typeof fields.end_tz === 'string' ? fields.end_tz : null;
    const envelope = reconstructGCalDate(iso, tz);
    if (envelope) patch.end = envelope;
  }

  return patch;
}

/** Flush all pending patches synchronously (used on beforeunload). */
export function flushAllPending(): void {
  for (const key of Array.from(_pending.keys())) {
    const entry = _pending.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    void flushPatch(key);
  }
}

// ──────────────────────────────────────────────────────────────
// Dispatch listener — the single write-back hook
// ──────────────────────────────────────────────────────────────

let _listenerInstalled = false;

/**
 * Install the global write-back listener. Idempotent — safe to call during
 * HMR. Claims the single onDispatch slot on useEoStore.
 */
export function startWriteBackListener(): void {
  if (_listenerInstalled) return;
  _listenerInstalled = true;

  useEoStore.getState().setOnDispatch((event: EoEventInput) => {
    handleDispatchForWriteBack(event);
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      flushAllPending();
    });
  }
}

/** Exposed for tests — process a single dispatched event. */
export function handleDispatchForWriteBack(event: EoEventInput): void {
  if (isPulling()) return;
  if (event.op !== 'DEF') return;
  if (typeof event.target !== 'string') return;
  if (!event.target.startsWith(`${GCAL_SCOPE_PREFIX}.`)) return;
  if (event.target.includes('._schema.')) return;
  if (event.target.includes('._displayField')) return;

  const parts = event.target.split('.');
  // Expected shape: ['google_calendar', '{sanitizedId}', '{eventId}']
  if (parts.length !== 3) return;
  const [, sanitizedCalId, eventId] = parts;

  // Map sanitized id back to real calendar id via the store's calendar list.
  const gcalStore = useGCalendarStore.getState();
  const realCal = gcalStore.calendars.find(
    (c) => sanitizeCalendarId(c.id) === sanitizedCalId,
  );
  if (!realCal) return;
  const calendarId = realCal.id;

  // Unwrap operand: handleCellSave emits either { [k]: v } or { fields: { [k]: v } }.
  const operand = event.operand as { fields?: Record<string, unknown> } | Record<string, unknown> | null;
  if (!operand || typeof operand !== 'object') return;
  const maybeNested = (operand as { fields?: unknown }).fields;
  const fields = (maybeNested && typeof maybeNested === 'object')
    ? maybeNested as Record<string, unknown>
    : operand as Record<string, unknown>;

  // Don't try to write back the system/agent metadata or fields whose keys
  // start with underscore (convention for meta).
  const patchableFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k.startsWith('_')) continue;
    patchableFields[k] = v;
  }
  if (Object.keys(patchableFields).length === 0) return;

  queuePatch(calendarId, eventId, patchableFields);
}
