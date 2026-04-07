/**
 * EO Operator Mapper — Maps scanned code entities to EO operator semantics.
 *
 * Operator mapping:
 *   INS  → File/module/function/component existence
 *   DEF  → Properties: line count, export count, complexity metrics
 *   CON  → Import relationships, cross-layer dependencies
 *   SEG  → Architecture layer boundaries
 *   SYN  → Server ↔ browser equivalent modules
 *   EVA  → TypeScript strict mode rules, architecture constraints
 *   REC  → Import cycles detected in the dependency graph
 *   SIG  → Complexity hotspots, unusually large files, high fan-in/out
 *   NUL  → Files observed with no notable signals
 */

import * as path from 'node:path';
import type {
  FileInfo,
  AnalysisEvent,
  ArchitectureLayer,
  LayerSummary,
  ConnectionSummary,
  Hotspot,
  CyclePath,
  AnalysisStats,
} from './types.js';
import { LAYERS, EQUIVALENCES, resolveLayer } from './layers.js';

let seq = 0;
const ts = new Date().toISOString();
const agent = 'eo-code-analysis';

function emit(op: AnalysisEvent['op'], target: string, operand: unknown): AnalysisEvent {
  seq++;
  return {
    seq,
    op,
    target,
    operand,
    agent,
    ts,
    client_event_id: `analysis-${op.toLowerCase()}-${seq}`,
  };
}

// ─── Main mapping pipeline ───────────────────────────────────────────────────

export interface MappingResult {
  events: AnalysisEvent[];
  layers: LayerSummary[];
  crossLayerConnections: ConnectionSummary[];
  hotspots: Hotspot[];
  cycles: CyclePath[];
  stats: AnalysisStats;
}

export function mapToEoOperators(files: FileInfo[]): MappingResult {
  const events: AnalysisEvent[] = [];
  seq = 0;

  // 1. SEG — Emit architecture layer boundaries
  const layerEvents = emitLayers();
  events.push(...layerEvents);

  // 2. INS + DEF — Emit file existence and properties
  for (const file of files) {
    events.push(...emitFileEntities(file));
  }

  // 3. CON — Emit import connections
  const importGraph = buildImportGraph(files);
  for (const [source, targets] of importGraph.entries()) {
    for (const target of targets) {
      events.push(emit('CON', `code.${normalizeTarget(source)}`, {
        dest: `code.${normalizeTarget(target)}`,
        edge_type: 'imports',
      }));
    }
  }

  // 4. SYN — Emit server ↔ browser equivalences
  for (const eq of EQUIVALENCES) {
    events.push(emit('SYN', `code.${normalizeTarget(eq.serverPath)}`, {
      alias: `code.${normalizeTarget(eq.browserPath)}`,
      description: eq.description,
    }));
  }

  // 5. EVA — Emit governance rules
  events.push(...emitGovernanceRules());

  // 6. REC — Detect and emit import cycles
  const cycles = detectCycles(importGraph);
  for (const cycle of cycles) {
    events.push(emit('REC', `code.cycle.${cycle.files.map(f => path.basename(f, path.extname(f))).join('_')}`, {
      participants: cycle.files.map(f => `code.${normalizeTarget(f)}`),
      kind: 'import-cycle',
    }));
  }

  // 7. SIG — Detect complexity hotspots
  const hotspots = detectHotspots(files, importGraph);
  for (const hotspot of hotspots) {
    events.push(emit('SIG', `code.${normalizeTarget(hotspot.path)}`, {
      signal: hotspot.reason,
      score: hotspot.score,
      metrics: hotspot.metrics,
    }));
  }

  // 8. NUL — Files with no signals (simple, well-contained)
  const signaled = new Set(hotspots.map(h => h.path));
  for (const file of files) {
    if (!signaled.has(file.relativePath) && file.lines < 50 && file.exports.length <= 2) {
      events.push(emit('NUL', `code.${normalizeTarget(file.relativePath)}`, {
        observation: 'small, well-contained module',
      }));
    }
  }

  // Compute summaries
  const layers = computeLayerSummaries(files);
  const crossLayerConnections = computeCrossLayerConnections(files, importGraph);
  const stats = computeStats(files, importGraph);

  return { events, layers, crossLayerConnections, hotspots, cycles, stats };
}

// ─── SEG: Layer boundaries ───────────────────────────────────────────────────

function emitLayers(): AnalysisEvent[] {
  const events: AnalysisEvent[] = [];
  for (const layer of LAYERS) {
    events.push(emit('SEG', `arch.${layer.id}`, {
      name: layer.name,
      description: layer.description,
      pathPrefix: layer.pathPrefix,
      parent: layer.parent ? `arch.${layer.parent}` : undefined,
    }));
  }
  return events;
}

// ─── INS + DEF: File entities ────────────────────────────────────────────────

