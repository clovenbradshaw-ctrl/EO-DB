import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import { processEvent } from '../src/db/fold.js';
import { getState } from '../src/db/state.js';
import type { EoEventInput } from '../src/db/types.js';
import type { DedupToolConfig } from '../src/dedup/types.js';
import { runDedupJob, storeTool, getTool, listTools, deleteTool, getCandidates, reviewCandidate } from '../src/dedup/engine.js';
import { compareRecords, scoreFields, extractFieldValue } from '../src/dedup/compare.js';
import { BASIC_FINGERPRINT_RANKED, BASIC_FINGERPRINT_COEQUAL } from '../src/dedup/presets.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

const AGENT = '@test:example.com';
const TS = '2025-06-01T00:00:00.000Z';

function ev(overrides: Partial<EoEventInput>): EoEventInput {
  return {
    op: 'INS',
    target: 'app.tbl.rec1',
    operand: {},
    agent: AGENT,
    ts: TS,
    acquired_ts: TS,
    ...overrides,
  };
}

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-dedup-test-'));
  db = createDb(dbPath);
  await db.open();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

// ─── Compare: extractFieldValue ──────────────────────────────────────────────

describe('extractFieldValue', () => {
  it('extracts top-level field', () => {
    const state = { target: 'x', value: { name: 'Alice' }, hash: '', level: 1, last_seq: 1, last_op: 'INS' as const, last_agent: '', last_ts: '', last_acquired_ts: '' };
    expect(extractFieldValue(state, 'name')).toBe('Alice');
  });

  it('extracts nested field', () => {
    const state = { target: 'x', value: { address: { city: 'LA' } }, hash: '', level: 1, last_seq: 1, last_op: 'INS' as const, last_agent: '', last_ts: '', last_acquired_ts: '' };
    expect(extractFieldValue(state, 'address.city')).toBe('LA');
  });

  it('returns undefined for missing field', () => {
    const state = { target: 'x', value: { name: 'Alice' }, hash: '', level: 1, last_seq: 1, last_op: 'INS' as const, last_agent: '', last_ts: '', last_acquired_ts: '' };
    expect(extractFieldValue(state, 'phone')).toBeUndefined();
  });
});

// ─── Compare: scoreFields ────────────────────────────────────────────────────

describe('scoreFields', () => {
  it('co-equal mode: simple average', () => {
    const scores = { 'name:exact': 1.0, 'email:exact': 0.5, 'phone:exact': 0.0 };
    const comparisons = [
      { field: 'name', metric: 'exact' as const },
      { field: 'email', metric: 'exact' as const },
      { field: 'phone', metric: 'exact' as const },
    ];
    const result = scoreFields(scores, comparisons, 'co-equal', ['name:exact', 'email:exact', 'phone:exact']);
    expect(result).toBeCloseTo(0.5, 5); // (1 + 0.5 + 0) / 3
  });

  it('ranked mode: weighted sum', () => {
    const scores = { 'name:exact': 1.0, 'email:exact': 0.0 };
    const comparisons = [
      { field: 'name', metric: 'exact' as const, weight: 0.8 },
      { field: 'email', metric: 'exact' as const, weight: 0.2 },
    ];
    const result = scoreFields(scores, comparisons, 'ranked', ['name:exact', 'email:exact']);
    expect(result).toBeCloseTo(0.8, 5); // (1*0.8 + 0*0.2) / (0.8+0.2)
  });

  it('ranked mode: all fields matching gives 1.0', () => {
    const scores = { 'name:exact': 1.0, 'email:exact': 1.0 };
    const comparisons = [
      { field: 'name', metric: 'exact' as const, weight: 0.6 },
      { field: 'email', metric: 'exact' as const, weight: 0.4 },
    ];
    const result = scoreFields(scores, comparisons, 'ranked', ['name:exact', 'email:exact']);
    expect(result).toBeCloseTo(1.0, 5);
  });

  it('co-equal mode: skipped fields reduce denominator', () => {
    const scores = { 'name:exact': 1.0 }; // email was skipped
    const comparisons = [
      { field: 'name', metric: 'exact' as const },
      { field: 'email', metric: 'exact' as const },
    ];
    const result = scoreFields(scores, comparisons, 'co-equal', ['name:exact']);
    expect(result).toBeCloseTo(1.0, 5); // 1.0 / 1 (only 1 active field)
  });

  it('ranked mode: skipped fields excluded from total weight', () => {
    const scores = { 'name:exact': 0.8 }; // email was skipped
    const comparisons = [
      { field: 'name', metric: 'exact' as const, weight: 0.7 },
      { field: 'email', metric: 'exact' as const, weight: 0.3 },
    ];
    const result = scoreFields(scores, comparisons, 'ranked', ['name:exact']);
    expect(result).toBeCloseTo(0.8, 5); // 0.8*0.7 / 0.7
  });
});

// ─── Compare: compareRecords ─────────────────────────────────────────────────

