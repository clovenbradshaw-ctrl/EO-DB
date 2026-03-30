import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import { resolveAlias, checkExists } from '../src/db/helpers.js';
import { setState } from '../src/db/state.js';
import type { EoState } from '../src/db/types.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

function makeState(target: string, value: any = {}): EoState {
  return {
    target,
    value,
    last_seq: 1,
    last_op: 'INS',
    last_agent: '@test:example.com',
    last_ts: '2025-06-01T00:00:00.000Z',
    last_acquired_ts: '2025-06-01T00:00:00.000Z',
  };
}

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-test-'));
  db = createDb(dbPath);
  await db.open();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

describe('resolveAlias', () => {
  it('returns the same target when no alias exists', async () => {
    await setState(db, makeState('A', { name: 'Alice' }));
    expect(await resolveAlias(db, 'A')).toBe('A');
  });

  it('returns the same target for non-existent entity', async () => {
    expect(await resolveAlias(db, 'nonexistent')).toBe('nonexistent');
  });

  it('follows a single alias A → B', async () => {
    await setState(db, makeState('A', { _alias: 'B' }));
    await setState(db, makeState('B', { name: 'Canonical' }));
    expect(await resolveAlias(db, 'A')).toBe('B');
  });

  it('follows a transitive chain A → B → C', async () => {
    await setState(db, makeState('A', { _alias: 'B' }));
    await setState(db, makeState('B', { _alias: 'C' }));
    await setState(db, makeState('C', { name: 'Final' }));
    expect(await resolveAlias(db, 'A')).toBe('C');
  });

  it('stops at max depth (10) for circular aliases', async () => {
    await setState(db, makeState('A', { _alias: 'B' }));
    await setState(db, makeState('B', { _alias: 'A' }));
    // After 10 iterations, should return whichever it's on
    const result = await resolveAlias(db, 'A');
    // With circular A→B→A→B... after 10 steps: even=A, odd=B
    expect(['A', 'B']).toContain(result);
  });

  it('handles alias pointing to non-existent target', async () => {
    await setState(db, makeState('A', { _alias: 'deleted-target' }));
    // deleted-target has no state, so no _alias — returns it
    expect(await resolveAlias(db, 'A')).toBe('deleted-target');
  });
});

describe('checkExists', () => {
  it('returns state for existing target', async () => {
    const state = makeState('app.tbl.rec001', { name: 'Maria' });
    await setState(db, state);
    const result = await checkExists(db, 'app.tbl.rec001');
    expect(result).not.toBeNull();
    expect(result?.value).toEqual({ name: 'Maria' });
  });

  it('returns null for non-existent target', async () => {
    const result = await checkExists(db, 'nonexistent');
    expect(result).toBeNull();
  });
});
