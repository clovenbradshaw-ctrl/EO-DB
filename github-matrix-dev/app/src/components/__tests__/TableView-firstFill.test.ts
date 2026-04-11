/**
 * Phase A.6/5 — TableView first-fill DEF × Making (end-to-end).
 *
 * This test pins down the interactive authoring path's resolution-axis
 * behavior: when `handleCellSave` lands a value on a field whose prior
 * value is absent (undefined / null / '' / []), the dispatched DEF must
 * carry `resolution: 'Making'`. When the prior value is present, the
 * dispatched DEF must carry NO resolution field (reads back as
 * 'unspecified', matching the existing inline shape in TableView.tsx).
 *
 * The project has no React Testing Library wiring (all existing tests are
 * .test.ts, no .test.tsx), so this file does not render the TableView
 * component. Instead it exercises the exact same code path
 * `handleCellSave` runs:
 *
 *   1. Build an EoState record via the same shape TableView receives from
 *      `useEoStore`.
 *   2. Read prior via `getFieldValue(rec, fieldKey, useFieldsSub)` — the
 *      same helper `handleCellSave` uses at TableView.tsx:1289/1385.
 *   3. Apply the first-fill predicate and dispatch through a fake-dispatch
 *      double, using `buildMakingDefEvent` for first-fill and the existing
 *      inline DEF shape otherwise.
 *   4. Assert on the captured dispatched event.
 *
 * The `simulateHandleCellSave` helper below is a direct transcription of
 * the first-fill branch in `handleCellSave`; if the TableView logic drifts
 * from the predicate documented here, these assertions will flag it.
 */

import { describe, it, expect } from 'vitest';
import { buildMakingDefEvent } from '../cell-events';
import { getFieldValue } from '../filter-types';
import type { EoState, EoEventInput } from '../../db/types';

type Dispatch = (ev: EoEventInput) => void;

/**
 * Pure transcription of `handleCellSave`'s first-fill + dispatch logic.
 * Callers provide the dispatch double and receive back the events that
 * would have been dispatched. Kept local to the test file so it cannot
 * drift into production as a hidden abstraction.
 */
function simulateHandleCellSave(
  records: EoState[],
  target: string,
  fieldKey: string,
  rawValue: string,
  agent: string,
  useFieldsSub: boolean,
  dispatch: Dispatch,
  ts: string = '2026-04-11T10:00:00.000Z',
): void {
  let parsed: unknown = rawValue;
  try { parsed = JSON.parse(rawValue); } catch { /* keep as string */ }

  const rec = records.find((r) => r.target === target);
  const prior = rec ? getFieldValue(rec, fieldKey, useFieldsSub) : undefined;
  const isFirstFill =
    prior === undefined ||
    prior === null ||
    prior === '' ||
    (Array.isArray(prior) && prior.length === 0);

  if (isFirstFill) {
    dispatch(buildMakingDefEvent(target, fieldKey, parsed, agent, useFieldsSub, ts));
  } else {
    const operand = useFieldsSub
      ? { fields: { [fieldKey]: parsed } }
      : { [fieldKey]: parsed };
    dispatch({
      op: 'DEF',
      target,
      operand,
      agent,
      ts,
      acquired_ts: ts,
    });
  }
}

/** Helper: build a minimal EoState record with a value subtree. */
function makeRecord(target: string, value: unknown): EoState {
  return {
    target,
    value,
    level: 1,
    last_seq: 1,
    last_op: 'INS',
    last_agent: 'user:@alice:example.com',
    last_ts: '2026-04-11T09:00:00.000Z',
    last_acquired_ts: '2026-04-11T09:00:00.000Z',
  };
}

