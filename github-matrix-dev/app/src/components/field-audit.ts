import type { EoEvent } from '../db/types';

/**
 * A single point on a field's audit trail. Derived purely from DEF events
 * already in the log — we don't store audit data alongside the value.
 *
 *  - `value`            the value this DEF assigned to the field
 *  - `agent`            who wrote it (Matrix user ID, 'system', sync agent…)
 *  - `ts`               submission timestamp (when the writer dispatched)
 *  - `acquiredTs`       when the server received / acquired the event
 *  - `source`           syncing method (e.g. 'user', 'airtable', 'sync',
 *                       'revert'); falls back to 'unknown' when missing
 *  - `branch`           branch the write happened on
 *  - `seq`              log sequence number — stable identity of this write
 *  - `clientEventId`    idempotency id supplied by the client (if any)
 *  - `revertedFromSeq`  set when this write was itself a revert; points at the
 *                       historical entry whose value was re-applied
 */
export interface FieldAuditEntry {
  value: unknown;
  agent: string;
  ts: string;
  acquiredTs: string;
  source: string;
  branch: string;
  seq: number;
  clientEventId?: string;
  revertedFromSeq?: number;
}

/**
 * Pull every value a field has ever held out of the event log.
 *
 * DEF events shallow-merge their operand into the record's value. So a field
 * has changed in an event iff that field name appears as a key in the
 * operand. We also flatten an inner `fields` sub-object (legacy Airtable
 * import shape) the same way `FigureFields` flattens it for display.
 *
 * Consecutive identical values collapse into one entry — re-asserting the
 * same value isn't a meaningful audit point.
 *
 * Returns entries in chronological order (oldest first).
 */
export function getFieldAuditTrail(
  events: EoEvent[] | undefined,
  fieldKey: string,
): FieldAuditEntry[] {
  if (!events || events.length === 0) return [];

  const defs = events
    .filter((e) => e.op === 'DEF')
    .slice()
    .sort((a, b) => {
      const ta = new Date(a.ts).getTime();
      const tb = new Date(b.ts).getTime();
      if (ta !== tb) return ta - tb;
      return (a.seq ?? 0) - (b.seq ?? 0);
    });

  const trail: FieldAuditEntry[] = [];

  for (const evt of defs) {
    const op = evt.operand as Record<string, unknown> | undefined;
    if (!op || typeof op !== 'object') continue;

    let value: unknown;
    let touched = false;
    if (Object.prototype.hasOwnProperty.call(op, fieldKey)) {
      value = op[fieldKey];
      touched = true;
    } else if (
      op.fields &&
      typeof op.fields === 'object' &&
      !Array.isArray(op.fields) &&
      Object.prototype.hasOwnProperty.call(op.fields, fieldKey)
    ) {
      value = (op.fields as Record<string, unknown>)[fieldKey];
      touched = true;
    }
    if (!touched) continue;

    const last = trail[trail.length - 1];
    if (last && JSON.stringify(last.value) === JSON.stringify(value)) continue;

    const meta = (evt.meta ?? {}) as Record<string, unknown>;
    const revertedFromSeq =
      typeof meta.revertedFromSeq === 'number' ? meta.revertedFromSeq : undefined;

    trail.push({
      value,
      agent: evt.agent ?? 'unknown',
      ts: evt.ts,
      acquiredTs: evt.acquired_ts ?? evt.ts,
      source: evt.source ?? 'unknown',
      branch: evt.branch ?? 'main',
      seq: evt.seq,
      clientEventId: evt.client_event_id,
      revertedFromSeq,
    });
  }

  return trail;
}

/** The latest audit entry — i.e. the field's current provenance. */
export function getLatestFieldAudit(
  events: EoEvent[] | undefined,
  fieldKey: string,
): FieldAuditEntry | null {
  const trail = getFieldAuditTrail(events, fieldKey);
  return trail.length > 0 ? trail[trail.length - 1] : null;
}

/**
 * Display a Matrix user ID as a short handle. "@alice:matrix.org" → "alice".
 * Plain identifiers ('system', 'user', 'airtable-sync') pass through.
 */
export function shortAgent(agentId: string): string {
  if (!agentId) return 'unknown';
  const m = agentId.match(/^@?([^:@]+)/);
  return m ? m[1] : agentId;
}

/** Compact relative-time label suitable for inline metadata. */
export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return new Date(iso).toLocaleString();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Friendlier label for a sync source. */
export function formatSource(source: string): string {
  switch (source) {
    case 'unknown':
    case '':
      return 'manual';
    case 'user':
      return 'manual edit';
    case 'agent':
      return 'manual edit';
    case 'airtable':
      return 'Airtable sync';
    case 'sync':
      return 'peer sync';
    case 'sandbox':
      return 'sandbox';
    case 'revert':
      return 'revert';
    default:
      return source;
  }
}
