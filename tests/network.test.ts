import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import { processEvent } from '../src/db/fold.js';
import { getState } from '../src/db/state.js';
import { getEdgesFrom } from '../src/db/graph.js';
import { resolveAlias } from '../src/db/helpers.js';
import {
  resolveAuthority,
  resolveGovernance,
  evaluateAuthority,
  readGroup,
  findAgentGroups,
} from '../src/db/custody.js';
import { AuthorityLevel } from '../src/db/network-types.js';
import type { EoEventInput } from '../src/db/types.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

const PROVIDER = '@provider:matrix.example.com';
const ALICE = '@alice:matrix.example.com';
const BOB = '@bob:matrix.example.com';
const TS = '2025-06-01T00:00:00.000Z';

function ev(overrides: Partial<EoEventInput>): EoEventInput {
  return {
    op: 'INS',
    target: 'test',
    operand: {},
    agent: PROVIDER,
    ts: TS,
    acquired_ts: TS,
    ...overrides,
  };
}

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-network-test-'));
  db = createDb(dbPath);
  await db.open();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Authority Resolution
// ---------------------------------------------------------------------------

describe('resolveAuthority', () => {
  it('returns NONE for an agent with no relationship to target', async () => {
    await processEvent(db, ev({ target: 'network.people.rec_alice', operand: { name: 'Alice' } }));

    const auth = await resolveAuthority(db, BOB, 'network.people.rec_alice');
    expect(auth.level).toBe(AuthorityLevel.NONE);
  });

  it('returns CREATOR for the agent who created the target', async () => {
    await processEvent(db, ev({
      target: 'network.people.rec_alice',
      agent: PROVIDER,
      operand: { name: 'Alice' },
    }));

    const auth = await resolveAuthority(db, PROVIDER, 'network.people.rec_alice');
    expect(auth.level).toBe(AuthorityLevel.CREATOR);
    expect(auth.via).toBe('creator');
  });

  it('returns CUSTODIAN when agent has a custodian edge to target', async () => {
    // Create target and agent identity
    await processEvent(db, ev({ target: 'network.people.rec_alice', operand: { name: 'Alice' } }));
    await processEvent(db, ev({ target: PROVIDER }));

    // Provider takes custody via CON
    await processEvent(db, ev({
      op: 'CON',
      target: 'network.people.rec_alice',
      operand: { added: [PROVIDER], edge_type: 'custodian' },
      agent: PROVIDER,
    }));

    const auth = await resolveAuthority(db, PROVIDER, 'network.people.rec_alice');
    expect(auth.level).toBe(AuthorityLevel.CUSTODIAN);
  });

  it('returns SELF after SYN claim — agent IS the target', async () => {
    // Provider creates a record about Alice
    await processEvent(db, ev({
      target: 'network.people.rec_alice',
      operand: { name: 'Alice' },
      agent: PROVIDER,
    }));

    // Alice's identity target
    await processEvent(db, ev({ target: ALICE, agent: ALICE }));

    // Alice claims the record via SYN
    await processEvent(db, ev({
      op: 'SYN',
      target: ALICE,
      operand: { merge: ['network.people.rec_alice', ALICE], into: ALICE, claim: true },
      agent: ALICE,
    }));

    // After SYN, rec_alice resolves to ALICE's identity
    const resolved = await resolveAlias(db, 'network.people.rec_alice');
    expect(resolved).toBe(ALICE);

    // Alice is SELF relative to her claimed record
    const auth = await resolveAuthority(db, ALICE, 'network.people.rec_alice');
    expect(auth.level).toBe(AuthorityLevel.SELF);
    expect(auth.via).toBe('syn_identity');
  });

  it('SELF outranks CREATOR after claim', async () => {
    // Provider creates record
    await processEvent(db, ev({
      target: 'network.people.rec_alice',
      operand: { name: 'Alice' },
      agent: PROVIDER,
    }));
    await processEvent(db, ev({ target: ALICE, agent: ALICE }));

    // Alice claims
    await processEvent(db, ev({
      op: 'SYN',
      target: ALICE,
      operand: { merge: ['network.people.rec_alice', ALICE], into: ALICE, claim: true },
      agent: ALICE,
    }));

    const aliceAuth = await resolveAuthority(db, ALICE, 'network.people.rec_alice');
    const providerAuth = await resolveAuthority(db, PROVIDER, 'network.people.rec_alice');

    expect(aliceAuth.level).toBeGreaterThan(providerAuth.level);
    expect(aliceAuth.level).toBe(AuthorityLevel.SELF);
    // Provider's authority doesn't vanish — they're still in the log as creator
    expect(providerAuth.level).toBe(AuthorityLevel.CREATOR);
  });
});

