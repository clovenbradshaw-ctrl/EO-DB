#!/usr/bin/env node
/**
 * EO Code Analysis Framework — Entry Point
 *
 * Analyzes the EO-DB codebase using EO's own nine-operator model:
 *
 *   INS  → Code entities come into existence
 *   DEF  → Properties assigned to entities
 *   CON  → Import/dependency connections
 *   SEG  → Architecture layer boundaries
 *   SYN  → Server ↔ browser equivalences
 *   EVA  → Governance rules
 *   REC  → Circular dependencies
 *   SIG  → Complexity hotspots
 *   NUL  → Well-contained modules
 *
 * Usage:
 *   npx tsx tools/eo-code-analysis/src/index.ts [--json] [--graph] [--report] [--all]
 *
 * Output (in tools/eo-code-analysis/output/):
 *   events.json  — EO event log describing the codebase (loadable into fold)
 *   graph.json   — CON dependency graph for visualization
 *   report.md    — Human-readable analysis through the EO lens
 */

import * as path from 'node:path';
import { scanDirectory } from './scanner.js';
import { mapToEoOperators } from './mapper.js';
import { writeEvents, writeGraph } from './emitter.js';
import { generateReport, writeReport } from './reporter.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '../../..');
const OUTPUT_DIR = path.resolve(import.meta.dirname, '../output');

function main() {
  const args = new Set(process.argv.slice(2));
  const all = args.has('--all') || args.size === 0; // default: emit everything
  const emitJson = all || args.has('--json');
  const emitGraph = all || args.has('--graph');
  const emitReport = all || args.has('--report');

  console.log('EO Code Analysis Framework');
  console.log('==========================');
  console.log(`Root: ${ROOT_DIR}`);
  console.log();

  // 1. Scan
  console.log('[1/4] Scanning codebase...');
  const files = scanDirectory(ROOT_DIR, ROOT_DIR);
  console.log(`  Found ${files.length} TypeScript files`);

  // 2. Map to EO operators
  console.log('[2/4] Mapping to EO operators...');
  const result = mapToEoOperators(files);
  console.log(`  Generated ${result.events.length} EO events`);
  console.log(`  - SEG: ${result.layers.length} architecture layers`);
  console.log(`  - CON: ${result.stats.totalImportEdges} import edges`);
  console.log(`  - SYN: 6 server/browser equivalences`);
  console.log(`  - REC: ${result.cycles.length} import cycles`);
  console.log(`  - SIG: ${result.hotspots.length} complexity hotspots`);

  // 3. Emit outputs
  console.log('[3/4] Writing outputs...');

  if (emitJson) {
    const eventsPath = path.join(OUTPUT_DIR, 'events.json');
    writeEvents(result.events, eventsPath);
    console.log(`  events.json → ${eventsPath}`);
  }

  if (emitGraph) {
    const graphPath = path.join(OUTPUT_DIR, 'graph.json');
    writeGraph(result.events, graphPath);
    console.log(`  graph.json  → ${graphPath}`);
  }

  if (emitReport) {
    const report = generateReport({
      events: result.events,
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

  // 4. Summary
  console.log();
  console.log('[4/4] Analysis complete!');
  console.log();
  console.log('Stats:');
  console.log(`  Files:       ${result.stats.totalFiles}`);
  console.log(`  Lines:       ${result.stats.totalLines.toLocaleString()}`);
  console.log(`  Functions:   ${result.stats.totalFunctions}`);
  console.log(`  Components:  ${result.stats.totalComponents}`);
  console.log(`  Interfaces:  ${result.stats.totalInterfaces}`);
  console.log(`  Types:       ${result.stats.totalTypes}`);
  console.log(`  Exports:     ${result.stats.totalExports}`);
  console.log(`  Import edges: ${result.stats.totalImportEdges}`);
  console.log();
  console.log('Operator event breakdown:');
  const opCounts = new Map<string, number>();
  for (const e of result.events) {
    opCounts.set(e.op, (opCounts.get(e.op) || 0) + 1);
  }
  for (const op of ['SEG', 'INS', 'DEF', 'CON', 'SYN', 'EVA', 'REC', 'SIG', 'NUL']) {
    const count = opCounts.get(op) || 0;
    if (count > 0) {
      console.log(`  ${op}: ${count}`);
    }
  }
}

main();
