/**
 * Airtable field type → EO-DB column type mapping.
 *
 * Used during ingestion to auto-set the `.type` DEF on schema fields.
 * Three accessors:
 *   - `mapAirtableType`       — silent 'text' fallback, for back-compat
 *   - `mapAirtableTypeOrNull` — returns null for unknown types (projection)
 *   - `mapAirtableTypeStrict` — throws UnknownFieldTypeError for unknown types
 */

import { UnknownFieldTypeError } from './errors.js';

export const AIRTABLE_TYPE_MAP: Record<string, string> = {
  singleLineText:         'text',
  multilineText:          'text',
  barcode:                'text',
  richText:               'richText',
  email:                  'email',
  url:                    'url',
  phoneNumber:            'phone',
  number:                 'number',
  currency:               'currency',
  percent:                'percent',
  rating:                 'rating',
  duration:               'duration',
  singleSelect:           'select',
  multipleSelects:        'multiSelect',
  date:                   'date',
  dateTime:               'date',
  checkbox:               'boolean',
  multipleAttachments:    'attachment',
  multipleRecordLinks:    'linkedRecord',
  singleCollaborator:     'collaborator',
  multipleCollaborators:  'collaborators',
  externalSyncSource:     'link',
  formula:                'formula',
  rollup:                 'rollup',
  lookup:                 'lookup',
  count:                  'count',
  autoNumber:             'autoNumber',
  createdTime:            'createdTime',
  lastModifiedTime:       'lastModifiedTime',
  createdBy:              'createdBy',
  lastModifiedBy:         'lastModifiedBy',
};

/** Map an Airtable field type to EO-DB column type. Unknown → 'text'. */
export function mapAirtableType(airtableType: string): string {
  return AIRTABLE_TYPE_MAP[airtableType] ?? 'text';
}

/** Like {@link mapAirtableType} but returns null for unrecognized types. */
export function mapAirtableTypeOrNull(airtableType: string): string | null {
  return AIRTABLE_TYPE_MAP[airtableType] ?? null;
}

/** Like {@link mapAirtableType} but throws {@link UnknownFieldTypeError} for unrecognized types. */
export function mapAirtableTypeStrict(airtableType: string): string {
  const mapped = AIRTABLE_TYPE_MAP[airtableType];
  if (mapped === undefined) throw new UnknownFieldTypeError(airtableType);
  return mapped;
}
