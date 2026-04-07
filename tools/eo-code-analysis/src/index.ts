#!/usr/bin/env node
/**
 * EO Code Analysis Framework — Entry Point
 *
 * Three layers of analysis, mirroring the three faces of the capacity cube:
 *
 * Layer 1 — Act face (Mode × Domain): Static code structure mapped to 9 operators
 *   INS → entities, DEF → properties, CON → imports, SEG → layers,
 *   SYN → equivalences, EVA → rules, REC → cycles, SIG → hotspots, NUL → simple
 *
 * Layer 2 — Site face (Mode × Object): Data transformation flow
 *   How data moves through the system: compose → fold → state → horizon → UI → sync
 *   Where each operator is implemented (server + browser)
 *
 * Layer 3 — Resolution face (Domain × Object): The capacity cube itself
 *   The 3D structure behind the 9 operators: Mode × Domain × Object = 27 cells
 *   Three faces (Act, Site, Resolution) as projection functors
 *   Self-reference: the analysis uses EO to analyze EO
 *
 * Usage:
 *   npx tsx tools/eo-code-analysis/src/index.ts [--json] [--graph] [--report] [--all]
 *
 * Output (in tools/eo-code-analysis/output/):
 *   events.json  — Full EO event log (all three layers)
 *   graph.json   — CON dependency graph for visualization
 *   report.md    — Human-readable analysis through the EO lens
 */

import * as path from 'node:path';
import { scanDirectory } from './scanner.js';
import { mapToEoOperators } from './mapper.js';
import { writeEvents, writeGraph } from './emitter.js';
import { generateReport, writeReport } from './reporter.js';
import { emitFlowEvents } from './flows.js';
import { emitOperatorMapEvents } from './operator-map.js';
import { emitCubeEvents } from './cube.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '../../..');
const OUTPUT_DIR = path.resolve(import.meta.dirname, '../output');

function main() {
  const args = new Set(process.argv.slice(2));
  const all = args.has('--all') || args.size === 0;
  const emitJson = all || args.has('--json');
  const emitGraph = all || args.has('--graph');
  const emitReport = all || args.has('--report');

  console.log('EO Code Analysis Framework');
  console.log('==========================');
  console.log(`Root: ${ROOT_DIR}`);
  console.log();

  // Layer 1: Act face — static code structure
  console.log('[1/5] Scanning codebase (Act face — code structure)...');
  const files = scanDirectory(ROOT_DIR, ROOT_DIR);
  console.log(`  Found ${files.length} TypeScript files`);

  console.log('[2/5] Mapping to EO operators...');
  const result = mapToEoOperators(files);
  console.log(`  Generated ${result.events.length} code structure events`);

  // Layer 2: Site face — data flow + operator implementations
  console.log('[3/5] Tracing transformation flow (Site face — data movement)...');
  const maxCodeSeq = result.events.length > 0 ? result.events[result.events.length - 1].seq : 0;
  const flowEvents = emitFlowEvents(maxCodeSeq);
  const opMapEvents = emitOperatorMapEvents(maxCodeSeq + flowEvents.length);
  console.log(`  ${flowEvents.length} flow events (pipeline stages + self-reference)`);
  console.log(`  ${opMapEvents.length} operator implementation events`);

  // Layer 3: Resolution face — the capacity cube
  console.log('[4/5] Building capacity cube (Resolution face — 3D structure)...');
  const cubeEvents = emitCubeEvents(maxCodeSeq + flowEvents.length + opMapEvents.length);
  console.log(`  ${cubeEvents.length} cube events (27 cells, 3 faces, 3 axes)`);

  // Merge all events
  const allEvents = [...result.events, ...flowEvents, ...opMapEvents, ...cubeEvents];
  console.log(`  Total: ${allEvents.length} events across all three layers`);

  // Emit outputs
  console.log('[5/5] Writing outputs...');

  if (emitJson) {
    const eventsPath = path.join(OUTPUT_DIR, 'events.json');
    writeEvents(allEvents, eventsPath);
    console.log(`  events.json → ${eventsPath}`);
  }

  if (emitGraph) {
    const graphPath = path.join(OUTPUT_DIR, 'graph.json');
    writeGraph(allEvents, graphPath);
    console.log(`  graph.json  → ${graphPath}`);
  }

  if (emitReport) {
    const report = generateReport({
      events: allEvents,
      files,
      layers: result.layers,
      crossLayerConnections: result.crossLayerConnections,
      hotspots: result.hotspots,
      cycles: result.cycles,
      stats: result.stats,
    });
    const reportPath = path.join(OUTPUT_DIR, 'report.md');
    writeReport(report, reportPath);
    console.log(`  report.md   → ${reportPath}`);
  }

  // Summary
  console.log();
  console.log('Analysis complete!');
  console.log();
  console.log(`Code:  ${result.stats.totalFiles} files, ${result.stats.totalLines.toLocaleString()} lines`);
  console.log(`Graph: ${result.stats.totalImportEdges} import edges, ${result.cycles.length} cycles`);
  console.log(`Cube:  27 cells = Mode(3) × Domain(3) × Object(3)`);
  console.log(`Faces: Act (9 operators) + Site (9 positions) + Resolution (9 strategies)`);
  console.log();

  const opCounts = new Map<string, number>();
  for (const e of allEvents) {
    opCounts.set(e.op, (opCounts.get(e.op) || 0) + 1);
  }
  console.log('Event breakdown:');
  for (const op of ['SEG', 'INS', 'DEF', 'CON', 'SYN', 'EVA', 'REC', 'SIG', 'NUL']) {
    const count = opCounts.get(op) || 0;
    if (count > 0) console.log(`  ${op}: ${count}`);
  }
}

main();
