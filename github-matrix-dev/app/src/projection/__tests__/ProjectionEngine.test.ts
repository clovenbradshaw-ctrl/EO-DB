/**
 * ProjectionEngine — unit tests covering W-0 / W-1 / W-2 replay,
 * EVA stance application, divergence map and projection cache.
 *
 * Uses a plain in-memory EoStore (matches the pattern in fold.test.ts) so
 * the projection engine can be exercised without IndexedDB or OPFS.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectionEngine } from '../ProjectionEngine';
import type { EoStore } from '../../db/encrypted-store';
import type { EoEvent } from '../../db/types';
import type { BranchRecord } from '../../types/branch';

// ─── Test store ──────────────────────────────────────────────────────────────

function createTestStore(): EoStore {
  const data = new Map<string, unknown>();
  let seq = 0;
  return {
    async get(key) {
      return data.has(key) ? (data.get(key) as unknown) : null;
    },
    async put(key, value) {
      data.set(key, value);
    },
    async del(key) {
      data.delete(key);
    },
    async iterator(prefix) {
      const out: [string, unknown][] = [];
      for (const [k, v] of data.entries()) {
        if (k >= prefix && k <= prefix + '\uffff') out.push([k, v]);
      }
      out.sort((a, b) => a[0].localeCompare(b[0]));
      return out;
    },
    async nextSeq() {
      seq += 1;
      data.set('meta:seq', seq);
      return seq;
    },
    async getCurrentSeq() {
      return seq;
    },
    close() { /* no-op */ },
  };
}

/** Helper: append a fake log event to the store. */
async function append(store: EoStore, event: Omit<EoEvent, 'seq'>): Promise<EoEvent> {
  const seq = await store.nextSeq();
  const full: EoEvent = { ...event, seq };
  await store.put(`log:${String(seq).padStart(12, '0')}`, full);
  return full;
}

// ─── Fixture ─────────────────────────────────────────────────────────────────
//
// Two case entities, A and B, evolved independently and merged at t=60s.
// After the merge the survivor entity (case.AB) keeps evolving on W-0.

const SOURCE_A = 'case.A';
const SOURCE_B = 'case.B';
const SURVIVOR = 'case.AB';

const T0 = '2025-01-01T00:00:00.000Z';
const T1 = '2025-01-01T00:00:10.000Z';
const T2 = '2025-01-01T00:00:30.000Z';
const TSYN = '2025-01-01T00:01:00.000Z';
const T3 = '2025-01-01T00:01:30.000Z';

async function loadFixture(store: EoStore) {
  // Initial state — case.A is owned by Jordan, status pending
  await append(store, {
    op: 'INS',
    target: SOURCE_A,
    operand: { status: 'pending', owner: 'Jordan', priority: 'medium' },
    agent: '@test:matrix.local',
    ts: T0,
    acquired_ts: T0,
  });
  // case.B is owned by Sam, status reviewing
  await append(store, {
    op: 'INS',
    target: SOURCE_B,
    operand: { status: 'reviewing', owner: 'Sam', priority: 'high' },
    agent: '@test:matrix.local',
    ts: T0,
    acquired_ts: T0,
  });
  // case.A status flips to active
  await append(store, {
    op: 'DEF',
    target: SOURCE_A,
    operand: { status: 'active' },
    agent: '@test:matrix.local',
    ts: T1,
    acquired_ts: T1,
  });
  // case.B priority bumped
  await append(store, {
    op: 'DEF',
    target: SOURCE_B,
    operand: { priority: 'critical' },
    agent: '@test:matrix.local',
    ts: T2,
    acquired_ts: T2,
  });
  // SYN merge — case.A + case.B → case.AB
  await append(store, {
    op: 'SYN',
    target: SURVIVOR,
    operand: { merge: [SOURCE_A, SOURCE_B], into: SURVIVOR },
    agent: '@test:matrix.local',
    ts: TSYN,
    acquired_ts: TSYN,
  });
  // Post-merge update on the survivor
  await append(store, {
    op: 'DEF',
    target: SURVIVOR,
    operand: { priority: 'critical', owner: 'Jordan+Sam' },
    agent: '@test:matrix.local',
    ts: T3,
    acquired_ts: T3,
  });
}

function makeBranch(world: BranchRecord['policy']['world']): BranchRecord {
  return {
    branch_id: `branch-${world}`,
    subject: `${SOURCE_A},${SOURCE_B}`,
    survivor_id: SURVIVOR,
    policy: {
      world,
      stance: world === 'always-merged' ? 'clearing' : null,
      suppress_event_ids: world === 'never-merged' ? [] : [],
      retroject_event_ids: [],
      branch_point_ts: TSYN,
    },
    epistemic_status: 'projection-sketch',
    author: '@test:matrix.local',
    created_at: '2025-01-01T00:02:00.000Z',
  };
}

// ─── Suites ──────────────────────────────────────────────────────────────────

