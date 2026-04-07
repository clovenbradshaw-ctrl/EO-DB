/**
 * Field-type classification for Airtable → EO ingestion.
 *
 * Mirrors the browser copy at github-matrix-dev/app/src/ingestion/field-rules.ts.
 *
 * Computed fields are skipped (they're Horizon outputs that change without
 * user action and cause false "updates"), link fields map to CON, fold-computed
 * metadata (lastModifiedTime, lastModifiedBy) are EVA, everything else is DEF.
 *
 * Source of truth: amino-eo buildSpecs.md §6.8
 */

/** Computed field types — skip (Horizon outputs, values come from fold). */
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
export const SKIP_VALUE_TYPES = new Set([
  ...COMPUTED_TYPES,
]);

export type FieldClassification = 'def' | 'con' | 'eva' | 'skip';

/**
 * Classify an Airtable field type into its EO operator category.
 * - 'skip': computed fields — no value events emitted
 * - 'eva': fold-computed metadata — values derived at fold time
 * - 'con': link fields — emit CON events
 * - 'def': stored value fields — emit DEF events
 */
export function classifyFieldType(type: string): FieldClassification {
  if (COMPUTED_TYPES.has(type)) return 'skip';
  if (FOLD_METADATA.has(type)) return 'eva';
  if (LINK_TYPES.has(type)) return 'con';
  return 'def';
}
