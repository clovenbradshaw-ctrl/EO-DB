/**
 * Branching-demo fixture — two sample SYN merges that exercise every
 * epistemic state the ProjectionEngine can produce.
 *
 * This is the dataset the "Scenario Stack" demo walkthrough is built on:
 *
 *   scenario A  contact:j_walker    ←  contact:jordan_w + contact:j_walker_alt
 *   scenario B  case:sarah_m        ←  case:sarah_m_intake + case:sarah_m_referral
 *
 * Each scenario is a pure list of EoEventInput values + a small metadata
 * bundle (source ids, survivor id, SYN timestamp, and a cursor timestamp
 * the tests can snap the scrubber to). The helper `materializeFixture`
 * appends the events to a store so they pick up sequential `seq` numbers
 * from the store's own counter — matching the pattern used by the
 * ProjectionEngine test suite.
 *
 * The data is intentionally shaped so that the three worlds disagree in
 * visible, distinguishable ways at the demo cursor. See the block comments
 * inside each scenario for the per-field intent.
 */

import type { EoStore } from '../../../db/encrypted-store';
import type { EoEvent, EoEventInput } from '../../../db/types';
import type { BranchRecord, EvaStance, WorldType } from '../../../types/branch';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BranchingFixture {
  /** Human-readable label for log lines and test descriptions. */
  label: string;
  /** Source entity ids that get merged. */
  sources: [string, string];
  /** Survivor entity id produced by the SYN. */
  survivor: string;
  /** ISO timestamp of the SYN merge event. */
  synTs: string;
  /** ISO timestamp the demo snapshots at (post-merge by construction). */
  cursorTs: string;
  /** The events that produce the scenario, in submission order (no seq). */
  events: EoEventInput[];
}

export interface MaterializedFixture extends BranchingFixture {
  /** The events after they were written, with assigned seq numbers. */
  materialized: EoEvent[];
  /** The seq of the SYN event — the policy branch point. */
  synSeq: number;
  /** Convenience helper to build a ready-to-project BranchRecord. */
  buildBranch: (world: WorldType, stance?: EvaStance | null) => BranchRecord;
}

// ─── Common helper ───────────────────────────────────────────────────────────

const TEST_AGENT = '@demo:matrix.local';

function ev(
  op: EoEventInput['op'],
  target: string,
  operand: unknown,
  ts: string,
): EoEventInput {
  return {
    op,
    target,
    operand,
    agent: TEST_AGENT,
    ts,
    acquired_ts: ts,
  };
}

// ─── Scenario A — contact:j_walker ───────────────────────────────────────────
//
// Two CRM contact records that lived independently for four months then got
// merged. Post-merge, the survivor is edited with an email override, a phone
// number (which neither source ever held), and a tag union.
//
// Per-field expectations at `cursorTs`:
//
//   full_name     conflict    — "Jordan W." (A) vs "J. Walker" (B)
//   email         conflict    — both sources wrote "jwalker@acme.com",
//                               survivor later overrode with "j@walker.dev"
//   company       single src  — only A wrote "Acme Corp"; policy-sensitive
//   status        conflict    — "lead" (A) vs "customer" (B)
//   phone         shadow      — never set in either source; survivor-only
//                               write lands as shadow in W-1 post-merge and
//                               contributes a survivor-bucket value in W-2
//   tags          policy-sens — array; value depends on stance (binding /
//                               composing / clearing each reshape it)
//   created_at    agreement   — both sources wrote "2024-01-03"

const SCENARIO_A: BranchingFixture = {
  label: 'contact:j_walker (CRM merge with override + shadow + conflicts)',
  sources: ['contact:jordan_w', 'contact:j_walker_alt'],
  survivor: 'contact:j_walker',
  synTs: '2024-04-30T12:00:00.000Z',
  cursorTs: '2024-07-22T09:00:00.000Z',
  events: [
    // --- Initial creation of both sources, same day ------------------------
    ev(
      'INS',
      'contact:jordan_w',
      {
        full_name: 'Jordan W.',
        email: 'jwalker@acme.com',
        company: 'Acme Corp',
        status: 'lead',
        tags: ['sales', 'priority'],
        created_at: '2024-01-03',
      },
      '2024-01-03T10:15:00.000Z',
    ),
    ev(
      'INS',
      'contact:j_walker_alt',
      {
        full_name: 'J. Walker',
        email: 'jwalker@acme.com',
        // company deliberately absent from B — demonstrates "single-source"
        // contribution under W-2 dissecting (policy-sensitive, not conflict).
        status: 'customer',
        tags: ['q4-followup'],
        created_at: '2024-01-03',
      },
      '2024-01-03T14:22:00.000Z',
    ),

    // --- Independent evolution on each source ------------------------------
    // Both rewrite their own status in February / March. These are no-ops
    // value-wise but stamp per-source events on the timeline so the
    // divergence map has something to render.
    ev('DEF', 'contact:jordan_w', { status: 'lead' }, '2024-02-14T09:00:00.000Z'),
    ev(
      'DEF',
      'contact:j_walker_alt',
      { status: 'customer' },
      '2024-03-20T16:45:00.000Z',
    ),

    // --- SYN merge ---------------------------------------------------------
    ev(
      'SYN',
      'contact:j_walker',
      {
        merge: ['contact:jordan_w', 'contact:j_walker_alt'],
        into: 'contact:j_walker',
      },
      '2024-04-30T12:00:00.000Z',
    ),

    // --- Post-merge activity on the survivor -------------------------------
    // Email override: canonical was jwalker@acme.com from both sources; the
    // survivor now writes j@walker.dev. In W-0 this overrides cleanly; in
    // W-2 dissecting the three distinct source-bucket values are held open.
    ev(
      'DEF',
      'contact:j_walker',
      { email: 'j@walker.dev' },
      '2024-06-15T11:30:00.000Z',
    ),
    // Phone: never set in either source. In W-1 post-merge this is shadow
    // (the whole world is indeterminate). In W-2 it's a survivor-only
    // contribution → policy-sensitive.
    ev(
      'DEF',
      'contact:j_walker',
      { phone: '+1-555-0142' },
      '2024-06-15T11:30:05.000Z',
    ),
    // Tags union: survivor re-writes tags to the union of both sources'
    // pre-merge lists plus one new tag. In W-0 this is the canonical value;
    // in W-2 it's a policy-sensitive field with three contributions.
    ev(
      'DEF',
      'contact:j_walker',
      { tags: ['sales', 'priority', 'q4-followup'] },
      '2024-07-10T08:00:00.000Z',
    ),
  ],
};

