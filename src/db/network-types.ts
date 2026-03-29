/**
 * Network model operand conventions.
 *
 * These are not new types the database needs to know about. They are conventions
 * for how the existing operators compose to produce network governance patterns.
 * The fold processes them as regular operands. The custody resolution function
 * reads them to compute authority. The Horizon governance layer already walks them.
 *
 * Nothing here changes the fold. These types describe what the operands MEAN
 * when you use EO operators to model how people relate to shared resources.
 */

import type { Operator } from './types.js';

// ---------------------------------------------------------------------------
// SEG operand conventions: boundary types for network structures
// ---------------------------------------------------------------------------

/** A SEG operand that declares a group boundary. */
export interface GroupBoundaryOperand {
  boundary: 'group';
  /** How new members join. The group can change this about itself (it's a DEF-able value). */
  membership: 'open' | 'petition' | 'invite';
  /** Optional: human-readable description of what this group is. */
  description?: string;
}

/** A SEG operand that declares sovereignty — internal governance is opaque to external systems. */
export interface SovereignBoundaryOperand {
  boundary: 'sovereign';
  /** The scope this sovereignty applies to (defaults to the SEG target's subtree). */
  scope?: string;
}

export type NetworkBoundaryOperand = GroupBoundaryOperand | SovereignBoundaryOperand;

export function isGroupBoundary(operand: any): operand is GroupBoundaryOperand {
  return operand?.boundary === 'group';
}

export function isSovereignBoundary(operand: any): operand is SovereignBoundaryOperand {
  return operand?.boundary === 'sovereign';
}

// ---------------------------------------------------------------------------
// CON edge_type conventions: relationship types in the network graph
// ---------------------------------------------------------------------------

/**
 * Standard edge types for CON operations in the network model.
 * These are conventions, not a closed enum. Communities can invent their own.
 */
export type NetworkEdgeType =
  | 'member'       // agent belongs to group
  | 'steward'      // agent has stewardship role in group
  | 'custodian'    // agent has custody of a target (can act on behalf)
  | 'delegate'     // agent can act on behalf of another agent within a scope
  | 'contributor'  // agent contributes to a commons resource
  | string;        // open — communities define their own edge types

// ---------------------------------------------------------------------------
// EVA operand conventions: governance policies
// ---------------------------------------------------------------------------

/** Base for all governance policy operands. */
export interface GovernancePolicyBase {
  /** How authority is determined. */
  strategy: string;
  /** The target subtree this policy governs. Defaults to the policy's own parent path. */
  scope?: string;
}

/**
 * Custody strategy: authority flows from proximity to the target.
 * SYN (agent IS target) > custodian edge > creator > observer.
 */
export interface CustodyPolicy extends GovernancePolicyBase {
  strategy: 'custody';
  /**
   * Which operators this policy governs. If absent, governs all operators.
   * Example: ['DEF', 'SEG'] means this policy controls who can define values
   * and draw boundaries in its scope.
   */
  operators?: Operator[];
  /**
   * Whether custody can be transferred (via CON edge_type: "custodian" change).
   * Default: true.
   */
  transferable?: boolean;
}

/**
 * Collective strategy: decisions require quorum of members.
 * Members are determined by CON edges of type "member" (or custom edge_type).
 */
export interface CollectivePolicy extends GovernancePolicyBase {
  strategy: 'collective';
  quorum: QuorumRule;
  /** Which CON edge_type counts as "membership" for quorum. Default: "member". */
  membership_edge?: string;
}

/** Quorum rule for collective decisions. */
export interface QuorumRule {
  type: 'fraction' | 'count' | 'unanimous';
  /** For 'fraction': the fraction required (0.5 = majority). For 'count': the absolute number. */
  value?: number;
  /** What the quorum is computed against. Default: "members". */
  of?: 'members' | 'stewards' | string;
}

/**
 * Role strategy: authority depends on a specific CON edge type.
 * An agent has the role if there's a CON edge of the specified type connecting them.
 */
export interface RolePolicy extends GovernancePolicyBase {
  strategy: 'role';
  /** The CON edge_type that grants this role's capabilities. */
  edge_type: string;
  /** Which operators agents with this role can perform. */
  capabilities: Operator[];
}

/**
 * Open strategy: anyone within the SEG boundary can act.
 * This is the default for protogon-phase groups (no governance yet).
 */
export interface OpenPolicy extends GovernancePolicyBase {
  strategy: 'open';
  /** Optionally restrict to specific operators. If absent, everything is open. */
  operators?: Operator[];
}

/**
 * Graduated strategy: response depends on the agent's trajectory.
 * The policy evaluates the agent's history of events in the governed scope.
 */
export interface GraduatedPolicy extends GovernancePolicyBase {
  strategy: 'graduated';
  input: 'trajectory';
  thresholds: GraduatedThreshold[];
}

export interface GraduatedThreshold {
  /** Number of prior violations/events that trigger this threshold. */
  count: number;
  /** What happens at this threshold. Convention, not enum — communities define responses. */
  response: string;
  /** Optional duration for time-limited responses (e.g., "7d" for a 7-day cooldown). */
  duration?: string;
}

/**
 * Resolution strategy: for conflict resolution. Methods tried in order,
 * with escalation to parent scope if none resolve.
 */
export interface ResolutionPolicy extends GovernancePolicyBase {
  strategy: 'resolution';
  /** Resolution methods tried in order. */
  methods: Array<'custody' | 'seniority' | 'collective' | string>;
  /** Target path of the parent scope's conflict policy for escalation. */
  escalation?: string;
}

export type GovernancePolicy =
  | CustodyPolicy
  | CollectivePolicy
  | RolePolicy
  | OpenPolicy
  | GraduatedPolicy
  | ResolutionPolicy;

export function isGovernancePolicy(operand: any): operand is GovernancePolicy {
  return operand != null && typeof operand.strategy === 'string';
}

// ---------------------------------------------------------------------------
// Authority levels — the gradient from observer to self
// ---------------------------------------------------------------------------

/**
 * Authority levels computed by custody resolution.
 * These are not permissions — they are descriptions of the relationship
 * between an agent and a target. EVA policies reference them.
 *
 * The ordering is a default. Communities can override it via EVA.
 */
export enum AuthorityLevel {
  /** No relationship. Agent has never interacted with this target. */
  NONE = 0,
  /** Agent has observed (NUL) or directed attention (SIG) to the target. */
  OBSERVER = 1,
  /** Agent created the target (first INS agent in log). */
  CREATOR = 2,
  /** Agent has a contributor edge to the target. */
  CONTRIBUTOR = 3,
  /** Agent has a custodian edge to the target. */
  CUSTODIAN = 4,
  /** Agent has a steward edge to the group containing the target. */
  STEWARD = 5,
  /** Agent IS the target (SYN merge — identity relationship). */
  SELF = 6,
}

// ---------------------------------------------------------------------------
// Custody claim: the SYN operand for "person claims their record"
// ---------------------------------------------------------------------------

/**
 * SYN operand convention for claiming an identity.
 * The `merge` field is already part of SYN semantics — this adds `claim: true`
 * to signal that this is an identity claim, not a general merge.
 */
export interface ClaimOperand {
  /** The two targets being merged: [agent_identity, record_about_agent]. */
  merge: [string, string];
  /** The canonical target after merge. Usually the agent's identity target. */
  into: string;
  /** Marks this SYN as an identity claim for custody resolution. */
  claim: true;
}

export function isClaimOperand(operand: any): operand is ClaimOperand {
  return operand?.claim === true && Array.isArray(operand?.merge);
}
