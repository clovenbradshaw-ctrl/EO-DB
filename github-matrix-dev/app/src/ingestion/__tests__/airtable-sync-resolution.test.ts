/**
 * Phase A.6/1 — SyncCustomization.defaultResolution threading.
 *
 * The Airtable/CSV importer accepts a batch-level resolution stance that is
 * stamped onto every record-level INS event. This test locks in:
 *
 *   1. A set defaultResolution ('Making') lands on every record INS.
 *   2. An unset defaultResolution leaves record INS events unchanged
 *      (resolution undefined → nibble 0 → 'unspecified' on read).
 *   3. Record-level DEF events are NOT stamped — the batch stance is about
 *      how rows are brought into existence, not how their individual value
 *      assertions land.
 *   4. Schema-level INS events (base / table / schema / field registration)
 *      also do NOT carry the batch default — the stance applies to imported
 *      rows, not to the schema scaffolding the importer emits alongside them.
 *
 * The test exercises processHydrationBundle — the public entry point — with
 * an in-memory EoStore + a hand-built RawImportBundle. No network, no OPFS.
 */

import { describe, it, expect } from 'vitest';
import { processHydrationBundle, type RawImportBundle } from '../airtable-sync';
import type { EoStore, IteratorOpts } from '../../db/encrypted-store';
import type { EoEvent } from '../../db/types';

// ─── In-memory test store ────────────────────────────────────────────────────

function createTestStore(): EoStore {
  const data = new Map<string, unknown>();
  let seq = 0;

  return {
    async get(key: string) {
      return data.has(key) ? data.get(key) : null;
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
    },
    async del(key: string) {
      data.delete(key);
    },
    async iterator(prefix: string, opts?: IteratorOpts) {
      const results: [string, unknown][] = [];
      for (const [key, value] of data.entries()) {
        if (key >= prefix && key <= prefix + '\uffff') {
          if (opts?.afterKey && key <= opts.afterKey) continue;
          results.push([key, value]);
        }
      }
      results.sort((a, b) => a[0].localeCompare(b[0]));
      if (opts?.limit !== undefined && results.length > opts.limit) {
        results.length = opts.limit;
      }
      return results;
    },
    async nextSeq() {
      seq += 1;
      data.set('meta:seq', seq);
      return seq;
    },
    async getCurrentSeq() {
      return seq;
    },
    close() {},
  };
}

// ─── Fixture bundle ──────────────────────────────────────────────────────────

function makeBundle(): RawImportBundle {
  return {
    source: 'airtable',
    importId: 'imp-test-001',
    collectedAt: '2026-04-11T10:00:00.000Z',
    manifest: {
      bases: [
        {
          id: 'appTEST',
          name: 'Test Base',
          tables: [
            {
              id: 'tblClients',
              name: 'Clients',
              primaryFieldId: 'fldName',
              fieldCount: 2,
              fields: [
                { id: 'fldName', name: 'Name', type: 'singleLineText' },
                { id: 'fldEmail', name: 'Email', type: 'email' },
              ],
            },
          ],
        },
      ],
      discovered_at: '2026-04-11T10:00:00.000Z',
    },
    tables: [
      {
        baseId: 'appTEST',
        baseName: 'Test Base',
        tableId: 'tblClients',
        tableName: 'Clients',
        useFieldIds: true,
        records: [
          {
            id: 'recA',
            createdTime: '2026-04-11T09:00:00.000Z',
            fields: { fldName: 'Alice', fldEmail: 'alice@example.com' },
          },
          {
            id: 'recB',
            createdTime: '2026-04-11T09:00:01.000Z',
            fields: { fldName: 'Bob', fldEmail: 'bob@example.com' },
          },
        ],
      },
    ],
  };
}

// ─── Event classifier ────────────────────────────────────────────────────────

/**
 * Record-level targets are of the form `at.{baseId}.{tableId}.{recordId}` —
 * exactly three dots after `at.`. Schema targets under `_schema` have more
 * dots (`at.{base}.{table}._schema` or `at.{base}.{table}._schema.{field}`).
 * Base/table containers have fewer dots.
 */
function isRecordTarget(target: string): boolean {
  if (!target.startsWith('at.')) return false;
  if (target.includes('_schema')) return false;
  const parts = target.slice(3).split('.');
  return parts.length === 3;
}

function collectEvents(): { onEvent: (event: EoEvent) => void; events: EoEvent[] } {
  const events: EoEvent[] = [];
  return {
    onEvent: (event: EoEvent) => {
      events.push(event);
    },
    events,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('A.6/1 — Airtable importer defaultResolution threading', () => {
  it("stamps 'Making' onto every record INS when defaultResolution is set", async () => {
    const store = createTestStore();
    const bundle = makeBundle();
    const { onEvent, events } = collectEvents();

    await processHydrationBundle(store, bundle, '@test:example.com', {
      onEvent,
      customization: { defaultResolution: 'Making' },
    });

    const recordINS = events.filter(
      (e) => e.op === 'INS' && isRecordTarget(e.target),
    );
    expect(recordINS.length).toBe(2);
    for (const event of recordINS) {
      expect(event.resolution).toBe('Making');
    }
  });

  it('leaves record INS resolution undefined when defaultResolution is not set', async () => {
    const store = createTestStore();
    const bundle = makeBundle();
    const { onEvent, events } = collectEvents();

    await processHydrationBundle(store, bundle, '@test:example.com', {
      onEvent,
      // no customization.defaultResolution
    });

    const recordINS = events.filter(
      (e) => e.op === 'INS' && isRecordTarget(e.target),
    );
    expect(recordINS.length).toBe(2);
    for (const event of recordINS) {
      expect(event.resolution).toBeUndefined();
    }
  });

  it('does NOT stamp defaultResolution onto record-level DEF events', async () => {
    // The batch stance describes entity birth, not individual value assertion.
    // DEFs that set field values on imported records stay at unspecified so
    // future slicing between "how did the row arrive" and "how did each field
    // land" is not lost.
    const store = createTestStore();
    const bundle = makeBundle();
    const { onEvent, events } = collectEvents();

    await processHydrationBundle(store, bundle, '@test:example.com', {
      onEvent,
      customization: { defaultResolution: 'Composing' },
    });

    const recordDEF = events.filter(
      (e) => e.op === 'DEF' && isRecordTarget(e.target),
    );
    // Each record produces one field-diff DEF after its INS.
    expect(recordDEF.length).toBeGreaterThanOrEqual(2);
    for (const event of recordDEF) {
      expect(event.resolution).toBeUndefined();
    }
  });

  it('does NOT stamp defaultResolution onto schema-scaffolding INS events', async () => {
    // Base DEF, table DEF, schema INS, and per-field INS/DEFs are emitted by
    // processHydrationBundle alongside the record imports. The batch stance
    // is about rows being imported, not about the scaffolding. All schema
    // events must stay at unspecified regardless of the batch default.
    const store = createTestStore();
    const bundle = makeBundle();
    const { onEvent, events } = collectEvents();

    await processHydrationBundle(store, bundle, '@test:example.com', {
      onEvent,
      customization: { defaultResolution: 'Binding' },
    });

    const schemaEvents = events.filter((e) => !isRecordTarget(e.target));
    expect(schemaEvents.length).toBeGreaterThan(0);
    for (const event of schemaEvents) {
      expect(event.resolution).toBeUndefined();
    }
  });
});
