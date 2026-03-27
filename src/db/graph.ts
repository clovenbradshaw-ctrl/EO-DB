import { EoDb, encode, decode } from './level.js';
import type { GraphEdge } from './types.js';

export async function addEdge(db: EoDb, edge: GraphEdge): Promise<void> {
  const fwdKey = `graph:fwd:${edge.source}:${edge.dest}`;
  const revKey = `graph:rev:${edge.dest}:${edge.source}`;
  await db.put(fwdKey, encode(edge));
  await db.put(revKey, encode(edge));
}

export async function removeEdge(db: EoDb, source: string, dest: string): Promise<void> {
  const fwdKey = `graph:fwd:${source}:${dest}`;
  const revKey = `graph:rev:${dest}:${source}`;
  try {
    await db.del(fwdKey);
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
  try {
    await db.del(revKey);
  } catch (e: any) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
}

export async function getEdgesFrom(db: EoDb, source: string): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  const prefix = `graph:fwd:${source}:`;

  for await (const [, value] of db.iterator({
    gte: prefix,
    lte: `${prefix}\xff`,
  })) {
    edges.push(decode(value) as GraphEdge);
  }
  return edges;
}

export async function getEdgesTo(db: EoDb, dest: string): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  const prefix = `graph:rev:${dest}:`;

  for await (const [, value] of db.iterator({
    gte: prefix,
    lte: `${prefix}\xff`,
  })) {
    edges.push(decode(value) as GraphEdge);
  }
  return edges;
}

export interface TraverseResult {
  targets: string[];
  edges: GraphEdge[];
}

export async function traverse(
  db: EoDb,
  start: string,
  depth: number = 1
): Promise<TraverseResult> {
  const visited = new Set<string>();
  const allEdges: GraphEdge[] = [];
  let frontier = [start];
  visited.add(start);

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const nextFrontier: string[] = [];
    for (const node of frontier) {
      const outgoing = await getEdgesFrom(db, node);
      for (const edge of outgoing) {
        allEdges.push(edge);
        if (!visited.has(edge.dest)) {
          visited.add(edge.dest);
          nextFrontier.push(edge.dest);
        }
      }
    }
    frontier = nextFrontier;
  }

  return {
    targets: Array.from(visited),
    edges: allEdges,
  };
}
