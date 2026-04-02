import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import { processEvent } from '../src/db/fold.js';
import type { EoEventInput } from '../src/db/types.js';
import {
  type EncryptionRule,
  type EncryptionRuleAccessEntry,
  type EncryptionRuleClient,
  isEncryptionRule,
  encryptionRuleTarget,
  dataTargetFromRule,
  getEncryptionRule,
  resolveEncryptionAccess,
  addRuleAccess,
  removeRuleAccess,
  changeRuleAccessRole,
  buildRuleAccessView,
  buildFullAccessView,
  publishEncryptionRule,
  syncEncryptionRules,
  ENCRYPTION_RULE_EVENT_TYPE,
} from '../src/crypto/encryption-access-resolver.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

const ALICE = '@alice:matrix.example.com'; // owner everywhere
const BOB = '@bob:matrix.example.com';     // admin on table, editor on record
const CAROL = '@carol:matrix.example.com'; // editor on table, no record access
const DAVE = '@dave:matrix.example.com';   // viewer on table, admin on specific field
const EVE = '@eve:matrix.example.com';     // no access anywhere
const TS = '2025-06-01T00:00:00.000Z';

function ev(overrides: Partial<EoEventInput>): EoEventInput {
  return {
    op: 'INS',
    target: 'app.tblClients',
    operand: {},
    agent: ALICE,
    ts: TS,
    acquired_ts: TS,
    ...overrides,
  };
}

function makeRule(scope: 'table' | 'record' | 'field', access: EncryptionRuleAccessEntry[]): EncryptionRule {
  return {
    scope,
    enabled: true,
    key_id: `key-${scope}`,
    algorithm: 'aes-256-gcm',
    key_version: 1,
    key_room_id: `!${scope}-keys:matrix.example.com`,
    access_list: access,
    created_by: ALICE,
    created_at: TS,
    updated_at: TS,
    updated_by: ALICE,
  };
}

function entry(userId: string, role: 'owner' | 'admin' | 'editor' | 'viewer'): EncryptionRuleAccessEntry {
  const plMap = { owner: 100, admin: 50, editor: 25, viewer: 0 };
  return {
    user_id: userId,
    role,
    power_level: plMap[role],
    granted_at: TS,
    granted_by: ALICE,
  };
}

/** Store an encryption rule as a DEF on {target}._encryption */
async function storeRule(target: string, rule: EncryptionRule): Promise<void> {
  const ruleTarget = encryptionRuleTarget(target);
  // Ensure parent hierarchy exists
  const parts = ruleTarget.split('.');
  for (let i = 2; i <= parts.length; i++) {
    const ancestor = parts.slice(0, i).join('.');
    try {
      await processEvent(db, ev({ op: 'INS', target: ancestor, operand: {} }));
    } catch {
      // Already exists — fine
    }
  }
  await processEvent(db, ev({ op: 'DEF', target: ruleTarget, operand: rule }));
}

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-enc-resolver-'));
  db = createDb(dbPath);
  await db.open();

  // Set up basic target hierarchy
  await processEvent(db, ev({ op: 'INS', target: 'app' }));
  await processEvent(db, ev({ op: 'INS', target: 'app.tblClients' }));
  await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001' }));
  await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001.fldSSN' }));
  await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec001.fldName' }));
  await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec002' }));
  await processEvent(db, ev({ op: 'INS', target: 'app.tblClients.rec002.fldSSN' }));
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

// ─── Rule Target Helpers ────────────────────────────────────────────────────

describe('rule target helpers', () => {
  it('encryptionRuleTarget appends _encryption', () => {
    expect(encryptionRuleTarget('app.tblClients')).toBe('app.tblClients._encryption');
    expect(encryptionRuleTarget('app.tblClients.rec001')).toBe('app.tblClients.rec001._encryption');
    expect(encryptionRuleTarget('app.tblClients.rec001.fldSSN')).toBe('app.tblClients.rec001.fldSSN._encryption');
  });

  it('dataTargetFromRule strips _encryption', () => {
    expect(dataTargetFromRule('app.tblClients._encryption')).toBe('app.tblClients');
    expect(dataTargetFromRule('app.tblClients.rec001._encryption')).toBe('app.tblClients.rec001');
  });
});

