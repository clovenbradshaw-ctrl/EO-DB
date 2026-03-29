/**
 * Custody resolution — computes authority from the CON/SYN graph.
 *
 * Authority is not stored. It is derived from relationships at evaluation time.
 * This is the same ancestry-walk pattern used by encryption scope and Horizon
 * governance — no new traversal mechanic, just a new reading of existing structure.
 *
 * The custody mechanic answers: "What is the relationship between this agent
 * and this target?" The answer is an AuthorityLevel — a gradient from NONE to SELF.
 * EVA policies reference this gradient to make governance decisions.
 */

import type { EoDb } from './level.js';
import { getState, getStateByPrefix } from './state.js';
import { getEdgesFrom, getEdgesTo } from './graph.js';
import { resolveAlias } from './helpers.js';
import { readLogForTarget } from './log.js';
import {
  AuthorityLevel,
  isGovernancePolicy,
  isGroupBoundary,
  type GovernancePolicy,
  type CustodyPolicy,
  type CollectivePolicy,
  type RolePolicy,
} from './network-types.js';
import type { EoState, Operator } from './types.js';

// ---------------------------------------------------------------------------
// Authority resolution: what is the relationship between agent and target?
// ---------------------------------------------------------------------------

export interface AuthorityResult {
  level: AuthorityLevel;
  /** The relationship path that produced this authority level. */
  via: string;
  /** The agent evaluated. */
  agent: string;
  /** The target evaluated (after alias resolution). */
  target: string;
}

/**
 * Resolve the authority level of an agent relative to a target.
 *
 * Walks the CON/SYN graph to determine the strongest relationship:
 *   SELF > STEWARD > CUSTODIAN > CONTRIBUTOR > CREATOR > OBSERVER > NONE
 *
 * This is a read-time computation — nothing is stored. The graph IS the
 * authority structure. Change the graph, authority changes.
 */
export async function resolveAuthority(
  db: EoDb,
  agent: string,
  target: string,
): Promise<AuthorityResult> {
  const resolved = await resolveAlias(db, target);

  // Check SYN: is the agent's identity target aliased to this target (or vice versa)?
  // After a claim SYN, the agent's identity and the record resolve to the same canonical target.
  const agentResolved = await resolveAlias(db, agent);
  if (agentResolved === resolved) {
    return { level: AuthorityLevel.SELF, via: 'syn_identity', agent, target: resolved };
  }

  // Check CON edges TO this target — who has relationships with it?
  const inbound = await getEdgesTo(db, resolved);
  for (const edge of inbound) {
    if (edge.source === agent || edge.source === agentResolved) {
      if (edge.edge_type === 'steward') {
        return { level: AuthorityLevel.STEWARD, via: `steward_edge:${edge.source}`, agent, target: resolved };
      }
      if (edge.edge_type === 'custodian') {
        return { level: AuthorityLevel.CUSTODIAN, via: `custodian_edge:${edge.source}`, agent, target: resolved };
      }
      if (edge.edge_type === 'contributor') {
        return { level: AuthorityLevel.CONTRIBUTOR, via: `contributor_edge:${edge.source}`, agent, target: resolved };
      }
    }
  }

  // Check CON edges FROM this target — is the agent a member/steward of the target (if target is a group)?
  const outbound = await getEdgesFrom(db, resolved);
  for (const edge of outbound) {
    if (edge.dest === agent || edge.dest === agentResolved) {
      if (edge.edge_type === 'steward') {
        return { level: AuthorityLevel.STEWARD, via: `steward_member:${edge.dest}`, agent, target: resolved };
      }
      if (edge.edge_type === 'custodian') {
        return { level: AuthorityLevel.CUSTODIAN, via: `custodian_member:${edge.dest}`, agent, target: resolved };
      }
      if (edge.edge_type === 'contributor') {
        return { level: AuthorityLevel.CONTRIBUTOR, via: `contributor_member:${edge.dest}`, agent, target: resolved };
      }
    }
  }

  // Check ancestry: walk up the target path to find group membership
  const parts = resolved.split('.');
  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const ancestor = parts.slice(0, depth).join('.');
    const ancestorEdges = await getEdgesFrom(db, ancestor);
    for (const edge of ancestorEdges) {
      if (edge.dest === agent || edge.dest === agentResolved) {
        if (edge.edge_type === 'steward') {
          return { level: AuthorityLevel.STEWARD, via: `steward_ancestor:${ancestor}`, agent, target: resolved };
        }
        if (edge.edge_type === 'member') {
          // Member of ancestor group — at least CONTRIBUTOR level
          return { level: AuthorityLevel.CONTRIBUTOR, via: `member_ancestor:${ancestor}`, agent, target: resolved };
        }
      }
    }
  }

  // Check creation: was this agent the first to INS this target?
  // After SYN alias resolution, the original target path differs from the resolved path.
  // Check both the resolved target and the original target in the log.
  const targetsToCheck = resolved !== target ? [resolved, target] : [resolved];
  for (const t of targetsToCheck) {
    const log = await readLogForTarget(db, t);
    const insEvent = log.find(e => e.op === 'INS');
    if (insEvent && insEvent.agent === agent) {
      return { level: AuthorityLevel.CREATOR, via: 'creator', agent, target: resolved };
    }
    const observed = log.some(e => (e.op === 'NUL') && e.agent === agent);
    if (observed) {
      return { level: AuthorityLevel.OBSERVER, via: 'observer', agent, target: resolved };
    }
  }

  return { level: AuthorityLevel.NONE, via: 'none', agent, target: resolved };
}

