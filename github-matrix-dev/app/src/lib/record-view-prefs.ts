/**
 * Per-browser preferences for the record detail view.
 *
 * Persisted to localStorage. The discovery sections (Similar Records,
 * Noticed, Patterns, Structural Twins, Dependency Cycle) are lazy-loaded
 * insights that some users find noisy; hidden by default and opt-in.
 */

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'eo-record-view-prefs';

export interface RecordViewPrefs {
  /** Render the bottom "discovery" lazy-section block. Default off. */
  showDiscovery: boolean;
}

const DEFAULT_PREFS: RecordViewPrefs = {
  showDiscovery: false,
};

let cached: RecordViewPrefs | null = null;
const listeners = new Set<(p: RecordViewPrefs) => void>();

export function loadRecordViewPrefs(): RecordViewPrefs {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RecordViewPrefs>;
      cached = { ...DEFAULT_PREFS, ...parsed };
      return cached;
    }
  } catch {
    // fall through
  }
  cached = { ...DEFAULT_PREFS };
  return cached;
}

export function setRecordViewPrefs(patch: Partial<RecordViewPrefs>): RecordViewPrefs {
  const next: RecordViewPrefs = { ...loadRecordViewPrefs(), ...patch };
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // quota / private mode
  }
  for (const cb of listeners) cb(next);
  return next;
}

export function subscribeRecordViewPrefs(cb: (p: RecordViewPrefs) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useRecordViewPrefs(): [RecordViewPrefs, (patch: Partial<RecordViewPrefs>) => void] {
  const [prefs, setPrefs] = useState<RecordViewPrefs>(loadRecordViewPrefs);
  useEffect(() => subscribeRecordViewPrefs(setPrefs), []);
  return [prefs, setRecordViewPrefs];
}
