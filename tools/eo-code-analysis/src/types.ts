/**
 * EO Code Analysis Framework — Type Definitions
 *
 * Uses EO's nine operators as a lens to model code structure:
 *   INS  → Code entities come into existence (files, functions, components)
 *   DEF  → Properties assigned (line counts, exports, descriptions)
 *   CON  → Connections between entities (imports, calls, type refs)
 *   SEG  → Boundaries drawn (directories, architectural layers)
 *   SYN  → Equivalences identified (server ↔ browser ports)
 *   EVA  → Rules governing the codebase (tsconfig, lint, architecture constraints)
 *   REC  → Circular dependencies detected
 *   SIG  → Complexity hotspots and notable patterns surfaced
 *   NUL  → Entities observed but requiring no action
 */

// Re-use the canonical operator type
export type Operator = 'NUL' | 'SIG' | 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'REC';

// ─── Scanner output ──────────────────────────────────────────────────────────

export interface FileInfo {
  path: string;            // absolute path
  relativePath: string;    // relative to repo root
  lines: number;
  imports: ImportInfo[];
  exports: ExportInfo[];
  functions: FunctionInfo[];
  interfaces: InterfaceInfo[];
  types: TypeInfo[];
  components: ComponentInfo[];
}

export interface ImportInfo {
  source: string;
  specifiers: string[];
  isDefault: boolean;
  isTypeOnly: boolean;
  line: number;
}

export interface ExportInfo {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'default' | 'enum' | 'other';
  line: number;
  isDefault: boolean;
}

export interface FunctionInfo {
  name: string;
  line: number;
  endLine: number;
  isExported: boolean;
  isAsync: boolean;
}

export interface InterfaceInfo {
  name: string;
  line: number;
  fieldCount: number;
  isExported: boolean;
}

export interface TypeInfo {
  name: string;
  line: number;
  isExported: boolean;
}

export interface ComponentInfo {
  name: string;
  line: number;
  isExported: boolean;
  hooks: string[];
}

// ─── Architecture layers ─────────────────────────────────────────────────────

export interface ArchitectureLayer {
  id: string;
  name: string;
  description: string;
  pathPrefix: string;
  parent?: string;
}

// ─── Analysis events (EO-format) ─────────────────────────────────────────────

export interface AnalysisEvent {
  seq: number;
  op: Operator;
  target: string;
  operand: unknown;
  agent: string;
  ts: string;
  client_event_id: string;
}

// ─── Analysis results ────────────────────────────────────────────────────────

export interface LayerSummary {
  layer: ArchitectureLayer;
  fileCount: number;
  totalLines: number;
  exportCount: number;
  topFiles: { path: string; lines: number }[];
}

export interface ConnectionSummary {
  sourceLayer: string;
  targetLayer: string;
  weight: number;
  examples: string[];
}

export interface EquivalencePair {
  serverPath: string;
  browserPath: string;
  description: string;
}

export interface Hotspot {
  path: string;
  reason: string;
  score: number;
  metrics: Record<string, number>;
}

export interface CyclePath {
  files: string[];
}

export interface AnalysisStats {
  totalFiles: number;
  totalLines: number;
  totalFunctions: number;
  totalComponents: number;
  totalInterfaces: number;
  totalTypes: number;
  totalImportEdges: number;
  totalExports: number;
}

export interface AnalysisResult {
  events: AnalysisEvent[];
  files: FileInfo[];
  layers: LayerSummary[];
  crossLayerConnections: ConnectionSummary[];
  equivalences: EquivalencePair[];
  hotspots: Hotspot[];
  cycles: CyclePath[];
  stats: AnalysisStats;
}
