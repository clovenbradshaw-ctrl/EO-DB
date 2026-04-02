/**
 * Encryption access resolver — unified permission resolution for encrypted content.
 *
 * SOURCE OF TRUTH: Matrix room state events.
 * The EO log is a record — Matrix events are the authority.
 *
 * Encryption rules are published as Matrix room state events in the governance room:
 *   Event type: com.eo-db.encryption.rule
 *   State key:  the data target (e.g., "app.tblClients", "app.tblClients.rec001.fldSSN")
 *
 * When a rule state event arrives via Matrix sync, it gets recorded into the EO log
 * as a DEF at {target}._encryption — this is the local materialized view.
 *
 * Three scopes:
 *   1. TABLE-level:  state_key = "app.tblClients"
 *   2. RECORD-level: state_key = "app.tblClients.rec001"
 *   3. FIELD-level:  state_key = "app.tblClients.rec001.fldSSN"
 *
 * The _encryption suffix in the EO log keeps rules in the same target namespace
 * as the data they protect, making them discoverable via standard horizon reads.
 *
 * ─── Permission Crossing Rules ─────────────────────────────────────────────
 *
 * When encryption rules exist at multiple levels, the MOST RESTRICTIVE wins
 * for access, but the MOST SPECIFIC wins for key selection:
 *
 *   1. If a FIELD rule exists → use that field's key + access list
 *      (field-level overrides everything for that field)
 *
 *   2. If no field rule but a RECORD rule exists → use the record's key + access list
 *      (record-level covers all fields in that record unless overridden by #1)
 *
 *   3. If neither field nor record rule → fall back to TABLE waterfall
 *      (table-level covers all records/fields unless overridden by #1 or #2)
 *
 * ACCESS INTERSECTION (the "crossing" question):
 *   When rules overlap, the user must satisfy ALL applicable levels:
 *
 *   - Table says Alice has access, Record says she doesn't → NO ACCESS to that record
 *   - Record says Bob has access, Field says he doesn't → NO ACCESS to that field
 *   - Field says Carol has access but Record says she doesn't → NO ACCESS
 *     (she can't read the record, so the field inside it is also inaccessible)
 *
 *   In other words: access is AND-gated across levels.
 *   You need access at every level from table down to the specific target.
 *
 *   Exception: a FIELD-level rule with explicit access BYPASSES the record check.
 *   This allows "Carol can see just the SSN field even though she can't see the
 *   rest of the record." The field rule explicitly includes her, so she gets
 *   a redacted record with only that field decrypted.
 *
 * ROLE INTERSECTION:
 *   When a user has different roles at different levels, the effective role
 *   for any operation is the MINIMUM across all applicable levels:
 *
 *   - Table: editor (PL 25), Record: admin (PL 50) → effective: editor (25)
 *   - Table: admin (PL 50), Field: viewer (PL 0) → effective: viewer (0)
 *
 *   This prevents privilege escalation: a record-level admin grant doesn't
 *   override a table-level viewer restriction.
 */

import type { EoDb } from '../db/level.js';
import { getState } from '../db/state.js';
import type { FieldAccessRole } from './field-access-control.js';
import { FIELD_ACCESS_POWER_LEVELS, powerLevelToFieldRole } from './field-access-control.js';
import { encryptionEventTypes } from '../config/matrix-domain.js';

// ─── Matrix Event Type ──────────────────────────────────────────────────────

/**
 * Matrix room state event type for encryption rules.
 * Published to the governance room. State key = data target path.
 *
 * Follows the same pattern as:
 *   - com.eo-db.key.announce (state_key = key_id) in key room
 *   - com.eo-db.space.config (state_key = '') in governance room
 *   - com.eo-db.schema.manifest (state_key = '') in main room
 */
export const ENCRYPTION_RULE_EVENT_TYPE = encryptionEventTypes().rule;

// ─── Matrix Client Interface (for publishing/syncing rules) ─────────────────

