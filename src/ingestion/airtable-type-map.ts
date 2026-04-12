/**
 * Airtable field type → EO-DB column type mapping.
 *
 * Used during ingestion to auto-set the `.type` DEF on schema fields.
 * Keep in sync with the client copy at github-matrix-dev/app/src/ingestion/airtable-type-map.ts.
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

/** Map an Airtable field type string to the corresponding EO-DB column type. */
export function mapAirtableType(airtableType: string): string {
  return AIRTABLE_TYPE_MAP[airtableType] ?? 'text';
}
