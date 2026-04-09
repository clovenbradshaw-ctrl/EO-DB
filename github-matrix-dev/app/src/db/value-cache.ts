/**
 * Layer 5 — Lazy per-field value Maps (main thread).
 *
 * First query on a field triggers a Worker fetch and populates the cache.
 * All subsequent queries for that field return directly from the Map —
 * zero Worker round-trips while the cache is warm.
 *
 * Invalidation is O(1): the Worker posts eventEmitted push notifications
 * when a DEF event is written, and the main thread calls invalidate()
 * to update the affected entry immediately.
 *
 * Eviction is time-based (evictStale), intended to run every 60 seconds
 * via setInterval on the main thread.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface FieldCache {
  values: Map<string, unknown>;  // target → current value
  lastAccess: number;            // Date.now() timestamp
}

export interface ValueCache {
  fields: Map<string, FieldCache>;
}

// ─── createValueCache ─────────────────────────────────────────────────────────

export function createValueCache(): ValueCache {
  return { fields: new Map() };
}

// ─── hasField ────────────────────────────────────────────────────────────────

/**
 * Returns true if the cache for this field has been populated.
 * Does NOT indicate whether any values exist — only that a fetch was done.
 */
export function hasField(cache: ValueCache, field: string): boolean {
  return cache.fields.has(field);
}

// ─── getFieldValue ────────────────────────────────────────────────────────────

/**
 * Return the cached value for target+field, or undefined if not cached.
 * undefined signals "cache miss" — the caller should fetch from the Worker
 * and then call populateField.
 *
 * Updates lastAccess on hit.
 */
export function getFieldValue(
  cache: ValueCache,
  target: string,
  field: string,
): unknown {
  const fc = cache.fields.get(field);
  if (!fc) return undefined;
  if (!fc.values.has(target)) return undefined;
  fc.lastAccess = Date.now();
  return fc.values.get(target);
}

// ─── populateField ────────────────────────────────────────────────────────────

/**
 * Bulk-populate a field cache after a Worker query.
 * Called once per field on first access or when refreshing.
 * Marks the field as "populated" even if entries is empty.
 */
export function populateField(
  cache: ValueCache,
  field: string,
  entries: Array<{ target: string; value: unknown }>,
): void {
  let fc = cache.fields.get(field);
  if (!fc) {
    fc = { values: new Map(), lastAccess: Date.now() };
    cache.fields.set(field, fc);
  }
  fc.lastAccess = Date.now();
  for (const { target, value } of entries) {
    fc.values.set(target, value);
  }
}

// ─── invalidate ───────────────────────────────────────────────────────────────

/**
 * O(1) update of a single target+field cache entry.
 * Called from the onEventEmitted handler when a DEF event arrives.
 *
 * Does nothing if the field cache hasn't been populated yet — the next
 * read will fetch from the Worker anyway.
 */
export function invalidate(
  cache: ValueCache,
  target: string,
  field: string,
  newValue: unknown,
): void {
  const fc = cache.fields.get(field);
  if (!fc) return; // not yet populated; no-op
  fc.values.set(target, newValue);
  fc.lastAccess = Date.now();
}

// ─── evictStale ───────────────────────────────────────────────────────────────

/**
 * Remove FieldCache entries not accessed within maxAgeMs.
 * Intended to run every 60 seconds via setInterval on the main thread.
 *
 * Default maxAgeMs: 30 minutes.
 */
export function evictStale(
  cache: ValueCache,
  maxAgeMs = 30 * 60 * 1000,
): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [field, fc] of cache.fields) {
    if (fc.lastAccess < cutoff) {
      cache.fields.delete(field);
    }
  }
}