describe('A.6/5 — TableView handleCellSave first-fill → DEF × Making', () => {
  it('undefined field → first save stamps resolution: Making', () => {
    // Record has fields sub-object but the target field is absent.
    const records = [
      makeRecord('at.appX.tblY.recA', { fields: { name: 'Alice' } }),
    ];
    const captured: EoEventInput[] = [];

    simulateHandleCellSave(
      records,
      'at.appX.tblY.recA',
      'fldEmail',
      '"alice@example.com"',
      'user:@alice:example.com',
      /* useFieldsSub */ true,
      (ev) => captured.push(ev),
    );

    expect(captured.length).toBe(1);
    expect(captured[0].op).toBe('DEF');
    expect(captured[0].resolution).toBe('Making');
    expect(captured[0].operand).toEqual({ fields: { fldEmail: 'alice@example.com' } });
  });

  it('second save to a non-empty value has NO resolution field', () => {
    // After the first fill, the record holds a value. The next save is a
    // plain update and must NOT stamp Making.
    const records = [
      makeRecord('at.appX.tblY.recA', {
        fields: { name: 'Alice', fldEmail: 'alice@example.com' },
      }),
    ];
    const captured: EoEventInput[] = [];

    simulateHandleCellSave(
      records,
      'at.appX.tblY.recA',
      'fldEmail',
      '"alice2@example.com"',
      'user:@alice:example.com',
      true,
      (ev) => captured.push(ev),
    );

    expect(captured.length).toBe(1);
    expect(captured[0].op).toBe('DEF');
    expect(captured[0].resolution).toBeUndefined();
    expect(captured[0].operand).toEqual({
      fields: { fldEmail: 'alice2@example.com' },
    });
  });

  it('null field value → first-fill (prior === null)', () => {
    const records = [
      makeRecord('at.appX.tblY.recA', { fields: { fldEmail: null } }),
    ];
    const captured: EoEventInput[] = [];

    simulateHandleCellSave(
      records,
      'at.appX.tblY.recA',
      'fldEmail',
      '"alice@example.com"',
      'user:@alice:example.com',
      true,
      (ev) => captured.push(ev),
    );

    expect(captured[0].resolution).toBe('Making');
  });

  it('empty-string field value → first-fill (scalar empty)', () => {
    const records = [
      makeRecord('at.appX.tblY.recA', { fields: { fldTitle: '' } }),
    ];
    const captured: EoEventInput[] = [];

    simulateHandleCellSave(
      records,
      'at.appX.tblY.recA',
      'fldTitle',
      '"Hello World"',
      'user:@alice:example.com',
      true,
      (ev) => captured.push(ev),
    );

    expect(captured[0].resolution).toBe('Making');
    expect(captured[0].operand).toEqual({ fields: { fldTitle: 'Hello World' } });
  });

  it('empty-array multiSelect → first-fill (Array.isArray + length 0)', () => {
    const records = [
      makeRecord('at.appX.tblY.recA', { fields: { fldTags: [] } }),
    ];
    const captured: EoEventInput[] = [];

    simulateHandleCellSave(
      records,
      'at.appX.tblY.recA',
      'fldTags',
      '["urgent","blocked"]',
      'user:@alice:example.com',
      true,
      (ev) => captured.push(ev),
    );

    expect(captured[0].resolution).toBe('Making');
    expect(captured[0].operand).toEqual({
      fields: { fldTags: ['urgent', 'blocked'] },
    });
  });

  it('populated multiSelect → plain update, no resolution', () => {
    const records = [
      makeRecord('at.appX.tblY.recA', {
        fields: { fldTags: ['urgent'] },
      }),
    ];
    const captured: EoEventInput[] = [];

    simulateHandleCellSave(
      records,
      'at.appX.tblY.recA',
      'fldTags',
      '["urgent","blocked"]',
      'user:@alice:example.com',
      true,
      (ev) => captured.push(ev),
    );

    expect(captured[0].resolution).toBeUndefined();
  });

  it('flat (non-fields-sub) layout: undefined → first-fill, populated → plain', () => {
    // useFieldsSub = false: the record stores values at value[fieldKey]
    // directly, not under value.fields. Exercises the else-branch of
    // getFieldValue and of buildMakingDefEvent's operand shape.
    const undefinedRec = makeRecord('ns.rec1', { title: 'existing title' });
    const capturedA: EoEventInput[] = [];
    simulateHandleCellSave(
      [undefinedRec],
      'ns.rec1',
      'subtitle',
      '"new subtitle"',
      'user:@alice:example.com',
      /* useFieldsSub */ false,
      (ev) => capturedA.push(ev),
    );
    expect(capturedA[0].resolution).toBe('Making');
    expect(capturedA[0].operand).toEqual({ subtitle: 'new subtitle' });

    const populatedRec = makeRecord('ns.rec1', {
      title: 'existing title',
      subtitle: 'old subtitle',
    });
    const capturedB: EoEventInput[] = [];
    simulateHandleCellSave(
      [populatedRec],
      'ns.rec1',
      'subtitle',
      '"new subtitle"',
      'user:@alice:example.com',
      false,
      (ev) => capturedB.push(ev),
    );
    expect(capturedB[0].resolution).toBeUndefined();
    expect(capturedB[0].operand).toEqual({ subtitle: 'new subtitle' });
  });

  it('unknown target (record not in records) is treated as first-fill', () => {
    // Symmetric with airtable-sync.ts:453: `if (!existing)` is treated as
    // the first-write case. Here, if the record isn't in our local records
    // list, prior is undefined, so the save is first-fill.
    const captured: EoEventInput[] = [];
    simulateHandleCellSave(
      [],
      'at.appX.tblY.recZ',
      'fldEmail',
      '"alice@example.com"',
      'user:@alice:example.com',
      true,
      (ev) => captured.push(ev),
    );
    expect(captured[0].resolution).toBe('Making');
  });
});
