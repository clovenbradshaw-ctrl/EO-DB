/**
 * Re-export shim. The real implementation lives in `src/shared/airtable/`
 * at the repo root and is consumed by both the browser app (here) and the
 * Fastify server. Typed error classes are re-exported so callers can
 * `instanceof`-check them instead of pattern-matching error strings.
 */

export * from '../../../../src/shared/airtable/client';
export * from '../../../../src/shared/airtable/errors';
