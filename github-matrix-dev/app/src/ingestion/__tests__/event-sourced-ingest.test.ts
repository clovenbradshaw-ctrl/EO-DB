/**
 * Idempotency contract for the shared event-sourced ingest helper.
 *
 * These are the pure pieces — `computeFieldDiff`, `recordTarget`, and the
 * `insEventId` / `defEventId` / `tombstoneEventId` client-event-id
 * constructors. Their determinism is what lets replays, peer-sync, and
 * second-device hydration all converge to the same EO log without
 * double-emitting records.
 *
 * The async orchestrator `ingestRemoteRecord` is intentionally NOT
 * covered here — it depends on the Zustand-backed EO store and is
 * exercised via integration tests in the consuming services.
 */

import { describe, it, expect } from 'vitest';
import {
  computeFieldDiff,
  defEventId,
  insEventId,
  recordTarget,
  tombstoneEventId,
} from '../event-sourced-ingest';

// ─── recordTarget ──────────────────────────────────────────────────────────

describe('recordTarget', () => {
  it('uses api.records.{cid}.{rid} so getStateByPrefix(api.records.{cid}.) can scan a single connection', () => {
    expect(recordTarget('conn-1', 'rec-A')).toBe('api.records.conn-1.rec-A');
  });

  it('separates two connections that share a record id', () => {
    expect(recordTarget('conn-1', 'rec-X')).not.toBe(recordTarget('conn-2', 'rec-X'));
  });
});

// ─── computeFieldDiff ──────────────────────────────────────────────────────

describe('computeFieldDiff', () => {
  it('returns every non-null field for new records', () => {
    expect(computeFieldDiff({ a: 1, b: 'x', c: null }, undefined)).toEqual({ a: 1, b: 'x' });
  });

  it('drops undefined as well as null for new records', () => {
    expect(computeFieldDiff({ a: 1, b: undefined, c: null }, undefined)).toEqual({ a: 1 });
  });

  it('returns only changed fields against existing state', () => {
    expect(computeFieldDiff({ a: 1, b: 'new', c: 3 }, { a: 1, b: 'old', c: 3 })).toEqual({ b: 'new' });
  });

  it('returns the empty diff when nothing changed', () => {
    expect(computeFieldDiff({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual({});
  });

  it('treats a null-to-value change as a diff against existing state', () => {
    expect(computeFieldDiff({ a: 'x' }, { a: null })).toEqual({ a: 'x' });
  });

  it('uses deep equality so reordered keys do not produce a spurious diff', () => {
    const incoming = { obj: { a: 1, b: 2 } };
    const existing = { obj: { b: 2, a: 1 } };
    expect(computeFieldDiff(incoming, existing)).toEqual({});
  });
});

// ─── insEventId ────────────────────────────────────────────────────────────

describe('insEventId', () => {
  it('is deterministic for the same (cid, rid)', () => {
    expect(insEventId('c', 'r')).toBe(insEventId('c', 'r'));
  });

  it('distinguishes between connections', () => {
    expect(insEventId('c1', 'r')).not.toBe(insEventId('c2', 'r'));
  });

  it('uses the at-conn:ins namespace so it cannot collide with airtable-sync.ts at-sync IDs', () => {
    expect(insEventId('c', 'r')).toMatch(/^at-conn:ins:/);
  });
});

// ─── defEventId ────────────────────────────────────────────────────────────

describe('defEventId', () => {
  it('is deterministic for the same content key', () => {
    expect(defEventId('c', 'r', '{"a":1}')).toBe(defEventId('c', 'r', '{"a":1}'));
  });

  it('changes when the content key changes', () => {
    expect(defEventId('c', 'r', '{"a":1}')).not.toBe(defEventId('c', 'r', '{"a":2}'));
  });

  it('distinguishes between connections that produce the same content', () => {
    expect(defEventId('c1', 'r', '{"a":1}')).not.toBe(defEventId('c2', 'r', '{"a":1}'));
  });

  it('uses the at-conn:def namespace', () => {
    expect(defEventId('c', 'r', 'x')).toMatch(/^at-conn:def:/);
  });
});

// ─── tombstoneEventId ──────────────────────────────────────────────────────

describe('tombstoneEventId', () => {
  it('distinguishes deletes at different timestamps so a delete-undelete-redelete cycle does not dedup', () => {
    expect(tombstoneEventId('c', 'r', '2026-01-01T00:00:00Z'))
      .not.toBe(tombstoneEventId('c', 'r', '2026-01-02T00:00:00Z'));
  });

  it('uses the at-conn:del namespace', () => {
    expect(tombstoneEventId('c', 'r', '2026-01-01T00:00:00Z')).toMatch(/^at-conn:del:/);
  });
});
