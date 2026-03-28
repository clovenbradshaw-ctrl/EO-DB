/**
 * Value extraction / normalization for Airtable fields.
 *
 * Airtable returns "Horizon" data alongside stored values — display names
 * on linked records, thumbnail URLs on attachments, labels on select choices.
 * These change without user action (e.g. a linked record's name changes)
 * and cause false diffs if stored as-is.
 *
 * This module strips Horizon data and normalizes values so comparisons
 * only detect actual user-driven changes.
 */

/**
 * Extract the storable value from a raw Airtable field value.
 * Strips Horizon data (display names, URLs) and normalizes to IDs.
 */
export function extractValue(rawValue: unknown, fieldType: string): unknown {
  if (rawValue === undefined || rawValue === null) return null;

  switch (fieldType) {
    case 'singleSelect':
      // Store choice ID only, not label
      return typeof rawValue === 'object' &&
        rawValue !== null &&
        'id' in rawValue
        ? (rawValue as { id: string }).id
        : rawValue;

    case 'multipleSelects':
      // Store choice ID array
      return Array.isArray(rawValue)
        ? rawValue.map((c) =>
            typeof c === 'object' && c !== null && 'id' in c
              ? (c as { id: string }).id
              : c,
          )
        : rawValue;

    case 'multipleRecordLinks':
      // Store linked record IDs only (name is Horizon)
      return Array.isArray(rawValue)
        ? rawValue.map((r) =>
            typeof r === 'object' && r !== null && 'id' in r
              ? (r as { id: string }).id
              : r,
          )
        : rawValue;

    case 'attachment':
      // Store identity only: id, filename, size, type (NOT URL — URLs rotate)
      return Array.isArray(rawValue)
        ? rawValue.map((a) => {
            const att = a as Record<string, unknown>;
            return {
              id: att.id,
              filename: att.filename,
              size: att.size,
              type: att.type,
            };
          })
        : rawValue;

    default:
      return rawValue;
  }
}

/**
 * Stable JSON stringify with sorted object keys for deterministic comparison.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const sorted = Object.keys(obj).sort();
  return (
    '{' +
    sorted
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',') +
    '}'
  );
}

/**
 * Deep equality check using stable stringification.
 * Treats null and undefined as equivalent (both are "empty" in Airtable).
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return stableStringify(a) === stableStringify(b);
}
