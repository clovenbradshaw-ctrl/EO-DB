/**
 * Dependency graph for computational (formula) references.
 *
 * Separate from the CON graph (entity relationships).
 * Edges here mean "target A's formula references target B" —
 * computational dependency, not entity connection.
 *
 * Storage:
 *   dep:fwd:{source}:{dest}  — source's formula references dest
 *   dep:rev:{dest}:{source}  — reverse index: dest is referenced by source
 *
 * Maintained in LevelDB alongside state. Rebuilt from EVA registrations on startup.
 */
import { EoDb, encode, decode } from './level.js';

export interface DepEdge {
  source: string;   // the target whose formula contains the reference
  dest: string;     // the target being referenced
}

/** Record that source's formula references dest. */
export async function addDepEdge(db: EoDb, edge: DepEdge): Promise<void> {
  const fwdKey = `dep:fwd:${edge.source}:${edge.dest}`;
  const revKey = `dep:rev:${edge.dest}:${edge.source}`;
  await db.put(fwdKey, encode(edge));
  await db.put(revKey, encode(edge));
}

/** Remove a single dependency edge. */
export async function removeDepEdge(db: EoDb, source: string, dest: string): Promise<void> {
  try { await db.del(`dep:fwd:${source}:${dest}`); } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
  try { await db.del(`dep:rev:${dest}:${source}`); } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
}

/** Remove all outgoing dependency edges from source (used when a formula is redefined). */
export async function clearDepEdgesFrom(db: EoDb, source: string): Promise<void> {
  const existing = await getDepEdgesFrom(db, source);
  for (const edge of existing) {
    await removeDepEdge(db, edge.source, edge.dest);
  }
}

/** Get all targets that source's formula references (outgoing). */
export async function getDepEdgesFrom(db: EoDb, source: string): Promise<DepEdge[]> {
  const edges: DepEdge[] = [];
  const prefix = `dep:fwd:${source}:`;
  for await (const [, value] of db.iterator({ gte: prefix, lte: `${prefix}\xff` })) {
    edges.push(decode(value) as DepEdge);
  }
  return edges;
}

/** Get all targets whose formulas reference dest (incoming — "who depends on me?"). */
export async function getDepEdgesTo(db: EoDb, dest: string): Promise<DepEdge[]> {
  const edges: DepEdge[] = [];
  const prefix = `dep:rev:${dest}:`;
  for await (const [, value] of db.iterator({ gte: prefix, lte: `${prefix}\xff` })) {
    edges.push(decode(value) as DepEdge);
  }
  return edges;
}

/**
 * Find the connected component containing `start` in the undirected dep graph.
 * Treats dep edges as undirected — follows both fwd and rev from each node.
 * Returns the set of all targets reachable from start through any dep edge.
 */
/**
 * Find the connected component containing `start` in the undirected dep graph.
 * maxNodes caps the traversal to prevent unbounded memory usage on highly
 * connected graphs. Defaults to 10 000 which is generous for formula deps.
 */
export async function getConnectedComponent(db: EoDb, start: string, maxNodes: number = 10_000): Promise<Set<string>> {
  const component = new Set<string>();
  const queue: string[] = [start];
  component.add(start);

  while (queue.length > 0) {
    if (component.size >= maxNodes) break;

    const current = queue.pop()!;

    // Follow forward edges (targets this node's formula references)
    const fwd = await getDepEdgesFrom(db, current);
    for (const edge of fwd) {
      if (!component.has(edge.dest)) {
        component.add(edge.dest);
        queue.push(edge.dest);
        if (component.size >= maxNodes) break;
      }
    }

    if (component.size >= maxNodes) break;

    // Follow reverse edges (targets whose formulas reference this node)
    const rev = await getDepEdgesTo(db, current);
    for (const edge of rev) {
      if (!component.has(edge.source)) {
        component.add(edge.source);
        queue.push(edge.source);
        if (component.size >= maxNodes) break;
      }
    }
  }

  return component;
}
