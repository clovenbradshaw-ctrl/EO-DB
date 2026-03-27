import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import { addEdge, removeEdge, getEdgesFrom, getEdgesTo, traverse } from '../src/db/graph.js';
import type { GraphEdge } from '../src/db/types.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: EoDb;
let dbPath: string;

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-db-test-'));
  db = createDb(dbPath);
  await db.open();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

describe('addEdge', () => {
  it('creates both forward and reverse entries', async () => {
    await addEdge(db, { source: 'A', dest: 'B', seq: 1 });
    const fwd = await getEdgesFrom(db, 'A');
    const rev = await getEdgesTo(db, 'B');
    expect(fwd).toHaveLength(1);
    expect(rev).toHaveLength(1);
    expect(fwd[0].source).toBe('A');
    expect(fwd[0].dest).toBe('B');
    expect(rev[0].source).toBe('A');
    expect(rev[0].dest).toBe('B');
  });
});

describe('getEdgesFrom', () => {
  it('returns outgoing edges', async () => {
    await addEdge(db, { source: 'A', dest: 'B', seq: 1 });
    await addEdge(db, { source: 'A', dest: 'C', seq: 2 });
    await addEdge(db, { source: 'X', dest: 'Y', seq: 3 });
    const edges = await getEdgesFrom(db, 'A');
    expect(edges).toHaveLength(2);
    expect(edges.map(e => e.dest).sort()).toEqual(['B', 'C']);
  });

  it('returns multiple edges from same source', async () => {
    await addEdge(db, { source: 'node.1', dest: 'node.2', seq: 1 });
    await addEdge(db, { source: 'node.1', dest: 'node.3', seq: 2 });
    await addEdge(db, { source: 'node.1', dest: 'node.4', seq: 3 });
    const edges = await getEdgesFrom(db, 'node.1');
    expect(edges).toHaveLength(3);
  });
});

describe('getEdgesTo', () => {
  it('returns incoming edges', async () => {
    await addEdge(db, { source: 'A', dest: 'C', seq: 1 });
    await addEdge(db, { source: 'B', dest: 'C', seq: 2 });
    const edges = await getEdgesTo(db, 'C');
    expect(edges).toHaveLength(2);
    expect(edges.map(e => e.source).sort()).toEqual(['A', 'B']);
  });
});

describe('removeEdge', () => {
  it('removes both forward and reverse entries', async () => {
    await addEdge(db, { source: 'A', dest: 'B', seq: 1 });
    await removeEdge(db, 'A', 'B');
    const fwd = await getEdgesFrom(db, 'A');
    const rev = await getEdgesTo(db, 'B');
    expect(fwd).toHaveLength(0);
    expect(rev).toHaveLength(0);
  });

  it('does not error when removing nonexistent edge', async () => {
    await expect(removeEdge(db, 'X', 'Y')).resolves.not.toThrow();
  });
});

describe('traverse', () => {
  beforeEach(async () => {
    // A -> B -> C -> D
    //      B -> E
    await addEdge(db, { source: 'A', dest: 'B', seq: 1 });
    await addEdge(db, { source: 'B', dest: 'C', seq: 2 });
    await addEdge(db, { source: 'B', dest: 'E', seq: 3 });
    await addEdge(db, { source: 'C', dest: 'D', seq: 4 });
  });

  it('depth=1 returns direct connections', async () => {
    const result = await traverse(db, 'A', 1);
    expect(result.targets.sort()).toEqual(['A', 'B']);
    expect(result.edges).toHaveLength(1);
  });

  it('depth=2 returns transitive connections', async () => {
    const result = await traverse(db, 'A', 2);
    expect(result.targets.sort()).toEqual(['A', 'B', 'C', 'E']);
    expect(result.edges).toHaveLength(3);
  });

  it('depth=3 reaches all nodes', async () => {
    const result = await traverse(db, 'A', 3);
    expect(result.targets.sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('returns both targets and edges', async () => {
    const result = await traverse(db, 'A', 2);
    expect(result.targets.length).toBeGreaterThan(0);
    expect(result.edges.length).toBeGreaterThan(0);
  });

  it('handles cycles without infinite loops', async () => {
    // Create cycle: D -> A
    await addEdge(db, { source: 'D', dest: 'A', seq: 5 });
    const result = await traverse(db, 'A', 10);
    // Should visit all nodes exactly once
    expect(result.targets.sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});
