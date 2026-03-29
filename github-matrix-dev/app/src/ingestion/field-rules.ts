/**
 * Field-type classification for Airtable → EO ingestion.
 *
 * Computed and metadata fields are skipped (they're Horizon outputs that
 * change without user action and cause false "updates"), link fields map
 * to CON, everything else to DEF.
 */

export const COMPUTED_TYPES = new Set([
  'formula',
  'rollup',
  'lookup',
  'count',
]);

export const METADATA_TYPES = new Set([
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'autoNumber',
]);

export const LINK_TYPES = new Set([
  'multipleRecordLinks',
]);

export const SKIP_VALUE_TYPES = new Set([
  ...COMPUTED_TYPES,
  ...METADATA_TYPES,
]);

export type FieldClassification = 'def' | 'con' | 'skip';

export function classifyFieldType(type: string): FieldClassification {
  if (SKIP_VALUE_TYPES.has(type)) return 'skip';
  if (LINK_TYPES.has(type)) return 'con';
  return 'def';
}