// ─── Rule Storage as DEF ────────────────────────────────────────────────────

describe('encryption rules stored as DEFs', () => {
  it('stores and retrieves a table-level rule via DEF', async () => {
    const rule = makeRule('table', [entry(ALICE, 'owner'), entry(BOB, 'admin')]);
    await storeRule('app.tblClients', rule);

    const retrieved = await getEncryptionRule(db, 'app.tblClients');
    expect(retrieved).not.toBeNull();
    expect(isEncryptionRule(retrieved)).toBe(true);
    expect(retrieved!.scope).toBe('table');
    expect(retrieved!.access_list).toHaveLength(2);
  });

  it('stores a record-level rule via DEF', async () => {
    const rule = makeRule('record', [entry(ALICE, 'owner'), entry(BOB, 'editor')]);
    await storeRule('app.tblClients.rec001', rule);

    const retrieved = await getEncryptionRule(db, 'app.tblClients.rec001');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.scope).toBe('record');
  });

  it('stores a field-level rule via DEF', async () => {
    const rule = makeRule('field', [entry(ALICE, 'owner'), entry(DAVE, 'admin')]);
    await storeRule('app.tblClients.rec001.fldSSN', rule);

    const retrieved = await getEncryptionRule(db, 'app.tblClients.rec001.fldSSN');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.scope).toBe('field');
  });

  it('returns null when no rule exists', async () => {
    const result = await getEncryptionRule(db, 'app.tblClients.rec002');
    expect(result).toBeNull();
  });

  it('DEF merges update the rule (new DEF overwrites)', async () => {
    const rule1 = makeRule('table', [entry(ALICE, 'owner')]);
    await storeRule('app.tblClients', rule1);

    // Update the rule with a new DEF
    const rule2 = addRuleAccess(rule1, BOB, 'admin', ALICE);
    await processEvent(db, ev({
      op: 'DEF',
      target: encryptionRuleTarget('app.tblClients'),
      operand: rule2,
    }));

    const retrieved = await getEncryptionRule(db, 'app.tblClients');
    expect(retrieved!.access_list).toHaveLength(2);
  });
});

// ─── Permission Crossing: Single Level ──────────────────────────────────────

describe('single-level access resolution', () => {
  it('grants access when user is in table access list', async () => {
    await storeRule('app.tblClients', makeRule('table', [
      entry(ALICE, 'owner'),
      entry(BOB, 'editor'),
    ]));

    const access = await resolveEncryptionAccess(db, 'app.tblClients.rec001.fldSSN', BOB);
    expect(access.has_access).toBe(true);
    expect(access.effective_role).toBe('editor');
    expect(access.can_write).toBe(true);
    expect(access.can_manage).toBe(false);
    expect(access.key_id).toBe('key-table');
  });

  it('denies access when user is not in table access list', async () => {
    await storeRule('app.tblClients', makeRule('table', [
      entry(ALICE, 'owner'),
    ]));

    const access = await resolveEncryptionAccess(db, 'app.tblClients.rec001.fldSSN', EVE);
    expect(access.has_access).toBe(false);
    expect(access.denied_by).not.toBeNull();
    expect(access.denied_by!.scope).toBe('table');
  });

  it('grants full access when no encryption rules exist', async () => {
    const access = await resolveEncryptionAccess(db, 'app.tblClients.rec001.fldSSN', EVE);
    expect(access.has_access).toBe(true);
    expect(access.key_id).toBeNull(); // plaintext
  });
});

// ─── Permission Crossing: Two Levels ────────────────────────────────────────

