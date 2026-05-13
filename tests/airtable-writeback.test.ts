import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDb, type EoDb } from '../src/db/level.js';
import { Feed } from '../src/db/feed.js';
import { processEvent } from '../src/db/fold.js';
import { getState } from '../src/db/state.js';
import { readLogForTarget } from '../src/db/log.js';
import {
  applyLocalEdit,
  drainWritebacks,
  getPendingFieldsFor,
  getPendingWriteback,
  listPendingWritebacks,
  isWritableFieldType,
  supersedePendingFields,
  EDIT_SOURCE,
} from '../src/ingestion/airtable-writeback.js';
import {
  LOCAL_REPLICA_ID,
  readFieldClocksFromState,
  _resetLocalHlcForTests,
} from '../src/ingestion/airtable-clocks.js';
import type { AirtableClient, AirtableRecord } from '../src/ingestion/airtable-client.js';

const BASE = 'appTest';
const TABLE = 'tblPeople';
const RECORD = 'recAlice';
const TARGET = `at.${BASE}.${TABLE}.${RECORD}`;
const AGENT = '@alice:example.com';

let db: EoDb;
let dbPath: string;
let feed: Feed;

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-writeback-test-'));
  db = createDb(dbPath);
  await db.open();
  feed = new Feed();
  _resetLocalHlcForTests();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

// Create the record so applyLocalEdit can target it.
async function seedRecord(initialFields: Record<string, unknown> = {}): Promise<void> {
  const now = new Date().toISOString();
  await processEvent(db, {
    op: 'INS',
    target: TARGET,
    operand: { _airtable: { record_id: RECORD, base_id: BASE, table_id: TABLE } },
    agent: 'airtable-sync',
    ts: now,
    acquired_ts: now,
    client_event_id: `at-ins:${BASE}:${TABLE}:${RECORD}`,
  }, feed);
  if (Object.keys(initialFields).length > 0) {
    await processEvent(db, {
      op: 'DEF',
      target: TARGET,
      operand: { fields: initialFields },
      agent: 'airtable-sync',
      ts: now,
      acquired_ts: now,
      client_event_id: `at-sync:${BASE}:${TABLE}:${RECORD}:seed`,
    }, feed);
  }
}

// Minimal AirtableClient stub for drain tests.
function makeStubClient(opts: {
  onUpdate?: (baseId: string, tableId: string, recordId: string, fields: Record<string, any>) => void;
  failWith?: Error;
} = {}): AirtableClient {
  return {
    async updateRecord(
      baseId: string,
      tableId: string,
      recordId: string,
      fields: Record<string, any>,
    ): Promise<AirtableRecord> {
      if (opts.failWith) throw opts.failWith;
      opts.onUpdate?.(baseId, tableId, recordId, fields);
      return {
        id: recordId,
        createdTime: new Date().toISOString(),
        fields,
      };
    },
  } as unknown as AirtableClient;
}

describe('isWritableFieldType', () => {
  it('rejects computed types', () => {
    expect(isWritableFieldType('formula')).toBe(false);
    expect(isWritableFieldType('rollup')).toBe(false);
    expect(isWritableFieldType('lookup')).toBe(false);
    expect(isWritableFieldType('count')).toBe(false);
  });

  it('rejects metadata fields', () => {
    expect(isWritableFieldType('createdTime')).toBe(false);
    expect(isWritableFieldType('lastModifiedTime')).toBe(false);
    expect(isWritableFieldType('autoNumber')).toBe(false);
  });

  it('accepts ordinary types', () => {
    expect(isWritableFieldType('singleLineText')).toBe(true);
    expect(isWritableFieldType('number')).toBe(true);
    expect(isWritableFieldType('multipleSelects')).toBe(true);
  });
});

