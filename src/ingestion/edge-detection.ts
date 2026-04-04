/**
 * Edge Detection Pipeline — discovers entities and resolves relationships
 * from arbitrary JSON/CSV data using user-supplied DEF declarations.
 *
 * Pipeline steps follow the EO helix:
 *   1. SIG  — Discover collections, ID fields, ID patterns
 *   2. INS  — Populate every entity into the registry
 *   3. CON  — Resolve DEF'd fields into explicit edges
 *   4. SYN  — (Optional) Infer co-occurrence edges from array fields
 *
 * This module is a pure, synchronous data transformation with no dependencies
 * on LevelDB, the fold engine, or any async I/O.
 */

import { parseCsvLines } from './log-import.js';
import type { ImportEventRow } from './log-import.js';

// ─── Input Types ─────────────────────────────────────────────────────────────

/** A single DEF declaration parsed from user text. */
export interface DefDeclaration {
  sourceCollection: string;
  sourceField: string;
  targetCollection: string;   // "*" for wildcard
  delimiter?: string;
}

/** Options controlling pipeline execution and output. */
export interface PipelineOptions {
  format: 'json' | 'csv';
  csvCollectionName?: string;
  csvDelimiter?: string;
  outputMode?: 'explicit' | 'inferred' | 'both';
  inferCooccurrence?: boolean;
}

// ─── Registry Types ──────────────────────────────────────────────────────────

/** Metadata about a discovered collection. */
export interface CollectionMeta {
  idField: string;
  pattern?: RegExp;
  recordCount: number;
}

/** collection name → metadata */
export type TypeRegistry = Map<string, CollectionMeta>;

/** A single entity in the entity registry. */
export interface EntityEntry {
  collection: string;
  data: Record<string, any>;
}

/** entity ID → entry */
export type EntityRegistry = Map<string, EntityEntry>;

// ─── Edge Types ──────────────────────────────────────────────────────────────

/** An explicit edge resolved from a DEF declaration. */
export interface ExplicitEdge {
  source: string;
  target: string;
  sourceCollection: string;
  targetCollection: string;
  field: string;
  type: 'explicit';
}

/** An unresolved reference from edge resolution. */
export interface UnresolvedRef {
  source: string;
  field: string;
  value: string;
  sourceCollection: string;
  targetCollection: string;
}

/** An inferred co-occurrence edge. */
export interface InferredEdge {
  source: string;
  target: string;
  cooccurrenceCount: number;
  contexts: Array<{ parentId: string; field: string }>;
  type: 'inferred';
}

// ─── Pipeline Result ─────────────────────────────────────────────────────────

export interface EdgeDetectionResult {
  typeRegistry: TypeRegistry;
  entityRegistry: EntityRegistry;
  explicitEdges: ExplicitEdge[];
  inferredEdges: InferredEdge[];
  unresolvedRefs: UnresolvedRef[];
}

// ─── DEF Parser ──────────────────────────────────────────────────────────────

const DEF_REGEX = /^DEF\(\s*(\w+)\.(\w+)\s*(?:→|->)\s*(\w+|\*)\s*(?:,\s*delimiter\s*=\s*"([^"]*)")?\s*\)$/;

export function parseDefDeclarations(text: string): DefDeclaration[] {
  const declarations: DefDeclaration[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const match = line.match(DEF_REGEX);
    if (!match) {
      throw new Error(`Malformed DEF declaration: ${line}`);
    }

    const decl: DefDeclaration = {
      sourceCollection: match[1],
      sourceField: match[2],
      targetCollection: match[3],
    };
    if (match[4] !== undefined) {
      decl.delimiter = match[4];
    }
    declarations.push(decl);
  }

  return declarations;
}

// ─── Step 1: SIG — Discover Structure ────────────────────────────────────────

const ID_PATTERNS: RegExp[] = [
  /^[A-Z]+-\d+$/,              // ATT-001, CASE-123
  /^[A-Z]+_\d+$/,              // ATT_001
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,  // UUID
  /^\d+$/,                      // numeric IDs
];

function detectPattern(values: string[]): RegExp | undefined {
  for (const pattern of ID_PATTERNS) {
    const matchCount = values.filter(v => pattern.test(v)).length;
    if (matchCount / values.length >= 0.9) {
      return pattern;
    }
  }
  return undefined;
}

