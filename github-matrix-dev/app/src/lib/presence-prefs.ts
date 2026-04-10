/**
 * Per-browser user preferences for the live-presence system.
 *
 * Two independent switches expose the UX the product spec asks for:
 *   - `showPeers` off  → "don't see other users"   (hides peer indicators)
 *   - `shareLocation` off → "move discretely"       (still online, no location)
 *
 * Preferences live in localStorage so they persist per browser profile
 * without needing any server round-trip. Subscribers are notified
 * synchronously so React components can re-render immediately on toggle.
 */

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'eo-presence-prefs';

export interface PresencePrefs {
  /** Render other users' presence (avatars, location dots) at all. */
  showPeers: boolean;
  /** Broadcast my own in-app location to peers. */
  shareLocation: boolean;
}

const DEFAULT_PREFS: PresencePrefs = {
  showPeers: true,
  shareLocation: true,
};

let cached: PresencePrefs | null = null;
const listeners = new Set<(p: PresencePrefs) => void>();

export function loadPresencePrefs(): PresencePrefs {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PresencePrefs>;
      cached = { ...DEFAULT_PREFS, ...parsed };
      return cached;
    }
  } catch {
    // Corrupt JSON — fall through to defaults.
  }
  cached = { ...DEFAULT_PREFS };
  return cached;
}

export function setPresencePrefs(patch: Partial<PresencePrefs>): PresencePrefs {
  const next: PresencePrefs = { ...loadPresencePrefs(), ...patch };
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota exceeded or private-mode storage denial — in-memory value still
    // applies for the rest of the session.
  }
  for (const cb of listeners) cb(next);
  return next;
}

export function subscribePresencePrefs(cb: (p: PresencePrefs) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * React hook: returns `[prefs, setPatch]`. `setPatch` is stable across
 * renders (it writes through to the module-level setter), so it's safe to
 * pass into dependency arrays.
 */
export function usePresencePrefs(): [PresencePrefs, (patch: Partial<PresencePrefs>) => void] {
  const [prefs, setPrefs] = useState<PresencePrefs>(loadPresencePrefs);
  useEffect(() => subscribePresencePrefs(setPrefs), []);
  return [prefs, setPresencePrefs];
}