function emitFileEntities(file: FileInfo): AnalysisEvent[] {
  const events: AnalysisEvent[] = [];
  const target = `code.${normalizeTarget(file.relativePath)}`;
  const layer = resolveLayer(file.relativePath);

  // INS — file exists
  events.push(emit('INS', target, {
    kind: 'file',
    layer: layer?.id ?? 'root',
    extension: path.extname(file.relativePath),
  }));

  // DEF — file properties
  events.push(emit('DEF', `${target}._metrics`, {
    lines: file.lines,
    importCount: file.imports.length,
    exportCount: file.exports.length,
    functionCount: file.functions.length,
    interfaceCount: file.interfaces.length,
    typeCount: file.types.length,
    componentCount: file.components.length,
  }));

  // INS — exported functions
  for (const fn of file.functions.filter(f => f.isExported)) {
    events.push(emit('INS', `${target}.fn.${fn.name}`, {
      kind: 'function',
      line: fn.line,
      bodyLines: fn.endLine - fn.line,
      async: fn.isAsync,
    }));
  }

  // INS — interfaces
  for (const iface of file.interfaces.filter(i => i.isExported)) {
    events.push(emit('INS', `${target}.iface.${iface.name}`, {
      kind: 'interface',
      line: iface.line,
      fieldCount: iface.fieldCount,
    }));
  }

  // INS — types
  for (const type of file.types.filter(t => t.isExported)) {
    events.push(emit('INS', `${target}.type.${type.name}`, {
      kind: 'type',
      line: type.line,
    }));
  }

  // INS — React components
  for (const comp of file.components) {
    events.push(emit('INS', `${target}.component.${comp.name}`, {
      kind: 'component',
      line: comp.line,
      hooks: comp.hooks,
    }));
  }

  return events;
}

// ─── CON: Import graph ───────────────────────────────────────────────────────

function buildImportGraph(files: FileInfo[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const fileSet = new Set(files.map(f => f.relativePath));

  for (const file of files) {
    const targets = new Set<string>();

    for (const imp of file.imports) {
      // Resolve relative imports to file paths
      if (imp.source.startsWith('.')) {
        const dir = path.dirname(file.relativePath);
        let resolved = path.normalize(path.join(dir, imp.source));
        // Strip extension if present, then try to find the file
        resolved = resolved.replace(/\.(js|ts|tsx)$/, '');

        // Try common extensions
        for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
          const candidate = resolved + ext;
          if (fileSet.has(candidate)) {
            targets.add(candidate);
            break;
          }
        }
      }
    }

    if (targets.size > 0) {
      graph.set(file.relativePath, targets);
    }
  }

  return graph;
}

// ─── EVA: Governance rules ───────────────────────────────────────────────────

function emitGovernanceRules(): AnalysisEvent[] {
  return [
    emit('EVA', 'arch.rules.strict-typescript', {
      rule: 'TypeScript strict mode enabled',
      scope: 'github-matrix-dev/app/',
      enforcement: 'tsc -b --noEmit before every commit',
    }),
    emit('EVA', 'arch.rules.no-server-dependency', {
      rule: 'Browser app must not import from src/',
      scope: 'github-matrix-dev/app/src/',
      enforcement: 'architecture boundary',
    }),
    emit('EVA', 'arch.rules.immutable-log', {
      rule: 'Events in the log are immutable — no updates, no deletes',
      scope: 'all',
      enforcement: 'fold engine design',
    }),
    emit('EVA', 'arch.rules.nine-operators', {
      rule: 'All mutations expressed through exactly nine operators',
      scope: 'all',
      operators: ['NUL', 'SIG', 'INS', 'SEG', 'CON', 'SYN', 'DEF', 'EVA', 'REC'],
    }),
    emit('EVA', 'arch.rules.fold-determinism', {
      rule: 'Fold must be deterministic — same events → same state',
      scope: 'src/db/fold.ts, github-matrix-dev/app/src/db/fold.ts',
      enforcement: 'event sourcing invariant',
    }),
  ];
}

// ─── REC: Cycle detection ────────────────────────────────────────────────────