describe('two-level permission crossing', () => {
  it('table YES + record YES → YES (minimum role)', async () => {
    await storeRule('app.tblClients', makeRule('table', [
      entry(ALICE, 'owner'),
      entry(BOB, 'admin'),    // admin at table
    ]));
    await storeRule('app.tblClients.rec001', makeRule('record', [
      entry(ALICE, 'owner'),
      entry(BOB, 'editor'),   // editor at record
    ]));

    const access = await resolveEncryptionAccess(db, 'app.tblClients.rec001.fldSSN', BOB);
    expect(access.has_access).toBe(true);
    // Effective role = min(admin=50, editor=25) = editor
    expect(access.effective_role).toBe('editor');
    expect(access.effective_power_level).toBe(25);
    // Most specific rule provides the key
    expect(access.key_id).toBe('key-record');
  });

  it('table YES + record NO → NO (AND gate)', async () => {
    await storeRule('app.tblClients', makeRule('table', [
      entry(ALICE, 'owner'),
      entry(CAROL, 'editor'),  // Carol has table access
    ]));
    await storeRule('app.tblClients.rec001', makeRule('record', [
      entry(ALICE, 'owner'),
      // Carol NOT in record access list
    ]));

    const access = await resolveEncryptionAccess(db, 'app.tblClients.rec001.fldSSN', CAROL);
    expect(access.has_access).toBe(false);
    expect(access.denied_by!.scope).toBe('record');
  });

  it('table NO + record YES → NO (table denial is binding)', async () => {
    await storeRule('app.tblClients', makeRule('table', [
      entry(ALICE, 'owner'),
      // EVE not in table access list
    ]));
    await storeRule('app.tblClients.rec001', makeRule('record', [
      entry(ALICE, 'owner'),
      entry(EVE, 'editor'),  // Eve has record access but not table
    ]));

    const access = await resolveEncryptionAccess(db, 'app.tblClients.rec001.fldSSN', EVE);
    expect(access.has_access).toBe(false);
    expect(access.denied_by!.scope).toBe('table');
  });
});

// ─── Permission Crossing: Three Levels ──────────────────────────────────────

describe('three-level permission crossing', () => {
  it('table YES + record YES + field YES → YES (min role)', async () => {
    await storeRule('app.tblClients', makeRule('table', [
      entry(ALICE, 'owner'),
      entry(BOB, 'admin'),
    ]));
    await storeRule('app.tblClients.rec001', makeRule('record', [
      entry(ALICE, 'owner'),
      entry(BOB, 'editor'),
    ]));
    await storeRule('app.tblClients.rec001.fldSSN', makeRule('field', [
      entry(ALICE, 'owner'),
      entry(BOB, 'viewer'),
    ]));

    const access = await resolveEncryptionAccess(db, 'app.tblClients.rec001.fldSSN', BOB);
    expect(access.has_access).toBe(true);
    // min(admin=50, editor=25, viewer=0) = viewer
    expect(access.effective_role).toBe('viewer');
    expect(access.can_write).toBe(false);
    // Field rule provides the key
    expect(access.key_id).toBe('key-field');
  });

  it('table YES + record NO + field YES → YES (field bypass)', async () => {
    // The key crossing case: Carol can't see the record, but CAN see the SSN field
    // because the field rule explicitly includes her.
    await storeRule('app.tblClients', makeRule('table', [
      entry(ALICE, 'owner'),
      entry(CAROL, 'editor'),  // Table access
    ]));
    await storeRule('app.tblClients.rec001', makeRule('record', [
      entry(ALICE, 'owner'),
      // Carol NOT in record list
    ]));
    await storeRule('app.tblClients.rec001.fldSSN', makeRule('field', [
      entry(ALICE, 'owner'),
      entry(CAROL, 'viewer'),  // Explicitly granted field access
    ]));

    const access = await resolveEncryptionAccess(db, 'app.tblClients.rec001.fldSSN', CAROL);
    expect(access.has_access).toBe(true);
    // Field bypass: record denial is overridden by explicit field grant
    expect(access.effective_role).toBe('viewer');
    expect(access.key_id).toBe('key-field');
  });

  it('table NO + record YES + field YES → NO (table denial always binding)', async () => {
    await storeRule('app.tblClients', makeRule('table', [
      entry(ALICE, 'owner'),
      // EVE not in table
    ]));
    await storeRule('app.tblClients.rec001', makeRule('record', [
      entry(ALICE, 'owner'),
      entry(EVE, 'editor'),
    ]));
    await storeRule('app.tblClients.rec001.fldSSN', makeRule('field', [
      entry(ALICE, 'owner'),
      entry(EVE, 'admin'),
    ]));

    const access = await resolveEncryptionAccess(db, 'app.tblClients.rec001.fldSSN', EVE);
    expect(access.has_access).toBe(false);
    // Table denial is ALWAYS binding — no bypass
    expect(access.denied_by!.scope).toBe('table');
  });
});