// ─── Scenario B — case:sarah_m ───────────────────────────────────────────────
//
// A homeless-services case with two intake records: one from the direct
// intake form (case:sarah_m_intake) and one from a partner-agency referral
// (case:sarah_m_referral). The merger exposes a field that in the real world
// needs to be multi-valued — current_situation — because someone can be
// "doubled up AND in a shelter" simultaneously. W-2 binding / composing
// stances expose the multi-value reading directly, without the schema
// itself having to change.
//
// Per-field expectations at `cursorTs`:
//
//   full_name          agreement — both wrote "Sarah Martinez"
//   current_situation  conflict  — "doubled_up" (intake) vs "sheltered" (referral)
//   priority           single src — only intake wrote "high"
//   intake_date        single src — only intake wrote it (referral shadows it)
//   referral_source    single src — only referral wrote it
//   case_worker        survivor   — post-merge assignment; shadow in W-1

const SCENARIO_B: BranchingFixture = {
  label: 'case:sarah_m (homeless-services merge exposing multi-value field)',
  sources: ['case:sarah_m_intake', 'case:sarah_m_referral'],
  survivor: 'case:sarah_m',
  synTs: '2024-09-05T14:00:00.000Z',
  cursorTs: '2024-11-15T10:00:00.000Z',
  events: [
    ev(
      'INS',
      'case:sarah_m_intake',
      {
        full_name: 'Sarah Martinez',
        current_situation: 'doubled_up',
        priority: 'high',
        intake_date: '2024-08-12',
      },
      '2024-08-12T09:30:00.000Z',
    ),
    ev(
      'INS',
      'case:sarah_m_referral',
      {
        full_name: 'Sarah Martinez',
        current_situation: 'sheltered',
        referral_source: 'shelter_partners',
      },
      '2024-08-28T17:15:00.000Z',
    ),

    // Each source gets a tiny follow-up update before the merge so the
    // divergence heat strip has something to show beyond the creation
    // events.
    ev(
      'DEF',
      'case:sarah_m_intake',
      { priority: 'high' },
      '2024-09-01T11:00:00.000Z',
    ),

    ev(
      'SYN',
      'case:sarah_m',
      {
        merge: ['case:sarah_m_intake', 'case:sarah_m_referral'],
        into: 'case:sarah_m',
      },
      '2024-09-05T14:00:00.000Z',
    ),

    // Post-merge: a case worker is assigned. Never set in either source.
    ev(
      'DEF',
      'case:sarah_m',
      { case_worker: '@maya:agency' },
      '2024-09-10T10:00:00.000Z',
    ),
  ],
};

// ─── Registry + materialization ──────────────────────────────────────────────

export const BRANCHING_FIXTURES = {
  contact_j_walker: SCENARIO_A,
  case_sarah_m: SCENARIO_B,
} as const satisfies Record<string, BranchingFixture>;

export type BranchingFixtureKey = keyof typeof BRANCHING_FIXTURES;

/**
 * Write every event in the fixture to the given store. Returns a
 * `MaterializedFixture` that includes the seq-assigned events and a
 * `buildBranch` helper for the engine.
 */
export async function materializeFixture(
  store: EoStore,
  fixture: BranchingFixture,
): Promise<MaterializedFixture> {
  const materialized: EoEvent[] = [];
  let synSeq = -1;

  for (const input of fixture.events) {
    const seq = await store.nextSeq();
    const full: EoEvent = { ...input, seq };
    const key = `log:${String(seq).padStart(12, '0')}`;
    await store.put(key, full);
    materialized.push(full);
    if (full.op === 'SYN') synSeq = full.seq;
  }

  if (synSeq < 0) {
    throw new Error(`Fixture "${fixture.label}" has no SYN event`);
  }

  const buildBranch = (
    world: WorldType,
    stance: EvaStance | null = null,
  ): BranchRecord => ({
    branch_id: `demo-${fixture.survivor}-${world}`,
    subject: fixture.sources.join(','),
    survivor_id: fixture.survivor,
    policy: {
      world,
      stance: world === 'always-merged' ? stance ?? 'clearing' : null,
      suppress_event_ids:
        world === 'never-merged' ? [String(synSeq)] : [],
      retroject_event_ids:
        world === 'always-merged' ? [String(synSeq)] : [],
      branch_point_ts: fixture.synTs,
    },
    epistemic_status: 'projection-sketch',
    author: TEST_AGENT,
    created_at: fixture.synTs,
    label: `demo-${world}`,
  });

  return {
    ...fixture,
    materialized,
    synSeq,
    buildBranch,
  };
}
