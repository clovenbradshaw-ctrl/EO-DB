/**
 * Google Calendar v3 API — direct fetch wrappers.
 *
 * All calls attach `Authorization: Bearer ${token}` and parse JSON responses.
 * Callers pass a token obtained from gcalendar-oauth (which re-exports
 * gdrive-oauth). There is no n8n-proxy mode for Calendar — the existing
 * n8n webhook only holds Drive credentials.
 */

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';

/** Thrown when Google returns 403 with an insufficient-scope reason. */
export class InsufficientCalendarScopeError extends Error {
  constructor(message = 'Calendar scope missing — user must re-authenticate') {
    super(message);
    this.name = 'InsufficientCalendarScopeError';
  }
}

/** Thrown when the target calendar denies write access (read-only share). */
export class CalendarForbiddenError extends Error {
  calendarId: string;
  constructor(calendarId: string, message = 'Calendar is read-only or access denied') {
    super(message);
    this.name = 'CalendarForbiddenError';
    this.calendarId = calendarId;
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}

async function checkStatus(res: Response, calendarId?: string): Promise<void> {
  if (res.ok) return;
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  if (res.status === 403) {
    // Distinguish insufficient-scope (needs re-auth) from read-only share.
    if (body.includes('insufficient') || body.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
      throw new InsufficientCalendarScopeError();
    }
    throw new CalendarForbiddenError(calendarId ?? 'unknown', body || 'forbidden');
  }
  throw new Error(`Google Calendar API ${res.status}: ${body}`);
}

// ──────────────────────────────────────────────────────────────
// Types — a trimmed subset of what Google returns / accepts.
// ──────────────────────────────────────────────────────────────

export interface CalendarListEntry {
  id: string;
  summary: string;
  description?: string;
  primary?: boolean;
  accessRole?: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  backgroundColor?: string;
  timeZone?: string;
}

export interface GCalDateTime {
  dateTime?: string;      // RFC3339, e.g. 2026-04-10T09:00:00-07:00
  date?: string;          // YYYY-MM-DD for all-day events
  timeZone?: string;
}

export interface GCalEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  start?: GCalDateTime;
  end?: GCalDateTime;
  updated?: string;
  created?: string;
  etag?: string;
}

export interface EventListResponse {
  items: GCalEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface EventListOptions {
  updatedMin?: string;    // ISO timestamp — only return events changed since
  pageToken?: string;
  maxResults?: number;    // default 250
  showDeleted?: boolean;
}

// ──────────────────────────────────────────────────────────────
// API calls
// ──────────────────────────────────────────────────────────────

/** List the calendars the authenticated user has access to. */
export async function calListCalendars(token: string): Promise<CalendarListEntry[]> {
  const res = await fetch(`${CAL_BASE}/users/me/calendarList`, {
    headers: authHeaders(token),
  });
  await checkStatus(res);
  const json = await res.json() as { items?: CalendarListEntry[] };
  return json.items ?? [];
}

/** List events from a calendar, with optional incremental `updatedMin`. */
export async function calListEvents(
  token: string,
  calendarId: string,
  opts: EventListOptions = {},
): Promise<EventListResponse> {
  const params = new URLSearchParams();
  params.set('singleEvents', 'true');      // expand recurring events
  params.set('orderBy', 'updated');
  params.set('maxResults', String(opts.maxResults ?? 250));
  if (opts.updatedMin) params.set('updatedMin', opts.updatedMin);
  if (opts.pageToken) params.set('pageToken', opts.pageToken);
  if (opts.showDeleted) params.set('showDeleted', 'true');

  const url = `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  await checkStatus(res, calendarId);
  const json = await res.json() as EventListResponse;
  return { items: json.items ?? [], nextPageToken: json.nextPageToken };
}

/** Fetch a single event (used for fresh reads after a patch). */
export async function calGetEvent(
  token: string,
  calendarId: string,
  eventId: string,
): Promise<GCalEvent> {
  const url = `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  await checkStatus(res, calendarId);
  return res.json();
}

/** PATCH a subset of fields on an existing event. */
export async function calPatchEvent(
  token: string,
  calendarId: string,
  eventId: string,
  patch: Partial<GCalEvent>,
): Promise<GCalEvent> {
  const url = `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patch),
  });
  await checkStatus(res, calendarId);
  return res.json();
}

/** Create a new event on a calendar. */
export async function calCreateEvent(
  token: string,
  calendarId: string,
  body: Partial<GCalEvent>,
): Promise<GCalEvent> {
  const url = `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  await checkStatus(res, calendarId);
  return res.json();
}

/** Delete an event. */
export async function calDeleteEvent(
  token: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const url = `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (res.status === 204 || res.status === 200) return;
  await checkStatus(res, calendarId);
}
