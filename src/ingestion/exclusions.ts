/**
 * Sync exclusion policies.
 *
 * Allows configurable filtering of specific fields or field name patterns
 * during Airtable → EO ingestion. Exclusions are cumulative across levels
 * (system + base + table).
 */

export interface SyncExclusions {
  /** Specific field IDs to exclude. */
  fields: string[];
  /** Regex patterns to match against field IDs or names. */
  patterns?: string[];
}

/** Empty exclusions (no fields excluded). */
export const EMPTY_EXCLUSIONS: SyncExclusions = { fields: [], patterns: [] };

/**
 * Check whether a field should be excluded from classification.
 * Matches against both exact field IDs and regex patterns on ID/name.
 */
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

/**
 * Merge exclusion policies from multiple levels (system + base + table).
 * All exclusions are cumulative.
 */
export function mergeExclusions(
  ...levels: SyncExclusions[]
): SyncExclusions {
  const fields = new Set<string>();
  const patterns = new Set<string>();
  for (const level of levels) {
    for (const f of level.fields) fields.add(f);
    if (level.patterns) {
      for (const p of level.patterns) patterns.add(p);
    }
  }
  return {
    fields: [...fields],
    patterns: [...patterns],
  };
}