// ---------------------------------------------------------------------------
// Governance resolution: what policies govern this target?
// ---------------------------------------------------------------------------

export interface GovernanceResult {
  /** All governance policies that apply, from most specific to most general. */
  policies: Array<{ target: string; policy: GovernancePolicy }>;
}

/**
 * Gather all governance policies that apply to a target.
 * Walks the target path ancestry, checking for _governance subtrees at each level.
 * Returns policies ordered from most specific (deepest) to most general (shallowest).
 *
 * This is the same ancestry walk as encryption scope resolution and Horizon's
 * governance layer — the pattern already exists, this is the network-model reading.
 */
export async function resolveGovernance(
  db: EoDb,
  target: string,
): Promise<GovernanceResult> {
  const resolved = await resolveAlias(db, target);
  const policies: Array<{ target: string; policy: GovernancePolicy }> = [];
  const seen = new Set<string>();

  // Walk ancestry for both the resolved target AND the original target.
  // After SYN, the resolved target may have a completely different path
  // (e.g., "@alice:homeserver" instead of "network.people.rec_alice").
  // The original path's governance still applies — it's where the entity lives
  // in the network topology.
  const pathsToWalk = [resolved];
  if (target !== resolved) {
    pathsToWalk.push(target);
  }

  for (const path of pathsToWalk) {
    const parts = path.split('.');
    for (let depth = parts.length; depth >= 1; depth--) {
      const ancestor = parts.slice(0, depth).join('.');
      const govPrefix = `${ancestor}._governance`;

      if (seen.has(govPrefix)) continue;
      seen.add(govPrefix);

      const govStates = await getStateByPrefix(db, govPrefix);
      for (const state of govStates) {
        if (state.value && isGovernancePolicy(state.value)) {
          policies.push({ target: state.target, policy: state.value });
        }
      }
    }
  }

  return { policies };
}

// ---------------------------------------------------------------------------
// Policy evaluation: does this agent have authority for this operation?
// ---------------------------------------------------------------------------

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  authority: AuthorityResult;
  /** If the policy says to escalate, this is the escalation target. */
  escalate_to?: string;
}

/**
 * Evaluate whether an agent can perform an operation on a target.
 *
 * Gathers governance policies, finds the most specific one that applies,
 * and evaluates it against the agent's authority. If no governance policies
 * exist (protogon phase), the default is ALLOW — structure emerges, it doesn't precede.
 */