describe('applyLocalEdit', () => {
  it('refuses to edit a record that does not exist locally', async () => {
    await expect(
      applyLocalEdit(db, feed, {
        baseId: BASE, tableId: TABLE, recordId: RECORD,
        fields: { fldName: 'Alice' },
        agent: AGENT,
      }),
    ).rejects.toThrow(/unknown record/);
  });

  it('emits a DEF and queues a writeback entry', async () => {
    await seedRecord({ fldName: 'Alice' });
    const before = await getPendingWriteback(db, BASE, TABLE, RECORD);
    expect(before).toBeNull();

    const result = await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldName: 'Alicia' },
      agent: AGENT,
    });

    expect(result.pending_field_count).toBe(1);
    expect(result.seq).toBeGreaterThan(0);

    // Local state reflects the edit immediately.
    const state = await getState(db, TARGET);
    expect(state?.value?.fields?.fldName).toBe('Alicia');

    // Queue entry exists.
    const entry = await getPendingWriteback(db, BASE, TABLE, RECORD);
    expect(entry).not.toBeNull();
    expect(entry!.fields).toEqual({ fldName: 'Alicia' });
    expect(entry!.agent).toBe(AGENT);
    expect(entry!.attempts).toBe(0);

    // Event in the log is tagged with the edit source.
    const events = await readLogForTarget(db, TARGET);
    const edit = events.find(e => e.source === EDIT_SOURCE);
    expect(edit).toBeDefined();
    expect(edit!.op).toBe('DEF');
    expect(edit!.operand.fields).toEqual({ fldName: 'Alicia' });
  });

  it('merges fields across multiple edits to the same record', async () => {
    await seedRecord({ fldName: 'Alice' });
    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldName: 'Alicia' }, agent: AGENT,
    });
    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldEmail: 'a@x.com' }, agent: AGENT,
    });
    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldName: 'Alicia G.' }, agent: AGENT,
    });

    const entry = await getPendingWriteback(db, BASE, TABLE, RECORD);
    expect(entry!.fields).toEqual({ fldName: 'Alicia G.', fldEmail: 'a@x.com' });
  });

  it('rejects empty fields', async () => {
    await seedRecord();
    await expect(
      applyLocalEdit(db, feed, {
        baseId: BASE, tableId: TABLE, recordId: RECORD,
        fields: {}, agent: AGENT,
      }),
    ).rejects.toThrow(/empty fields/);
  });
});

describe('applyLocalEdit clock stamping', () => {
  it('stamps each edited field with a local-replica clock', async () => {
    await seedRecord({ fldName: 'Alice' });
    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldName: 'Alicia', fldEmail: 'a@x.com' }, agent: AGENT,
    });
    const state = await getState(db, TARGET);
    const clocks = readFieldClocksFromState(state);
    expect(clocks.fldName).toBeDefined();
    expect(clocks.fldEmail).toBeDefined();
    expect(clocks.fldName.replica).toBe(LOCAL_REPLICA_ID);
    expect(clocks.fldEmail.replica).toBe(LOCAL_REPLICA_ID);
  });

  it('advances clocks on successive edits to the same field', async () => {
    await seedRecord({ fldName: 'Alice' });
    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldName: 'Alicia' }, agent: AGENT,
    });
    const c1 = readFieldClocksFromState(await getState(db, TARGET)).fldName;

    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldName: 'Alicia G.' }, agent: AGENT,
    });
    const c2 = readFieldClocksFromState(await getState(db, TARGET)).fldName;

    expect(
      c2.hlc.wall_ms > c1.hlc.wall_ms ||
      (c2.hlc.wall_ms === c1.hlc.wall_ms && c2.hlc.logical > c1.hlc.logical),
    ).toBe(true);
  });

  it('preserves clocks for fields not touched by the new edit', async () => {
    await seedRecord({ fldA: 1, fldB: 2 });
    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldA: 10 }, agent: AGENT,
    });
    const afterFirst = readFieldClocksFromState(await getState(db, TARGET));
    const fldAClock1 = afterFirst.fldA;
    expect(afterFirst.fldB).toBeUndefined(); // fldB never edited locally

    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldB: 20 }, agent: AGENT,
    });
    const afterSecond = readFieldClocksFromState(await getState(db, TARGET));
    expect(afterSecond.fldA).toEqual(fldAClock1);
    expect(afterSecond.fldB.replica).toBe(LOCAL_REPLICA_ID);
  });
});

describe('supersedePendingFields', () => {
  it('returns null when no pending entry exists', async () => {
    const result = await supersedePendingFields(db, BASE, TABLE, RECORD, ['fldA']);
    expect(result).toBeNull();
  });

  it('removes the listed fields and leaves the rest', async () => {
    await seedRecord();
    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldA: 1, fldB: 2, fldC: 3 }, agent: AGENT,
    });

    const result = await supersedePendingFields(db, BASE, TABLE, RECORD, ['fldB']);
    expect(result).toEqual({ removed: 1, remaining: 2 });

    const entry = await getPendingWriteback(db, BASE, TABLE, RECORD);
    expect(entry).not.toBeNull();
    expect(Object.keys(entry!.fields).sort()).toEqual(['fldA', 'fldC']);
  });

  it('deletes the entry entirely when all fields are superseded', async () => {
    await seedRecord();
    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldA: 1, fldB: 2 }, agent: AGENT,
    });

    const result = await supersedePendingFields(db, BASE, TABLE, RECORD, ['fldA', 'fldB']);
    expect(result).toEqual({ removed: 2, remaining: 0 });
    expect(await getPendingWriteback(db, BASE, TABLE, RECORD)).toBeNull();
  });

  it('no-ops on fields that were not pending', async () => {
    await seedRecord();
    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldA: 1 }, agent: AGENT,
    });

    const result = await supersedePendingFields(db, BASE, TABLE, RECORD, ['fldZ', 'fldQ']);
    expect(result).toEqual({ removed: 0, remaining: 1 });
    const entry = await getPendingWriteback(db, BASE, TABLE, RECORD);
    expect(entry!.fields).toEqual({ fldA: 1 });
  });
});

