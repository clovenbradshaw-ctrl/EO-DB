/**
 * Implementation of all formula functions.
 * Each function takes evaluated arguments and returns a value.
 * Organized by category matching the EO spec.
 */

import type { EvalContext } from './types';

type FormulaFn = (args: any[], ctx: EvalContext) => any;

// ─── Helpers ──────────────────────────────────────────────

function toNumber(v: any): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function toString(v: any): string {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

function toDate(v: any): Date | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function isTruthy(v: any): boolean {
  if (v == null || v === '' || v === 0 || v === false) return false;
  return true;
}

function isBlank(v: any): boolean {
  return v == null || v === '';
}

function formatDateISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── C.1 Text Functions ──────────────────────────────────

const CONCATENATE: FormulaFn = (args) => args.map(toString).join('');
const TRIM: FormulaFn = ([s]) => toString(s).trim();
const LOWER: FormulaFn = ([s]) => toString(s).toLowerCase();
const UPPER: FormulaFn = ([s]) => toString(s).toUpperCase();
const LEN: FormulaFn = ([s]) => toString(s).length;

const LEFT: FormulaFn = ([s, n]) => {
  const str = toString(s);
  const count = toNumber(n) ?? 0;
  return str.substring(0, count);
};

const RIGHT: FormulaFn = ([s, n]) => {
  const str = toString(s);
  const count = toNumber(n) ?? 0;
  return str.substring(str.length - count);
};

const MID: FormulaFn = ([s, start, count]) => {
  const str = toString(s);
  const st = (toNumber(start) ?? 1) - 1; // 1-indexed
  const ct = toNumber(count) ?? 0;
  return str.substring(st, st + ct);
};

const REPT: FormulaFn = ([s, n]) => {
  const str = toString(s);
  const count = toNumber(n) ?? 0;
  return str.repeat(Math.max(0, Math.floor(count)));
};

const T: FormulaFn = ([v]) => (typeof v === 'string' ? v : null);

const FIND: FormulaFn = ([needle, haystack, startPos]) => {
  const n = toString(needle);
  const h = toString(haystack);
  const start = toNumber(startPos) ?? 0;
  const idx = h.indexOf(n, start);
  return idx === -1 ? 0 : idx + 1;
};

const SEARCH: FormulaFn = ([needle, haystack, startPos]) => {
  const n = toString(needle);
  const h = toString(haystack);
  const start = toNumber(startPos) ?? 0;
  const idx = h.indexOf(n, start);
  return idx === -1 ? null : idx + 1;
};

const SUBSTITUTE: FormulaFn = ([s, oldText, newText, index]) => {
  const str = toString(s);
  const old = toString(oldText);
  const rep = toString(newText);
  const idx = index != null ? toNumber(index) : null;

  if (idx != null && idx > 0) {
    let count = 0;
    return str.replace(new RegExp(old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), (match) => {
      count++;
      return count === idx ? rep : match;
    });
  }
  return str.split(old).join(rep);
};

const REPLACE: FormulaFn = ([s, start, count, replacement]) => {
  const str = toString(s);
  const st = (toNumber(start) ?? 1) - 1;
  const ct = toNumber(count) ?? 0;
  return str.substring(0, st) + toString(replacement) + str.substring(st + ct);
};

const ENCODE_URL_COMPONENT: FormulaFn = ([s]) => encodeURIComponent(toString(s));

// ─── C.2 Logical Functions ───────────────────────────────

const IF: FormulaFn = ([condition, ifTrue, ifFalse]) => {
  return isTruthy(condition) ? ifTrue : ifFalse;
};

const AND: FormulaFn = (args) => args.every(isTruthy) ? 1 : 0;
const OR: FormulaFn = (args) => args.some(isTruthy) ? 1 : 0;
const NOT: FormulaFn = ([v]) => isTruthy(v) ? 0 : 1;

const XOR: FormulaFn = (args) => {
  const trueCount = args.filter(isTruthy).length;
  return trueCount % 2 === 1 ? 1 : 0;
};

const SWITCH: FormulaFn = (args) => {
  if (args.length < 1) return null;
  const expr = args[0];
  for (let i = 1; i + 1 < args.length; i += 2) {
    if (expr === args[i] || (toString(expr) === toString(args[i]))) {
      return args[i + 1];
    }
  }
  if (args.length >= 2 && (args.length - 1) % 2 === 1) {
    return args[args.length - 1];
  }
  return null;
};

const TRUE: FormulaFn = () => 1;
const FALSE: FormulaFn = () => 0;
const BLANK: FormulaFn = () => null;
const ERROR: FormulaFn = () => { throw new FormulaError('#ERROR!'); };

const ISERROR: FormulaFn = ([v]) => {
  return v instanceof FormulaError ? 1 : 0;
};

// ─── C.3 Numeric Functions ───────────────────────────────

const ABS: FormulaFn = ([v]) => Math.abs(toNumber(v) ?? 0);

const CEILING: FormulaFn = ([v, sig]) => {
  const val = toNumber(v) ?? 0;
  const s = toNumber(sig) ?? 1;
  return Math.ceil(val / s) * s;
};

const FLOOR: FormulaFn = ([v, sig]) => {
  const val = toNumber(v) ?? 0;
  const s = toNumber(sig) ?? 1;
  return Math.floor(val / s) * s;
};

const ROUND: FormulaFn = ([v, precision]) => {
  const val = toNumber(v) ?? 0;
  const p = toNumber(precision) ?? 0;
  const factor = Math.pow(10, p);
  return Math.round(val * factor) / factor;
};

const ROUNDUP: FormulaFn = ([v, precision]) => {
  const val = toNumber(v) ?? 0;
  const p = toNumber(precision) ?? 0;
  const factor = Math.pow(10, p);
  return (val >= 0 ? Math.ceil(val * factor) : Math.floor(val * factor)) / factor;
};

const ROUNDDOWN: FormulaFn = ([v, precision]) => {
  const val = toNumber(v) ?? 0;
  const p = toNumber(precision) ?? 0;
  const factor = Math.pow(10, p);
  return (val >= 0 ? Math.floor(val * factor) : Math.ceil(val * factor)) / factor;
};

const INT: FormulaFn = ([v]) => Math.floor(toNumber(v) ?? 0);

const EVEN: FormulaFn = ([v]) => {
  const n = toNumber(v) ?? 0;
  const c = Math.ceil(Math.abs(n));
  const even = c % 2 === 0 ? c : c + 1;
  return n >= 0 ? even : -even;
};

const ODD: FormulaFn = ([v]) => {
  const n = toNumber(v) ?? 0;
  const c = Math.ceil(Math.abs(n));
  const odd = c % 2 === 1 ? c : c + 1;
  return n >= 0 ? odd : -odd;
};

const MOD: FormulaFn = ([v, divisor]) => {
  const val = toNumber(v) ?? 0;
  const div = toNumber(divisor) ?? 1;
  return val % div;
};

const POWER: FormulaFn = ([base, power]) => {
  return Math.pow(toNumber(base) ?? 0, toNumber(power) ?? 0);
};

const SQRT: FormulaFn = ([v]) => Math.sqrt(toNumber(v) ?? 0);
const EXP: FormulaFn = ([v]) => Math.exp(toNumber(v) ?? 0);

const LOG: FormulaFn = ([v, base]) => {
  const val = toNumber(v) ?? 0;
  const b = toNumber(base) ?? 10;
  return Math.log(val) / Math.log(b);
};

const SUM: FormulaFn = (args) => {
  let total = 0;
  for (const a of args) {
    const n = toNumber(a);
    if (n != null) total += n;
  }
  return total;
};

const AVERAGE: FormulaFn = (args) => {
  let total = 0, count = 0;
  for (const a of args) {
    const n = toNumber(a);
    if (n != null) { total += n; count++; }
  }
  return count > 0 ? total / count : null;
};

const MAX: FormulaFn = (args) => {
  const nums = args.map(toNumber).filter(n => n != null) as number[];
  return nums.length > 0 ? Math.max(...nums) : null;
};

const MIN: FormulaFn = (args) => {
  const nums = args.map(toNumber).filter(n => n != null) as number[];
  return nums.length > 0 ? Math.min(...nums) : null;
};

const COUNT: FormulaFn = (args) => args.filter(a => toNumber(a) != null).length;
const COUNTA: FormulaFn = (args) => args.filter(a => !isBlank(a)).length;
const COUNTALL: FormulaFn = (args) => args.length;

const VALUE: FormulaFn = ([s]) => {
  const str = toString(s).replace(/[^0-9.\-]/g, '');
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
};

// ─── C.4 Date/Time Functions ─────────────────────────────

const UNIT_MS: Record<string, number> = {
  milliseconds: 1, ms: 1,
  seconds: 1000, s: 1000,
  minutes: 60_000, m: 60_000,
  hours: 3_600_000, h: 3_600_000,
  days: 86_400_000, d: 86_400_000,
  weeks: 604_800_000, w: 604_800_000,
};

const TODAY: FormulaFn = (_, ctx) => {
  const d = ctx.now();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

const NOW: FormulaFn = (_, ctx) => ctx.now();

const DATEADD: FormulaFn = ([date, count, units]) => {
  const d = toDate(date);
  const n = toNumber(count) ?? 0;
  const unit = toString(units).toLowerCase();
  if (!d) return null;
  const result = new Date(d);

  if (unit === 'years' || unit === 'year') {
    result.setFullYear(result.getFullYear() + n);
  } else if (unit === 'months' || unit === 'month') {
    result.setMonth(result.getMonth() + n);
  } else {
    const ms = UNIT_MS[unit] || UNIT_MS.days;
    result.setTime(result.getTime() + n * ms);
  }
  return result;
};

const DATETIME_DIFF: FormulaFn = ([date1, date2, units]) => {
  const d1 = toDate(date1);
  const d2 = toDate(date2);
  if (!d1 || !d2) return null;

  const unit = toString(units).toLowerCase();
  const diffMs = d1.getTime() - d2.getTime();

  if (unit === 'years' || unit === 'year') {
    return d1.getFullYear() - d2.getFullYear();
  }
  if (unit === 'months' || unit === 'month') {
    return (d1.getFullYear() - d2.getFullYear()) * 12 + (d1.getMonth() - d2.getMonth());
  }

  const ms = UNIT_MS[unit] || UNIT_MS.seconds;
  return Math.floor(diffMs / ms);
};

const DATETIME_PARSE: FormulaFn = ([text]) => toDate(text);

const DATETIME_FORMAT: FormulaFn = ([date, format]) => {
  const d = toDate(date);
  if (!d) return null;
  const fmt = toString(format);

  return fmt
    .replace('YYYY', String(d.getFullYear()))
    .replace('YY', String(d.getFullYear()).slice(-2))
    .replace('MM', String(d.getMonth() + 1).padStart(2, '0'))
    .replace('M', String(d.getMonth() + 1))
    .replace('DD', String(d.getDate()).padStart(2, '0'))
    .replace('D', String(d.getDate()))
    .replace('HH', String(d.getHours()).padStart(2, '0'))
    .replace('hh', String(d.getHours() % 12 || 12).padStart(2, '0'))
    .replace('mm', String(d.getMinutes()).padStart(2, '0'))
    .replace('ss', String(d.getSeconds()).padStart(2, '0'))
    .replace('a', d.getHours() >= 12 ? 'pm' : 'am')
    .replace('A', d.getHours() >= 12 ? 'PM' : 'AM');
};

const DATESTR: FormulaFn = ([date]) => {
  const d = toDate(date);
  if (!d) return null;
  return formatDateISO(d);
};

const TIMESTR: FormulaFn = ([date]) => {
  const d = toDate(date);
  if (!d) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};

const DAY: FormulaFn = ([date]) => { const d = toDate(date); return d ? d.getDate() : null; };
const MONTH: FormulaFn = ([date]) => { const d = toDate(date); return d ? d.getMonth() + 1 : null; };
const YEAR: FormulaFn = ([date]) => { const d = toDate(date); return d ? d.getFullYear() : null; };
const HOUR: FormulaFn = ([date]) => { const d = toDate(date); return d ? d.getHours() : null; };
const MINUTE: FormulaFn = ([date]) => { const d = toDate(date); return d ? d.getMinutes() : null; };
const SECOND: FormulaFn = ([date]) => { const d = toDate(date); return d ? d.getSeconds() : null; };
const WEEKDAY: FormulaFn = ([date]) => { const d = toDate(date); return d ? d.getDay() : null; };

const WEEKNUM: FormulaFn = ([date]) => {
  const d = toDate(date);
  if (!d) return null;
  const start = new Date(d.getFullYear(), 0, 1);
  const diff = d.getTime() - start.getTime();
  return Math.ceil((diff / 86_400_000 + start.getDay() + 1) / 7);
};

const IS_BEFORE: FormulaFn = ([d1, d2]) => {
  const a = toDate(d1), b = toDate(d2);
  return a && b && a.getTime() < b.getTime() ? 1 : 0;
};

const IS_AFTER: FormulaFn = ([d1, d2]) => {
  const a = toDate(d1), b = toDate(d2);
  return a && b && a.getTime() > b.getTime() ? 1 : 0;
};

const IS_SAME: FormulaFn = ([d1, d2, unit]) => {
  const a = toDate(d1), b = toDate(d2);
  if (!a || !b) return 0;
  const u = toString(unit).toLowerCase();
  if (u === 'year') return a.getFullYear() === b.getFullYear() ? 1 : 0;
  if (u === 'month') return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() ? 1 : 0;
  if (u === 'day') return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate() ? 1 : 0;
  if (u === 'hour') return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate() && a.getHours() === b.getHours() ? 1 : 0;
  return a.getTime() === b.getTime() ? 1 : 0;
};

const TONOW: FormulaFn = ([date], ctx) => {
  const d = toDate(date);
  if (!d) return null;
  const diff = ctx.now().getTime() - d.getTime();
  const days = Math.floor(diff / 86_400_000);
  return `${days} days`;
};

const FROMNOW: FormulaFn = ([date], ctx) => {
  const d = toDate(date);
  if (!d) return null;
  const diff = d.getTime() - ctx.now().getTime();
  const days = Math.floor(diff / 86_400_000);
  return `${Math.abs(days)} days`;
};

const WORKDAY: FormulaFn = ([startDate, numDays, holidays]) => {
  const d = toDate(startDate);
  const n = toNumber(numDays) ?? 0;
  if (!d) return null;

  const holidaySet = new Set<string>();
  if (holidays) {
    toString(holidays).split(',').map(s => s.trim()).filter(Boolean).forEach(h => {
      const hd = toDate(h);
      if (hd) holidaySet.add(formatDateISO(hd));
    });
  }

  const result = new Date(d);
  let remaining = Math.abs(n);
  const direction = n >= 0 ? 1 : -1;

  while (remaining > 0) {
    result.setDate(result.getDate() + direction);
    const day = result.getDay();
    const dateStr = formatDateISO(result);
    if (day !== 0 && day !== 6 && !holidaySet.has(dateStr)) {
      remaining--;
    }
  }
  return result;
};

const WORKDAY_DIFF: FormulaFn = ([startDate, endDate, holidays]) => {
  const d1 = toDate(startDate);
  const d2 = toDate(endDate);
  if (!d1 || !d2) return null;

  const holidaySet = new Set<string>();
  if (holidays) {
    toString(holidays).split(',').map(s => s.trim()).filter(Boolean).forEach(h => {
      const hd = toDate(h);
      if (hd) holidaySet.add(formatDateISO(hd));
    });
  }

  let count = 0;
  const current = new Date(d1);
  const direction = d2.getTime() >= d1.getTime() ? 1 : -1;

  while (true) {
    current.setDate(current.getDate() + direction);
    if (direction === 1 && current.getTime() > d2.getTime()) break;
    if (direction === -1 && current.getTime() < d2.getTime()) break;
    const day = current.getDay();
    const dateStr = formatDateISO(current);
    if (day !== 0 && day !== 6 && !holidaySet.has(dateStr)) {
      count++;
    }
  }
  return count;
};

const SET_TIMEZONE: FormulaFn = ([date]) => toDate(date);
const SET_LOCALE: FormulaFn = ([date]) => toDate(date);

// ─── C.5 Array Functions ─────────────────────────────────

const ARRAYJOIN: FormulaFn = ([arr, separator]) => {
  if (!Array.isArray(arr)) return toString(arr);
  return arr.map(toString).join(toString(separator));
};

const ARRAYCOMPACT: FormulaFn = ([arr]) => {
  if (!Array.isArray(arr)) return arr;
  return arr.filter(v => v != null && v !== '');
};

const ARRAYFLATTEN: FormulaFn = ([arr]) => {
  if (!Array.isArray(arr)) return arr;
  return arr.flat(Infinity);
};

const ARRAYUNIQUE: FormulaFn = ([arr]) => {
  if (!Array.isArray(arr)) return arr;
  return [...new Set(arr)];
};

// ─── C.6 Record Functions ────────────────────────────────

const RECORD_ID: FormulaFn = (_, ctx) => ctx.recordId;

const CREATED_TIME: FormulaFn = (_, ctx) => {
  const entry = ctx.eoState.get(`${ctx.tableTarget}.${ctx.recordId}`);
  return entry ? toDate(entry.value?.createdTime) : null;
};

const LAST_MODIFIED_TIME: FormulaFn = (_args, _ctx) => {
  void _args;
  void _ctx;
  return null;
};

// ─── C.7 Regex Functions ─────────────────────────────────

const REGEX_MATCH: FormulaFn = ([s, pattern]) => {
  try {
    const re = new RegExp(toString(pattern));
    return re.test(toString(s)) ? 1 : 0;
  } catch { return 0; }
};

const REGEX_EXTRACT: FormulaFn = ([s, pattern]) => {
  try {
    const re = new RegExp(toString(pattern));
    const match = toString(s).match(re);
    return match ? match[0] : null;
  } catch { return null; }
};

const REGEX_REPLACE: FormulaFn = ([s, pattern, replacement]) => {
  try {
    const re = new RegExp(toString(pattern), 'g');
    return toString(s).replace(re, toString(replacement));
  } catch { return toString(s); }
};

// ─── Error Type ──────────────────────────────────────────

export class FormulaError {
  message: string;
  constructor(message: string) { this.message = message; }
}

// ─── Function Registry ───────────────────────────────────

export const FORMULA_FUNCTIONS: Record<string, FormulaFn> = {
  // Text (C.1)
  CONCATENATE, TRIM, LOWER, UPPER, LEN, LEFT, RIGHT, MID,
  REPT, T, FIND, SEARCH, SUBSTITUTE, REPLACE, ENCODE_URL_COMPONENT,
  // Logical (C.2)
  IF, AND, OR, NOT, XOR, SWITCH, TRUE, FALSE, BLANK, ERROR, ISERROR,
  // Numeric (C.3)
  ABS, CEILING, FLOOR, ROUND, ROUNDUP, ROUNDDOWN, INT, EVEN, ODD,
  MOD, POWER, SQRT, EXP, LOG, SUM, AVERAGE, MAX, MIN,
  COUNT, COUNTA, COUNTALL, VALUE,
  // Date/Time (C.4)
  TODAY, NOW, DATEADD, DATETIME_DIFF, DATETIME_PARSE, DATETIME_FORMAT,
  DATESTR, TIMESTR, DAY, MONTH, YEAR, HOUR, MINUTE, SECOND,
  WEEKDAY, WEEKNUM, IS_BEFORE, IS_AFTER, IS_SAME,
  TONOW, FROMNOW, WORKDAY, WORKDAY_DIFF, SET_TIMEZONE, SET_LOCALE,
  // Array (C.5)
  ARRAYJOIN, ARRAYCOMPACT, ARRAYFLATTEN, ARRAYUNIQUE,
  // Record (C.6)
  RECORD_ID, CREATED_TIME, LAST_MODIFIED_TIME,
  // Regex (C.7)
  REGEX_MATCH, REGEX_EXTRACT, REGEX_REPLACE,
};
