import type { EoState } from '../db/types';
import { getFieldValue, hasFieldsSubObject } from './filter-types';

// --- Types ---

export interface DateColumnOption {
  key: string;   // field key, or '__last_ts__' / '__airtable_created__'
  label: string;
}

export interface TimeScrubberFilter {
  dateField: string;
  rangeMin: number | null;   // epoch ms, null = unbounded
  rangeMax: number | null;
  emptyHandling: 'show' | 'hide' | 'end';
}

export const DEFAULT_FILTER: TimeScrubberFilter = {
  dateField: '__last_ts__',
  rangeMin: null,
  rangeMax: null,
  emptyHandling: 'show',
};

// --- Date detection ---

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function looksLikeDate(v: any): boolean {
  if (typeof v === 'string' && ISO_DATE_RE.test(v)) {
    const d = new Date(v);
    return !isNaN(d.getTime());
  }
  return false;
}

/**
 * Scan records to find fields whose values are date-like.
 * Always includes "Operation date" as the first option.
 */
export function detectDateColumns(
  records: EoState[],
  useFieldsSub: boolean,
  fieldNameMap?: Map<string, string>,
): DateColumnOption[] {
  const options: DateColumnOption[] = [
    { key: '__last_ts__', label: 'Operation date' },
  ];

  // Check for _airtable.created_time
  const hasAirtableCreated = records.some(
    (r) => r.value?._airtable?.created_time,
  );
  if (hasAirtableCreated) {
    options.push({ key: '__airtable_created__', label: 'Airtable created' });
  }

  // Sample up to 100 records for performance
  const sample = records.slice(0, 100);
  const fieldCounts = new Map<string, { total: number; dateCount: number }>();

  for (const rec of sample) {
    if (!rec.value || typeof rec.value !== 'object') continue;

    const source =
      useFieldsSub &&
      rec.value.fields &&
      typeof rec.value.fields === 'object' &&
      !Array.isArray(rec.value.fields)
        ? (rec.value.fields as Record<string, any>)
        : rec.value;

    for (const [key, val] of Object.entries(source)) {
      if (key.startsWith('_')) continue;
      if (val == null) continue;

      let counts = fieldCounts.get(key);
      if (!counts) {
        counts = { total: 0, dateCount: 0 };
        fieldCounts.set(key, counts);
      }
      counts.total++;
      if (looksLikeDate(val)) counts.dateCount++;
    }
  }

  for (const [key, counts] of fieldCounts) {
    if (counts.total > 0 && counts.dateCount / counts.total > 0.5) {
      const label = fieldNameMap?.get(key) ?? key;
      options.push({ key, label });
    }
  }

  return options;
}

// --- Value extraction ---

/**
 * Extract epoch ms from a record for a given date field key.
 * Returns null if the value is missing or unparseable.
 */
export function getDateValue(
  rec: EoState,
  dateField: string,
  useFieldsSub: boolean,
): number | null {
  let raw: any;

  switch (dateField) {
    case '__last_ts__':
      raw = rec.last_ts;
      break;
    case '__last_acquired_ts__':
      raw = rec.last_acquired_ts;
      break;
    case '__airtable_created__':
      raw = rec.value?._airtable?.created_time;
      break;
    default:
      raw = getFieldValue(rec, dateField, useFieldsSub);
  }

  if (raw == null) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.getTime();
}

// --- Range computation ---

export function computeDateRange(
  records: EoState[],
  dateField: string,
  useFieldsSub: boolean,
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;

  for (const rec of records) {
    const v = getDateValue(rec, dateField, useFieldsSub);
    if (v == null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  return min <= max ? { min, max } : null;
}

// --- Filter application ---

/**
 * Apply the time scrubber filter to a set of records.
 * Returns a new array — does not mutate the input.
 */
export function applyTimeScrubber(
  records: EoState[],
  filter: TimeScrubberFilter,
  useFieldsSub: boolean,
): EoState[] {
  // If range is fully unbounded and empty handling is 'show', no-op
  if (
    filter.rangeMin == null &&
    filter.rangeMax == null &&
    filter.emptyHandling === 'show'
  ) {
    return records;
  }

  const dated: EoState[] = [];
  const empty: EoState[] = [];

  for (const rec of records) {
    const v = getDateValue(rec, filter.dateField, useFieldsSub);

    if (v == null) {
      // Empty date value
      switch (filter.emptyHandling) {
        case 'show':
          dated.push(rec);
          break;
        case 'hide':
          // exclude
          break;
        case 'end':
          empty.push(rec);
          break;
      }
      continue;
    }

    // Range check
    if (filter.rangeMin != null && v < filter.rangeMin) continue;
    if (filter.rangeMax != null && v > filter.rangeMax) continue;
    dated.push(rec);
  }

  return filter.emptyHandling === 'end' ? [...dated, ...empty] : dated;
}

// --- Adaptive formatting ---

const MS_SECOND = 1_000;
const MS_MINUTE = 60_000;
const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;
const MS_MONTH = 30 * MS_DAY;
const MS_YEAR = 365 * MS_DAY;

type ScaleTier =
  | 'sub-second'   // < 1s
  | 'seconds'      // < 1min
  | 'minutes'      // < 1hr
  | 'hours'        // < 1day
  | 'days'         // < ~1month
  | 'months'       // < ~1year
  | 'years'        // < ~10yr
  | 'decades';     // >= ~10yr

function detectScaleTier(rangeMs: number): ScaleTier {
  if (rangeMs < MS_SECOND) return 'sub-second';
  if (rangeMs < MS_MINUTE) return 'seconds';
  if (rangeMs < MS_HOUR) return 'minutes';
  if (rangeMs < MS_DAY) return 'hours';
  if (rangeMs < MS_MONTH) return 'days';
  if (rangeMs < MS_YEAR) return 'months';
  if (rangeMs < 10 * MS_YEAR) return 'years';
  return 'decades';
}

const tierFormatters: Record<ScaleTier, (d: Date) => string> = {
  'sub-second': (d) => {
    const hms = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `${hms}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  },
  'seconds': (d) =>
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  'minutes': (d) =>
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  'hours': (d) => {
    const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return `${day} ${time}`;
  },
  'days': (d) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
  'months': (d) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
  'years': (d) =>
    d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
  'decades': (d) =>
    d.toLocaleDateString(undefined, { year: 'numeric' }),
};

/**
 * Build a formatter tuned to the data's actual time span.
 * Call once when the range changes, then reuse for all labels.
 */
export function buildAdaptiveFormatter(rangeMs: number): (epochMs: number) => string {
  const tier = detectScaleTier(Math.abs(rangeMs));
  const fmt = tierFormatters[tier];
  return (epochMs: number) => fmt(new Date(epochMs));
}

/** Convenience: format a single label with a known range span. */
export function formatDateLabel(epochMs: number, rangeMs?: number): string {
  if (rangeMs != null) {
    return buildAdaptiveFormatter(rangeMs)(epochMs);
  }
  // fallback – no range context
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
