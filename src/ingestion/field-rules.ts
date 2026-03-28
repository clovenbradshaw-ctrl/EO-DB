/**
 * Field-type classification for Airtable → EO ingestion.
 *
 * Mirrors the amino-eo classifier's field-rules: computed and metadata fields
 * are skipped (they're Horizon outputs that change without user action and
 * cause false "updates"), link fields map to CON, everything else to DEF.
 *
 * Source of truth: amino-eo buildSpecs.md §6.8
 */

/** Computed field types — skip (Horizon outputs, can't be written back). */
export const COMPUTED_TYPES = new Set([
  'formula',
  'rollup',
  'lookup',
  'count',
]);

/** Metadata field types — skip (auto-populated by Airtable). */
export const METADATA_TYPES = new Set([
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'autoNumber',
]);

/** Link field types — emit CON instead of DEF. */
export const LINK_TYPES = new Set([
  'multipleRecordLinks',
]);

/** All types whose values should be skipped entirely. */
export const SKIP_VALUE_TYPES = new Set([
  ...COMPUTED_TYPES,
  ...METADATA_TYPES,
]);

export type FieldClassification = 'def' | 'con' | 'skip';

/**
 * Classify an Airtable field type into its EO operator category.
 * - 'skip': computed/metadata fields — no value events emitted
 * - 'con': link fields — emit CON events
 * - 'def': stored value fields — emit DEF events
 */
export function classifyFieldType(type: string): FieldClassification {
  if (SKIP_VALUE_TYPES.has(type)) return 'skip';
  if (LINK_TYPES.has(type)) return 'con';
  return 'def';
}