describe('ProjectionEngine', () => {
  let store: EoStore;
  let engine: ProjectionEngine;

  beforeEach(async () => {
    store = createTestStore();
    await loadFixture(store);
    engine = new ProjectionEngine({ store });
  });

  it('W-0 basic replay before SYN — two separate entities', async () => {
    const branch = makeBranch('canonical');
    const projected = await engine.project(branch, T2);
    expect(projected.world).toBe('canonical');
    expect(projected.entities).toHaveLength(2);
    const a = projected.entities.find((e) => e.target === SOURCE_A);
    const b = projected.entities.find((e) => e.target === SOURCE_B);
    expect(a?.fields.status?.value).toBe('active');
    expect(a?.fields.owner?.value).toBe('Jordan');
    expect(b?.fields.status?.value).toBe('reviewing');
    expect(b?.fields.priority?.value).toBe('critical');
  });

  it('W-0 post-merge collapses to a single survivor with merged fields', async () => {
    const branch = makeBranch('canonical');
    const projected = await engine.project(branch, T3);
    expect(projected.entities).toHaveLength(1);
    const survivor = projected.entities[0];
    expect(survivor.target).toBe(SURVIVOR);
    expect(survivor.fields.priority?.value).toBe('critical');
    expect(survivor.fields.owner?.value).toBe('Jordan+Sam');
  });

  it('W-1 pre-merge identity with W-0', async () => {
    const w0 = await engine.project(makeBranch('canonical'), T2);
    const w1 = await engine.project(makeBranch('never-merged'), T2);
    // Both projections should produce the same source-entity field values.
    const a0 = w0.entities.find((e) => e.target === SOURCE_A);
    const a1 = w1.entities.find((e) => e.target === SOURCE_A);
    expect(a1?.fields.status?.value).toEqual(a0?.fields.status?.value);
    expect(a1?.fields.owner?.value).toEqual(a0?.fields.owner?.value);
  });

  it('W-1 post-merge marks fields as shadow', async () => {
    const branch = makeBranch('never-merged');
    const projected = await engine.project(branch, T3);
    expect(projected.indeterminate).toBe(true);
    expect(projected.entities).toHaveLength(2);
    for (const entity of projected.entities) {
      expect(entity.status).toBe('shadow');
      for (const field of Object.values(entity.fields)) {
        expect(field.epistemic).toBe('shadow');
      }
    }
  });

  it('W-2 clearing stance — single merged entity, conflicts resolved to first source', async () => {
    const branch = makeBranch('always-merged');
    branch.policy.stance = 'clearing';
    const projected = await engine.project(branch, TSYN);
    expect(projected.entities).toHaveLength(1);
    const survivor = projected.entities[0];
    // Both A and B set 'status' — clearing picks A (alphabetically first source).
    expect(survivor.fields.status?.epistemic).toBe('policy-sensitive');
    expect(survivor.fields.status?.value).toBe('active');
  });

  it('W-2 dissecting stance — conflicted fields held as conflict_values', async () => {
    const branch = makeBranch('always-merged');
    branch.policy.stance = 'dissecting';
    const projected = await engine.project(branch, TSYN);
    const survivor = projected.entities[0];
    expect(survivor.fields.owner?.epistemic).toBe('conflict');
    expect(survivor.fields.owner?.conflict_values).toEqual(
      expect.arrayContaining(['Jordan', 'Sam']),
    );
  });

  it('W-2 binding stance — conflicted fields rendered as arrays', async () => {
    const branch = makeBranch('always-merged');
    branch.policy.stance = 'binding';
    const projected = await engine.project(branch, TSYN);
    const survivor = projected.entities[0];
    expect(survivor.fields.owner?.epistemic).toBe('policy-sensitive');
    expect(Array.isArray(survivor.fields.owner?.value)).toBe(true);
  });

  it('W-2 composing stance — string conflicts joined with " + "', async () => {
    const branch = makeBranch('always-merged');
    branch.policy.stance = 'composing';
    const projected = await engine.project(branch, TSYN);
    const survivor = projected.entities[0];
    const owner = survivor.fields.owner?.value;
    expect(typeof owner).toBe('string');
    expect(owner).toContain('Jordan');
    expect(owner).toContain('Sam');
  });

  it('divergenceMap returns the SYN point and at least one cross-source field collision', async () => {
    const branch = makeBranch('canonical');
    const points = await engine.divergenceMap(branch);
    expect(points.length).toBeGreaterThan(0);
    const synPoint = points.find((p) => p.field_path === '_syn');
    expect(synPoint?.ts).toBe(TSYN);
    expect(synPoint?.worlds_diverge).toEqual(['canonical', 'never-merged']);
    const crossSource = points.find((p) => p.worlds_diverge.includes('always-merged'));
    expect(crossSource).toBeTruthy();
  });

  it('cache hit — calling project twice with same params returns the same object', async () => {
    const branch = makeBranch('canonical');
    const first = await engine.project(branch, T2);
    const second = await engine.project(branch, T2);
    expect(first).toBe(second);
  });

  it('invalidate clears the cache so a re-project returns a fresh object', async () => {
    const branch = makeBranch('canonical');
    const first = await engine.project(branch, T2);
    engine.invalidate();
    const second = await engine.project(branch, T2);
    expect(first).not.toBe(second);
    // But still equal in content.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
