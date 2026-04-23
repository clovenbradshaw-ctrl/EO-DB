/**
 * Airtable field type → EO-DB column type mapping.
 *
 * Used during ingestion to auto-set the `.type` DEF on schema fields.
 */

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

/**
 * Result of mapping an Airtable field type. When the raw type is not in
 * `AIRTABLE_TYPE_MAP`, `unknown` carries the raw string so callers can
 * distinguish "legitimately a text field" from "unmapped, defaulted to text".
 */
export type MappedAirtableType =
  | { type: string; unknown?: undefined }
  | { type: 'text'; unknown: string };

/**
 * Map an Airtable field type string to the corresponding EO-DB column type.
 * Returns `{ type: 'text', unknown: rawType }` as a fallback so callers can
 * detect unmapped types and surface a telemetry event rather than silently
 * coercing every new Airtable field type to `'text'`.
 */
export function mapAirtableType(airtableType: string): MappedAirtableType {
  const mapped = AIRTABLE_TYPE_MAP[airtableType];
  if (mapped != null) return { type: mapped };
  return { type: 'text', unknown: airtableType };
}
