/**
 * Sync exclusion policies for Airtable → EO ingestion.
 */

export interface SyncExclusions {
  fields: string[];
  patterns?: string[];
}

export const EMPTY_EXCLUSIONS: SyncExclusions = { fields: [], patterns: [] };

export function isExcluded(
  fieldId: string,
  fieldName: string,
  exclusions: SyncExclusions,
): boolean {
  if (exclusions.fields.includes(fieldId)) return true;
  if (exclusions.patterns) {
    for (const pattern of exclusions.patterns) {
      const re = new RegExp(pattern);
      if (re.test(fieldId) || re.test(fieldName)) return true;
    }
  }
  return false;
}