function detectCycles(graph: Map<string, Set<string>>): CyclePath[] {
  const cycles: CyclePath[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string) {
    if (inStack.has(node)) {
      // Found a cycle — extract it
      const cycleStart = stack.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push({ files: [...stack.slice(cycleStart), node] });
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    stack.push(node);

    const neighbors = graph.get(node);
    if (neighbors) {
      for (const neighbor of neighbors) {
        dfs(neighbor);
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  for (const node of graph.keys()) {
    dfs(node);
  }

  return cycles;
}

// ─── SIG: Hotspot detection ──────────────────────────────────────────────────

function detectHotspots(files: FileInfo[], importGraph: Map<string, Set<string>>): Hotspot[] {
  const hotspots: Hotspot[] = [];

  // Compute fan-in (how many files import this one)
  const fanIn = new Map<string, number>();
  for (const [, targets] of importGraph) {
    for (const target of targets) {
      fanIn.set(target, (fanIn.get(target) || 0) + 1);
    }
  }

  for (const file of files) {
    const metrics: Record<string, number> = {
      lines: file.lines,
      imports: file.imports.length,
      exports: file.exports.length,
      functions: file.functions.length,
      components: file.components.length,
      fanIn: fanIn.get(file.relativePath) || 0,
      fanOut: importGraph.get(file.relativePath)?.size || 0,
    };

    let score = 0;
    const reasons: string[] = [];

    // Large file
    if (file.lines > 500) {
      score += Math.floor(file.lines / 100);
      reasons.push(`large file (${file.lines} lines)`);
    }

    // High fan-in (many dependents)
    if (metrics.fanIn > 10) {
      score += metrics.fanIn;
      reasons.push(`high fan-in (${metrics.fanIn} importers)`);
    }

    // High fan-out (many dependencies)
    if (metrics.fanOut > 10) {
      score += metrics.fanOut;
      reasons.push(`high fan-out (${metrics.fanOut} imports)`);
    }

    // Many exports (wide API surface)
    if (file.exports.length > 15) {
      score += Math.floor(file.exports.length / 3);
      reasons.push(`wide API surface (${file.exports.length} exports)`);
    }

    // Long functions
    for (const fn of file.functions) {
      const bodyLines = fn.endLine - fn.line;
      if (bodyLines > 100) {
        score += Math.floor(bodyLines / 25);
        reasons.push(`long function ${fn.name} (${bodyLines} lines)`);
      }
    }

    if (score > 0) {
      hotspots.push({
        path: file.relativePath,
        reason: reasons.join('; '),
        score,
        metrics,
      });
    }
  }

  return hotspots.sort((a, b) => b.score - a.score);
}

// ─── Summary computation ─────────────────────────────────────────────────────

function computeLayerSummaries(files: FileInfo[]): LayerSummary[] {
  const layerFiles = new Map<string, FileInfo[]>();

  for (const file of files) {
    const layer = resolveLayer(file.relativePath);
    const id = layer?.id ?? 'root';
    if (!layerFiles.has(id)) layerFiles.set(id, []);
    layerFiles.get(id)!.push(file);
  }

  return LAYERS.map(layer => {
    const lf = layerFiles.get(layer.id) || [];
    return {
      layer,
      fileCount: lf.length,
      totalLines: lf.reduce((sum, f) => sum + f.lines, 0),
      exportCount: lf.reduce((sum, f) => sum + f.exports.length, 0),
      topFiles: lf
        .sort((a, b) => b.lines - a.lines)
        .slice(0, 5)
        .map(f => ({ path: f.relativePath, lines: f.lines })),
    };
  }).filter(s => s.fileCount > 0);
}

function computeCrossLayerConnections(
  files: FileInfo[],
  importGraph: Map<string, Set<string>>
): ConnectionSummary[] {
  const connections = new Map<string, { weight: number; examples: string[] }>();

  for (const [source, targets] of importGraph) {
    const sourceLayer = resolveLayer(source)?.id ?? 'root';
    for (const target of targets) {
      const targetLayer = resolveLayer(target)?.id ?? 'root';
      if (sourceLayer !== targetLayer) {
        const key = `${sourceLayer} → ${targetLayer}`;
        const conn = connections.get(key) || { weight: 0, examples: [] };
        conn.weight++;
        if (conn.examples.length < 3) {
          conn.examples.push(`${path.basename(source)} → ${path.basename(target)}`);
        }
        connections.set(key, conn);
      }
    }
  }

  return Array.from(connections.entries()).map(([key, value]) => {
    const [sourceLayer, targetLayer] = key.split(' → ');
    return { sourceLayer, targetLayer, weight: value.weight, examples: value.examples };
  }).sort((a, b) => b.weight - a.weight);
}

function computeStats(files: FileInfo[], importGraph: Map<string, Set<string>>): AnalysisStats {
  let totalEdges = 0;
  for (const targets of importGraph.values()) totalEdges += targets.size;

  return {
    totalFiles: files.length,
    totalLines: files.reduce((sum, f) => sum + f.lines, 0),
    totalFunctions: files.reduce((sum, f) => sum + f.functions.length, 0),
    totalComponents: files.reduce((sum, f) => sum + f.components.length, 0),
    totalInterfaces: files.reduce((sum, f) => sum + f.interfaces.length, 0),
    totalTypes: files.reduce((sum, f) => sum + f.types.length, 0),
    totalImportEdges: totalEdges,
    totalExports: files.reduce((sum, f) => sum + f.exports.length, 0),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert a file path to an EO-style dot-separated target path. */
function normalizeTarget(filePath: string): string {
  return filePath
    .replace(/\.(ts|tsx|js|jsx)$/, '')
    .replace(/\//g, '.')
    .replace(/-/g, '_');
}
