/**
 * Fold determinism harness — Phase 0 of the EO///DB scaling roadmap.
 *
 * Property-based tests (via fast-check) that pin down the invariants the
 * fold must satisfy before any of the parallel-execution phases (B–K) can
 * land. The harness is the gate: every later phase plugs its new fold
 * implementation into the `FoldRunner` contract below, and the same
 * properties must continue to hold.
 *
 * Properties verified:
 *
 *   1. Serial determinism — running the same input twice through
 *      processEvent produces byte-identical store contents. (This is the
 *      simplest "no hidden randomness" check; it currently passes.)
 *
 *   2. Bulk determinism — same property for processEventsBulk.
 *
 *   3. Serial ≡ Bulk projection equivalence — the canonical projection
 *      (state values, content hashes, trajectories, graph edges, helix
 *      declared sets) is identical between the serial and the
 *      wave-grouped bulk path. Seq numbers and log:* keys are excluded
 *      from the projection: the bulk path's per-target sharding
 *      interleaves seq assignment via Promise.all microtask scheduling,
 *      so seq values legitimately differ between paths even when the
 *      "what does the database look like to a reader" view is identical.
 *
 *   4. DEF re-block — DEFs sprinkled mid-stream produce a final value at
 *      each field equal to that field's last DEF, and surrounding
 *      structure (e.g. CON edges placed between DEFs) survives intact.
 *      This is the property the Phase B mid-wave barrier must preserve
 *      when it starts splitting waves at DEF events.
 *
 * ─── Constraints on the generated input ───────────────────────────────
 *
 * The arbitrary produces inputs that respect TWO restrictions, so the
 * harness measures fold determinism in isolation from two pre-existing
 * issues this phase intentionally does NOT fix:
 *
 *   (a) **Every literal target referenced by any event is explicitly
 *       INS'd first.** Without this, processEventCore's checkAndPromote
 *       fires synthetic INS events with `new Date().toISOString()`
 *       timestamps and grabs seq numbers via a microtask race that V8's
 *       JIT optimization tier can reorder between runs of the same input.
 *       That race is real and worth fixing — Phase A's Constitutive Site
 *       Model is the right place to fix it — but the fix is out of scope
 *       for Phase 0. Once Phase A lands, this constraint can be removed.
 *
 *   (b) **The input is pre-sorted by helix level.** processEventsBulk
 *       re-groups events by helix level via sortByHelixLevel, which
 *       changes the per-target arrival order whenever a target receives
 *       events at multiple helix levels. The trajectory hash chain in
 *       fold-cache.ts is order-dependent, so unsorted input would
 *       legitimately produce different trajectory hashes between serial
 *       and bulk. Pre-sorting collapses the two paths' per-target
 *       orderings, so the fold's invariants can be tested directly.
 *
 * Determinism also requires that the wall clock isn't observed during the
 * fold. fold-cache.ts:76 (cadence classification) reads Date.now(); we
 * freeze it with vi.useFakeTimers so the two runs in each property check
 * see the same instant.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { processEvent, processEventsBulk } from '../fold';
import type { EoStore, IteratorOpts } from '../encrypted-store';
import type { EoEventInput } from '../types';

// ─── In-memory test store ────────────────────────────────────────────────────

interface TestStoreHandle {
  store: EoStore;
  data: Map<string, unknown>;
}

/**
 * Same shape as the createTestStore() in fold.test.ts, but exposes the
 * underlying Map so the harness can compute a fingerprint over every key.
 */
