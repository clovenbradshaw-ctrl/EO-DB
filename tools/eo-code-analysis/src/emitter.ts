/**
 * EO Event Emitter — Serializes analysis events to JSON.
 *
 * Outputs events in the same format as the EO-DB event log,
 * so they can be loaded into the app's fold engine for visualization.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AnalysisEvent } from './types.js';

/**
 * Write analysis events to a JSON file.
 * Format matches the EoEvent interface from src/db/types.ts.
 */
export function writeEvents(events: AnalysisEvent[], outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const formatted = events.map(e => ({
    seq: e.seq,
    op: e.op,
    target: e.target,
    operand: e.operand,
    agent: e.agent,
    ts: e.ts,
    acquired_ts: e.ts,
    client_event_id: e.client_event_id,
  }));

  fs.writeFileSync(outputPath, JSON.stringify(formatted, null, 2), 'utf-8');
}

/**
 * Write a CON graph in a format suitable for visualization.
 * Nodes are files, edges are import relationships.
 */
export function writeGraph(events: AnalysisEvent[], outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const nodes = new Map<string, { id: string; op: string; layer?: string; metrics?: unknown }>();
  const edges: Array<{ source: string; target: string; type: string }> = [];

  for (const event of events) {
    if (event.op === 'INS') {
      const operand = event.operand as Record<string, unknown>;
      nodes.set(event.target, {
        id: event.target,
        op: 'INS',
        layer: operand.layer as string | undefined,
        metrics: undefined,
      });
    }

    if (event.op === 'DEF' && event.target.endsWith('._metrics')) {
      const parentTarget = event.target.replace(/\._metrics$/, '');
      const existing = nodes.get(parentTarget);
      if (existing) {
        existing.metrics = event.operand;
      }
    }

    if (event.op === 'CON') {
      const operand = event.operand as Record<string, string>;
      edges.push({
        source: event.target,
        target: operand.dest,
        type: operand.edge_type || 'imports',
      });
    }
  }

  const graph = {
    nodes: Array.from(nodes.values()),
    edges,
    meta: {
      generated: new Date().toISOString(),
      nodeCount: nodes.size,
      edgeCount: edges.length,
    },
  };

  fs.writeFileSync(outputPath, JSON.stringify(graph, null, 2), 'utf-8');
}