describe('getPendingFieldsFor', () => {
  it('returns the set of pending field IDs', async () => {
    await seedRecord();
    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldA: 1, fldB: 2 }, agent: AGENT,
    });
    const pending = await getPendingFieldsFor(db, BASE, TABLE, RECORD);
    expect(pending).toEqual(new Set(['fldA', 'fldB']));
  });

  it('returns empty set when no writeback is pending', async () => {
    const pending = await getPendingFieldsFor(db, BASE, TABLE, RECORD);
    expect(pending.size).toBe(0);
  });
});

describe('drainWritebacks', () => {
  it('PATCHes Airtable and removes the queue entry on success', async () => {
    await seedRecord({ fldName: 'Alice' });
    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldName: 'Alicia' }, agent: AGENT,
    });

    const patches: Array<{ recordId: string; fields: Record<string, any> }> = [];
    const client = makeStubClient({
      onUpdate: (_b, _t, recordId, fields) => patches.push({ recordId, fields }),
    });

    const result = await drainWritebacks(db, client);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(0);
    expect(patches).toEqual([{ recordId: RECORD, fields: { fldName: 'Alicia' } }]);

    const after = await getPendingWriteback(db, BASE, TABLE, RECORD);
    expect(after).toBeNull();
  });

  it('records the error and keeps the entry on failure', async () => {
    await seedRecord();
    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldName: 'Alicia' }, agent: AGENT,
    });

    const client = makeStubClient({ failWith: new Error('429 rate limited') });
    const result = await drainWritebacks(db, client);

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.remaining).toBe(1);

    const entry = await getPendingWriteback(db, BASE, TABLE, RECORD);
    expect(entry).not.toBeNull();
    expect(entry!.attempts).toBe(1);
    expect(entry!.last_error).toMatch(/429/);
    expect(entry!.last_attempt_at).toBeDefined();
  });

  it('skips entries past maxAttempts', async () => {
    await seedRecord();
    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: RECORD,
      fields: { fldName: 'Alicia' }, agent: AGENT,
    });

    // First pass: fail.
    const failClient = makeStubClient({ failWith: new Error('boom') });
    await drainWritebacks(db, failClient, { maxAttempts: 1 });

    // Entry now has attempts=1, which equals maxAttempts → second pass skips it.
    const successClient = makeStubClient();
    const result = await drainWritebacks(db, successClient, { maxAttempts: 1 });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.remaining).toBe(1);
  });
});

describe('listPendingWritebacks', () => {
  it('returns all pending entries, optionally scoped', async () => {
    // Seed two distinct records.
    for (const id of ['recA', 'recB']) {
      const tgt = `at.${BASE}.${TABLE}.${id}`;
      const now = new Date().toISOString();
      await processEvent(db, {
        op: 'INS', target: tgt,
        operand: { _airtable: { record_id: id, base_id: BASE, table_id: TABLE } },
        agent: 'sync', ts: now, acquired_ts: now,
        client_event_id: `at-ins:${BASE}:${TABLE}:${id}`,
      }, feed);
    }

    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: 'recA',
      fields: { x: 1 }, agent: AGENT,
    });
    await applyLocalEdit(db, feed, {
      baseId: BASE, tableId: TABLE, recordId: 'recB',
      fields: { y: 2 }, agent: AGENT,
    });

    const all = await listPendingWritebacks(db);
    expect(all).toHaveLength(2);

    const scoped = await listPendingWritebacks(db, { baseId: BASE, tableId: TABLE });
    expect(scoped).toHaveLength(2);

    const otherBase = await listPendingWritebacks(db, { baseId: 'appOther' });
    expect(otherBase).toHaveLength(0);
  });
});