// ─── Record-Level Only ──────────────────────────────────────────────────────

describe('record-level encryption (no table rule)', () => {
  it('encrypts a specific record while others stay plaintext', async () => {
    // Only rec001 is encrypted, rec002 is not
    await storeRule('app.tblClients.rec001', makeRule('record', [
      entry(ALICE, 'owner'),
      entry(BOB, 'editor'),
    ]));

    // rec001 field: Bob has access via record rule
    const access1 = await resolveEncryptionAccess(db, 'app.tblClients.rec001.fldSSN', BOB);
    expect(access1.has_access).toBe(true);
    expect(access1.key_id).toBe('key-record');

    // rec002 field: no rules, plaintext
    const access2 = await resolveEncryptionAccess(db, 'app.tblClients.rec002.fldSSN', BOB);
    expect(access2.has_access).toBe(true);
    expect(access2.key_id).toBeNull();

    // Eve can't access rec001 but can access rec002 (no rules)
    const eveAccess1 = await resolveEncryptionAccess(db, 'app.tblClients.rec001.fldSSN', EVE);
    expect(eveAccess1.has_access).toBe(false);

    const eveAccess2 = await resolveEncryptionAccess(db, 'app.tblClients.rec002.fldSSN', EVE);
    expect(eveAccess2.has_access).toBe(true);
  });
});

// ─── Role Intersection ──────────────────────────────────────────────────────

describe('role intersection across levels', () => {
  it('effective role is minimum power level across all levels', async () => {
    await storeRule('app.tblClients', makeRule('table', [
      entry(ALICE, 'owner'),
      entry(BOB, 'admin'),    // PL 50
    ]));
    await storeRule('app.tblClients.rec001', makeRule('record', [
      entry(ALICE, 'owner'),
      entry(BOB, 'viewer'),   // PL 0
    ]));

    const access = await resolveEncryptionAccess(db, 'app.tblClients.rec001.fldSSN', BOB);
    expect(access.has_access).toBe(true);
    // min(50, 0) = 0 → viewer
    expect(access.effective_role).toBe('viewer');
    expect(access.can_write).toBe(false);
    expect(access.can_manage).toBe(false);
  });

  it('single-level role is preserved when no other levels exist', async () => {
    await storeRule('app.tblClients.rec001', makeRule('record', [
      entry(ALICE, 'owner'),
      entry(BOB, 'admin'),
    ]));

    const access = await resolveEncryptionAccess(db, 'app.tblClients.rec001.fldSSN', BOB);
    expect(access.effective_role).toBe('admin');
    expect(access.can_write).toBe(true);
    expect(access.can_manage).toBe(true);
  });
});

// ─── Rule Mutations ─────────────────────────────────────────────────────────

