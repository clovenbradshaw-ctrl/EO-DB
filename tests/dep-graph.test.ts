import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type EoDb } from '../src/db/level.js';
import {
  addDepEdge,
  removeDepEdge,
  clearDepEdgesFrom,
  getDepEdgesFrom,
  getDepEdgesTo,
  getConnectedComponent,
} from '../src/db/dep-graph.js';
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

describe('addDepEdge + getDepEdgesFrom', () => {
  it('round-trips a dependency edge', async () => {
    await addDepEdge(db, { source: 'A', dest: 'B' });
    const edges = await getDepEdgesFrom(db, 'A');
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('A');
    expect(edges[0].dest).toBe('B');
  });

  it('returns multiple outgoing edges', async () => {
    await addDepEdge(db, { source: 'A', dest: 'B' });
    await addDepEdge(db, { source: 'A', dest: 'C' });
    const edges = await getDepEdgesFrom(db, 'A');
    expect(edges).toHaveLength(2);
    expect(edges.map(e => e.dest).sort()).toEqual(['B', 'C']);
  });

  it('returns empty for node with no outgoing edges', async () => {
    const edges = await getDepEdgesFrom(db, 'nonexistent');
    expect(edges).toHaveLength(0);
  });
});

describe('addDepEdge + getDepEdgesTo', () => {
  it('round-trips reverse lookup', async () => {
    await addDepEdge(db, { source: 'A', dest: 'B' });
    const edges = await getDepEdgesTo(db, 'B');
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('A');
    expect(edges[0].dest).toBe('B');
  });

  it('returns multiple incoming edges', async () => {
    await addDepEdge(db, { source: 'A', dest: 'C' });
    await addDepEdge(db, { source: 'B', dest: 'C' });
    const edges = await getDepEdgesTo(db, 'C');
    expect(edges).toHaveLength(2);
    expect(edges.map(e => e.source).sort()).toEqual(['A', 'B']);
  });
});

describe('removeDepEdge', () => {
  it('removes both forward and reverse entries', async () => {
    await addDepEdge(db, { source: 'A', dest: 'B' });
    await removeDepEdge(db, 'A', 'B');
    expect(await getDepEdgesFrom(db, 'A')).toHaveLength(0);
    expect(await getDepEdgesTo(db, 'B')).toHaveLength(0);
  });

  it('does not error on non-existent edge', async () => {
    await expect(removeDepEdge(db, 'X', 'Y')).resolves.not.toThrow();
  });
});

describe('clearDepEdgesFrom', () => {
  it('removes all outgoing edges from source', async () => {
    await addDepEdge(db, { source: 'A', dest: 'B' });
    await addDepEdge(db, { source: 'A', dest: 'C' });
    await addDepEdge(db, { source: 'A', dest: 'D' });
    await clearDepEdgesFrom(db, 'A');
    expect(await getDepEdgesFrom(db, 'A')).toHaveLength(0);
    // Reverse entries should also be cleaned
    expect(await getDepEdgesTo(db, 'B')).toHaveLength(0);
    expect(await getDepEdgesTo(db, 'C')).toHaveLength(0);
  });

  it('does not affect other sources', async () => {
    await addDepEdge(db, { source: 'A', dest: 'C' });
    await addDepEdge(db, { source: 'B', dest: 'C' });
    await clearDepEdgesFrom(db, 'A');
    expect(await getDepEdgesTo(db, 'C')).toHaveLength(1);
  });
});

describe('getConnectedComponent', () => {
  it('returns single node when isolated', async () => {
    const component = await getConnectedComponent(db, 'lonely');
    expect(component.size).toBe(1);
    expect(component.has('lonely')).toBe(true);
  });

  it('finds linear chain A→B→C', async () => {
    await addDepEdge(db, { source: 'A', dest: 'B' });
    await addDepEdge(db, { source: 'B', dest: 'C' });
    const component = await getConnectedComponent(db, 'A');
    expect(component).toEqual(new Set(['A', 'B', 'C']));
  });

  it('finds component from any starting node', async () => {
    await addDepEdge(db, { source: 'A', dest: 'B' });
    await addDepEdge(db, { source: 'B', dest: 'C' });
    // Starting from C should find the same component (undirected traversal)
    const component = await getConnectedComponent(db, 'C');
    expect(component).toEqual(new Set(['A', 'B', 'C']));
  });

  it('handles diamond graph', async () => {
    //   A → B
    //   A → C
    //   B → D
    //   C → D
    await addDepEdge(db, { source: 'A', dest: 'B' });
    await addDepEdge(db, { source: 'A', dest: 'C' });
    await addDepEdge(db, { source: 'B', dest: 'D' });
    await addDepEdge(db, { source: 'C', dest: 'D' });
    const component = await getConnectedComponent(db, 'A');
    expect(component).toEqual(new Set(['A', 'B', 'C', 'D']));
  });

  it('handles cycles without infinite loop', async () => {
    await addDepEdge(db, { source: 'A', dest: 'B' });
    await addDepEdge(db, { source: 'B', dest: 'C' });
    await addDepEdge(db, { source: 'C', dest: 'A' });
    const component = await getConnectedComponent(db, 'A');
    expect(component).toEqual(new Set(['A', 'B', 'C']));
  });

  it('does not cross between disconnected components', async () => {
    await addDepEdge(db, { source: 'A', dest: 'B' });
    await addDepEdge(db, { source: 'X', dest: 'Y' });
    const compA = await getConnectedComponent(db, 'A');
    expect(compA).toEqual(new Set(['A', 'B']));
    const compX = await getConnectedComponent(db, 'X');
    expect(compX).toEqual(new Set(['X', 'Y']));
  });
});