function findIdField(records: Record<string, any>[]): { idField: string; pattern?: RegExp } {
  if (records.length === 0) {
    return { idField: 'id' };
  }

  // Collect all string-valued fields and their values
  const fieldValues = new Map<string, string[]>();
  for (const record of records) {
    for (const [key, val] of Object.entries(record)) {
      if (val == null) continue;
      const strVal = typeof val === 'string' ? val : typeof val === 'number' ? String(val) : null;
      if (strVal === null) continue;
      if (!fieldValues.has(key)) fieldValues.set(key, []);
      fieldValues.get(key)!.push(strVal);
    }
  }

  // Find fields with full uniqueness (cardinality === record count)
  const candidates: string[] = [];
  for (const [field, values] of fieldValues) {
    if (values.length === records.length && new Set(values).size === records.length) {
      candidates.push(field);
    }
  }

  if (candidates.length === 0) {
    // No fully unique field — pick first string field as fallback
    const firstField = fieldValues.keys().next().value;
    return { idField: firstField ?? 'id' };
  }

  // Preference: "id" > ends with "_id" > first candidate
  let chosen = candidates[0];
  for (const c of candidates) {
    if (c === 'id') { chosen = c; break; }
    if (c.endsWith('_id') && chosen !== 'id') { chosen = c; }
  }

  const values = fieldValues.get(chosen)!;
  const pattern = detectPattern(values);
  return { idField: chosen, pattern };
}

export function discoverStructure(
  collections: Record<string, Record<string, any>[]>,
): TypeRegistry {
  const registry: TypeRegistry = new Map();

  for (const [name, records] of Object.entries(collections)) {
    const { idField, pattern } = findIdField(records);
    registry.set(name, { idField, pattern, recordCount: records.length });
  }

  return registry;
}

// ─── CSV → Collections helper ────────────────────────────────────────────────

export function csvToCollections(
  csvText: string,
  collectionName: string,
  delimiter?: string,
): Record<string, Record<string, any>[]> {
  // Auto-detect delimiter if not specified
  let csvDelimiter = delimiter;
  if (!csvDelimiter) {
    const firstLine = csvText.split(/\r?\n/)[0];
    const tabCount = (firstLine.match(/\t/g) || []).length;
    const commaCount = (firstLine.match(/,/g) || []).length;
    csvDelimiter = tabCount > commaCount ? '\t' : ',';
  }

  const lines = parseCsvLines(csvText, csvDelimiter);
  if (lines.length < 2) {
    throw new Error('CSV must contain a header row and at least one data row');
  }

  const headers = lines[0].map(h => h.trim());
  const records: Record<string, any>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i];
    if (cols.length === 1 && cols[0].trim() === '') continue;
    if (cols.every(c => c.trim() === '')) continue;

    const record: Record<string, any> = {};
    for (let j = 0; j < headers.length; j++) {
      const val = (cols[j] || '').trim();
      if (val === '') continue;
      if (val === 'true') record[headers[j]] = true;
      else if (val === 'false') record[headers[j]] = false;
      else if (val === 'null') record[headers[j]] = null;
      else if (!isNaN(Number(val)) && val !== '') record[headers[j]] = Number(val);
      else record[headers[j]] = val;
    }
    records.push(record);
  }

  return { [collectionName]: records };
}

// ─── Step 2: INS — Populate Entity Registry ─────────────────────────────────

export function populateEntities(
  collections: Record<string, Record<string, any>[]>,
  typeRegistry: TypeRegistry,
): EntityRegistry {
  const registry: EntityRegistry = new Map();

  for (const [collectionName, records] of Object.entries(collections)) {
    const meta = typeRegistry.get(collectionName);
    if (!meta) continue;

    for (const record of records) {
      const id = String(record[meta.idField]);
      if (registry.has(id) && registry.get(id)!.collection === collectionName) {
        throw new Error(`Duplicate ID "${id}" in collection "${collectionName}"`);
      }
      registry.set(id, { collection: collectionName, data: record });
    }
  }

  return registry;
}

// ─── Step 3: DEF → CON — Resolve Edges ──────────────────────────────────────

function normalizeFieldToIds(value: any, delimiter?: string): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map(v => String(v)).filter(v => v !== '' && v !== 'null' && v !== 'undefined');
  }
  const str = String(value);
  if (str === '' || str === 'null' || str === 'undefined') return [];
  if (delimiter) {
    return str.split(delimiter).map(s => s.trim()).filter(s => s !== '');
  }
  return [str];
}

export function resolveEdges(
  declarations: DefDeclaration[],
  collections: Record<string, Record<string, any>[]>,
  typeRegistry: TypeRegistry,
  entityRegistry: EntityRegistry,
): { explicitEdges: ExplicitEdge[]; unresolvedRefs: UnresolvedRef[] } {
  const explicitEdges: ExplicitEdge[] = [];
  const unresolvedRefs: UnresolvedRef[] = [];

  for (const decl of declarations) {
    const records = collections[decl.sourceCollection];
    if (!records) continue;

    const meta = typeRegistry.get(decl.sourceCollection);
    if (!meta) continue;

    for (const record of records) {
      const sourceId = String(record[meta.idField]);
      const candidateIds = normalizeFieldToIds(record[decl.sourceField], decl.delimiter);

      for (const candidateId of candidateIds) {
        const entity = entityRegistry.get(candidateId);
        const isMatch = decl.targetCollection === '*'
          ? entity !== undefined
          : entity !== undefined && entity.collection === decl.targetCollection;

        if (isMatch) {
          explicitEdges.push({
            source: sourceId,
            target: candidateId,
            sourceCollection: decl.sourceCollection,
            targetCollection: entity!.collection,
            field: decl.sourceField,
            type: 'explicit',
          });
        } else {
          unresolvedRefs.push({
            source: sourceId,
            field: decl.sourceField,
            value: candidateId,
            sourceCollection: decl.sourceCollection,
            targetCollection: decl.targetCollection,
          });
        }
      }
    }
  }

  return { explicitEdges, unresolvedRefs };
}