describe('compareRecords', () => {
  const stateA = {
    target: 'app.tbl.rec1', value: { name: 'Tom Cruise', email: 'tom@example.com' },
    hash: '', level: 1, last_seq: 1, last_op: 'INS' as const, last_agent: '', last_ts: '', last_acquired_ts: '',
  };
  const stateB = {
    target: 'app.tbl.rec2', value: { name: 'Cruise, Tom', email: 'tom@example.com' },
    hash: '', level: 1, last_seq: 2, last_op: 'INS' as const, last_agent: '', last_ts: '', last_acquired_ts: '',
  };

  it('produces a candidate with field scores and overall score', () => {
    const config: DedupToolConfig = {
      ...BASIC_FINGERPRINT_RANKED,
      scope: { collection: 'app.tbl' },
    };
    const candidate = compareRecords(stateA, stateB, config);
    expect(candidate.id).toBeTruthy();
    expect(candidate.target_a).toBeTruthy();
    expect(candidate.target_b).toBeTruthy();
    expect(candidate.score).toBeGreaterThan(0);
    expect(candidate.field_scores).toBeDefined();
    expect(candidate.status).toBe('pending');
  });

  it('fingerprint matches catch name reordering', () => {
    const config: DedupToolConfig = {
      ...BASIC_FINGERPRINT_RANKED,
      scope: { collection: 'app.tbl' },
    };
    const candidate = compareRecords(stateA, stateB, config);
    expect(candidate.field_scores['name:fingerprint']).toBe(1); // fingerprint: "cruise tom" matches
    expect(candidate.field_scores['email:exact']).toBe(1); // exact match
  });

  it('co-equal mode weights fields equally', () => {
    const config: DedupToolConfig = {
      ...BASIC_FINGERPRINT_COEQUAL,
      scope: { collection: 'app.tbl' },
    };
    const candidate = compareRecords(stateA, stateB, config);
    // With fingerprint(name)=1 and exact(email)=1, phone missing→skipped
    // co-equal: (1 + 1) / 2 = 1.0
    expect(candidate.score).toBeCloseTo(1.0, 1);
  });
});

// ─── Tool Config CRUD ────────────────────────────────────────────────────────

describe('tool config CRUD', () => {
  it('stores and retrieves a tool', async () => {
    await storeTool(db, BASIC_FINGERPRINT_RANKED);
    const tool = await getTool(db, BASIC_FINGERPRINT_RANKED.id);
    expect(tool).toBeTruthy();
    expect(tool!.name).toBe(BASIC_FINGERPRINT_RANKED.name);
    expect(tool!.tier).toBe('basic');
  });

  it('lists all tools', async () => {
    await storeTool(db, BASIC_FINGERPRINT_RANKED);
    await storeTool(db, BASIC_FINGERPRINT_COEQUAL);
    const tools = await listTools(db);
    expect(tools.length).toBe(2);
  });

  it('deletes a tool', async () => {
    await storeTool(db, BASIC_FINGERPRINT_RANKED);
    await deleteTool(db, BASIC_FINGERPRINT_RANKED.id);
    const tool = await getTool(db, BASIC_FINGERPRINT_RANKED.id);
    expect(tool).toBeNull();
  });

  it('lists empty when no tools stored', async () => {
    const tools = await listTools(db);
    expect(tools).toEqual([]);
  });
});

// ─── Engine: runDedupJob ─────────────────────────────────────────────────────

