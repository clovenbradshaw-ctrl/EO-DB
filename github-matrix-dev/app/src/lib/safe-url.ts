const DEFAULT_SCHEMES: ReadonlyArray<string> = ['http:', 'https:', 'mailto:', 'tel:'];

/**
 * Returns the input URL if it parses and uses one of the allowed schemes,
 * otherwise null. Rejects javascript:, data:, vbscript:, file:, and any
 * scheme outside the allowlist so that user-supplied values can be safely
 * bound to <a href>, <img src>, etc.
 */
export function safeUrl(value: unknown, allowedSchemes: ReadonlyArray<string> = DEFAULT_SCHEMES): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const allow = new Set(allowedSchemes.map((s) => (s.endsWith(':') ? s.toLowerCase() : `${s.toLowerCase()}:`)));
  try {
    const url = new URL(trimmed, typeof window !== 'undefined' ? window.location.href : 'http://localhost');
    return allow.has(url.protocol.toLowerCase()) ? url.toString() : null;
  } catch {
    return null;
  }
}
