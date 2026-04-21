/**
 * Branching-demo tests — run the sample fixtures through the
 * ProjectionEngine and assert that each branching behavior from the demo
 * walkthrough actually appears in the output.
 *
 * The fixtures live in ./fixtures/branching-demo.ts and cover:
 *
 *   A. contact:j_walker  — CRM merge exercising conflict / override /
 *      shadow / policy-sensitive / canonical in a single subject.
 *   B. case:sarah_m      — homeless-services merge exposing the
 *      "multi-value field" reading via W-2 binding stance.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectionEngine } from '../ProjectionEngine';
import type { EoStore } from '../../db/encrypted-store';
import {
  BRANCHING_FIXTURES,
  materializeFixture,
  type MaterializedFixture,
} from './fixtures/branching-demo';
import type { ProjectedField } from '../../types/branch';

// ─── Test store (shares the pattern from ProjectionEngine.test.ts) ───────────

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
        if (k >= prefix && k <= prefix + '￿') out.push([k, v]);
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
    close() {
      /* no-op */
    },
  };
}

// ─── Scenario A — contact:j_walker ───────────────────────────────────────────

describe('branching-demo / contact:j_walker', () => {
  let store: EoStore;
  let engine: ProjectionEngine;
  let fixture: MaterializedFixture;

  beforeEach(async () => {
    store = createTestStore();
    fixture = await materializeFixture(store, BRANCHING_FIXTURES.contact_j_walker);
    engine = new ProjectionEngine({ store });
  });

  // ─── W-0 canonical ───────────────────────────────────────────────────────

  it('W-0 pre-merge shows two independent source entities', async () => {
    const branch = fixture.buildBranch('canonical');
    const preMergeTs = '2024-04-01T00:00:00.000Z';
    const projected = await engine.project(branch, preMergeTs);

    expect(projected.entities).toHaveLength(2);
    const jordan = projected.entities.find((e) => e.target === 'contact:jordan_w');
    const alt = projected.entities.find((e) => e.target === 'contact:j_walker_alt');
    expect(jordan?.fields.full_name?.value).toBe('Jordan W.');
    expect(alt?.fields.full_name?.value).toBe('J. Walker');
    expect(jordan?.fields.status?.value).toBe('lead');
    expect(alt?.fields.status?.value).toBe('customer');
    // company only exists on Jordan's record before the merge.
    expect(jordan?.fields.company?.value).toBe('Acme Corp');
    expect(alt?.fields.company).toBeUndefined();
  });

  it('W-0 at cursor collapses to one survivor; email override wins', async () => {
    const branch = fixture.buildBranch('canonical');
    const projected = await engine.project(branch, fixture.cursorTs);

    expect(projected.entities).toHaveLength(1);
    const survivor = projected.entities[0];
    expect(survivor.target).toBe(fixture.survivor);

    // Email: survivor override beats both source contributions.
    expect(survivor.fields.email?.value).toBe('j@walker.dev');
    // Phone: survivor-only contribution is preserved.
    expect(survivor.fields.phone?.value).toBe('+1-555-0142');
    // Company: preserved from the single source that had it.
    expect(survivor.fields.company?.value).toBe('Acme Corp');
    // Tags: survivor-written union.
    expect(survivor.fields.tags?.value).toEqual([
      'sales',
      'priority',
      'q4-followup',
    ]);
    // created_at: shared-agreement canonical value.
    expect(survivor.fields.created_at?.value).toBe('2024-01-03');

    for (const f of Object.values(survivor.fields)) {
      expect(f.epistemic).toBe('canonical');
    }
  });

  // ─── W-1 never-merged ────────────────────────────────────────────────────

  it('W-1 pre-merge identity with W-0', async () => {
    const preMergeTs = '2024-04-01T00:00:00.000Z';
    const w0 = await engine.project(fixture.buildBranch('canonical'), preMergeTs);
    const w1 = await engine.project(fixture.buildBranch('never-merged'), preMergeTs);

    for (const src of fixture.sources) {
      const a = w0.entities.find((e) => e.target === src);
      const b = w1.entities.find((e) => e.target === src);
      expect(b?.fields.full_name?.value).toBe(a?.fields.full_name?.value);
      expect(b?.fields.status?.value).toBe(a?.fields.status?.value);
    }
    expect(w1.indeterminate).toBe(false);
  });

  it('W-1 post-merge marks every source-entity field as shadow', async () => {
    const branch = fixture.buildBranch('never-merged');
    const projected = await engine.project(branch, fixture.cursorTs);

    expect(projected.indeterminate).toBe(true);
    expect(projected.entities).toHaveLength(2);
    for (const entity of projected.entities) {
      expect(entity.status).toBe('shadow');
      for (const field of Object.values(entity.fields)) {
        expect(field.epistemic).toBe('shadow');
      }
    }
    // The phone was never written on either source, so it must not appear
    // in W-1 at all — there's nothing to shadow. This is the three-state NUL
    // distinction: "never-set" is not the same as "unknown-in-this-world".
    for (const entity of projected.entities) {
      expect(entity.fields.phone).toBeUndefined();
    }
  });

  // ─── W-2 dissecting ──────────────────────────────────────────────────────

  it('W-2 dissecting holds full_name and status as open conflicts', async () => {
    const branch = fixture.buildBranch('always-merged', 'dissecting');
    const projected = await engine.project(branch, fixture.cursorTs);

    const survivor = projected.entities[0];
    expect(survivor.fields.full_name?.epistemic).toBe('conflict');
    expect(survivor.fields.full_name?.conflict_values).toEqual(
      expect.arrayContaining(['Jordan W.', 'J. Walker']),
    );
    expect(survivor.fields.status?.epistemic).toBe('conflict');
    expect(survivor.fields.status?.conflict_values).toEqual(
      expect.arrayContaining(['lead', 'customer']),
    );
  });

  it('W-2 dissecting preserves the email override as a third conflict value', async () => {
    const branch = fixture.buildBranch('always-merged', 'dissecting');
    const projected = await engine.project(branch, fixture.cursorTs);

    const email = projected.entities[0].fields.email;
    expect(email?.epistemic).toBe('conflict');
    const values = (email?.conflict_values ?? []) as string[];
    // Two sources agreed on the Acme address; survivor later overrode.
    // Dissecting holds all three buckets open (no dedupe).
    expect(values).toContain('jwalker@acme.com');
    expect(values).toContain('j@walker.dev');
    expect(values.length).toBeGreaterThanOrEqual(3);
  });

  it('W-2 dissecting marks single-source contributions policy-sensitive, not conflict', async () => {
    const branch = fixture.buildBranch('always-merged', 'dissecting');
    const projected = await engine.project(branch, fixture.cursorTs);

    const survivor = projected.entities[0];
    // Only Jordan's record carried company.
    expect(survivor.fields.company?.epistemic).toBe('policy-sensitive');
    expect(survivor.fields.company?.value).toBe('Acme Corp');
    // Only the survivor carried phone.
    expect(survivor.fields.phone?.epistemic).toBe('policy-sensitive');
    expect(survivor.fields.phone?.value).toBe('+1-555-0142');
  });

  // ─── W-2 across stances ──────────────────────────────────────────────────

  it('W-2 clearing reduces every conflict to a single winner', async () => {
    const branch = fixture.buildBranch('always-merged', 'clearing');
    const projected = await engine.project(branch, fixture.cursorTs);
    const survivor = projected.entities[0];

    // Every conflicted field collapses to a single string value — no
    // conflict-typed fields anywhere.
    for (const f of Object.values(survivor.fields)) {
      expect(f.epistemic).not.toBe('conflict');
    }
    expect(typeof survivor.fields.full_name?.value).toBe('string');
    expect(typeof survivor.fields.status?.value).toBe('string');
    // full_name must be one of the two known source values.
    expect(['Jordan W.', 'J. Walker']).toContain(survivor.fields.full_name?.value);
  });

  it('W-2 binding turns multi-source fields into arrays', async () => {
    const branch = fixture.buildBranch('always-merged', 'binding');
    const projected = await engine.project(branch, fixture.cursorTs);
    const survivor = projected.entities[0];

    expect(Array.isArray(survivor.fields.full_name?.value)).toBe(true);
    expect(survivor.fields.full_name?.value).toEqual(
      expect.arrayContaining(['Jordan W.', 'J. Walker']),
    );
    expect(Array.isArray(survivor.fields.status?.value)).toBe(true);
    expect(survivor.fields.status?.value).toEqual(
      expect.arrayContaining(['lead', 'customer']),
    );
  });

  it('W-2 composing fuses string conflicts with " + "', async () => {
    const branch = fixture.buildBranch('always-merged', 'composing');
    const projected = await engine.project(branch, fixture.cursorTs);
    const survivor = projected.entities[0];

    const fullName = survivor.fields.full_name?.value;
    expect(typeof fullName).toBe('string');
    expect(fullName).toContain('Jordan W.');
    expect(fullName).toContain('J. Walker');
    expect(fullName).toContain(' + ');
  });

  // ─── Divergence map ──────────────────────────────────────────────────────

  it('divergenceMap surfaces the SYN fork and multiple cross-source collisions', async () => {
    const branch = fixture.buildBranch('canonical');
    const points = await engine.divergenceMap(branch);

    const syn = points.find((p) => p.field_path === '_syn');
    expect(syn?.ts).toBe(fixture.synTs);

    const w2Collisions = points.filter((p) =>
      p.worlds_diverge.includes('always-merged'),
    );
    const fields = new Set(w2Collisions.map((p) => p.field_path));
    // At least full_name, email, status, tags, created_at collide across
    // both sources at some point in the timeline.
    expect(fields).toContain('full_name');
    expect(fields).toContain('email');
    expect(fields).toContain('status');
    expect(fields).toContain('created_at');
  });
});