/** Minimal Matrix client interface for encryption rule management. */
export interface EncryptionRuleClient {
  /** Send a state event to a room. */
  sendStateEvent(roomId: string, eventType: string, content: any, stateKey: string): Promise<void>;
  /** Get all state events of a given type from a room. */
  getStateEvents(roomId: string, eventType: string): Promise<any[]>;
  /** Get own user ID. */
  getUserId(): string | null;
}

// ─── Publish / Sync (Matrix ↔ EO Log) ──────────────────────────────────────

/**
 * Publish an encryption rule to the governance room as a Matrix state event.
 * This is the authoritative action — the EO log DEF happens when sync picks it up.
 *
 * State key = the data target, so each target has exactly one rule state event
 * (updating the same state_key replaces the old rule, like key rotation).
 */
export async function publishEncryptionRule(
  client: EncryptionRuleClient,
  governanceRoomId: string,
  dataTarget: string,
  rule: EncryptionRule,
): Promise<void> {
  await client.sendStateEvent(
    governanceRoomId,
    ENCRYPTION_RULE_EVENT_TYPE,
    rule,
    dataTarget, // state_key = the data target path
  );
}

/**
 * Sync all encryption rules from the governance room into the local EO state.
 * Called on first login, new device setup, or manual resync.
 *
 * Reads all encryption.rule state events and returns them keyed by data target.
 * The caller is responsible for recording them into the EO log as DEFs.
 */
export async function syncEncryptionRules(
  client: EncryptionRuleClient,
  governanceRoomId: string,
): Promise<Map<string, EncryptionRule>> {
  const rules = new Map<string, EncryptionRule>();
  const stateEvents = await client.getStateEvents(governanceRoomId, ENCRYPTION_RULE_EVENT_TYPE);

  for (const event of stateEvents) {
    const content = (event.getContent ? event.getContent() : event.content ?? event) as any;
    const stateKey = (event.getStateKey ? event.getStateKey() : event.state_key ?? '') as string;

    if (!stateKey || !isEncryptionRule(content)) continue;

    rules.set(stateKey, content);
  }

  return rules;
}

// ─── Encryption Rule (source of truth: Matrix state event, materialized as DEF) ──

/** Scope of the encryption rule. */
export type EncryptionRuleScope = 'table' | 'record' | 'field';

/** A single user's access in an encryption rule. */
export interface EncryptionRuleAccessEntry {
  user_id: string;
  role: FieldAccessRole;
  power_level: number;
  granted_at: string;
  granted_by: string;
}

/**
 * Encryption rule — published as Matrix room state event, recorded locally as DEF.
 *
 * Source of truth: Matrix governance room state event
 *   Event type: com.eo-db.encryption.rule
 *   State key:  data target path
 *
 * Local materialization: DEF at {target}._encryption
 *   (written by sync when the Matrix event is received)
 *
 * Examples:
 *   Matrix state_key "app.tblClients"           → table rule
 *   Matrix state_key "app.tblClients.rec001"    → record rule
 *   Matrix state_key "app.tblClients.rec001.fldSSN" → field rule
 */
export interface EncryptionRule {
  /** What level this rule applies to */
  scope: EncryptionRuleScope;
  /** Whether encryption is active for this scope */
  enabled: boolean;
  /** The AES-256-GCM key ID */
  key_id: string;
  /** Algorithm */
  algorithm: 'aes-256-gcm';
  /** Key version (incremented on rotation) */
  key_version: number;
  /** Key room where this scope's keys are distributed */
  key_room_id: string;
  /** Who can access encrypted content at this level */
  access_list: EncryptionRuleAccessEntry[];
  /** Who created this rule */
  created_by: string;
  /** When */
  created_at: string;
  /** When last modified */
  updated_at: string;
  /** Who last modified */
  updated_by: string;
}