// ---------------------------------------------------------------------------
// Group Formation — emergent structure from operator composition
// ---------------------------------------------------------------------------

describe('group formation', () => {
  it('a group emerges from SEG + CON composition', async () => {
    // INS the group
    await processEvent(db, ev({
      target: 'network.crew.infraTeam',
      agent: ALICE,
    }));

    // SEG: draw a group boundary
    await processEvent(db, ev({
      op: 'SEG',
      target: 'network.crew.infraTeam',
      operand: { boundary: 'group', membership: 'open' },
      agent: ALICE,
    }));

    // CON: Alice and Bob join
    await processEvent(db, ev({ target: ALICE, agent: ALICE }));
    await processEvent(db, ev({ target: BOB, agent: BOB }));

    await processEvent(db, ev({
      op: 'CON',
      target: 'network.crew.infraTeam',
      operand: { added: [ALICE], edge_type: 'member' },
      agent: ALICE,
    }));
    await processEvent(db, ev({
      op: 'CON',
      target: 'network.crew.infraTeam',
      operand: { added: [BOB], edge_type: 'member' },
      agent: BOB,
    }));

    // Read the emergent group
    const group = await readGroup(db, 'network.crew.infraTeam');
    expect(group).not.toBeNull();
    expect(group!.boundary).toMatchObject({ boundary: 'group', membership: 'open' });
    expect(group!.members).toHaveLength(2);
    expect(group!.members.map(m => m.agent)).toContain(ALICE);
    expect(group!.members.map(m => m.agent)).toContain(BOB);
  });

  it('agent can discover their groups via reverse graph walk', async () => {
    // Create two groups, Alice in both, Bob in one
    await processEvent(db, ev({ target: 'network.crew.teamA', agent: ALICE }));
    await processEvent(db, ev({
      op: 'SEG', target: 'network.crew.teamA',
      operand: { boundary: 'group', membership: 'open' }, agent: ALICE,
    }));

    await processEvent(db, ev({ target: 'network.crew.teamB', agent: ALICE }));
    await processEvent(db, ev({
      op: 'SEG', target: 'network.crew.teamB',
      operand: { boundary: 'group', membership: 'open' }, agent: ALICE,
    }));

    await processEvent(db, ev({ target: ALICE, agent: ALICE }));
    await processEvent(db, ev({ target: BOB, agent: BOB }));

    await processEvent(db, ev({
      op: 'CON', target: 'network.crew.teamA',
      operand: { added: [ALICE], edge_type: 'member' }, agent: ALICE,
    }));
    await processEvent(db, ev({
      op: 'CON', target: 'network.crew.teamB',
      operand: { added: [ALICE], edge_type: 'member' }, agent: ALICE,
    }));
    await processEvent(db, ev({
      op: 'CON', target: 'network.crew.teamA',
      operand: { added: [BOB], edge_type: 'member' }, agent: BOB,
    }));

    const aliceGroups = await findAgentGroups(db, ALICE);
    const bobGroups = await findAgentGroups(db, BOB);

    expect(aliceGroups).toHaveLength(2);
    expect(bobGroups).toHaveLength(1);
    expect(bobGroups[0].group).toBe('network.crew.teamA');
  });
});

// ---------------------------------------------------------------------------
// Governance — EVA policies at boundaries
// ---------------------------------------------------------------------------

