import { create } from 'zustand';
import type { SortRule } from '../components/SortPanel';
import type { FilterRule } from '../components/filter-types';
import type { TableViewConfig, ViewSig, SavedView } from '../components/view-types';
import { createDefaultConfig } from '../components/view-types';

// ---------------------------------------------------------------------------
// localStorage helpers — SIG persistence
// ---------------------------------------------------------------------------

function sigKey(scope: string): string {
  return `eo-view-sig:${scope}`;
}

function loadSig(scope: string): ViewSig | null {
  try {
    const raw = localStorage.getItem(sigKey(scope));
    if (!raw) return null;
    return JSON.parse(raw) as ViewSig;
  } catch {
    return null;
  }
}

function persistSig(sig: ViewSig): void {
  try {
    localStorage.setItem(sigKey(sig.scope), JSON.stringify(sig));
  } catch { /* quota exceeded — silently drop */ }
}

// ---------------------------------------------------------------------------
// localStorage helpers — savedViews persistence
// ---------------------------------------------------------------------------

const SAVED_VIEWS_KEY = 'eo-saved-views';

function loadSavedViews(): Record<string, SavedView> {
  try {
    const raw = localStorage.getItem(SAVED_VIEWS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function persistSavedViews(views: Record<string, SavedView>): void {
  try {
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views));
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
// Store
// ---------------------------------------------------------------------------

interface ViewStoreState {
  /** Per-scope SIG cache (loaded lazily from localStorage) */
  sigs: Record<string, ViewSig>;

  /** Saved views loaded from DB (INS entities), keyed by view ID */
  savedViews: Record<string, SavedView>;

  // --- SIG accessors ---

  /** Get or create the SIG for a scope */
  getSig: (scope: string) => ViewSig;

  /** Get the active config for a scope (from SIG) */
  getConfig: (scope: string) => TableViewConfig;

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

  // --- View lifecycle ---

  /** Load a saved view's config into the SIG for a scope */
  activateView: (scope: string, view: SavedView) => void;

  /** Reset to default (no active view) */
  resetToDefault: (scope: string) => void;

  /** After saving: mark SIG clean and set activeViewId */
  markSaved: (scope: string, viewId: string) => void;

  /** Register saved views from DB */
  registerSavedViews: (views: SavedView[]) => void;

  /** Remove a saved view */
  removeSavedView: (viewId: string) => void;

  /** Get saved views for a scope */
  getViewsForScope: (scope: string) => SavedView[];

  // --- Open scopes (multi-collection tabs) ---

  /** Ordered list of scopes with open tabs */
  openScopes: string[];

  /** Add a scope to the open tabs list */
  openScope: (scope: string) => void;

  /** Remove a scope from the open tabs list and clean up its sig */
  closeScope: (scope: string) => void;

  /** Get the ordered list of open scopes */
  getOpenScopes: () => string[];
}

export const useViewStore = create<ViewStoreState>((set, get) => ({
  sigs: {},
  savedViews: loadSavedViews(),
  openScopes: loadOpenScopes(),

  getSig(scope: string): ViewSig {
    const existing = get().sigs[scope];
    if (existing) return existing;

    // Try localStorage
    const persisted = loadSig(scope);
    if (persisted) {
      // Never restore __schema as the active view — always start on grid
      if (persisted.activeViewId === '__schema') {
        persisted.activeViewId = null;
      }
      set((s) => ({ sigs: { ...s.sigs, [scope]: persisted } }));
      return persisted;
    }

    // Create default
    const fresh: ViewSig = {
      scope,
      activeViewId: null,
      config: createDefaultConfig(),
      dirty: false,
    };
    set((s) => ({ sigs: { ...s.sigs, [scope]: fresh } }));
    persistSig(fresh);
    return fresh;
  },

  getConfig(scope: string): TableViewConfig {
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
    const patch: Partial<TableViewConfig> = { filters };
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

  activateView(scope, view) {
    const sig: ViewSig = {
      scope,
      activeViewId: view.id,
      config: { ...view.config },
      dirty: false,
    };
    set((s) => ({ sigs: { ...s.sigs, [scope]: sig } }));
    persistSig(sig);
  },

  resetToDefault(scope) {
    const sig: ViewSig = {
      scope,
      activeViewId: null,
      config: createDefaultConfig(),
      dirty: false,
    };
    set((s) => ({ sigs: { ...s.sigs, [scope]: sig } }));
    persistSig(sig);
  },

  markSaved(scope, viewId) {
    const existing = get().getSig(scope);
    const sig: ViewSig = { ...existing, activeViewId: viewId, dirty: false };
    set((s) => ({ sigs: { ...s.sigs, [scope]: sig } }));
    persistSig(sig);
  },

  registerSavedViews(views) {
    const map: Record<string, SavedView> = { ...get().savedViews };
    for (const v of views) map[v.id] = v;
    set({ savedViews: map });
    persistSavedViews(map);
  },

  removeSavedView(viewId) {
    const map = { ...get().savedViews };
    delete map[viewId];
    set({ savedViews: map });
    persistSavedViews(map);
  },

  getViewsForScope(scope) {
    return Object.values(get().savedViews).filter((v) => v.scope === scope);
  },

  openScope(scope) {
    const current = get().openScopes;
    if (current.includes(scope)) return;
    const updated = [...current, scope];
    set({ openScopes: updated });
    persistOpenScopes(updated);
  },

  closeScope(scope) {
    const updated = get().openScopes.filter((s) => s !== scope);
    set({ openScopes: updated });
    persistOpenScopes(updated);
    // Clean up sig from memory (localStorage sig stays for potential re-open)
    const sigs = { ...get().sigs };
    delete sigs[scope];
    set({ sigs });
  },

  getOpenScopes() {
    return get().openScopes;
  },
}));

// ---------------------------------------------------------------------------
// Internal config updater — merges partial config, marks dirty, persists
// ---------------------------------------------------------------------------

function _updateConfig(
  set: (fn: (s: ViewStoreState) => Partial<ViewStoreState>) => void,
  get: () => ViewStoreState,
  scope: string,
  patch: Partial<TableViewConfig>,
): void {
  const sig = get().getSig(scope);
  const updated: ViewSig = {
    ...sig,
    config: { ...sig.config, ...patch },
    dirty: true,
  };
  set((s) => ({ sigs: { ...s.sigs, [scope]: updated } }));
  persistSig(updated);
}
