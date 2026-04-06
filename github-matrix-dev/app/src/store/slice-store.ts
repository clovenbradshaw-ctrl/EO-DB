import { create } from 'zustand';
import type { SortRule } from '../components/SortPanel';
import type { FilterRule } from '../components/filter-types';
import type { TableSliceConfig, SliceSig, SavedSlice } from '../components/slice-types';
import { createDefaultConfig } from '../components/slice-types';

// ---------------------------------------------------------------------------
// localStorage helpers — SIG persistence
// ---------------------------------------------------------------------------

function sigKey(scope: string): string {
  return `eo-slice-sig:${scope}`;
}

function loadSig(scope: string): SliceSig | null {
  try {
    const raw = localStorage.getItem(sigKey(scope));
    if (!raw) return null;
    return JSON.parse(raw) as SliceSig;
  } catch {
    return null;
  }
}

function persistSig(sig: SliceSig): void {
  try {
    localStorage.setItem(sigKey(sig.scope), JSON.stringify(sig));
  } catch { /* quota exceeded — silently drop */ }
}

// ---------------------------------------------------------------------------
// localStorage helpers — savedSlices persistence
// ---------------------------------------------------------------------------

const SAVED_SLICES_KEY = 'eo-saved-slices';

function loadSavedSlices(): Record<string, SavedSlice> {
  try {
    const raw = localStorage.getItem(SAVED_SLICES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function persistSavedSlices(slices: Record<string, SavedSlice>): void {
  try {
    localStorage.setItem(SAVED_SLICES_KEY, JSON.stringify(slices));
  } catch { /* quota exceeded — silently drop */ }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SliceStoreState {
  /** Per-scope SIG cache (loaded lazily from localStorage) */
  sigs: Record<string, SliceSig>;

  /** Saved slices loaded from DB (INS entities), keyed by slice ID */
  savedSlices: Record<string, SavedSlice>;

  // --- SIG accessors ---

  /** Get or create the SIG for a scope */
  getSig: (scope: string) => SliceSig;

  /** Get the active config for a scope (from SIG) */
  getConfig: (scope: string) => TableSliceConfig;

  // --- Config mutations (all mark dirty + persist SIG) ---

  setColumnOrder: (scope: string, order: string[]) => void;
  setColumnWidth: (scope: string, key: string, width: number) => void;
  setColumnWidths: (scope: string, widths: Record<string, number>) => void;
  toggleHiddenColumn: (scope: string, key: string) => void;
  setHiddenColumns: (scope: string, hidden: string[]) => void;
  showAllColumns: (scope: string) => void;
  setSorts: (scope: string, sorts: SortRule[]) => void;
  setFilters: (scope: string, filters: FilterRule[], conjunction?: 'AND' | 'OR') => void;
  setFilterConjunction: (scope: string, conjunction: 'AND' | 'OR') => void;
  setShowLastUpdated: (scope: string, show: boolean) => void;
  setRowHeight: (scope: string, height: 'compact' | 'default' | 'tall') => void;
  setCellOverflow: (scope: string, mode: 'clip' | 'wrap') => void;
  setProfileFields: (scope: string, fields: string[] | undefined) => void;
  setDisplayField: (scope: string, field: string | undefined) => void;
  setShowFieldIds: (scope: string, show: boolean) => void;

  // --- Slice lifecycle ---

  /** Load a saved slice's config into the SIG for a scope */
  activateSlice: (scope: string, slice: SavedSlice) => void;

  /** Reset to default (no active slice) */
  resetToDefault: (scope: string) => void;

  /** After saving: mark SIG clean and set activeSliceId */
  markSaved: (scope: string, sliceId: string) => void;

  /** Register saved slices from DB */
  registerSavedSlices: (slices: SavedSlice[]) => void;

  /** Remove a saved slice */
  removeSavedSlice: (sliceId: string) => void;

  /** Get saved slices for a scope */
  getSlicesForScope: (scope: string) => SavedSlice[];
}

export const useSliceStore = create<SliceStoreState>((set, get) => ({
  sigs: {},
  savedSlices: loadSavedSlices(),

  getSig(scope: string): SliceSig {
    const existing = get().sigs[scope];
    if (existing) return existing;

    // Try localStorage
    const persisted = loadSig(scope);
    if (persisted) {
      // Never restore __schema as the active slice — always start on grid
      if (persisted.activeSliceId === '__schema') {
        persisted.activeSliceId = null;
      }
      set((s) => ({ sigs: { ...s.sigs, [scope]: persisted } }));
      return persisted;
    }

    // Create default
    const fresh: SliceSig = {
      scope,
      activeSliceId: null,
      config: createDefaultConfig(),
      dirty: false,
    };
    set((s) => ({ sigs: { ...s.sigs, [scope]: fresh } }));
    persistSig(fresh);
    return fresh;
  },

  getConfig(scope: string): TableSliceConfig {
    return get().getSig(scope).config;
  },

  // --- Internal helper to update a SIG ---
  ...({} as any), // TS trick — real mutations below

  setColumnOrder(scope, order) {
    _updateConfig(set, get, scope, { columnOrder: order });
  },

  setColumnWidth(scope, key, width) {
    const config = get().getSig(scope).config;
    _updateConfig(set, get, scope, {
      columnWidths: { ...config.columnWidths, [key]: width },
    });
  },

  setColumnWidths(scope, widths) {
    _updateConfig(set, get, scope, { columnWidths: widths });
  },

  toggleHiddenColumn(scope, key) {
    const config = get().getSig(scope).config;
    const hidden = new Set(config.hiddenColumns);
    if (hidden.has(key)) hidden.delete(key);
    else hidden.add(key);
    _updateConfig(set, get, scope, { hiddenColumns: [...hidden] });
  },

  setHiddenColumns(scope, hidden) {
    _updateConfig(set, get, scope, { hiddenColumns: hidden });
  },

  showAllColumns(scope) {
    _updateConfig(set, get, scope, { hiddenColumns: [] });
  },

  setSorts(scope, sorts) {
    _updateConfig(set, get, scope, { sorts });
  },

  setFilters(scope, filters, conjunction) {
    const patch: Partial<TableSliceConfig> = { filters };
    if (conjunction) patch.filterConjunction = conjunction;
    _updateConfig(set, get, scope, patch);
  },

  setFilterConjunction(scope, conjunction) {
    _updateConfig(set, get, scope, { filterConjunction: conjunction });
  },

  setShowLastUpdated(scope, show) {
    _updateConfig(set, get, scope, { showLastUpdated: show });
  },

  setRowHeight(scope, height) {
    _updateConfig(set, get, scope, { rowHeight: height });
  },

  setCellOverflow(scope, mode) {
    _updateConfig(set, get, scope, { cellOverflow: mode });
  },

  setProfileFields(scope, fields) {
    _updateConfig(set, get, scope, { profileFields: fields });
  },

  setDisplayField(scope, field) {
    _updateConfig(set, get, scope, { displayField: field });
  },

  setShowFieldIds(scope, show) {
    _updateConfig(set, get, scope, { showFieldIds: show });
  },

  activateSlice(scope, slice) {
    const sig: SliceSig = {
      scope,
      activeSliceId: slice.id,
      config: { ...slice.config },
      dirty: false,
    };
    set((s) => ({ sigs: { ...s.sigs, [scope]: sig } }));
    persistSig(sig);
  },

  resetToDefault(scope) {
    const sig: SliceSig = {
      scope,
      activeSliceId: null,
      config: createDefaultConfig(),
      dirty: false,
    };
    set((s) => ({ sigs: { ...s.sigs, [scope]: sig } }));
    persistSig(sig);
  },

  markSaved(scope, sliceId) {
    const existing = get().getSig(scope);
    const sig: SliceSig = { ...existing, activeSliceId: sliceId, dirty: false };
    set((s) => ({ sigs: { ...s.sigs, [scope]: sig } }));
    persistSig(sig);
  },

  registerSavedSlices(slices) {
    const map: Record<string, SavedSlice> = { ...get().savedSlices };
    for (const v of slices) map[v.id] = v;
    set({ savedSlices: map });
    persistSavedSlices(map);
  },

  removeSavedSlice(sliceId) {
    const map = { ...get().savedSlices };
    delete map[sliceId];
    set({ savedSlices: map });
    persistSavedSlices(map);
  },

  getSlicesForScope(scope) {
    return Object.values(get().savedSlices).filter((v) => v.scope === scope);
  },
}));

// ---------------------------------------------------------------------------
// Internal config updater — merges partial config, marks dirty, persists
// ---------------------------------------------------------------------------

function _updateConfig(
  set: (fn: (s: SliceStoreState) => Partial<SliceStoreState>) => void,
  get: () => SliceStoreState,
  scope: string,
  patch: Partial<TableSliceConfig>,
): void {
  const sig = get().getSig(scope);
  const updated: SliceSig = {
    ...sig,
    config: { ...sig.config, ...patch },
    dirty: true,
  };
  set((s) => ({ sigs: { ...s.sigs, [scope]: updated } }));
  persistSig(updated);
}