describe('governance', () => {
  it('resolves governance policies from ancestry chain', async () => {
    // Create nested structure
    await processEvent(db, ev({ target: 'network', agent: ALICE }));
    await processEvent(db, ev({ target: 'network.crew', agent: ALICE }));
    await processEvent(db, ev({ target: 'network.crew.infraTeam', agent: ALICE }));

    // Network-wide policy
    await processEvent(db, ev({
      op: 'INS',
      target: 'network._governance.openPolicy',
      agent: ALICE,
    }));
    await processEvent(db, ev({
      op: 'EVA',
      target: 'network._governance.openPolicy',
      operand: { strategy: 'open' },
      agent: ALICE,
    }));

    // Team-specific policy
    await processEvent(db, ev({
      op: 'INS',
      target: 'network.crew.infraTeam._governance.custodyPolicy',
      agent: ALICE,
    }));
    await processEvent(db, ev({
      op: 'EVA',
      target: 'network.crew.infraTeam._governance.custodyPolicy',
      operand: { strategy: 'custody', operators: ['DEF', 'SEG'] },
      agent: ALICE,
    }));

    // Resolve governance for a target inside the team
    const gov = await resolveGovernance(db, 'network.crew.infraTeam.resource1');

    // Should find both policies, team-specific first (most specific)
    expect(gov.policies.length).toBeGreaterThanOrEqual(2);
    expect(gov.policies[0].policy.strategy).toBe('custody'); // team-level, most specific
    // Network-level policy should be later in the list
    const openPolicy = gov.policies.find(p => p.policy.strategy === 'open');
    expect(openPolicy).toBeDefined();
  });

  it('protogon phase: no governance = everything allowed', async () => {
    await processEvent(db, ev({ target: 'network.experiment.thing', agent: ALICE }));

    const decision = await evaluateAuthority(db, BOB, 'network.experiment.thing', 'DEF');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('protogon');
  });

  it('custody policy: SELF always allowed, CREATOR limited', async () => {
    // Provider creates target, Alice claims it
    await processEvent(db, ev({
      target: 'network.people.rec_alice',
      operand: { name: 'Alice' },
      agent: PROVIDER,
    }));
    await processEvent(db, ev({ target: ALICE, agent: ALICE }));
    await processEvent(db, ev({
      op: 'SYN', target: ALICE,
      operand: { merge: ['network.people.rec_alice', ALICE], into: ALICE, claim: true },
      agent: ALICE,
    }));

    // Add custody governance
    await processEvent(db, ev({
      op: 'INS',
      target: 'network.people._governance.custodyPolicy',
      agent: ALICE,
    }));
    await processEvent(db, ev({
      op: 'EVA',
      target: 'network.people._governance.custodyPolicy',
      operand: { strategy: 'custody' },
      agent: ALICE,
    }));

    // Alice (SELF) can do anything
    const aliceDef = await evaluateAuthority(db, ALICE, 'network.people.rec_alice', 'DEF');
    expect(aliceDef.allowed).toBe(true);

    const aliceSeg = await evaluateAuthority(db, ALICE, 'network.people.rec_alice', 'SEG');
    expect(aliceSeg.allowed).toBe(true);

    // Provider (CREATOR) can DEF but not SEG
    const providerDef = await evaluateAuthority(db, PROVIDER, 'network.people.rec_alice', 'DEF');
    expect(providerDef.allowed).toBe(true);

    const providerSeg = await evaluateAuthority(db, PROVIDER, 'network.people.rec_alice', 'SEG');
    expect(providerSeg.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Roles — EVA policies referencing CON edge types
// ---------------------------------------------------------------------------

describe('roles', () => {
  it('steward role grants capabilities via CON edge + EVA policy', async () => {
    // Create group
    await processEvent(db, ev({ target: 'network.crew.infraTeam', agent: ALICE }));
    await processEvent(db, ev({
      op: 'SEG', target: 'network.crew.infraTeam',
      operand: { boundary: 'group', membership: 'open' }, agent: ALICE,
    }));

    // Alice is steward, Bob is member
    await processEvent(db, ev({ target: ALICE, agent: ALICE }));
    await processEvent(db, ev({ target: BOB, agent: BOB }));
    await processEvent(db, ev({
      op: 'CON', target: 'network.crew.infraTeam',
      operand: { added: [ALICE], edge_type: 'steward' }, agent: ALICE,
    }));
    await processEvent(db, ev({
      op: 'CON', target: 'network.crew.infraTeam',
      operand: { added: [BOB], edge_type: 'member' }, agent: BOB,
    }));

    // Role policy: stewards can modify governance
    await processEvent(db, ev({
      op: 'INS',
      target: 'network.crew.infraTeam._governance.stewardPolicy',
      agent: ALICE,
    }));
    await processEvent(db, ev({
      op: 'EVA',
      target: 'network.crew.infraTeam._governance.stewardPolicy',
      operand: {
        strategy: 'role',
        edge_type: 'steward',
        capabilities: ['SEG', 'EVA', 'CON'],
        scope: 'network.crew.infraTeam',
      },
      agent: ALICE,
    }));

    // Alice (steward) can EVA
    const aliceEva = await evaluateAuthority(db, ALICE, 'network.crew.infraTeam', 'EVA');
    expect(aliceEva.allowed).toBe(true);

    // Bob (member, not steward) cannot EVA under role policy
    const bobEva = await evaluateAuthority(db, BOB, 'network.crew.infraTeam', 'EVA');
    expect(bobEva.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Nested teams — Horizon ancestry provides polycentric governance
// ---------------------------------------------------------------------------

describe('nested teams', () => {
  it('inner team inherits outer governance via ancestry', async () => {
    // Outer group
    await processEvent(db, ev({ target: 'network.crew', agent: ALICE }));
    await processEvent(db, ev({
      op: 'SEG', target: 'network.crew',
      operand: { boundary: 'group', membership: 'open' }, agent: ALICE,
    }));

    // Outer governance: open policy
    await processEvent(db, ev({
      op: 'INS', target: 'network.crew._governance.openPolicy', agent: ALICE,
    }));
    await processEvent(db, ev({
      op: 'EVA', target: 'network.crew._governance.openPolicy',
      operand: { strategy: 'open' }, agent: ALICE,
    }));

    // Inner team
    await processEvent(db, ev({ target: 'network.crew.infraTeam', agent: ALICE }));
    await processEvent(db, ev({
      op: 'SEG', target: 'network.crew.infraTeam',
      operand: { boundary: 'group', membership: 'invite' }, agent: ALICE,
    }));

    // Inner team has no governance of its own
    // Resolve governance for a resource inside the inner team
    const gov = await resolveGovernance(db, 'network.crew.infraTeam.someResource');

    // Should inherit the outer crew's open policy
    expect(gov.policies.length).toBeGreaterThanOrEqual(1);
    const openPolicy = gov.policies.find(p => p.policy.strategy === 'open');
    expect(openPolicy).toBeDefined();
    expect(openPolicy!.target).toBe('network.crew._governance.openPolicy');
  });
});

// ---------------------------------------------------------------------------
// The full claiming lifecycle
// ---------------------------------------------------------------------------

describe('claiming lifecycle', () => {
  it('provider creates → person claims → authority shifts', async () => {
    // Step 1: Provider creates record about Alice
    await processEvent(db, ev({
      target: 'network.people.rec_alice',
      operand: { name: 'Alice', email: 'alice@example.com' },
      agent: PROVIDER,
    }));

    // Provider is creator
    let auth = await resolveAuthority(db, PROVIDER, 'network.people.rec_alice');
    expect(auth.level).toBe(AuthorityLevel.CREATOR);

    // Alice has no relationship yet
    auth = await resolveAuthority(db, ALICE, 'network.people.rec_alice');
    expect(auth.level).toBe(AuthorityLevel.NONE);

    // Step 2: Alice authenticates and claims
    await processEvent(db, ev({ target: ALICE, agent: ALICE }));
    await processEvent(db, ev({
      op: 'SYN',
      target: ALICE,
      operand: {
        merge: ['network.people.rec_alice', ALICE],
        into: ALICE,
        claim: true,
      },
      agent: ALICE,
    }));

    // Step 3: Authority has shifted
    auth = await resolveAuthority(db, ALICE, 'network.people.rec_alice');
    expect(auth.level).toBe(AuthorityLevel.SELF);

    auth = await resolveAuthority(db, PROVIDER, 'network.people.rec_alice');
    expect(auth.level).toBe(AuthorityLevel.CREATOR);

    // Step 4: The data merged — Alice's record now carries the provider's data
    const state = await getState(db, ALICE);
    expect(state?.value).toMatchObject({ name: 'Alice', email: 'alice@example.com' });

    // Step 5: The old path still resolves (via SYN alias)
    const resolved = await resolveAlias(db, 'network.people.rec_alice');
    expect(resolved).toBe(ALICE);
  });
});
