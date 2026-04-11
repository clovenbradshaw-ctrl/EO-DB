/**
 * Phase A.6/2 — ResolutionPolicyComposer case migration.
 *
 * The composer's StanceEntry.stance taxonomy was renamed from lowercase
 * (`'clearing'`) to titlecase (`'Clearing'`) to match the shared Resolution
 * union in db/types.ts. Persisted FieldSchema.resolve.value records written
 * before this slice use the lowercase form, so normalizeResolvePolicy is
 * the one-shot migration shim applied at the deserialization boundary —
 * the four consumer call sites (SchemaFieldPanel, SchemaView, TableView ×2)
 * route every raw policy value through it before handing to summarizePolicy
 * or the composer.
 *
 * These tests lock the shim's behavior on:
 *   1. Null / undefined / malformed input → null.
 *   2. Canonical titlecase shape passes through unchanged.
 *   3. Legacy lowercase keys migrate to titlecase.
 *   4. Legacy `{ strategy }` shape converts to a Dissecting one-entry policy.
 *   5. Unknown / missing stance entries get filtered out.
 *   6. subType / formula / order survive the round trip.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeResolvePolicy,
  type ResolvePolicy,
} from '../ResolutionPolicyComposer';

describe('A.6/2 — normalizeResolvePolicy', () => {
  // ─── Null / junk inputs ───────────────────────────────────────────────────

  it('returns null for null', () => {
    expect(normalizeResolvePolicy(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(normalizeResolvePolicy(undefined)).toBeNull();
  });

  it('returns null for a string', () => {
    expect(normalizeResolvePolicy('Clearing')).toBeNull();
  });

  it('returns null for a number', () => {
    expect(normalizeResolvePolicy(42)).toBeNull();
  });

  it('returns null for an empty object', () => {
    expect(normalizeResolvePolicy({})).toBeNull();
  });

  it('returns null for { stances: [] } (no-op policy)', () => {
    expect(normalizeResolvePolicy({ stances: [] })).toBeNull();
  });

  it('returns null for { stances: "not an array" }', () => {
    expect(normalizeResolvePolicy({ stances: 'Clearing' })).toBeNull();
  });

  // ─── Canonical titlecase passes through ──────────────────────────────────

  it('passes a single-stance titlecase policy through unchanged', () => {
    const input = { stances: [{ stance: 'Clearing' }] };
    const out = normalizeResolvePolicy(input);
    expect(out).toEqual<ResolvePolicy>({ stances: [{ stance: 'Clearing' }] });
  });

  it('passes a multi-stance titlecase policy through unchanged', () => {
    const input: ResolvePolicy = {
      stances: [
        { stance: 'Dissecting', subType: 'latest', order: 0 },
        { stance: 'Making', formula: 'AVERAGE(a, b)', order: 1 },
      ],
    };
    expect(normalizeResolvePolicy(input)).toEqual(input);
  });

  // ─── Legacy lowercase keys migrate to titlecase ──────────────────────────

  it('migrates a single-stance lowercase policy to titlecase', () => {
    const legacy = { stances: [{ stance: 'clearing' }] };
    const out = normalizeResolvePolicy(legacy);
    expect(out).toEqual<ResolvePolicy>({ stances: [{ stance: 'Clearing' }] });
  });

  it('migrates every one of the nine lowercase stances to its titlecase counterpart', () => {
    const legacy = {
      stances: [
        { stance: 'clearing' },
        { stance: 'dissecting' },
        { stance: 'unraveling' },
        { stance: 'tending' },
        { stance: 'binding' },
        { stance: 'tracing' },
        { stance: 'cultivating' },
        { stance: 'making' },
        { stance: 'composing' },
      ],
    };
    const out = normalizeResolvePolicy(legacy);
    expect(out).not.toBeNull();
    expect(out!.stances.map(s => s.stance)).toEqual([
      'Clearing',
      'Dissecting',
      'Unraveling',
      'Tending',
      'Binding',
      'Tracing',
      'Cultivating',
      'Making',
      'Composing',
    ]);
  });

  it('preserves subType, formula, and order during lowercase migration', () => {
    const legacy = {
      stances: [
        { stance: 'dissecting', subType: 'latest', order: 0 },
        { stance: 'making', formula: 'AVERAGE(a, b)', order: 1 },
      ],
    };
    const out = normalizeResolvePolicy(legacy);
    expect(out).toEqual<ResolvePolicy>({
      stances: [
        { stance: 'Dissecting', subType: 'latest', order: 0 },
        { stance: 'Making', formula: 'AVERAGE(a, b)', order: 1 },
      ],
    });
  });

  // ─── Legacy { strategy } shape ───────────────────────────────────────────

  it("converts legacy { strategy: 'latest' } to a Dissecting one-entry policy", () => {
    const legacy = { strategy: 'latest' };
    const out = normalizeResolvePolicy(legacy);
    expect(out).toEqual<ResolvePolicy>({
      stances: [{ stance: 'Dissecting', subType: 'latest' }],
    });
  });

  it('converts legacy { strategy } regardless of the strategy value', () => {
    expect(normalizeResolvePolicy({ strategy: 'first' })).toEqual({
      stances: [{ stance: 'Dissecting', subType: 'first' }],
    });
    expect(normalizeResolvePolicy({ strategy: 'priority' })).toEqual({
      stances: [{ stance: 'Dissecting', subType: 'priority' }],
    });
  });

  it('prefers { stances } over { strategy } when both are present', () => {
    // Defensive: if a record somehow carries both, the explicit stances
    // array wins because it's the more specific form.
    const mixed = {
      stances: [{ stance: 'binding' }],
      strategy: 'latest',
    };
    const out = normalizeResolvePolicy(mixed);
    expect(out).toEqual<ResolvePolicy>({ stances: [{ stance: 'Binding' }] });
  });

  // ─── Filtering of invalid entries ────────────────────────────────────────

  it('drops entries whose stance is an unknown value', () => {
    const input = {
      stances: [
        { stance: 'Clearing' },
        { stance: 'totally-not-a-stance' },
        { stance: 'Making' },
      ],
    };
    const out = normalizeResolvePolicy(input);
    expect(out!.stances.map(s => s.stance)).toEqual(['Clearing', 'Making']);
  });

  it('drops entries whose stance is missing', () => {
    const input = {
      stances: [
        { stance: 'Clearing' },
        { subType: 'latest' }, // no stance
        { stance: 'Making' },
      ],
    };
    const out = normalizeResolvePolicy(input);
    expect(out!.stances.map(s => s.stance)).toEqual(['Clearing', 'Making']);
  });

  it('drops non-object entries', () => {
    const input = { stances: [null, 'Clearing', 42, { stance: 'Binding' }] };
    const out = normalizeResolvePolicy(input);
    expect(out).toEqual<ResolvePolicy>({ stances: [{ stance: 'Binding' }] });
  });

  it('returns null if every entry is invalid', () => {
    const input = { stances: [{ stance: 'gibberish' }, { other: 'field' }] };
    expect(normalizeResolvePolicy(input)).toBeNull();
  });

  // ─── Mixed case ──────────────────────────────────────────────────────────

  it('normalizes a mix of titlecase and lowercase entries in one pass', () => {
    const mixed = {
      stances: [
        { stance: 'Clearing' },
        { stance: 'dissecting', subType: 'latest' },
        { stance: 'Making', formula: 'AVERAGE(a, b)' },
      ],
    };
    const out = normalizeResolvePolicy(mixed);
    expect(out).toEqual<ResolvePolicy>({
      stances: [
        { stance: 'Clearing' },
        { stance: 'Dissecting', subType: 'latest' },
        { stance: 'Making', formula: 'AVERAGE(a, b)' },
      ],
    });
  });

  it('is idempotent on already-canonical input', () => {
    const canonical: ResolvePolicy = {
      stances: [
        { stance: 'Clearing', order: 0 },
        { stance: 'Tracing', order: 1 },
      ],
    };
    const once = normalizeResolvePolicy(canonical);
    const twice = normalizeResolvePolicy(once);
    expect(twice).toEqual(canonical);
  });
});
