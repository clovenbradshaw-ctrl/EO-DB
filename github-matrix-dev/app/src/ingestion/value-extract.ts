/**
 * Value extraction / normalization for Airtable fields.
 *
 * Strips Horizon data (display names, rotating URLs) and normalizes
 * values so comparisons only detect actual user-driven changes.
 */

export function extractValue(rawValue: unknown, fieldType: string): unknown {
  if (rawValue === undefined || rawValue === null) return null;

  switch (fieldType) {
    case 'singleSelect':
    case 'multipleSelects':
      return rawValue;

    case 'multipleRecordLinks':
      return Array.isArray(rawValue)
        ? rawValue.map((r) =>
            typeof r === 'object' && r !== null && 'id' in r
              ? (r as { id: string }).id
              : r,
          )
        : rawValue;

    case 'attachment':
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

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return stableStringify(a) === stableStringify(b);
}