/** Type guard. */
export function isEncryptionRule(operand: any): operand is EncryptionRule {
  return (
    operand != null &&
    typeof operand === 'object' &&
    typeof operand.scope === 'string' &&
    typeof operand.key_id === 'string' &&
    Array.isArray(operand.access_list) &&
    typeof operand.enabled === 'boolean'
  );
}

// ─── Rule Storage Path ──────────────────────────────────────────────────────

/** Derive the _encryption target for a given data target. */
export function encryptionRuleTarget(dataTarget: string): string {
  return `${dataTarget}._encryption`;
}

/** Extract the data target from an _encryption rule target. */
export function dataTargetFromRule(ruleTarget: string): string {
  return ruleTarget.replace(/\._encryption$/, '');
}

// ─── Rule Read ──────────────────────────────────────────────────────────────

/** Read an encryption rule from state. Returns null if no rule exists. */
export async function getEncryptionRule(
  db: EoDb,
  dataTarget: string,
): Promise<EncryptionRule | null> {
  const state = await getState(db, encryptionRuleTarget(dataTarget));
  if (state?.value && isEncryptionRule(state.value)) {
    return state.value;
  }
  return null;
}

// ─── Resolved Access ────────────────────────────────────────────────────────

/** The resolved encryption access for a specific user at a specific target. */
export interface ResolvedEncryptionAccess {
  /** Whether the user can access the decrypted content */
  has_access: boolean;

  /** The effective role (minimum across all applicable levels) */
  effective_role: FieldAccessRole | null;

  /** The effective power level */
  effective_power_level: number;

  /** Which key to use for encrypt/decrypt */
  key_id: string | null;

  /** Key version */
  key_version: number;

  /** Which key room holds the key */
  key_room_id: string | null;

  /** Which rules were evaluated (for debugging / "why can't I see this?" UI) */
  evaluated_rules: EvaluatedRule[];

  /** If access denied, which rule blocked it */
  denied_by: EvaluatedRule | null;

  /** Can this user write (editor+)? */
  can_write: boolean;

  /** Can this user manage the access list (admin+)? */
  can_manage: boolean;
}

/** Debug info about a rule that was evaluated. */
export interface EvaluatedRule {
  /** The data target this rule is attached to */
  target: string;
  /** The scope level */
  scope: EncryptionRuleScope;
  /** Whether this rule grants access to the user */
  grants_access: boolean;
  /** The user's role at this level (null if not in access list) */
  role: FieldAccessRole | null;
  /** Power level at this level */
  power_level: number;
}

// ─── Resolution Logic ───────────────────────────────────────────────────────

/**
 * Resolve a user's effective encryption access for a target.
 *
 * Walks up from the target checking field → record → table rules.
 * Access is AND-gated: the user must be in the access list at every
 * level that has a rule, UNLESS a more specific rule explicitly includes them
 * (the field-level bypass for record restrictions).
 *
 * The most specific rule's key is used for encryption/decryption.
 */
