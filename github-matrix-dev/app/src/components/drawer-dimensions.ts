/**
 * Shared sizing for right-side detail drawers.
 *
 * Both the record detail drawer (RecordDetailDrawer) and the field detail
 * drawer (SchemaFieldPanel) live in the same slot on the right side of the
 * table grid. They should feel like the same component — same default width,
 * same min/max, same resize behavior — so users see consistent visuals and a
 * single remembered width across both drawers.
 */

export const DRAWER_WIDTH_KEY = 'eo-record-drawer-width';
export const DRAWER_DEFAULT_WIDTH = 640;
export const DRAWER_MIN_WIDTH = 360;
export const DRAWER_MAX_WIDTH = 1200;

export function loadSavedDrawerWidth(): number {
  if (typeof window === 'undefined') return DRAWER_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(DRAWER_WIDTH_KEY);
    if (!raw) return DRAWER_DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return DRAWER_DEFAULT_WIDTH;
    return n;
  } catch {
    return DRAWER_DEFAULT_WIDTH;
  }
}

export function clampDrawerWidth(w: number): number {
  const maxByViewport = typeof window !== 'undefined'
    ? Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, window.innerWidth - 240))
    : DRAWER_MAX_WIDTH;
  return Math.max(DRAWER_MIN_WIDTH, Math.min(maxByViewport, w));
}

export function saveDrawerWidth(w: number): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(DRAWER_WIDTH_KEY, String(w)); } catch { /* ignore */ }
}
