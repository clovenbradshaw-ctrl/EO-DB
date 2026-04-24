/**
 * Space permissions manifest — types, fold, and helpers.
 *
 * The manifest is an append-only EO event log. It is the source of truth for
 * role assignments and field sensitivity config.
 *
 * Event schema:
 *   INS("{spaceId}.space")
 *   DEF("{spaceId}.space.name",  "Amino")
 *   DEF("{spaceId}.member.@alice:server",  { role, grantedBy, grantedAt, keyIds })
 *   NUL("{spaceId}.member.@alice:server")          — revocation
 *   DEF("{spaceId}.field.ssn",  { sensitivity, shadowValue, shadowLabel })
 */

import type { EoEvent } from '../db/types';

/** Space-level roles in ascending capability order. */
export type SpaceRole = 'viewer' | 'editor' | 'restricted' | 'admin' | 'owner';

const ROLE_ORDER: SpaceRole[] = ['viewer', 'editor', 'restricted', 'admin', 'owner'];

/** Return true if `a` >= `b` in capability order. */
export function roleAtLeast(a: SpaceRole, b: SpaceRole): boolean {
  return ROLE_ORDER.indexOf(a) >= ROLE_ORDER.indexOf(b);
}

export interface ManifestMember {
  role: SpaceRole;
  grantedBy: string;
  grantedAt: string;
  /** Active key IDs for each tier the member can access (set at grant time). */
  keyIds: Partial<Record<'viewer' | 'editor' | 'restricted' | 'admin', string>>;
}

export interface FieldShadowConfig {
  /** Log tier required to decrypt this field's events. */
  sensitivity: 'restricted' | 'admin';
  /**
   * Value rendered for users who cannot decrypt this field.
   * null = hide the column entirely.
   * string = show this placeholder (e.g. "***-**-****").
   */
  shadowValue: string | null;
  /** Optional column header override when the field is shadowed. */
  shadowLabel?: string;
}

export interface ManifestState {
  spaceName?: string;
  /** userId → current member entry (NUL events remove entries). */
  members: Record<string, ManifestMember>;
  /** fieldKey → restriction config for fields above viewer tier. */
  fields: Record<string, FieldShadowConfig>;
}

/**
 * Fold a list of manifest events into a ManifestState snapshot.
 */
export function foldManifest(events: EoEvent[]): ManifestState {
  const state: ManifestState = { members: {}, fields: {} };

  for (const ev of events) {
    const parts = ev.target.split('.');

    if (parts.length < 3) continue;
    const segment = parts[1];
    const key = parts.slice(2).join('.');

    if (segment === 'space' && key === 'name' && ev.op === 'DEF') {
      state.spaceName = ev.operand as string;
      continue;
    }

    if (segment === 'member') {
      if (ev.op === 'DEF' && ev.operand && typeof ev.operand === 'object') {
        state.members[key] = ev.operand as ManifestMember;
      } else if (ev.op === 'NUL') {
        delete state.members[key];
      }
      continue;
    }

    if (segment === 'field') {
      if (ev.op === 'DEF' && ev.operand && typeof ev.operand === 'object') {
        state.fields[key] = ev.operand as FieldShadowConfig;
      } else if (ev.op === 'NUL') {
        delete state.fields[key];
      }
    }
  }

  return state;
}

/** Get the resolved role for a user ID, or null if not a member. */
export function getOwnRole(state: ManifestState, userId: string): SpaceRole | null {
  return state.members[userId]?.role ?? null;
}

/** Get all field shadow configs keyed by field name. */
export function getFieldShadows(state: ManifestState): Record<string, FieldShadowConfig> {
  return { ...state.fields };
}

/**
 * Build the DEF event for granting a role to a user.
 */
export function buildGrantEvent(
  spaceId: string,
  targetUserId: string,
  role: SpaceRole,
  grantedByUserId: string,
  keyIds: ManifestMember['keyIds'],
  seq: number,
): EoEvent {
  const now = new Date().toISOString();
  return {
    seq,
    op: 'DEF',
    target: `${spaceId}.member.${targetUserId}`,
    operand: {
      role,
      grantedBy: grantedByUserId,
      grantedAt: now,
      keyIds,
    } satisfies ManifestMember,
    agent: grantedByUserId,
    ts: now,
    acquired_ts: now,
  };
}

/**
 * Build the NUL event for revoking a user's access.
 */
export function buildRevokeEvent(
  spaceId: string,
  targetUserId: string,
  revokedByUserId: string,
  seq: number,
): EoEvent {
  const now = new Date().toISOString();
  return {
    seq,
    op: 'NUL',
    target: `${spaceId}.member.${targetUserId}`,
    operand: null,
    agent: revokedByUserId,
    ts: now,
    acquired_ts: now,
    resolution: 'Clearing',
    nul_state: 'cleared',
  };
}

/**
 * Build DEF events for setting field sensitivity / shadow config.
 */
export function buildFieldConfigEvent(
  spaceId: string,
  fieldKey: string,
  config: FieldShadowConfig,
  agentUserId: string,
  seq: number,
): EoEvent {
  const now = new Date().toISOString();
  return {
    seq,
    op: 'DEF',
    target: `${spaceId}.field.${fieldKey}`,
    operand: config,
    agent: agentUserId,
    ts: now,
    acquired_ts: now,
  };
}

/**
 * Given a resolved role, return the set of log tiers the user can access.
 */
export function accessibleTiers(role: SpaceRole): Array<'viewer' | 'restricted' | 'admin'> {
  const tiers: Array<'viewer' | 'restricted' | 'admin'> = ['viewer'];
  if (roleAtLeast(role, 'restricted')) tiers.push('restricted');
  if (roleAtLeast(role, 'admin')) tiers.push('admin');
  return tiers;
}
