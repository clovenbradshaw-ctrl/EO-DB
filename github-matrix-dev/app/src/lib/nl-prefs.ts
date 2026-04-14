/**
 * Per-browser user preferences for the Natural Language document-explorer
 * feature. Follows the same pattern as presence-prefs.ts — localStorage-backed,
 * module-cached, listener set, React hook.
 *
 * The NL feature is hidden behind `enabled` so it does not clutter the UI for
 * users who are not ingesting documents.
 */

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'eo-nl-prefs';

export interface NLPrefs {
  /** Whether NL UI (nav item, view) is exposed at all. */
  enabled: boolean;
  /** After upload, immediately classify all extracted clauses. */
  autoClassifyOnUpload: boolean;
  /** Minimum confidence gap below which a classification is flagged as a boundary. */
  confidenceThreshold: number;
  /** Include top-k clause↔clause similarity edges (expensive; off by default). */
  emitSimilarityEdges: boolean;
}

const DEFAULT_PREFS: NLPrefs = {
  enabled: false,
  autoClassifyOnUpload: true,
  confidenceThreshold: 0.05,
  emitSimilarityEdges: false,
};

let cached: NLPrefs | null = null;
const listeners = new Set<(p: NLPrefs) => void>();

export function loadNLPrefs(): NLPrefs {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<NLPrefs>;
      cached = { ...DEFAULT_PREFS, ...parsed };
      return cached;
    }
  } catch {
    // Corrupt JSON — fall through to defaults.
  }
  cached = { ...DEFAULT_PREFS };
  return cached;
}

export function setNLPrefs(patch: Partial<NLPrefs>): NLPrefs {
  const next: NLPrefs = { ...loadNLPrefs(), ...patch };
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

export function subscribeNLPrefs(cb: (p: NLPrefs) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * React hook: returns `[prefs, setPatch]`. `setPatch` is stable across renders
 * (it writes through to the module-level setter), so it's safe to pass into
 * dependency arrays.
 */
export function useNLPrefs(): [NLPrefs, (patch: Partial<NLPrefs>) => void] {
  const [prefs, setPrefs] = useState<NLPrefs>(loadNLPrefs);
  useEffect(() => subscribeNLPrefs(setPrefs), []);
  return [prefs, setNLPrefs];
}
