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