describe('rule mutations', () => {
  it('addRuleAccess adds a user', () => {
    const rule = makeRule('table', [entry(ALICE, 'owner')]);
    const updated = addRuleAccess(rule, BOB, 'editor', ALICE);
    expect(updated.access_list).toHaveLength(2);
    expect(updated.access_list[1].user_id).toBe(BOB);
    expect(updated.access_list[1].role).toBe('editor');
  });

  it('addRuleAccess updates existing user role', () => {
    const rule = makeRule('table', [entry(ALICE, 'owner'), entry(BOB, 'viewer')]);
    const updated = addRuleAccess(rule, BOB, 'admin', ALICE);
    expect(updated.access_list).toHaveLength(2);
    expect(updated.access_list.find(e => e.user_id === BOB)!.role).toBe('admin');
  });

  it('removeRuleAccess removes user and rotates key', () => {
    const rule = makeRule('table', [entry(ALICE, 'owner'), entry(BOB, 'editor')]);
    const updated = removeRuleAccess(rule, BOB, 'new-key-id', ALICE);
    expect(updated.access_list).toHaveLength(1);
    expect(updated.key_id).toBe('new-key-id');
    expect(updated.key_version).toBe(2);
  });

  it('changeRuleAccessRole changes role', () => {
    const rule = makeRule('table', [entry(ALICE, 'owner'), entry(BOB, 'editor')]);
    const updated = changeRuleAccessRole(rule, BOB, 'admin', ALICE);
    expect(updated).not.toBeNull();
    expect(updated!.access_list.find(e => e.user_id === BOB)!.role).toBe('admin');
  });

  it('changeRuleAccessRole returns null for nonexistent user', () => {
    const rule = makeRule('table', [entry(ALICE, 'owner')]);
    expect(changeRuleAccessRole(rule, EVE, 'viewer', ALICE)).toBeNull();
  });
});

// ─── Access View ────────────────────────────────────────────────────────────

describe('access management views', () => {
  it('buildRuleAccessView shows mutation capabilities', () => {
    const rule = makeRule('table', [
      entry(ALICE, 'owner'),
      entry(BOB, 'admin'),
      entry(CAROL, 'editor'),
    ]);

    const view = buildRuleAccessView(rule, 'app.tblClients', ALICE);
    expect(view.users).toHaveLength(3);

    const bobView = view.users.find(u => u.user_id === BOB)!;
    expect(bobView.can_remove).toBe(true);
    expect(bobView.can_change_role).toBe(true);

    const carolView = view.users.find(u => u.user_id === CAROL)!;
    expect(carolView.can_remove).toBe(true);

    // Alice can't remove herself
    const aliceView = view.users.find(u => u.user_id === ALICE)!;
    expect(aliceView.can_remove).toBe(false);
  });

  it('buildFullAccessView shows rules at all levels', async () => {
    await storeRule('app.tblClients', makeRule('table', [entry(ALICE, 'owner')]));
    await storeRule('app.tblClients.rec001', makeRule('record', [entry(ALICE, 'owner')]));
    await storeRule('app.tblClients.rec001.fldSSN', makeRule('field', [entry(ALICE, 'owner')]));

    const views = await buildFullAccessView(db, 'app.tblClients.rec001.fldSSN', ALICE);
    expect(views).toHaveLength(3);
    expect(views.map(v => v.scope)).toEqual(
      expect.arrayContaining(['field', 'record', 'table'])
    );
  });

  it('buildFullAccessView only shows existing rules', async () => {
    await storeRule('app.tblClients', makeRule('table', [entry(ALICE, 'owner')]));
    // No record or field rules

    const views = await buildFullAccessView(db, 'app.tblClients.rec001.fldSSN', ALICE);
    expect(views).toHaveLength(1);
    expect(views[0].scope).toBe('table');
  });
});

// ─── Evaluated Rules (debug info) ───────────────────────────────────────────

describe('evaluated rules for debugging', () => {
  it('shows which rules were evaluated and what they decided', async () => {
    await storeRule('app.tblClients', makeRule('table', [
      entry(ALICE, 'owner'),
      entry(BOB, 'admin'),
    ]));
    await storeRule('app.tblClients.rec001', makeRule('record', [
      entry(ALICE, 'owner'),
      // Bob not in record
    ]));

    const access = await resolveEncryptionAccess(db, 'app.tblClients.rec001.fldSSN', BOB);
    expect(access.has_access).toBe(false);
    expect(access.evaluated_rules).toHaveLength(2);

    const tableEval = access.evaluated_rules.find(r => r.scope === 'table')!;
    expect(tableEval.grants_access).toBe(true);
    expect(tableEval.role).toBe('admin');

    const recordEval = access.evaluated_rules.find(r => r.scope === 'record')!;
    expect(recordEval.grants_access).toBe(false);
    expect(recordEval.role).toBeNull();

    expect(access.denied_by!.scope).toBe('record');
  });
});

