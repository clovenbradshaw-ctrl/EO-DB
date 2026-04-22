/**
 * Schema rules — helpers for the decomposed schema target structure.
 *
 * Schema metadata is stored as individually addressable child targets
 * under `scope._schema.{fieldKey}`:
 *
 *   scope._schema.fldX              ← field entity (INS from ingestion)
 *   scope._schema.fldX.type         ← DEF: {type: "number", format: "currency"}
 *   scope._schema.fldX.constraint.gte ← DEF: {value: 0}
 *   scope._schema.fldX.resolve      ← EVA: {strategy: "latest"}
 *
 * One canonical DEF per kind+subject — path uniqueness eliminates conflicts.
 */

import type { EoState, EdgeAttrDef } from './types';

// ─── Target path builders ────────────────────────────────────────────────

export function schemaFieldTarget(scope: string, fieldKey: string): string {
  return `${scope}._schema.${fieldKey}`;
}

export function schemaTypeTarget(scope: string, fieldKey: string): string {
  return `${scope}._schema.${fieldKey}.type`;
}

export function schemaConstraintTarget(
  scope: string,
  fieldKey: string,
  constraintName: string,
): string {
  return `${scope}._schema.${fieldKey}.constraint.${constraintName}`;
}

export function schemaResolveTarget(scope: string, fieldKey: string): string {
  return `${scope}._schema.${fieldKey}.resolve`;
}

// ─── Schema grouping ─────────────────────────────────────────────────────

/** Aggregated schema information for a single field. */
export interface FieldSchema {
  fieldKey: string;
  /** Display name — from parent _schema.{field} value.name or value._label */
  name?: string;
  /** Airtable-provided type — from parent _schema.{field} value.type */
  ingestedType?: string;
  /** User-declared type definition — from .type child (full operand preserved) */
  typeDef?: { target: string; value: any };
  /** Individually addressable constraints — from .constraint.* children */
  constraints: Array<{ target: string; name: string; value: any }>;
  /** Resolution policy — from .resolve child (EVA) */
  resolve?: { target: string; value: any };
}

/**
 * Group schema states by field and classify child targets by kind.
 *
 * Given all states under `scope._schema.*`, partitions them into
 * per-field FieldSchema objects based on the relative path structure.
 */
export function groupSchemaStates(
  schemaStates: EoState[],
  schemaPrefix: string,
): Map<string, FieldSchema> {
  const fields = new Map<string, FieldSchema>();

  for (const state of schemaStates) {
    if (state.value?._alias) continue;

    const rel = state.target.slice(schemaPrefix.length);
    const parts = rel.split('.');
    if (parts.length === 0 || !parts[0]) continue;

    const fieldKey = parts[0];

    if (!fields.has(fieldKey)) {
      fields.set(fieldKey, { fieldKey, constraints: [] });
    }
    const fs = fields.get(fieldKey)!;

    if (parts.length === 1) {
      if (state.value?.name) fs.name = state.value.name;
      if (state.value?._label) fs.name = state.value._label;
      if (state.value?.type) fs.ingestedType = state.value.type;
    } else if (parts.length === 2 && parts[1] === 'type') {
      fs.typeDef = { target: state.target, value: state.value };
    } else if (parts.length === 2 && parts[1] === 'resolve') {
      fs.resolve = { target: state.target, value: state.value };
    } else if (parts.length === 3 && parts[1] === 'constraint') {
      fs.constraints.push({
        target: state.target,
        name: parts[2],
        value: state.value,
      });
    }
  }

  return fields;
}

// ─── Edge attribute extraction ───────────────────────────────────────────

/**
 * Extract edge attribute definitions from a relationship field's constraints.
 *
 * Edge attrs are stored as individual constraints named `edgeAttr_{key}`:
 *   scope._schema.fieldKey.constraint.edgeAttr_role  → { label: "Role", type: "text" }
 */
export function extractEdgeAttrDefs(fs: FieldSchema): EdgeAttrDef[] {
  return fs.constraints
    .filter(c => c.name.startsWith('edgeAttr_'))
    .map(c => ({
      key: c.name.slice('edgeAttr_'.length),
      label: c.value?.label ?? c.name.slice('edgeAttr_'.length),
      type: c.value?.type ?? 'text',
      options: c.value?.options,
    }));
}

// ─── Column type extraction ──────────────────────────────────────────────

/**
 * Extract column type overrides from grouped field schemas.
 *
 * Returns the full type DEF operand (not just the type string) so callers
 * can access format, currency, and other metadata beyond the base type.
 */
export function extractColumnTypeOverrides(
  fieldSchemas: Map<string, FieldSchema>,
): Map<string, any> {
  const overrides = new Map<string, any>();
  for (const [fieldKey, fs] of fieldSchemas) {
    if (fs.typeDef?.value) {
      overrides.set(fieldKey, fs.typeDef.value);
    }
  }
  return overrides;
}
