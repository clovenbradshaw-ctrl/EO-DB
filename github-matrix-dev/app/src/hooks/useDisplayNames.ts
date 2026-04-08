/**
 * useDisplayNames — resolves full target paths to human-readable display names.
 *
 * Resolution order per target:
 * 1. Parent scope's _displayField → pull that field from the record
 * 2. value.name
 * 3. value.title
 * 4. formatName(lastSegment) — strips tbl/rec/fld prefixes, adds spaces
 */

import { useState, useEffect, useMemo } from 'react';
import { useEoStore } from '../store/eo-store';
import { formatName } from '../components/scope-picker-utils';

export function useDisplayNames(targets: string[]): Map<string, string> {
  const getState = useEoStore(s => s.getState);
  const ready = useEoStore(s => s.ready);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  // Stable key for the dependency array
  const key = useMemo(() => targets.slice().sort().join('\n'), [targets]);

  useEffect(() => {
    if (!ready || targets.length === 0) return;
    let cancelled = false;

    (async () => {
      const result = new Map<string, string>();

      // Collect unique parent scopes to batch-fetch _displayField configs
      const uniqueParents = new Set<string>();
      for (const t of targets) {
        const parts = t.split('.');
        if (parts.length >= 2) {
          uniqueParents.add(parts.slice(0, -1).join('.'));
        }
      }

      // Fetch parent scopes for _displayField
      const parentDisplayFields = new Map<string, string>();
      await Promise.all([...uniqueParents].map(async (parent) => {
        try {
          const state = await getState(parent);
          if (state?.value?._displayField) {
            parentDisplayFields.set(parent, state.value._displayField);
          }
          // Also resolve the parent scope name (for Grounds source paths)
          const name = state?.value?.name || state?.value?.title;
          if (name) result.set(parent, String(name));
        } catch { /* ignore */ }
      }));

      // Resolve each target
      await Promise.all(targets.map(async (t) => {
        if (result.has(t)) return; // already resolved as a parent scope
        try {
          const state = await getState(t);
          if (!state) {
            result.set(t, formatName(t.split('.').pop() || t));
            return;
          }

          const parentTarget = t.split('.').slice(0, -1).join('.');
          const displayFieldKey = parentDisplayFields.get(parentTarget);
          let name: string | null = null;

          if (displayFieldKey) {
            const fieldVal = state.value?.fields?.[displayFieldKey] ?? state.value?.[displayFieldKey];
            if (fieldVal != null) name = String(fieldVal);
          }
          if (!name) name = state.value?.name || state.value?.title || null;

          result.set(t, name || formatName(t.split('.').pop() || t));
        } catch {
          result.set(t, formatName(t.split('.').pop() || t));
        }
      }));

      if (!cancelled) setNames(result);
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, key, getState]);

  return names;
}
