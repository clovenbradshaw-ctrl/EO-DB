/**
 * Report Generator — Produces a human-readable analysis through the EO lens.
 *
 * Each section maps to an EO operator, explaining the codebase
 * in terms of the nine-operator transformation calculus.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AnalysisEvent,
  AnalysisStats,
  ConnectionSummary,
  Hotspot,
  CyclePath,
  LayerSummary,
  FileInfo,
} from './types.js';
import { EQUIVALENCES } from './layers.js';

export interface ReportData {
  events: AnalysisEvent[];
  files: FileInfo[];
  layers: LayerSummary[];
  crossLayerConnections: ConnectionSummary[];
  hotspots: Hotspot[];
  cycles: CyclePath[];
  stats: AnalysisStats;
}

export function generateReport(data: ReportData): string {
  const lines: string[] = [];
  const w = (s: string) => lines.push(s);
  const blank = () => lines.push('');

  w('# EO Code Analysis Report');
  w(`> Generated ${new Date().toISOString()} by eo-code-analysis`);
  w('>');
  w('> This report models the EO-DB codebase using its own nine-operator');
  w('> transformation calculus. Each section corresponds to an EO operator.');
  blank();

  // ─── Overview ────────────────────────────────────────────────────────
  w('## Overview');
  blank();
  w('| Metric | Count |');
  w('|--------|-------|');
  w(`| Files | ${data.stats.totalFiles} |`);
  w(`| Lines of code | ${data.stats.totalLines.toLocaleString()} |`);
  w(`| Functions | ${data.stats.totalFunctions} |`);
  w(`| React components | ${data.stats.totalComponents} |`);
  w(`| Interfaces | ${data.stats.totalInterfaces} |`);
  w(`| Type aliases | ${data.stats.totalTypes} |`);
  w(`| Exports | ${data.stats.totalExports} |`);
  w(`| Import edges | ${data.stats.totalImportEdges} |`);
  w(`| EO analysis events | ${data.events.length} |`);
  blank();

  // ─── SEG: Architecture Layers ────────────────────────────────────────
  w('## SEG — Architecture Layers (Boundaries)');
  blank();
  w('The codebase is organized into distinct layers, each a SEG boundary');
  w('that contains related functionality:');
  blank();

  for (const layer of data.layers) {
    const indent = layer.layer.parent ? '  ' : '';
    w(`${indent}### ${layer.layer.name} (\`${layer.layer.pathPrefix}\`)`);
    w(`${indent}${layer.layer.description}`);
    blank();
    w(`${indent}| Metric | Value |`);
    w(`${indent}|--------|-------|`);
    w(`${indent}| Files | ${layer.fileCount} |`);
    w(`${indent}| Lines | ${layer.totalLines.toLocaleString()} |`);
    w(`${indent}| Exports | ${layer.exportCount} |`);
    blank();
    if (layer.topFiles.length > 0) {
      w(`${indent}**Largest files:**`);
      for (const f of layer.topFiles) {
        w(`${indent}- \`${f.path}\` (${f.lines} lines)`);
      }
      blank();
    }
  }

  // ─── INS: What exists ────────────────────────────────────────────────
  w('## INS — Entity Census (What Exists)');
  blank();
  w('INS events mark when something comes into existence. Here are the key');
  w('entities that constitute the system:');
  blank();

  const insEvents = data.events.filter(e => e.op === 'INS');
  const fileEntities = insEvents.filter(e => (e.operand as Record<string, unknown>).kind === 'file');
  const fnEntities = insEvents.filter(e => (e.operand as Record<string, unknown>).kind === 'function');
  const compEntities = insEvents.filter(e => (e.operand as Record<string, unknown>).kind === 'component');
  const ifaceEntities = insEvents.filter(e => (e.operand as Record<string, unknown>).kind === 'interface');

  w(`- **${fileEntities.length}** files (modules)`);
  w(`- **${fnEntities.length}** exported functions`);
  w(`- **${compEntities.length}** React components`);
  w(`- **${ifaceEntities.length}** exported interfaces`);
  blank();

  // Key components
  if (compEntities.length > 0) {
    w('### Key React Components');
    blank();
    const byLayer = new Map<string, AnalysisEvent[]>();
    for (const e of compEntities) {
      const layer = inferLayerFromTarget(e.target);
      if (!byLayer.has(layer)) byLayer.set(layer, []);
      byLayer.get(layer)!.push(e);
    }
    for (const [layer, comps] of byLayer) {
      w(`**${layer}:**`);
      for (const c of comps.slice(0, 10)) {
        const operand = c.operand as Record<string, unknown>;
        const hooks = operand.hooks as string[] || [];
        const hookStr = hooks.length > 0 ? ` — hooks: ${hooks.join(', ')}` : '';
        w(`- \`${extractName(c.target)}\`${hookStr}`);
      }
      if (comps.length > 10) w(`- ... and ${comps.length - 10} more`);
      blank();
    }
  }

  // Key interfaces
  if (ifaceEntities.length > 0) {
    w('### Core Interfaces (Data Model)');
    blank();
    for (const e of ifaceEntities.slice(0, 20)) {
      const operand = e.operand as Record<string, number>;
      w(`- \`${extractName(e.target)}\` (${operand.fieldCount} fields)`);
    }
    if (ifaceEntities.length > 20) w(`- ... and ${ifaceEntities.length - 20} more`);
    blank();
  }

  // ─── CON: Connections ────────────────────────────────────────────────
  w('## CON — Import Graph (Connections)');
  blank();
  w('CON events link two entities. Import relationships form the dependency');
  w('graph that wires the system together.');
  blank();

  const conEvents = data.events.filter(e => e.op === 'CON');
  w(`**${conEvents.length}** import connections detected.`);
  blank();

  if (data.crossLayerConnections.length > 0) {
    w('### Cross-Layer Dependencies');
    blank();
    w('These imports cross architectural boundaries:');
    blank();
    w('| Source Layer | Target Layer | Weight | Examples |');
    w('|-------------|-------------|--------|----------|');
    for (const conn of data.crossLayerConnections.slice(0, 15)) {
      w(`| ${conn.sourceLayer} | ${conn.targetLayer} | ${conn.weight} | ${conn.examples.join(', ')} |`);
    }
    blank();
  }

  // ─── SYN: Equivalences ──────────────────────────────────────────────
  w('## SYN — Server / Browser Equivalences');
  blank();
  w('SYN identifies when two things are the same. The browser app ports');
  w('core server modules to run locally:');
  blank();
  w('| Server | Browser | Description |');
  w('|--------|---------|-------------|');
  for (const eq of EQUIVALENCES) {
    w(`| \`${eq.serverPath}\` | \`${eq.browserPath}\` | ${eq.description} |`);
  }
  blank();

  // ─── DEF: Properties ────────────────────────────────────────────────
  w('## DEF — Module Properties');
  blank();
  w('DEF assigns values. Here are the properties of the most substantial modules:');
  blank();

  const bigFiles = [...data.files]
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 20);

  w('| File | Lines | Functions | Exports | Components |');
  w('|------|-------|-----------|---------|------------|');
  for (const f of bigFiles) {
    w(`| \`${f.relativePath}\` | ${f.lines} | ${f.functions.length} | ${f.exports.length} | ${f.components.length} |`);
  }
  blank();

  // ─── EVA: Governance Rules ──────────────────────────────────────────
  w('## EVA — Governance Rules');
  blank();
  w('EVA registers rules that govern how the system behaves:');
  blank();

  const evaEvents = data.events.filter(e => e.op === 'EVA');
  for (const e of evaEvents) {
    const operand = e.operand as Record<string, unknown>;
    w(`- **${operand.rule}**`);
    if (operand.scope) w(`  - Scope: \`${operand.scope}\``);
    if (operand.enforcement) w(`  - Enforcement: ${operand.enforcement}`);
  }
  blank();

  // ─── REC: Circular Dependencies ─────────────────────────────────────
  w('## REC — Circular Dependencies');
  blank();

  if (data.cycles.length === 0) {
    w('No import cycles detected. The dependency graph is acyclic.');
  } else {
    w(`**${data.cycles.length}** import cycles detected:`);
    blank();
    for (let i = 0; i < data.cycles.length; i++) {
      const cycle = data.cycles[i];
      w(`${i + 1}. ${cycle.files.map(f => `\`${path.basename(f)}\``).join(' → ')}`);
    }
  }
  blank();

  // ─── SIG: Complexity Hotspots ───────────────────────────────────────
  w('## SIG — Complexity Hotspots');
  blank();
  w('SIG surfaces patterns that deserve attention. These files have high');
  w('complexity scores based on size, coupling, and API surface:');
  blank();

  if (data.hotspots.length === 0) {
    w('No significant hotspots detected.');
  } else {
    w('| File | Score | Reason |');
    w('|------|-------|--------|');
    for (const h of data.hotspots.slice(0, 20)) {
      w(`| \`${h.path}\` | ${h.score} | ${h.reason} |`);
    }
    if (data.hotspots.length > 20) {
      blank();
      w(`... and ${data.hotspots.length - 20} more hotspots.`);
    }
  }
  blank();

  // ─── NUL: Well-Contained Modules ───────────────────────────────────
  w('## NUL — Well-Contained Modules');
  blank();
  const nulEvents = data.events.filter(e => e.op === 'NUL');
  w(`**${nulEvents.length}** files are small, well-contained modules with no complexity signals.`);
  w('These are the simplest parts of the codebase — observe, no action needed.');
  blank();

  // ─── How to Read This Codebase ──────────────────────────────────────
  w('## Reading Guide — How to Navigate the Codebase');
  blank();
  w('### Start here (core abstractions):');
  w('1. **`src/db/types.ts`** — The nine operators, EoEvent, EoState, HorizonResponse');
  w('2. **`src/db/fold.ts`** — The fold engine: how events become state');
  w('3. **`src/db/horizon.ts`** — The six-layer read model');
  blank();
  w('### Then understand the browser port:');
  w('4. **`github-matrix-dev/app/src/db/idb.ts`** — IndexedDB schema (replaces LevelDB)');
  w('5. **`github-matrix-dev/app/src/db/fold.ts`** — Browser fold (port of server)');
  w('6. **`github-matrix-dev/app/src/db/encrypted-store.ts`** — Encryption layer');
  blank();
  w('### Then the application layer:');
  w('7. **`github-matrix-dev/app/src/store/eo-store.ts`** — Zustand store (dispatch, horizon, state)');
  w('8. **`github-matrix-dev/app/src/App.tsx`** — Root component and routing');
  w('9. **`github-matrix-dev/app/src/components/`** — 80+ UI components');
  blank();
  w('### Data flow:');
  w('```');
  w('User action → ComposeView → dispatch() → fold.processEvent()');
  w('  → IndexedDB (log + state + graph) → UI re-render');
  w('  → SyncManager → Matrix room → other devices → their fold');
  w('```');
  blank();

  // ─── Event Summary ──────────────────────────────────────────────────
  w('## Event Summary');
  blank();
  w('| Operator | Count | Purpose |');
  w('|----------|-------|---------|');
  const opCounts = new Map<string, number>();
  for (const e of data.events) {
    opCounts.set(e.op, (opCounts.get(e.op) || 0) + 1);
  }
  const opDescriptions: Record<string, string> = {
    SEG: 'Architecture layer boundaries',
    INS: 'Code entities (files, functions, components, types)',
    DEF: 'Module properties and metrics',
    CON: 'Import/dependency connections',
    SYN: 'Server ↔ browser equivalences',
    EVA: 'Governance rules and constraints',
    REC: 'Circular dependency detection',
    SIG: 'Complexity hotspots and patterns',
    NUL: 'Well-contained modules (no action)',
  };
  for (const op of ['SEG', 'INS', 'DEF', 'CON', 'SYN', 'EVA', 'REC', 'SIG', 'NUL']) {
    w(`| **${op}** | ${opCounts.get(op) || 0} | ${opDescriptions[op]} |`);
  }
  blank();
  w(`**Total: ${data.events.length} events** describe the full codebase structure.`);
  blank();

  return lines.join('\n');
}

export function writeReport(report: string, outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, report, 'utf-8');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractName(target: string): string {
  const parts = target.split('.');
  return parts[parts.length - 1];
}

function inferLayerFromTarget(target: string): string {
  if (target.includes('browser.components')) return 'UI Components';
  if (target.includes('browser.store')) return 'State Management';
  if (target.includes('browser.db')) return 'Browser Engine';
  if (target.includes('browser.matrix')) return 'Browser Matrix';
  if (target.includes('browser')) return 'Browser App';
  if (target.includes('server.db')) return 'Core Engine';
  if (target.includes('server.api')) return 'HTTP API';
  if (target.includes('server')) return 'Server';
  return 'Other';
}
