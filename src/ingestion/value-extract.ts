/**
 * Value extraction / normalization for Airtable fields.
 *
 * Airtable returns "Horizon" data alongside stored values — display names
 * on linked records, rotating thumbnail URLs on attachments, etc.
 * These change without user action (e.g. a linked record's name changes)
 * and cause false diffs if stored as-is.
 *
 * This module strips Horizon data and normalizes values so comparisons
 * only detect actual user-driven changes.
 *
 * Select choices (singleSelect, multipleSelects) keep id + name + color
 * because those are user-authored configuration, not Horizon.
 *
 * Attachments store identity only (id, filename, size, type). URLs are
 * NOT stored — they rotate and must be generated via API on use.
 */

/**
 * Extract the storable value from a raw Airtable field value.
 * Strips Horizon data (display names, URLs) and normalizes to IDs.
 */
export function extractValue(rawValue: unknown, fieldType: string): unknown {
  if (rawValue === undefined || rawValue === null) return null;

  switch (fieldType) {
    case 'singleSelect':
    case 'multipleSelects':
      // Keep as-is — id, name, color are all user-authored config
      return rawValue;

    case 'lastModifiedBy':
    case 'createdBy':
    case 'collaborator':
      if (typeof rawValue === 'object' && rawValue !== null) {
        const c = rawValue as Record<string, unknown>;
        return { id: c.id, name: c.name };
      }
      return rawValue;

    case 'collaborators':
      if (Array.isArray(rawValue)) {
        return rawValue.map((c) =>
          typeof c === 'object' && c !== null
            ? { id: (c as Record<string, unknown>).id, name: (c as Record<string, unknown>).name }
            : c,
        );
      }
      return rawValue;

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
