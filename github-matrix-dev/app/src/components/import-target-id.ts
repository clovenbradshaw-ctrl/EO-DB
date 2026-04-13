/**
 * import-target-id — generic-row target-ID generator used by ImportView.
 *
 * Extracted as a pure function so the collision-guarantee property is
 * directly testable. The shape of the ID is:
 *
 *   rec_<zero-padded row index>_<12 hex chars of entropy>
 *
 * The row index guarantees no within-import collision — two rows with
 * different indices produce different IDs by construction, regardless of
 * the random suffix. The suffix keeps back-to-back imports of the same
 * file from colliding with prior imports (~2^48 headroom per import,
 * which makes inter-import collision negligible for any realistic
 * workload).
 *
 * Historical note. This helper replaces a `crypto.randomUUID().slice(0, 8)`
 * scheme that kept only 32 bits of entropy and birthday-collided at
 * ~100% for a 1M-row CSV, surfacing as "Target already instantiated"
 * out of the shard worker's helix pre-check.
 */

/**
 * Compute the padding width for a row index, given the total row count.
 * Kept at a minimum of 6 so small imports also produce visually stable
 * IDs, and so test fixtures that hand-assert on the format don't flex
 * when row counts change.
 */
export function genericRowIdWidth(rowCount: number): number {
  return Math.max(6, String(Math.max(0, rowCount - 1)).length);
}

/**
 * Produce a unique target ID for a generic CSV row. Callers pass:
 *   - rowIndex:   the 0-based position of the row in the import batch
 *   - width:      `genericRowIdWidth(rows.length)` (kept constant within
 *                 a batch so all IDs align)
 *   - randomHex:  a 12+ hex-char source of entropy (typically
 *                 `crypto.randomUUID().replace(/-/g,'').slice(0,12)`)
 *
 * Returns an ID of the form `rec_<padded-index>_<12-hex>`.
 */
export function generateGenericRowTargetId(
  rowIndex: number,
  width: number,
  randomHex: string,
): string {
  const padded = String(rowIndex).padStart(width, '0');
  const suffix = randomHex.slice(0, 12);
  return `rec_${padded}_${suffix}`;
}