describe('runDedupJob', () => {
  async function seedRecords() {
    // Create records that are obvious duplicates
    await processEvent(db, ev({ target: 'app.tbl.rec1', operand: { name: 'Tom Cruise', email: 'tom@ex.com' } }));
    await processEvent(db, ev({ target: 'app.tbl.rec2', operand: { name: 'Cruise, Tom', email: 'tom@ex.com' } }));
    await processEvent(db, ev({ target: 'app.tbl.rec3', operand: { name: 'Brad Pitt', email: 'brad@ex.com' } }));
  }

  it('runs a basic dedup job and returns stats', async () => {
    await seedRecords();

    const config: DedupToolConfig = {
      ...BASIC_FINGERPRINT_RANKED,
      scope: { collection: 'app.tbl' },
      blocking: [{ method: 'none', fields: [] }],
      scoring: {
        method: 'weighted-sum',
        auto_merge_threshold: 0.99,
        review_threshold: 0.50,
      },
    };

    const job = await runDedupJob(db, config);
    expect(job.status).toBe('completed');
    expect(job.stats.records_scanned).toBe(3);
    expect(job.stats.pairs_compared).toBe(3); // 3 choose 2
    expect(job.stats.pairs_total_possible).toBe(3);
  });

  it('auto-merges high-confidence pairs via SYN', async () => {
    await seedRecords();

    const config: DedupToolConfig = {
      ...BASIC_FINGERPRINT_RANKED,
      scope: { collection: 'app.tbl' },
      blocking: [{ method: 'none', fields: [] }],
      scoring: {
        method: 'weighted-sum',
        auto_merge_threshold: 0.60, // low threshold to ensure auto-merge
        review_threshold: 0.30,
      },
    };

    const job = await runDedupJob(db, config);
    expect(job.stats.auto_merged).toBeGreaterThan(0);

    // Verify SYN was applied — one of the cruise records should be aliased
    const state2 = await getState(db, 'app.tbl.rec2');
    // After SYN, rec2 should have _alias pointing to rec1 (or vice versa)
    const hasAlias = state2?.value?._alias != null;
    const state1 = await getState(db, 'app.tbl.rec1');
    const hasAlias1 = state1?.value?._alias != null;
    expect(hasAlias || hasAlias1).toBe(true);
  });

  it('queues uncertain pairs for review', async () => {
    await seedRecords();

    const config: DedupToolConfig = {
      ...BASIC_FINGERPRINT_RANKED,
      scope: { collection: 'app.tbl' },
      blocking: [{ method: 'none', fields: [] }],
      scoring: {
        method: 'weighted-sum',
        auto_merge_threshold: 1.01, // impossible — nothing auto-merges
        review_threshold: 0.01,     // everything goes to review
      },
    };

    const job = await runDedupJob(db, config);
    expect(job.stats.pending_review).toBeGreaterThan(0);
    expect(job.stats.auto_merged).toBe(0);

    // Candidates should be retrievable
    const candidates = await getCandidates(db, config.id, 'pending');
    expect(candidates.length).toBe(job.stats.pending_review);
  });

  it('skips already-aliased records', async () => {
    // Create records, SYN two of them, then run dedup
    await processEvent(db, ev({ target: 'app.tbl.a', operand: { name: 'Alice' } }));
    await processEvent(db, ev({ target: 'app.tbl.b', operand: { name: 'Alice' } }));
    await processEvent(db, ev({ target: 'app.tbl.c', operand: { name: 'Alice' } }));

    // Manually SYN a and b
    await processEvent(db, ev({
      op: 'SYN',
      target: 'app.tbl.merged',
      operand: { merge: ['app.tbl.a', 'app.tbl.b'], into: 'app.tbl.merged' },
    }));

    const config: DedupToolConfig = {
      ...BASIC_FINGERPRINT_COEQUAL,
      scope: { collection: 'app.tbl' },
      blocking: [{ method: 'none', fields: [] }],
      comparisons: [{ field: 'name', metric: 'fingerprint' }],
      scoring: {
        method: 'weighted-sum',
        auto_merge_threshold: 1.01,
        review_threshold: 0.01,
      },
    };

    const job = await runDedupJob(db, config);
    // a and b are aliased — only merged, c, and the merged target should be scanned
    // aliased records (a, b) should be filtered out
    expect(job.stats.records_scanned).toBeLessThanOrEqual(2);
  });
});

// ─── Engine: reviewCandidate ─────────────────────────────────────────────────

describe('reviewCandidate', () => {
  async function seedAndGetCandidate() {
    await processEvent(db, ev({ target: 'app.tbl.r1', operand: { name: 'Alice Smith', email: 'alice@ex.com' } }));
    await processEvent(db, ev({ target: 'app.tbl.r2', operand: { name: 'Alice Smyth', email: 'alice@ex.com' } }));

    const config: DedupToolConfig = {
      ...BASIC_FINGERPRINT_RANKED,
      scope: { collection: 'app.tbl' },
      blocking: [{ method: 'none', fields: [] }],
      scoring: {
        method: 'weighted-sum',
        auto_merge_threshold: 1.01, // no auto-merge
        review_threshold: 0.01,     // everything to review
      },
    };

    await runDedupJob(db, config);
    const candidates = await getCandidates(db, config.id, 'pending');
    return candidates[0];
  }

  it('approving a candidate emits SYN and marks as approved', async () => {
    const candidate = await seedAndGetCandidate();
    const reviewed = await reviewCandidate(db, candidate.id, 'approved', AGENT);

    expect(reviewed.status).toBe('approved');
    expect(reviewed.reviewed_by).toBe(AGENT);
    expect(reviewed.reviewed_at).toBeTruthy();

    // Verify SYN was emitted — one record should now be aliased
    const state1 = await getState(db, 'app.tbl.r1');
    const state2 = await getState(db, 'app.tbl.r2');
    const aliased = (state1?.value?._alias != null) || (state2?.value?._alias != null);
    expect(aliased).toBe(true);
  });

  it('rejecting a candidate does NOT emit SYN', async () => {
    const candidate = await seedAndGetCandidate();
    const reviewed = await reviewCandidate(db, candidate.id, 'rejected', AGENT);

    expect(reviewed.status).toBe('rejected');

    // Neither record should be aliased
    const state1 = await getState(db, 'app.tbl.r1');
    const state2 = await getState(db, 'app.tbl.r2');
    expect(state1?.value?._alias).toBeUndefined();
    expect(state2?.value?._alias).toBeUndefined();
  });
});