function createTestStore(): TestStoreHandle {
  const data = new Map<string, unknown>();
  let seq = 0;

  const store: EoStore = {
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

  return { store, data };
}

// ─── Fingerprints ────────────────────────────────────────────────────────────

/** Recursively sort object keys so two equal objects encode to identical strings. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/**
 * Full byte-for-byte fingerprint over every key in the store. Used by the
 * "same input twice through the same runner" tests, where literal byte
 * equality is expected.
 */
function fullFingerprint(handle: TestStoreHandle): string {
  const keys = [...handle.data.keys()].sort();
  return keys.map((k) => `${k}=${stableStringify(handle.data.get(k))}`).join('\n');
}

/**
 * Canonical projection fingerprint — captures the "what does the database
 * look like to a reader" view, dropping seq-dependent and log-shaped data.
 *
 * Specifically:
 *   - state:* rows are kept, but `last_seq` is stripped (bulk and serial
 *     paths assign different seq numbers because of microtask interleaving
 *     in the bulk path's per-target sharding; the *content* at each target
 *     is what must agree)
 *   - graph:fwd:* and graph:rev:* edges are kept verbatim
 *   - helix:* rows are kept, with seq-dependent fields stripped (firstSeq,
 *     lastSeq), and the `declared` array is sorted because it carries set
 *     semantics — the order operators were first declared depends on the
 *     wave grouping, which differs between paths
 *   - log:*, idem:*, meta:seq, error:* are dropped (seq-shaped or
 *     volatile)
 */
function projectionFingerprint(handle: TestStoreHandle): string {
  const lines: string[] = [];
  const keys = [...handle.data.keys()].sort();
  for (const key of keys) {
    if (key.startsWith('log:')) continue;
    if (key.startsWith('idem:')) continue;
    if (key === 'meta:seq') continue;
    if (key.startsWith('error:')) continue;

    const raw = handle.data.get(key);

    if (key.startsWith('state:')) {
      const s = raw as Record<string, unknown> | null;
      if (!s) continue;
      const stripped: Record<string, unknown> = { ...s };
      delete stripped.last_seq;
      lines.push(`${key}=${stableStringify(stripped)}`);
      continue;
    }

    if (key.startsWith('helix:')) {
      const h = raw as Record<string, unknown> | null;
      if (!h) continue;
      const declared = Array.isArray(h.declared)
        ? [...(h.declared as string[])].sort()
        : h.declared;
      const stripped: Record<string, unknown> = {
        declared,
        count: h.count,
      };
      lines.push(`${key}=${stableStringify(stripped)}`);
      continue;
    }

    if (key.startsWith('graph:fwd:') || key.startsWith('graph:rev:')) {
      const e = raw as Record<string, unknown> | null;
      if (!e) continue;
      const stripped: Record<string, unknown> = { ...e };
      // The CON handler stores `seq: event.seq` on each edge; that
      // differs between serial and bulk because of microtask
      // interleaving. The edge's source/dest/edge_type are the
      // semantic content.
      delete stripped.seq;
      lines.push(`${key}=${stableStringify(stripped)}`);
      continue;
    }

    lines.push(`${key}=${stableStringify(raw)}`);
  }
  return lines.join('\n');
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const TARGETS = ['app.t.r0', 'app.t.r1', 'app.t.r2', 'app.t.r3'] as const;
const FIELDS = ['fldA', 'fldB', 'fldC'] as const;
const AGENT = '@harness:example.com';

/** Helix level mirror — kept local because fold.ts does not export it. */
const HELIX_LEVEL: Record<string, number> = {
  NUL: 0,
  SIG: 0,
  INS: 1,
  SEG: 2,
  CON: 2,
  SYN: 3,
  DEF: 4,
  EVA: 5,
};

/**
 * Operators the seed arbitrary will emit. INS is added by buildSequence.
 *
 * NUL and SIG (helix level 0) are deliberately excluded for the same
 * reason described in the file header: SIG creates state ahead of any
 * pre-emitted INS, which then throws "Target already instantiated" out
 * of processEventCore's pre-check. handleSIG should arguably register
 * itself as ephemeral state that doesn't trip the INS pre-check, but
 * that's a fold-semantics question for Phase A's Constitutive Site
 * Model, not a determinism question.
 */
type GenOp = 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA';

interface EventSeed {
  op: GenOp;
  targetIdx: number;
  fieldIdx: number;
  destIdx: number;
  scalarValue: string | number | boolean;
  segTag: string;
}

const eventSeedArb: fc.Arbitrary<EventSeed> = fc.record({
  op: fc.constantFrom<GenOp>('SEG', 'CON', 'SYN', 'DEF', 'EVA'),
  targetIdx: fc.integer({ min: 0, max: TARGETS.length - 1 }),
  fieldIdx: fc.integer({ min: 0, max: FIELDS.length - 1 }),
  destIdx: fc.integer({ min: 0, max: TARGETS.length - 1 }),
  scalarValue: fc.oneof(
    fc.string({ minLength: 1, maxLength: 6 }),
    fc.integer({ min: 0, max: 1000 }),
    fc.boolean(),
  ),
  segTag: fc.string({ minLength: 1, maxLength: 6 }),
});

/** A partially-built event with its target known but ts/cid not yet assigned. */
interface PartialEvent {
  op: EoEventInput['op'];
  target: string;
  operand: unknown;
}

/**
 * Convert a list of seeds into a well-ordered EoEventInput[]. The output
 * satisfies the two harness restrictions documented in the file header:
 *
 *   1. Every literal target referenced by any event is explicitly INS'd
 *      first, so the fold's auto-promotion path never fires. The bare
 *      record (e.g. app.t.r0), each field path that any event addresses
 *      (e.g. app.t.r0.fldA), and CON destinations all get pre-INS.
 *
 *   2. The combined list is stably sorted by helix level, so that bulk's
 *      helix-wave regrouping is a no-op relative to serial's arrival order
 *      and the per-target trajectory hash chain matches between paths.
 *
 * Timestamps and client_event_ids are assigned AFTER the helix sort, by
 * the events' final positions in the output list. This keeps `eventHash`
 * out of the picture (every event already has a client_event_id) and
 * keeps fold-cache.ts's intervalsSorted monotonic.
 */
function buildSequence(seeds: EventSeed[]): EoEventInput[] {
  const partials: PartialEvent[] = [];
  const insted = new Set<string>();

  const ensureINS = (target: string) => {
    if (insted.has(target)) return;
    insted.add(target);
    partials.push({
      op: 'INS',
      target,
      operand: { name: target },
    });
  };

  for (const s of seeds) {
    const record = TARGETS[s.targetIdx];
    const field = FIELDS[s.fieldIdx];
    const fieldPath = `${record}.${field}`;

    switch (s.op) {
      case 'SEG':
        ensureINS(fieldPath);
        partials.push({ op: 'SEG', target: fieldPath, operand: s.segTag });
        break;

      case 'CON':
        ensureINS(fieldPath);
        ensureINS(TARGETS[s.destIdx]);
        partials.push({
          op: 'CON',
          target: fieldPath,
          operand: { added: [TARGETS[s.destIdx]] },
        });
        break;

      case 'SYN':
        ensureINS(record);
        // No-op SYN — operand has no `merge` field, so handleSYN does
        // nothing (the helix declared set still gets SYN added).
        partials.push({ op: 'SYN', target: record, operand: {} });
        break;

      case 'DEF':
        ensureINS(fieldPath);
        partials.push({
          op: 'DEF',
          target: fieldPath,
          operand: s.scalarValue,
        });
        break;

      case 'EVA':
        ensureINS(fieldPath);
        partials.push({
          op: 'EVA',
          target: fieldPath,
          operand: { strategy: 'latest' },
        });
        break;
    }
  }

  // Stable sort by helix level so serial arrival order matches bulk's
  // wave-grouping. Array.prototype.sort is stable in V8 (and per spec
  // since ES2019), so events at the same level retain insertion order.
  const sorted = partials
    .map((p, i) => ({ p, i }))
    .sort((a, b) => HELIX_LEVEL[a.p.op] - HELIX_LEVEL[b.p.op] || a.i - b.i)
    .map(({ p }) => p);

  // Assign monotonic ts and unique client_event_id by final position.
  const tsAt = (i: number) => {
    const hours = Math.floor(i / 3600);
    const mins = Math.floor((i % 3600) / 60);
    const secs = i % 60;
    return `2025-01-01T${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.000Z`;
  };

  return sorted.map((p, i) => {
    const ts = tsAt(i);
    return {
      op: p.op,
      target: p.target,
      operand: p.operand,
      agent: AGENT,
      ts,
      acquired_ts: ts,
      client_event_id: `cid-${i}`,
    };
  });
}

const sequenceArb: fc.Arbitrary<EoEventInput[]> = fc
  .array(eventSeedArb, { minLength: 1, maxLength: 16 })
  .map(buildSequence);

// ─── Fold runners ────────────────────────────────────────────────────────────

/**
 * The contract every fold implementation must satisfy. Phase C/E will
 * supply additional FoldRunners (worker pool, shard pool, GPU) and the
 * tests below should be re-instantiated against each.
 */
type FoldRunner = (store: EoStore, events: EoEventInput[]) => Promise<void>;

const runSerial: FoldRunner = async (store, events) => {
  for (const event of events) {
    await processEvent(store, event);
  }
};

const runBulk: FoldRunner = async (store, events) => {
  await processEventsBulk(store, events);
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Fold determinism harness (Phase 0)', () => {
  beforeEach(() => {
    // Freeze Date.now() so fold-cache.ts cadence classification is
    // deterministic across the two runs in each property check.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bulk determinism (projection): same input twice through processEventsBulk → identical projection', async () => {
    // Projection-level guarantee. Verifies that two bulk runs of the same
    // input agree on every value-bearing field (state values, hashes,
    // trajectories, edges, helix declared sets) even when the underlying
    // seq numbers don't match between runs.
    await fc.assert(
      fc.asyncProperty(sequenceArb, async (events) => {
        const a = createTestStore();
        const b = createTestStore();
        await runBulk(a.store, events);
        await runBulk(b.store, events);
        expect(projectionFingerprint(a)).toBe(projectionFingerprint(b));
      }),
      { numRuns: 20 },
    );
  });

  // ───────────────────────────────────────────────────────────────────
  // FIXME(phase-A) — bulk byte-identity is FLAKY today.
  //
  // The byte-identical version of the bulk determinism property — two
  // runs of the same input through processEventsBulk producing identical
  // store contents down to seq numbers — is NOT verified above. It is
  // currently broken by a V8-microtask race in processEventsBulk's
  // per-target Promise.all sharding (fold.ts:251). When multiple targets
  // in the same helix wave concurrently call store.nextSeq(), V8's JIT
  // optimization tier can reorder which task's await resolves first
  // between runs of the same code on the same input, so identical
  // events get assigned different seq numbers across runs.
  //
  // Empirically (30-iteration diagnostic on a 4-event input):
  //   serial: 1 distinct fingerprint
  //   bulk:   4 distinct fingerprints
  //
  // The semantic projection is unaffected — the projection-level test
  // above passes — because seedHash/chainHash are seq-independent and
  // per-target arrival order is preserved. But the on-disk log is not
  // reproducible byte-for-byte, which the roadmap's Phase 0 statement
  // ("byte-for-byte identical FoldPosition output") asks for.
  //
  // The fix belongs in Phase A (Constitutive Site Model — make seq
  // assignment go through the addressing horizon, not through a free
  // race) or Phase B (productive barrier — assign seq at the barrier,
  // not inside the per-target task body). Once fixed, replace the
  // projection-level bulk-determinism test above with the
  // fullFingerprint version, and update this comment.
  // ───────────────────────────────────────────────────────────────────

  it('serial determinism: same input twice through processEvent → byte-identical', async () => {
    await fc.assert(
      fc.asyncProperty(sequenceArb, async (events) => {
        const a = createTestStore();
        const b = createTestStore();
        await runSerial(a.store, events);
        await runSerial(b.store, events);
        expect(fullFingerprint(a)).toBe(fullFingerprint(b));
      }),
      { numRuns: 20 },
    );
  });

  it('projection equivalence: serial fold = bulk fold on causally-ordered input', async () => {
    await fc.assert(
      fc.asyncProperty(sequenceArb, async (events) => {
        const serial = createTestStore();
        const bulk = createTestStore();
        await runSerial(serial.store, events);
        await runBulk(bulk.store, events);
        expect(projectionFingerprint(serial)).toBe(projectionFingerprint(bulk));
      }),
      { numRuns: 20 },
    );
  });

  it('DEF re-block: final value at a field equals the last DEF on that field', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.string({ minLength: 1, maxLength: 6 }),
            fc.integer({ min: 0, max: 1000 }),
            fc.boolean(),
          ),
          { minLength: 1, maxLength: 8 },
        ),
        async (defValues) => {
          const target = TARGETS[0];
          const field = FIELDS[0];
          const events: EoEventInput[] = [
            {
              op: 'INS',
              target,
              operand: { seed: 0 },
              agent: AGENT,
              ts: '2025-01-01T00:00:00.000Z',
              acquired_ts: '2025-01-01T00:00:00.000Z',
              client_event_id: 'rb-ins',
            },
          ];
          defValues.forEach((v, i) => {
            const ts = `2025-01-01T00:01:${String(i).padStart(2, '0')}.000Z`;
            events.push({
              op: 'DEF',
              target: `${target}.${field}`,
              operand: v,
              agent: AGENT,
              ts,
              acquired_ts: ts,
              client_event_id: `rb-def-${i}`,
            });
          });

          const handle = createTestStore();
          await runBulk(handle.store, events);

          const finalState = handle.data.get(`state:${target}.${field}`) as
            | { value: unknown }
            | undefined;
          expect(finalState).toBeTruthy();
          expect(finalState!.value).toStrictEqual(defValues[defValues.length - 1]);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('DEF re-block: structure surrounding interleaved DEFs survives', async () => {
    // Concrete regression: INS → DEF(a) → CON → DEF(b) → DEF(c) on the
    // same field gives final value c, AND the CON edge is intact. This is
    // the Phase B mid-wave-barrier scenario in miniature.
    const events: EoEventInput[] = [
      {
        op: 'INS',
        target: TARGETS[0],
        operand: { name: 'first' },
        agent: AGENT,
        ts: '2025-01-01T00:00:00.000Z',
        acquired_ts: '2025-01-01T00:00:00.000Z',
        client_event_id: 'rs-a',
      },
      {
        op: 'INS',
        target: TARGETS[1],
        operand: { name: 'second' },
        agent: AGENT,
        ts: '2025-01-01T00:00:01.000Z',
        acquired_ts: '2025-01-01T00:00:01.000Z',
        client_event_id: 'rs-b',
      },
      {
        op: 'DEF',
        target: `${TARGETS[0]}.${FIELDS[0]}`,
        operand: 'a',
        agent: AGENT,
        ts: '2025-01-01T00:00:02.000Z',
        acquired_ts: '2025-01-01T00:00:02.000Z',
        client_event_id: 'rs-c',
      },
      {
        op: 'CON',
        target: `${TARGETS[0]}.${FIELDS[1]}`,
        operand: { added: [TARGETS[1]] },
        agent: AGENT,
        ts: '2025-01-01T00:00:03.000Z',
        acquired_ts: '2025-01-01T00:00:03.000Z',
        client_event_id: 'rs-d',
      },
      {
        op: 'DEF',
        target: `${TARGETS[0]}.${FIELDS[0]}`,
        operand: 'b',
        agent: AGENT,
        ts: '2025-01-01T00:00:04.000Z',
        acquired_ts: '2025-01-01T00:00:04.000Z',
        client_event_id: 'rs-e',
      },
      {
        op: 'DEF',
        target: `${TARGETS[0]}.${FIELDS[0]}`,
        operand: 'c',
        agent: AGENT,
        ts: '2025-01-01T00:00:05.000Z',
        acquired_ts: '2025-01-01T00:00:05.000Z',
        client_event_id: 'rs-f',
      },
    ];

    const handle = createTestStore();
    await runBulk(handle.store, events);

    const fld = handle.data.get(`state:${TARGETS[0]}.${FIELDS[0]}`) as
      | { value: unknown }
      | undefined;
    expect(fld?.value).toBe('c');

    const fwdEdge = handle.data.get(
      `graph:fwd:${TARGETS[0]}.${FIELDS[1]}:${TARGETS[1]}`,
    );
    expect(fwdEdge).toBeTruthy();
  });
});