// ─── Step 4: SYN — Infer Co-occurrence Edges ────────────────────────────────

export function inferCooccurrence(
  declarations: DefDeclaration[],
  collections: Record<string, Record<string, any>[]>,
  typeRegistry: TypeRegistry,
  entityRegistry: EntityRegistry,
): InferredEdge[] {
  const accumulator = new Map<string, { count: number; contexts: Array<{ parentId: string; field: string }> }>();

  for (const decl of declarations) {
    const records = collections[decl.sourceCollection];
    if (!records) continue;

    const meta = typeRegistry.get(decl.sourceCollection);
    if (!meta) continue;

    for (const record of records) {
      const sourceId = String(record[meta.idField]);
      const candidateIds = normalizeFieldToIds(record[decl.sourceField], decl.delimiter);

      // Filter to resolved IDs only
      const resolvedIds = candidateIds.filter(id => {
        const entity = entityRegistry.get(id);
        return decl.targetCollection === '*'
          ? entity !== undefined
          : entity !== undefined && entity.collection === decl.targetCollection;
      });

      if (resolvedIds.length < 2) continue;

      // Generate all unordered pairs
      for (let i = 0; i < resolvedIds.length; i++) {
        for (let j = i + 1; j < resolvedIds.length; j++) {
          const a = resolvedIds[i] < resolvedIds[j] ? resolvedIds[i] : resolvedIds[j];
          const b = resolvedIds[i] < resolvedIds[j] ? resolvedIds[j] : resolvedIds[i];
          const key = `${a}::${b}`;

          if (!accumulator.has(key)) {
            accumulator.set(key, { count: 0, contexts: [] });
          }
          const entry = accumulator.get(key)!;
          entry.count++;
          entry.contexts.push({ parentId: sourceId, field: decl.sourceField });
        }
      }
    }
  }

  const edges: InferredEdge[] = [];
  for (const [key, { count, contexts }] of accumulator) {
    const [source, target] = key.split('::');
    edges.push({ source, target, cooccurrenceCount: count, contexts, type: 'inferred' });
  }

  return edges;
}

// ─── Pipeline Orchestrator ───────────────────────────────────────────────────

export function runEdgeDetection(
  rawData: string,
  defText: string,
  options: PipelineOptions,
): EdgeDetectionResult {
  // Parse DEF declarations
  const declarations = parseDefDeclarations(defText);

  // Parse raw data into collections
  let collections: Record<string, Record<string, any>[]>;
  if (options.format === 'json') {
    const parsed = JSON.parse(rawData);
    collections = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
        collections[key] = val as Record<string, any>[];
      }
    }
  } else {
    collections = csvToCollections(
      rawData,
      options.csvCollectionName || 'data',
      options.csvDelimiter,
    );
  }

  // Step 1: SIG
  const typeRegistry = discoverStructure(collections);

  // Step 2: INS
  const entityRegistry = populateEntities(collections, typeRegistry);

  // Step 3: DEF → CON
  const { explicitEdges, unresolvedRefs } = resolveEdges(declarations, collections, typeRegistry, entityRegistry);

  // Step 4: SYN (optional)
  const inferredEdges = options.inferCooccurrence
    ? inferCooccurrence(declarations, collections, typeRegistry, entityRegistry)
    : [];

  // Filter by output mode
  const mode = options.outputMode || 'both';
  return {
    typeRegistry,
    entityRegistry,
    explicitEdges: mode === 'inferred' ? [] : explicitEdges,
    inferredEdges: mode === 'explicit' ? [] : inferredEdges,
    unresolvedRefs,
  };
}

// ─── EO Event Converter ─────────────────────────────────────────────────────

export function toEoEvents(
  result: EdgeDetectionResult,
  targetPrefix: string = 'import',
): ImportEventRow[] {
  const rows: ImportEventRow[] = [];

  // INS events for all entities
  for (const [id, entry] of result.entityRegistry) {
    rows.push({
      op: 'INS',
      target: `${targetPrefix}.${entry.collection}.${id}`,
      operand: entry.data,
    });
  }

  // CON events for explicit edges
  for (const edge of result.explicitEdges) {
    rows.push({
      op: 'CON',
      target: `${targetPrefix}.${edge.sourceCollection}.${edge.source}`,
      operand: {
        added: [`${targetPrefix}.${edge.targetCollection}.${edge.target}`],
        edge_type: edge.field,
      },
    });
  }

  return rows;
}