export async function resolveEncryptionAccess(
  db: EoDb,
  target: string,
  userId: string,
): Promise<ResolvedEncryptionAccess> {
  const parts = target.split('.');
  const evaluatedRules: EvaluatedRule[] = [];

  // Collect rules at each level (field, record, table)
  // Target structure: app.table.record.field → 4 parts
  // We check from most specific to least specific

  let fieldRule: { rule: EncryptionRule; target: string } | null = null;
  let recordRule: { rule: EncryptionRule; target: string } | null = null;
  let tableRule: { rule: EncryptionRule; target: string } | null = null;

  // Determine what level this target is at
  // app.tbl = 2 parts (table)
  // app.tbl.rec = 3 parts (record)
  // app.tbl.rec.fld = 4 parts (field)

  // Check for rules at each ancestor level
  for (let depth = parts.length; depth >= 2; depth--) {
    const candidate = parts.slice(0, depth).join('.');
    const rule = await getEncryptionRule(db, candidate);

    if (rule && rule.enabled) {
      const evaluated = evaluateRule(rule, candidate, userId);
      evaluatedRules.push(evaluated);

      if (rule.scope === 'field' || depth === parts.length && parts.length >= 4) {
        fieldRule = { rule, target: candidate };
      } else if (rule.scope === 'record' || depth === parts.length && parts.length === 3) {
        recordRule = { rule, target: candidate };
      } else if (rule.scope === 'table') {
        tableRule = { rule, target: candidate };
      }
    }
  }

  // No rules at all → plaintext, full access
  if (evaluatedRules.length === 0) {
    return {
      has_access: true,
      effective_role: null,
      effective_power_level: Infinity,
      key_id: null,
      key_version: 0,
      key_room_id: null,
      evaluated_rules: [],
      denied_by: null,
      can_write: true,
      can_manage: true,
    };
  }

  // ─── Apply Crossing Rules ───────────────────────────────────────────────

  // Most specific rule provides the key
  const keySource = fieldRule ?? recordRule ?? tableRule;
  const key_id = keySource?.rule.key_id ?? null;
  const key_version = keySource?.rule.key_version ?? 0;
  const key_room_id = keySource?.rule.key_room_id ?? null;

  // AND-gate access across all levels, with field-level bypass
  let minPowerLevel = Infinity;
  let denied: EvaluatedRule | null = null;

  for (const evaluated of evaluatedRules) {
    if (!evaluated.grants_access) {
      // Field-level bypass: if a field rule explicitly includes the user,
      // they can see that field even if a record rule excludes them.
      // But table-level denial is always binding.
      if (evaluated.scope === 'record' && fieldRule) {
        const fieldEval = evaluatedRules.find(e => e.scope === 'field');
        if (fieldEval?.grants_access) {
          // Bypass record denial — field rule explicitly includes user
          continue;
        }
      }

      denied = evaluated;
      break;
    }

    // Track minimum power level for role intersection
    if (evaluated.power_level < minPowerLevel) {
      minPowerLevel = evaluated.power_level;
    }
  }

  if (denied) {
    return {
      has_access: false,
      effective_role: null,
      effective_power_level: 0,
      key_id,
      key_version,
      key_room_id,
      evaluated_rules: evaluatedRules,
      denied_by: denied,
      can_write: false,
      can_manage: false,
    };
  }

  // Access granted — effective role is the minimum across all levels
  const effectivePL = minPowerLevel === Infinity ? 0 : minPowerLevel;
  const effectiveRole = powerLevelToFieldRole(effectivePL);

  return {
    has_access: true,
    effective_role: effectiveRole,
    effective_power_level: effectivePL,
    key_id,
    key_version,
    key_room_id,
    evaluated_rules: evaluatedRules,
    denied_by: null,
    can_write: effectivePL >= FIELD_ACCESS_POWER_LEVELS.editor,
    can_manage: effectivePL >= FIELD_ACCESS_POWER_LEVELS.admin,
  };
}

/** Evaluate a single rule for a user. */
function evaluateRule(
  rule: EncryptionRule,
  target: string,
  userId: string,
): EvaluatedRule {
  const entry = rule.access_list.find(e => e.user_id === userId);

  return {
    target,
    scope: rule.scope,
    grants_access: entry != null,
    role: entry?.role ?? null,
    power_level: entry?.power_level ?? 0,
  };
}

// ─── Access List Mutations (for DEF operands) ───────────────────────────────