export async function evaluateAuthority(
  db: EoDb,
  agent: string,
  target: string,
  op: Operator,
): Promise<PolicyDecision> {
  const authority = await resolveAuthority(db, agent, target);
  const governance = await resolveGovernance(db, target);

  // Protogon phase: no governance policies → everything is allowed.
  // Structure emerges from interaction, it doesn't precede it.
  if (governance.policies.length === 0) {
    return { allowed: true, reason: 'no_governance (protogon phase)', authority };
  }

  // Find the most specific policy that governs this operator
  for (const { target: policyTarget, policy } of governance.policies) {
    switch (policy.strategy) {
      case 'custody':
        return evaluateCustody(policy as CustodyPolicy, authority, op, policyTarget);

      case 'collective':
        return evaluateCollective(db, policy as CollectivePolicy, authority, op, policyTarget, target);

      case 'role':
        return evaluateRole(db, policy as RolePolicy, authority, op, policyTarget, agent, target);

      case 'open':
        // Open strategy: allow if agent is at least an observer
        if (authority.level >= AuthorityLevel.OBSERVER) {
          return { allowed: true, reason: `open_policy:${policyTarget}`, authority };
        }
        return { allowed: true, reason: `open_policy:${policyTarget}`, authority };

      case 'graduated':
        // Graduated sanctions are evaluated elsewhere (at enforcement time, not authorization time)
        // They modify the response, not the initial authorization
        continue;

      case 'resolution':
        // Resolution policies apply to conflicts, not to initial authorization
        continue;

      default:
        // Unknown strategy — skip, let more general policies handle it
        continue;
    }
  }

  // No applicable policy found — default allow (same as protogon)
  return { allowed: true, reason: 'no_applicable_policy', authority };
}

// ---------------------------------------------------------------------------
// Strategy evaluators
// ---------------------------------------------------------------------------

function evaluateCustody(
  policy: CustodyPolicy,
  authority: AuthorityResult,
  op: Operator,
  policyTarget: string,
): PolicyDecision {
  // If the policy specifies operators, only apply to those
  if (policy.operators && !policy.operators.includes(op)) {
    return { allowed: true, reason: `custody_policy_not_applicable:${policyTarget}`, authority };
  }

  // SELF can always act on their own identity
  if (authority.level === AuthorityLevel.SELF) {
    return { allowed: true, reason: `self:${policyTarget}`, authority };
  }

  // STEWARD and CUSTODIAN can perform governed operations
  if (authority.level >= AuthorityLevel.CUSTODIAN) {
    return { allowed: true, reason: `custodian_or_above:${policyTarget}`, authority };
  }

  // CREATOR can perform limited operations (DEF, CON but not SEG, EVA)
  if (authority.level === AuthorityLevel.CREATOR) {
    const creatorOps: Operator[] = ['NUL', 'DEF', 'CON'];
    if (creatorOps.includes(op)) {
      return { allowed: true, reason: `creator_limited:${policyTarget}`, authority };
    }
    return { allowed: false, reason: `creator_insufficient_for_${op}:${policyTarget}`, authority };
  }

  // Below CREATOR: deny for mutating operations, allow for read-only
  if (op === 'NUL') {
    return { allowed: true, reason: `observer_read:${policyTarget}`, authority };
  }

  return { allowed: false, reason: `insufficient_authority:${policyTarget}`, authority };
}

async function evaluateCollective(
  db: EoDb,
  policy: CollectivePolicy,
  authority: AuthorityResult,
  op: Operator,
  policyTarget: string,
  target: string,
): Promise<PolicyDecision> {
  // Collective policies require counting members.
  // The actual voting/quorum mechanism is outside the fold — it's a coordination
  // problem the community solves. What we evaluate here is whether the agent
  // is a member at all.

  const edgeType = policy.membership_edge || 'member';
  const scope = policy.scope || policyTarget.replace(/\._governance.*$/, '');

  // Count members by walking CON edges from the governed scope
  const edges = await getEdgesFrom(db, scope);
  const members = edges.filter(e => e.edge_type === edgeType || e.edge_type === 'steward');
  const isMember = members.some(e => e.dest === authority.agent);

  if (!isMember) {
    return { allowed: false, reason: `not_member_of:${scope}`, authority };
  }

  // Member can participate — actual quorum enforcement happens at the coordination layer
  // (e.g., a SIG-based voting mechanism where SIG events are counted)
  return { allowed: true, reason: `member_of:${scope}`, authority };
}

