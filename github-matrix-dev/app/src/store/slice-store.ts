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
    const parsed = JSON.parse(raw) as SliceSig;
    return {
      ...parsed,
      scope,
      config: normalizeTableSliceConfig(parsed.config),
    };
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
// localStorage helpers — openScopes persistence
// ---------------------------------------------------------------------------

const OPEN_SCOPES_KEY = 'eo-open-scopes';

function loadOpenScopes(): string[] {
  try {
    const raw = localStorage.getItem(OPEN_SCOPES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function persistOpenScopes(scopes: string[]): void {
  try {
    localStorage.setItem(OPEN_SCOPES_KEY, JSON.stringify(scopes));
  } catch { /* quota exceeded — silently drop */ }
}

// ---------------------------------------------------------------------------
// localStorage helpers — pinnedScopes persistence
// ---------------------------------------------------------------------------

const PINNED_SCOPES_KEY = 'eo-pinned-scopes';

function loadPinnedScopes(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_SCOPES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function persistPinnedScopes(scopes: string[]): void {
  try {
    localStorage.setItem(PINNED_SCOPES_KEY, JSON.stringify(scopes));
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
  setKanbanField: (scope: string, field: string | undefined) => void;
  setCalendarField: (scope: string, field: string | undefined) => void;

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

  // --- Open scopes (multi-collection tabs) ---

  /** Ordered list of scopes with open tabs */
  openScopes: string[];

  /** Scopes that are pinned (won't be swapped out when opening a new scope) */
  pinnedScopes: string[];

  /** Add a scope to the open tabs list (closes unpinned scopes) */
  openScope: (scope: string) => void;

  /** Remove a scope from the open tabs list and clean up its sig */
  closeScope: (scope: string) => void;

  /** Pin a scope so it stays open */
  pinScope: (scope: string) => void;

  /** Unpin a scope so it can be swapped out */
  unpinScope: (scope: string) => void;

  /** Check if a scope is pinned */
  isPinned: (scope: string) => boolean;

  /** Get the ordered list of open scopes */
  getOpenScopes: () => string[];

  /**
   * Wipe every slice-store artifact rooted in a space. Drops in-memory SIGs,
   * filters open/pinned scopes, removes saved slices scoped to the space, and
   * clears the matching `eo-slice-sig:` localStorage entries. Used when
   * leaving a space so state does not leak back in on re-entry.
   */
  clearSpaceScopes: (spaceId: string) => void;
}

/** True if a scope string is equal to or rooted inside `spaceId`. */
function scopeBelongsToSpace(scope: string, spaceId: string): boolean {
  return scope === spaceId || scope.startsWith(spaceId + '.');
}

export const useSliceStore = create<SliceStoreState>((set, get) => ({
  sigs: {},
  savedSlices: loadSavedSlices(),
  openScopes: loadOpenScopes(),
  pinnedScopes: loadPinnedScopes(),

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

  setKanbanField(scope, field) {
    _updateConfig(set, get, scope, { kanbanField: field });
  },

  setCalendarField(scope, field) {
    _updateConfig(set, get, scope, { calendarField: field });
  },

  activateSlice(scope, slice) {
    // Fast path — if the slice is already active and the user hasn't made
    // unsaved changes, re-clicking the tab is a no-op.  Skipping the set()
    // keeps existing config object references alive, which prevents the
    // downstream useMemo in TableView (filter + sort over all records)
    // from being invalidated on an effectively no-op click.
    const existing = get().sigs[scope];
    if (existing && existing.activeSliceId === slice.id && !existing.dirty) {
      return;
    }
    const sig: SliceSig = {
      scope,
      activeSliceId: slice.id,
      config: normalizeTableSliceConfig(slice.config),
      dirty: false,
    };
    set((s) => ({ sigs: { ...s.sigs, [scope]: sig } }));
    persistSig(sig);
  },

  resetToDefault(scope) {
    // Same fast path as activateSlice: re-clicking the Grid tab while already
    // on the default (and clean) view must not churn SIG references.
    const existing = get().sigs[scope];
    if (existing && existing.activeSliceId === null && !existing.dirty) {
      return;
    }
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

  openScope(scope) {
    const current = get().openScopes;
    if (current.includes(scope)) return;
    const pinned = get().pinnedScopes;
    // Close any unpinned scopes — only pinned ones survive
    const kept = current.filter((s) => pinned.includes(s));
    const updated = [...kept, scope];
    // Clean up sigs for closed scopes
    const closed = current.filter((s) => !pinned.includes(s));
    if (closed.length > 0) {
      const sigs = { ...get().sigs };
      for (const s of closed) delete sigs[s];
      set({ sigs });
    }
    set({ openScopes: updated });
    persistOpenScopes(updated);
  },

  closeScope(scope) {
    const updated = get().openScopes.filter((s) => s !== scope);
    set({ openScopes: updated });
    persistOpenScopes(updated);
    // Also unpin if pinned
    const pinned = get().pinnedScopes;
    if (pinned.includes(scope)) {
      const updatedPinned = pinned.filter((s) => s !== scope);
      set({ pinnedScopes: updatedPinned });
      persistPinnedScopes(updatedPinned);
    }
    // Clean up sig from memory (localStorage sig stays for potential re-open)
    const sigs = { ...get().sigs };
    delete sigs[scope];
    set({ sigs });
  },

  pinScope(scope) {
    const current = get().pinnedScopes;
    if (current.includes(scope)) return;
    const updated = [...current, scope];
    set({ pinnedScopes: updated });
    persistPinnedScopes(updated);
  },

  unpinScope(scope) {
    const updated = get().pinnedScopes.filter((s) => s !== scope);
    set({ pinnedScopes: updated });
    persistPinnedScopes(updated);
  },

  isPinned(scope) {
    return get().pinnedScopes.includes(scope);
  },

  getOpenScopes() {
    return get().openScopes;
  },

  clearSpaceScopes(spaceId: string) {
    // Drop in-memory SIGs for scopes rooted in this space
    const sigs = { ...get().sigs };
    for (const scope of Object.keys(sigs)) {
      if (scopeBelongsToSpace(scope, spaceId)) delete sigs[scope];
    }

    // Drop saved slices whose scope is rooted in this space
    const savedSlices = { ...get().savedSlices };
    for (const [id, slice] of Object.entries(savedSlices)) {
      if (scopeBelongsToSpace(slice.scope, spaceId)) delete savedSlices[id];
    }

    // Filter open/pinned scopes
    const openScopes = get().openScopes.filter((s) => !scopeBelongsToSpace(s, spaceId));
    const pinnedScopes = get().pinnedScopes.filter((s) => !scopeBelongsToSpace(s, spaceId));

    set({ sigs, savedSlices, openScopes, pinnedScopes });
    persistSavedSlices(savedSlices);
    persistOpenScopes(openScopes);
    persistPinnedScopes(pinnedScopes);

    // Clear persisted per-scope SIGs from localStorage. The SIG key format
    // is `eo-slice-sig:{scope}` (see sigKey() above).
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('eo-slice-sig:')) continue;
        const scope = key.slice('eo-slice-sig:'.length);
        if (scopeBelongsToSpace(scope, spaceId)) toRemove.push(key);
      }
      for (const key of toRemove) localStorage.removeItem(key);
    } catch { /* localStorage unavailable — best effort */ }
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

function normalizeTableSliceConfig(config?: Partial<TableSliceConfig> | null): TableSliceConfig {
  const defaults = createDefaultConfig();
  return {
    ...defaults,
    ...(config ?? {}),
    columnOrder: Array.isArray(config?.columnOrder) ? config.columnOrder : defaults.columnOrder,
    columnWidths: config?.columnWidths && typeof config.columnWidths === 'object' ? config.columnWidths : defaults.columnWidths,
    hiddenColumns: Array.isArray(config?.hiddenColumns) ? config.hiddenColumns : defaults.hiddenColumns,
    sorts: Array.isArray(config?.sorts) ? config.sorts : defaults.sorts,
    filters: Array.isArray(config?.filters) ? config.filters : defaults.filters,
    filterConjunction: config?.filterConjunction === 'OR' ? 'OR' : 'AND',
    showLastUpdated: typeof config?.showLastUpdated === 'boolean' ? config.showLastUpdated : defaults.showLastUpdated,
  };
}