// ─── Scenario B — case:sarah_m ───────────────────────────────────────────────

describe('branching-demo / case:sarah_m', () => {
  let store: EoStore;
  let engine: ProjectionEngine;
  let fixture: MaterializedFixture;

  beforeEach(async () => {
    store = createTestStore();
    fixture = await materializeFixture(store, BRANCHING_FIXTURES.case_sarah_m);
    engine = new ProjectionEngine({ store });
  });

  it('W-0 at cursor picks a single current_situation (last-write silently wins)', async () => {
    const branch = fixture.buildBranch('canonical');
    const projected = await engine.project(branch, fixture.cursorTs);
    const survivor = projected.entities[0];

    // Without stance machinery, W-0 flattens the conflict — information loss.
    expect(typeof survivor.fields.current_situation?.value).toBe('string');
    expect(['doubled_up', 'sheltered']).toContain(
      survivor.fields.current_situation?.value,
    );
    // Post-merge survivor update is visible.
    expect(survivor.fields.case_worker?.value).toBe('@maya:agency');
  });

  it('W-2 dissecting exposes the current_situation conflict', async () => {
    const branch = fixture.buildBranch('always-merged', 'dissecting');
    const projected = await engine.project(branch, fixture.cursorTs);
    const situation = projected.entities[0].fields.current_situation;

    expect(situation?.epistemic).toBe('conflict');
    expect(situation?.conflict_values).toEqual(
      expect.arrayContaining(['doubled_up', 'sheltered']),
    );
  });

  it('W-2 binding renders current_situation as a multi-valued field', async () => {
    // The demo point: W-2 binding stance is the clean way to read a field
    // whose real-world semantics are multi-valued ("doubled up AND
    // sheltered"). The schema never had to change — the same DEFs under
    // the same log, reprojected, show the multi-value reading.
    const branch = fixture.buildBranch('always-merged', 'binding');
    const projected = await engine.project(branch, fixture.cursorTs);
    const situation = projected.entities[0].fields.current_situation;

    expect(Array.isArray(situation?.value)).toBe(true);
    const values = (situation?.value ?? []) as string[];
    expect(values).toEqual(
      expect.arrayContaining(['doubled_up', 'sheltered']),
    );
    expect(situation?.epistemic).toBe('policy-sensitive');
  });

  it('W-1 post-merge flags intake_date as shadow on the referral record (unknown-in-world)', async () => {
    const branch = fixture.buildBranch('never-merged');
    const projected = await engine.project(branch, fixture.cursorTs);

    const intake = projected.entities.find(
      (e) => e.target === 'case:sarah_m_intake',
    );
    const referral = projected.entities.find(
      (e) => e.target === 'case:sarah_m_referral',
    );
    // intake_date lived only on the intake record — in the never-merged
    // world, the referral record still does not have it (never-set is not
    // unknown-in-world). The intake record's value is present but marked
    // shadow, because the whole post-merge world is indeterminate.
    expect(intake?.fields.intake_date?.epistemic).toBe('shadow');
    expect(referral?.fields.intake_date).toBeUndefined();
  });

  it('survivor-only fields never leak into W-1', async () => {
    const branch = fixture.buildBranch('never-merged');
    const projected = await engine.project(branch, fixture.cursorTs);
    for (const entity of projected.entities) {
      const caseWorker: ProjectedField | undefined = entity.fields.case_worker;
      expect(caseWorker).toBeUndefined();
    }
  });
});
