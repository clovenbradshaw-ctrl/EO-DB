/**
 * Report Generator — Produces a human-readable analysis through the EO lens.
 *
 * Three layers of analysis, mirroring the three faces of the capacity cube:
 *   Layer 1 (Act face):       Code structure → 9 operator categories
 *   Layer 2 (Site face):      Data transformation flow + operator implementations
 *   Layer 3 (Resolution face): The capacity cube + self-reference
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
import { PRIMARY_FLOW, FLOW_EDGES, SELF_REFERENCE_MAPPINGS } from './flows.js';
import { OPERATOR_MAP, INHERITANCE_LATTICE } from './operator-map.js';
import { ACT_FACE, SITE_FACE, RESOLUTION_FACE, MODE_AXIS, DOMAIN_AXIS, OBJECT_AXIS } from './cube.js';

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

  // ═══════════════════════════════════════════════════════════════════════
  // LAYER 2: SITE FACE — Data Transformation Flow
  // ═══════════════════════════════════════════════════════════════════════

  w('---');
  blank();
  w('# Layer 2: Site Face — How Data Moves and Transforms');
  blank();
  w('> The Site face is Mode x Object — where you look from changes what you see.');
  w('> This layer traces how data actually flows through the system.');
  blank();

  // ─── Transformation Pipeline ───────────────────────────────────────
  w('## The Transformation Pipeline');
  blank();
  w('An event\'s journey from user action to distributed state:');
  blank();
  w('```');
  w('compose → dispatch → fold → operator-switch → log-append');
  w('                                            → state-project → cascade → rec-detect');
  w('                                                           → horizon → ui-render → [compose]');
  w('                   → sync-send → [Matrix] → sync-receive → fold');
  w('```');
  blank();
  w('Each stage is itself a transformation — and each maps to an EO operator analogy:');
  blank();
  w('| Stage | What Happens | Operator Analogy | Implementation |');
  w('|-------|-------------|-----------------|----------------|');
  for (const stage of PRIMARY_FLOW) {
    w(`| **${stage.name}** | ${stage.description.slice(0, 60)}... | ${stage.operatorAnalogy.split(' — ')[0]} | \`${stage.implementation.file}:${stage.implementation.line}\` |`);
  }
  blank();

  w('The pipeline is **circular**: UI → compose → fold → state → horizon → UI.');
  w('This circularity is itself a REC — the system is a fixed-point iteration');
  w('over its own state, converging when the user stops acting.');
  blank();

  // ─── Operator Implementation Map ───────────────────────────────────
  w('## Operator Implementation Map');
  blank();
  w('Each operator has a handler in both the server and browser fold,');
  w('storage backends, a Horizon layer, and UI surfaces:');
  blank();
  w('| Op | Semantics | Server Handler | Browser Handler | Horizon Layer |');
  w('|----|-----------|---------------|----------------|--------------|');
  for (const impl of OPERATOR_MAP) {
    w(`| **${impl.op}** | ${impl.name} | \`${impl.serverHandler.function}:${impl.serverHandler.line}\` | \`${impl.browserHandler.function}:${impl.browserHandler.line}\` | ${impl.horizonLayer.split(' — ')[0]} |`);
  }
  blank();

  w('### Operator Inheritance Lattice');
  blank();
  w('```');
  w('        EVA (governs — inherits all 8 capacities)');
  w('         |');
  w('        DEF (defines — inherits SYN+SEG+INS+CON)');
  w('       /|\\');
  w('      / | \\');
  w('    SYN CON SEG (structure operators — each inherits INS)');
  w('      \\ | /');
  w('       INS (instantiate — inherits NUL)');
  w('        |');
  w('       NUL (observe — base)');
  w('');
  w('    SIG (signal — ephemeral, outside persistence lattice)');
  w('    REC (recursion — system-generated, outside submission lattice)');
  w('```');
  blank();
  w(INHERITANCE_LATTICE.description);
  blank();

  // ─── Site Face Grid ────────────────────────────────────────────────
  w('## The Site Face — 9 Observation Positions');
  blank();
  w('The Horizon implements this face. Each cell is a different perspective');
  w('on the same target:');
  blank();
  w('| | Self | Container | Peer |');
  w('|---|------|-----------|------|');
  const siteByMode = new Map<string, typeof SITE_FACE.cells[number][]>();
  for (const cell of SITE_FACE.cells) {
    const list = siteByMode.get(cell.mode) || [];
    list.push(cell);
    siteByMode.set(cell.mode, list);
  }
  for (const [mode, cells] of siteByMode) {
    const row = cells.map(c => `**${c.label}** — ${c.description.slice(0, 40)}...`);
    w(`| **${mode.charAt(0).toUpperCase() + mode.slice(1)}** | ${row.join(' | ')} |`);
  }
  blank();

  // ═══════════════════════════════════════════════════════════════════════
  // LAYER 3: RESOLUTION FACE — The Capacity Cube
  // ═══════════════════════════════════════════════════════════════════════

  w('---');
  blank();
  w('# Layer 3: Resolution Face — The Capacity Cube');
  blank();
  w('> The nine operators are NOT a flat list. They are one face of a');
  w('> three-dimensional structure: Mode x Domain x Object = 27 cells.');
  w('> Three faces project from this cube: Act, Site, Resolution.');
  blank();

  // ─── The Three Axes ────────────────────────────────────────────────
  w('## The Three Axes');
  blank();
  for (const axis of [MODE_AXIS, DOMAIN_AXIS, OBJECT_AXIS]) {
    w(`### ${axis.name} — ${axis.description}`);
    blank();
    for (const val of axis.values) {
      w(`- **${val.name}**: ${val.description}`);
    }
    blank();
  }

  // ─── Act Face Grid ─────────────────────────────────────────────────
  w('## Face 1: Act (Mode x Domain) — The 9 Operators');
  blank();
  w('What transformation happens. Implemented by the fold.');
  blank();
  w('| | Existence | Structure | Value |');
  w('|---|-----------|-----------|-------|');
  const actByMode = new Map<string, typeof ACT_FACE.cells[number][]>();
  for (const cell of ACT_FACE.cells) {
    const list = actByMode.get(cell.mode) || [];
    list.push(cell);
    actByMode.set(cell.mode, list);
  }
  for (const [mode, cells] of actByMode) {
    const row = cells.map(c => `**${c.op}** (${c.label})`);
    w(`| **${mode.charAt(0).toUpperCase() + mode.slice(1)}** | ${row.join(' | ')} |`);
  }
  blank();

  // ─── Resolution Face Grid ─────────────────────────────────────────
  w('## Face 3: Resolution (Domain x Object) — The 9 Conflict Strategies');
  blank();
  w('How conflicts resolve. Implemented by EVA governance + sync.');
  blank();
  w('| | Self | Container | Peer |');
  w('|---|------|-----------|------|');
  const resByDomain = new Map<string, typeof RESOLUTION_FACE.cells[number][]>();
  for (const cell of RESOLUTION_FACE.cells) {
    const list = resByDomain.get(cell.domain) || [];
    list.push(cell);
    resByDomain.set(cell.domain, list);
  }
  for (const [domain, cells] of resByDomain) {
    const row = cells.map(c => `**${c.label}**`);
    w(`| **${domain.charAt(0).toUpperCase() + domain.slice(1)}** | ${row.join(' | ')} |`);
  }
  blank();
  w('Each resolution strategy maps to code:');
  blank();
  for (const cell of RESOLUTION_FACE.cells) {
    w(`- **${cell.label}** (${cell.domain} x ${cell.object}): ${cell.description}`);
    w(`  - \`${cell.impl}\``);
  }
  blank();

  // ─── Self-Reference ────────────────────────────────────────────────
  w('## Self-Reference — The Analysis Mirrors What It Analyzes');
  blank();
  w('This framework uses EO operators to analyze code that implements EO operators.');
  w('The analysis is recursive — it IS the thing it describes:');
  blank();
  w('| Op | Analysis Does | Code Does | Reflection |');
  w('|----|--------------|-----------|------------|');
  for (const m of SELF_REFERENCE_MAPPINGS) {
    w(`| **${m.analysisOp}** | ${m.analysisAction.slice(0, 45)}... | ${m.codeAction.slice(0, 40)}... | ${m.reflection.slice(0, 45)}... |`);
  }
  blank();

  // ─── Reading Guide ─────────────────────────────────────────────────
  w('---');
  blank();
  w('## Reading Guide — How to Navigate the Codebase');
  blank();
  w('### Start with the cube (understand the model):');
  w('1. **`about.md` §10** — The three axes, the product category, the faces');
  w('2. **`src/db/types.ts`** — The nine operators, EoEvent, EoState, HorizonResponse');
  blank();
  w('### Then the Act face (how events become state):');
  w('3. **`src/db/fold.ts`** — The fold engine: nine-operator switch');
  w('4. **`github-matrix-dev/app/src/db/fold.ts`** — Browser fold (port of server)');
  blank();
  w('### Then the Site face (how state is observed):');
  w('5. **`github-matrix-dev/app/src/db/horizon.ts`** — Six-layer read model');
  w('6. **`github-matrix-dev/app/src/store/eo-store.ts`** — Zustand store (dispatch, horizon)');
  blank();
  w('### Then the Resolution face (how conflicts resolve):');
  w('7. **`src/db/fold.ts` handleDEF/handleEVA** — Conflict operand, formula registration');
  w('8. **`github-matrix-dev/app/src/matrix/sync-manager.ts`** — Distributed conflict resolution');
  blank();
  w('### Data flow (the circular pipeline):');
  w('```');
  w('User action → ComposeView → dispatch() → fold.processEvent()');
  w('  → IndexedDB (log + state + graph) → Horizon → UI re-render');
  w('  → SyncManager → Matrix room → other devices → their fold');
  w('  → [User acts again — the cycle continues]');
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
    SEG: 'Architecture layers + cube boundary',
    INS: 'Code entities + flow stages + cube cells',
    DEF: 'Module properties + operator map + cube faces',
    CON: 'Import edges + flow connections + face links',
    SYN: 'Server/browser equivalences + self-reference mappings',
    EVA: 'Governance rules and constraints',
    REC: 'Import cycles + transformation cycle',
    SIG: 'Complexity hotspots and patterns',
    NUL: 'Well-contained modules (no action)',
  };
  for (const op of ['SEG', 'INS', 'DEF', 'CON', 'SYN', 'EVA', 'REC', 'SIG', 'NUL']) {
    w(`| **${op}** | ${opCounts.get(op) || 0} | ${opDescriptions[op]} |`);
  }
  blank();
  w(`**Total: ${data.events.length} events** across three layers of analysis.`);
  blank();
  w('```');
  w('Layer 1 (Act face):       Code structure → operators');
  w('Layer 2 (Site face):      Data flow → observation positions');
  w('Layer 3 (Resolution face): Capacity cube → conflict strategies');
  w('```');
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
