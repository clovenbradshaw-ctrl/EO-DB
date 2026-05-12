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
  fieldDefEventId,
  fieldInsEventId,
  fieldSchemaTarget,
  insEventId,
  recordTarget,
  schemaDefEventId,
  schemaInsEventId,
  schemaTarget,
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

// ─── schemaTarget / fieldSchemaTarget ──────────────────────────────────────

describe('schemaTarget', () => {
  it('uses api.schema.{cid} so a per-connection scan separates schemas', () => {
    expect(schemaTarget('conn-1')).toBe('api.schema.conn-1');
  });

  it('separates two connections', () => {
    expect(schemaTarget('conn-1')).not.toBe(schemaTarget('conn-2'));
  });
});

describe('fieldSchemaTarget', () => {
  it('nests under the connection schema target', () => {
    expect(fieldSchemaTarget('c', 'fldX')).toBe('api.schema.c.field.fldX');
  });

  it('shares the schema prefix so getStateByPrefix can enumerate all fields', () => {
    expect(fieldSchemaTarget('c', 'fldX').startsWith(schemaTarget('c') + '.')).toBe(true);
  });
});

// ─── schemaInsEventId / schemaDefEventId ───────────────────────────────────

describe('schemaInsEventId', () => {
  it('is deterministic and distinguishes connections', () => {
    expect(schemaInsEventId('c')).toBe(schemaInsEventId('c'));
    expect(schemaInsEventId('c1')).not.toBe(schemaInsEventId('c2'));
  });

  it('uses the at-conn:schema:ins namespace', () => {
    expect(schemaInsEventId('c')).toMatch(/^at-conn:schema:ins:/);
  });
});

describe('schemaDefEventId', () => {
  it('changes when the content key changes', () => {
    expect(schemaDefEventId('c', 'k1')).not.toBe(schemaDefEventId('c', 'k2'));
  });

  it('stays stable for the same content key — a no-op re-emit dedups', () => {
    expect(schemaDefEventId('c', 'k')).toBe(schemaDefEventId('c', 'k'));
  });
});

// ─── fieldInsEventId / fieldDefEventId ─────────────────────────────────────

describe('fieldInsEventId', () => {
  it('distinguishes fields within the same connection', () => {
    expect(fieldInsEventId('c', 'fldX')).not.toBe(fieldInsEventId('c', 'fldY'));
  });

  it('distinguishes the same field across connections', () => {
    expect(fieldInsEventId('c1', 'fldX')).not.toBe(fieldInsEventId('c2', 'fldX'));
  });
});

describe('fieldDefEventId', () => {
  it('changes when field metadata changes (e.g. linked-table id flips)', () => {
    const a = fieldDefEventId('c', 'fldX', '{"linkedTableId":"tblA"}');
    const b = fieldDefEventId('c', 'fldX', '{"linkedTableId":"tblB"}');
    expect(a).not.toBe(b);
  });
});

describe('tombstoneEventId', () => {
  it('distinguishes deletes at different timestamps so a delete-undelete-redelete cycle does not dedup', () => {
    expect(tombstoneEventId('c', 'r', '2026-01-01T00:00:00Z'))
      .not.toBe(tombstoneEventId('c', 'r', '2026-01-02T00:00:00Z'));
  });

  it('uses the at-conn:del namespace', () => {
    expect(tombstoneEventId('c', 'r', '2026-01-01T00:00:00Z')).toMatch(/^at-conn:del:/);
  });
});