async function evaluateRole(
  db: EoDb,
  policy: RolePolicy,
  authority: AuthorityResult,
  op: Operator,
  policyTarget: string,
  agent: string,
  target: string,
): Promise<PolicyDecision> {
  // Check if this operator is in the role's capability set
  if (!policy.capabilities.includes(op)) {
    // This role doesn't govern this operator — skip to let other policies handle it
    return { allowed: true, reason: `role_not_applicable:${policyTarget}`, authority };
  }

  const scope = policy.scope || policyTarget.replace(/\._governance.*$/, '');

  // Check if agent has the required edge type
  const edges = await getEdgesFrom(db, scope);
  const agentResolved = await resolveAlias(db, agent);
  const hasRole = edges.some(
    e => (e.dest === agent || e.dest === agentResolved) && e.edge_type === policy.edge_type,
  );

  if (hasRole) {
    return { allowed: true, reason: `role:${policy.edge_type}:${policyTarget}`, authority };
  }

  return { allowed: false, reason: `missing_role:${policy.edge_type}:${policyTarget}`, authority };
}

// ---------------------------------------------------------------------------
// Group membership helpers — read from the graph, not from configuration
// ---------------------------------------------------------------------------

export interface GroupInfo {
  target: string;
  boundary: any;
  members: Array<{ agent: string; edge_type: string }>;
  governance: GovernanceResult;
}

/**
 * Read group information from the graph. A "group" is any target with a
 * group boundary SEG and CON membership edges. This function doesn't create
 * groups — it reads the emergent structure.
 *
 * Because CON overwrites state value, the boundary info is recovered from the
 * log (the SEG event that declared it). The log is the source of truth.
 */
export async function readGroup(db: EoDb, target: string): Promise<GroupInfo | null> {
  const resolved = await resolveAlias(db, target);

  // Check log for the SEG event that declared the group boundary.
  // CON overwrites state, but the log preserves the boundary declaration.
  const log = await readLogForTarget(db, resolved);
  const segEvent = [...log].reverse().find(
    e => e.op === 'SEG' && e.operand?.boundary === 'group',
  );

  if (!segEvent) {
    return null;
  }

  const edges = await getEdgesFrom(db, resolved);
  const members = edges
    .filter(e => e.edge_type === 'member' || e.edge_type === 'steward' || e.edge_type === 'custodian')
    .map(e => ({ agent: e.dest, edge_type: e.edge_type || 'member' }));

  const governance = await resolveGovernance(db, resolved);

  return {
    target: resolved,
    boundary: segEvent.operand,
    members,
    governance,
  };
}

/**
 * Find all groups an agent belongs to by walking the reverse CON graph.
 * Returns the targets of groups where the agent has membership edges.
 *
 * Note: CON overwrites the SEG boundary in state, so we check the log for
 * a SEG event with group boundary rather than relying on current state value.
 * This is consistent with how the fold works — the boundary was declared,
 * the CON edges came later, the log records both.
 */
export async function findAgentGroups(
  db: EoDb,
  agent: string,
): Promise<Array<{ group: string; edge_type: string }>> {
  const agentResolved = await resolveAlias(db, agent);
  const inbound = await getEdgesTo(db, agentResolved);

  const groups: Array<{ group: string; edge_type: string }> = [];
  for (const edge of inbound) {
    const memberEdgeTypes = ['member', 'steward', 'custodian', 'contributor'];
    if (memberEdgeTypes.includes(edge.edge_type || '')) {
      // Check log for a SEG with group boundary to confirm this is a group
      const log = await readLogForTarget(db, edge.source);
      const hasGroupBoundary = log.some(
        e => e.op === 'SEG' && e.operand?.boundary === 'group',
      );
      if (hasGroupBoundary) {
        groups.push({ group: edge.source, edge_type: edge.edge_type || 'member' });
      }
    }
  }

  return groups;
}