/** Add a user to an encryption rule's access list. */
export function addRuleAccess(
  rule: EncryptionRule,
  userId: string,
  role: FieldAccessRole,
  grantedBy: string,
): EncryptionRule {
  const existing = rule.access_list.find(e => e.user_id === userId);
  const now = new Date().toISOString();

  if (existing) {
    return {
      ...rule,
      access_list: rule.access_list.map(e =>
        e.user_id === userId
          ? { ...e, role, power_level: FIELD_ACCESS_POWER_LEVELS[role] }
          : e
      ),
      updated_at: now,
      updated_by: grantedBy,
    };
  }

  return {
    ...rule,
    access_list: [
      ...rule.access_list,
      {
        user_id: userId,
        role,
        power_level: FIELD_ACCESS_POWER_LEVELS[role],
        granted_at: now,
        granted_by: grantedBy,
      },
    ],
    updated_at: now,
    updated_by: grantedBy,
  };
}

/** Remove a user from an encryption rule's access list. Bumps key_version. */
export function removeRuleAccess(
  rule: EncryptionRule,
  userId: string,
  newKeyId: string,
  actor: string,
): EncryptionRule {
  const now = new Date().toISOString();
  return {
    ...rule,
    access_list: rule.access_list.filter(e => e.user_id !== userId),
    key_id: newKeyId,
    key_version: rule.key_version + 1,
    updated_at: now,
    updated_by: actor,
  };
}

/** Change a user's role in an encryption rule. */
export function changeRuleAccessRole(
  rule: EncryptionRule,
  userId: string,
  newRole: FieldAccessRole,
  actor: string,
): EncryptionRule | null {
  if (!rule.access_list.some(e => e.user_id === userId)) return null;

  const now = new Date().toISOString();
  return {
    ...rule,
    access_list: rule.access_list.map(e =>
      e.user_id === userId
        ? { ...e, role: newRole, power_level: FIELD_ACCESS_POWER_LEVELS[newRole] }
        : e
    ),
    updated_at: now,
    updated_by: actor,
  };
}

// ─── "Who Has Access" View ──────────────────────────────────────────────────

/** Summary for the access management screen. */
export interface EncryptionAccessSummary {
  /** The data target this rule covers */
  target: string;
  /** Scope level */
  scope: EncryptionRuleScope;
  /** Users with access */
  users: Array<{
    user_id: string;
    role: FieldAccessRole;
    power_level: number;
    granted_at: string;
    granted_by: string;
    can_remove: boolean;
    can_change_role: boolean;
  }>;
  /** Current key info */
  key_id: string;
  key_version: number;
  key_room_id: string;
}

/** Build the "who has access" view for an encryption rule. */
export function buildRuleAccessView(
  rule: EncryptionRule,
  ruleTarget: string,
  viewerUserId: string,
): EncryptionAccessSummary {
  const viewer = rule.access_list.find(e => e.user_id === viewerUserId);
  const viewerPL = viewer?.power_level ?? -1;

  return {
    target: ruleTarget,
    scope: rule.scope,
    users: rule.access_list.map(entry => ({
      user_id: entry.user_id,
      role: entry.role,
      power_level: entry.power_level,
      granted_at: entry.granted_at,
      granted_by: entry.granted_by,
      can_remove: viewerPL >= FIELD_ACCESS_POWER_LEVELS.admin && entry.power_level < viewerPL,
      can_change_role: viewerPL >= FIELD_ACCESS_POWER_LEVELS.admin && entry.power_level < viewerPL,
    })),
    key_id: rule.key_id,
    key_version: rule.key_version,
    key_room_id: rule.key_room_id,
  };
}

/**
 * Build a combined access view showing rules at all levels for a target.
 * This is for the "why can/can't I see this?" diagnostic UI.
 */
export async function buildFullAccessView(
  db: EoDb,
  target: string,
  viewerUserId: string,
): Promise<EncryptionAccessSummary[]> {
  const parts = target.split('.');
  const views: EncryptionAccessSummary[] = [];

  for (let depth = parts.length; depth >= 2; depth--) {
    const candidate = parts.slice(0, depth).join('.');
    const rule = await getEncryptionRule(db, candidate);
    if (rule && rule.enabled) {
      views.push(buildRuleAccessView(rule, candidate, viewerUserId));
    }
  }

  return views;
}
