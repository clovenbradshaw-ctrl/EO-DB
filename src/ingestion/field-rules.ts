/**
 * Field-type classification for Airtable → EO ingestion.
 *
 * Mirrors the browser copy at github-matrix-dev/app/src/ingestion/field-rules.ts.
 *
 * Computed field types (formula, rollup, lookup, count) are DEF'd — Airtable
 * already evaluates them, so we ingest their values as definitions.
 * Link fields map to CON, fold-computed metadata (lastModifiedTime,
 * lastModifiedBy) are EVA, everything else is DEF.
 *
 * Source of truth: amino-eo buildSpecs.md §6.8
 */

/**
 * Computed field types — ingested as DEF.
 * Airtable evaluates these server-side; we store their resolved values.
 * The formula expressions are stored separately as schema constraints.
 */
export const COMPUTED_TYPES = new Set([
  'formula',
  'rollup',
  'lookup',
  'count',
]);

/** Metadata fields whose values are ingested as DEFs (factual, set once). */
export const INGESTABLE_METADATA = new Set([
  'createdTime',
  'createdBy',
  'autoNumber',
]);

/** Metadata fields whose values are computed at fold via EVA. */
export const FOLD_METADATA = new Set([
  'lastModifiedTime',
  'lastModifiedBy',
]);

/** Link field types — emit CON instead of DEF. */
export const LINK_TYPES = new Set([
  'multipleRecordLinks',
]);

/** All types whose values should be skipped during ingestion. */
export const SKIP_VALUE_TYPES = new Set<string>([
]);

export type FieldClassification = 'def' | 'con' | 'eva' | 'skip';

/**
 * Classify an Airtable field type into its EO operator category.
 * - 'eva': fold-computed metadata — values derived at fold time
 * - 'con': link fields — emit CON events
 * - 'def': stored value fields — emit DEF events (includes computed types)
 */
export function classifyFieldType(type: string): FieldClassification {
  if (FOLD_METADATA.has(type)) return 'eva';
  if (LINK_TYPES.has(type)) return 'con';
  return 'def';
}
