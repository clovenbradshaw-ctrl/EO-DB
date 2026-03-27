import type { EoStore } from './encrypted-store';
import type { GraphEdge } from './types';

export async function addEdge(store: EoStore, edge: GraphEdge): Promise<void> {
  const fwdKey = `graph:fwd:${edge.source}:${edge.dest}`;
  const revKey = `graph:rev:${edge.dest}:${edge.source}`;
  await store.put(fwdKey, edge);
  await store.put(revKey, edge);
}

export async function removeEdge(store: EoStore, source: string, dest: string): Promise<void> {
  const fwdKey = `graph:fwd:${source}:${dest}`;
  const revKey = `graph:rev:${dest}:${source}`;
  await store.del(fwdKey);
  await store.del(revKey);
}

export async function getEdgesFrom(store: EoStore, source: string): Promise<GraphEdge[]> {
  const prefix = `graph:fwd:${source}:`;
  const entries = await store.iterator(prefix);
  return entries.map(([, value]) => value as GraphEdge);
}

export async function getEdgesTo(store: EoStore, dest: string): Promise<GraphEdge[]> {
  const prefix = `graph:rev:${dest}:`;
  const entries = await store.iterator(prefix);
  return entries.map(([, value]) => value as GraphEdge);
}

export interface TraverseResult {
  targets: string[];
  edges: GraphEdge[];
}

export async function traverse(
  store: EoStore,
  start: string,
  depth: number = 1,
): Promise<TraverseResult> {
  const visited = new Set<string>();
  const allEdges: GraphEdge[] = [];
  let frontier = [start];
  visited.add(start);

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const nextFrontier: string[] = [];
    for (const node of frontier) {
      const outgoing = await getEdgesFrom(store, node);
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