// ─── Matrix Event Flow (source of truth) ────────────────────────────────────

describe('Matrix event flow', () => {
  /** Mock Matrix client that stores state events in memory. */
  function mockClient(): EncryptionRuleClient & { _state: Map<string, Map<string, any>> } {
    const _state = new Map<string, Map<string, any>>();
    return {
      _state,
      getUserId: () => ALICE,
      async sendStateEvent(roomId: string, eventType: string, content: any, stateKey: string) {
        const roomState = _state.get(roomId) ?? new Map();
        roomState.set(`${eventType}:${stateKey}`, { content, state_key: stateKey });
        _state.set(roomId, roomState);
      },
      async getStateEvents(roomId: string, eventType: string) {
        const roomState = _state.get(roomId) ?? new Map();
        const events: any[] = [];
        for (const [key, event] of roomState) {
          if (key.startsWith(`${eventType}:`)) {
            events.push(event);
          }
        }
        return events;
      },
    };
  }

  it('publishes encryption rule as Matrix state event with target as state_key', async () => {
    const client = mockClient();
    const govRoom = '!governance:matrix.example.com';
    const rule = makeRule('record', [entry(ALICE, 'owner'), entry(BOB, 'editor')]);

    await publishEncryptionRule(client, govRoom, 'app.tblClients.rec001', rule);

    // Verify it was stored with the data target as state_key
    const roomState = client._state.get(govRoom)!;
    const stateEvent = roomState.get(`${ENCRYPTION_RULE_EVENT_TYPE}:app.tblClients.rec001`);
    expect(stateEvent).toBeDefined();
    expect(stateEvent.state_key).toBe('app.tblClients.rec001');
    expect(stateEvent.content.scope).toBe('record');
    expect(stateEvent.content.access_list).toHaveLength(2);
  });

  it('syncEncryptionRules rebuilds all rules from governance room state', async () => {
    const client = mockClient();
    const govRoom = '!governance:matrix.example.com';

    // Publish rules at different levels
    await publishEncryptionRule(client, govRoom, 'app.tblClients',
      makeRule('table', [entry(ALICE, 'owner')]));
    await publishEncryptionRule(client, govRoom, 'app.tblClients.rec001',
      makeRule('record', [entry(ALICE, 'owner'), entry(BOB, 'editor')]));
    await publishEncryptionRule(client, govRoom, 'app.tblClients.rec001.fldSSN',
      makeRule('field', [entry(ALICE, 'owner'), entry(DAVE, 'viewer')]));

    // Sync — as if a new device is recovering
    const rules = await syncEncryptionRules(client, govRoom);

    expect(rules.size).toBe(3);
    expect(rules.get('app.tblClients')!.scope).toBe('table');
    expect(rules.get('app.tblClients.rec001')!.scope).toBe('record');
    expect(rules.get('app.tblClients.rec001.fldSSN')!.scope).toBe('field');
    expect(rules.get('app.tblClients.rec001')!.access_list).toHaveLength(2);
  });

  it('updating a rule replaces the state event (same state_key)', async () => {
    const client = mockClient();
    const govRoom = '!governance:matrix.example.com';

    // Initial rule: just Alice
    await publishEncryptionRule(client, govRoom, 'app.tblClients',
      makeRule('table', [entry(ALICE, 'owner')]));

    // Update: add Bob
    const updated = addRuleAccess(
      makeRule('table', [entry(ALICE, 'owner')]),
      BOB, 'admin', ALICE,
    );
    await publishEncryptionRule(client, govRoom, 'app.tblClients', updated);

    // Sync should show the updated version
    const rules = await syncEncryptionRules(client, govRoom);
    expect(rules.size).toBe(1); // Same state_key, so only one entry
    expect(rules.get('app.tblClients')!.access_list).toHaveLength(2);
  });

  it('ENCRYPTION_RULE_EVENT_TYPE follows com.eo-db namespace', () => {
    expect(ENCRYPTION_RULE_EVENT_TYPE).toBe('com.eo-db.encryption.rule');
  });
});
