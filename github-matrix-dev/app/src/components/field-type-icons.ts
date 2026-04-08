/** Shared Airtable field type → display symbol and color mapping. */

export const AIRTABLE_TYPE_ICONS: Record<string, string> = {
  singleLineText: 'T',
  multilineText: 'T',
  richText: 'T',
  email: '@',
  url: '\u2197',
  phoneNumber: '#',
  number: '#',
  currency: '$',
  percent: '%',
  rating: '\u2605',
  checkbox: '\u2610',
  date: '\u25A1',
  dateTime: '\u25A1',
  duration: '\u25CB',
  autoNumber: '##',
  formula: 'f()',
  rollup: '\u03A3',
  count: 'N',
  lookup: '\u2197',
  singleSelect: '\u25CE',
  multipleSelects: '\u25CE',
  multipleRecordLinks: '\u21C4',
  multipleAttachments: '\u2399',
  multipleCollaborators: '\u2689',
  singleCollaborator: '\u2689',
  createdBy: '\u2689',
  lastModifiedBy: '\u2689',
  createdTime: '\u25CB',
  lastModifiedTime: '\u25CB',
  externalSyncSource: '\u2B07',
  button: '\u25A1',
  aiText: 'AI',
  barcode: '\u2AFF',
};

/** Muted color token names per Airtable type family.
 *  Values are CSS colors; designed for use against a dark/muted background chip. */
export const AIRTABLE_TYPE_COLORS: Record<string, string> = {
  // Text family
  singleLineText: '#7eb8f7',
  multilineText: '#7eb8f7',
  richText: '#7eb8f7',
  email: '#7eb8f7',
  url: '#7eb8f7',
  phoneNumber: '#7eb8f7',
  // Number family
  number: '#a8d8a0',
  currency: '#a8d8a0',
  percent: '#a8d8a0',
  rating: '#a8d8a0',
  autoNumber: '#a8d8a0',
  count: '#a8d8a0',
  // Date family
  date: '#f7c97e',
  dateTime: '#f7c97e',
  duration: '#f7c97e',
  createdTime: '#f7c97e',
  lastModifiedTime: '#f7c97e',
  // Select family
  singleSelect: '#c9a8f7',
  multipleSelects: '#c9a8f7',
  // Link family
  multipleRecordLinks: '#f78fb3',
  lookup: '#f78fb3',
  // Formula / rollup family
  formula: '#f7d07e',
  rollup: '#f7d07e',
  // People
  multipleCollaborators: '#a0c4d8',
  singleCollaborator: '#a0c4d8',
  createdBy: '#a0c4d8',
  lastModifiedBy: '#a0c4d8',
  // Checkbox
  checkbox: '#8fd8b0',
  // Default
  multipleAttachments: '#d8c4a0',
  button: '#b0b0b0',
  aiText: '#e0a8f7',
};

export function getAirtableTypeIcon(type: string): string {
  return AIRTABLE_TYPE_ICONS[type] ?? '?';
}

export function getAirtableTypeColor(type: string): string {
  return AIRTABLE_TYPE_COLORS[type] ?? '#888';
}
