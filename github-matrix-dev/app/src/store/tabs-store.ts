import { create } from 'zustand';
import type { AppRoute, View } from '../lib/router';

/**
 * A single browser-style tab. Each tab owns a route snapshot — the active
 * tab's route is reflected in the URL hash, and navigation updates the
 * active tab's route rather than replacing the global view.
 *
 * `id` is a stable opaque key so React can identify tabs across re-orders.
 */
export interface Tab {
  id: string;
  view: View;
  space: string | null;
  scope: string | null;
  record: string | null;
  builderViewId: string | null;
  customPageId: string | null;
  query: Record<string, string>;
  /** Human-readable title shown on the tab. Recomputed on route change. */
  title: string;
  /** Short icon glyph (monospace/unicode) shown next to the title. */
  icon: string;
}

export interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;

  /** Replace the entire tab list (used on initial hydration). */
  hydrate: (tabs: Tab[], activeTabId: string | null) => void;

  /**
   * Open a tab for the given route. If `reuseByView` is true and a tab with
   * the same view+space+scope already exists, focus it instead of creating
   * a duplicate. Otherwise always append a new tab and focus it.
   */
  openTab: (
    partial: Partial<AppRoute> & { title?: string; icon?: string },
    opts?: { reuseByView?: boolean; inBackground?: boolean },
  ) => string;

  /** Update the active tab's route (called by navigate()). */
  updateActiveTab: (partial: Partial<AppRoute>) => void;

  /** Patch any tab's title/icon — used when route context resolves to names. */
  setTabMeta: (id: string, meta: Partial<Pick<Tab, 'title' | 'icon'>>) => void;

  /** Focus a tab by ID. */
  setActiveTab: (id: string) => void;

  /** Close a tab. If it was active, focus a neighbour. */
  closeTab: (id: string) => void;

  /** Reorder via drag — move `id` to `toIndex`. */
  moveTab: (id: string, toIndex: number) => void;
}

function makeId(): string {
  return (
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  );
}

/** Friendly default title for a bare view, before route context resolves. */
const VIEW_TITLES: Record<View, string> = {
  records: 'Records',
  log: 'Event log',
  graph: 'Graph',
  import: 'Import',
  compose: 'Compose',
  settings: 'Settings',
  builder: 'Builder',
  messages: 'Messages',
  people: 'People',
  multiuser: 'Multi-user test',
  api: 'API connections',
  members: 'Members',
  branch: 'Branches',
  nl: 'Natural language',
};

const VIEW_ICONS: Record<View, string> = {
  records: '\u25A6',       // ▦
  log: '\u2261',            // ≡
  graph: '\u25C8',          // ◈
  import: '\u2935',         // ⤵
  compose: '\u002B',        // +
  settings: '\u2699',       // ⚙
  builder: '\u25A3',        // ▣
  messages: '\u2709',       // ✉
  people: '\u2689',         // ⚉
  multiuser: '\u2690',      // ⚐
  api: '\u29C9',            // ⧉
  members: '\u2736',        // ✶
  branch: '\u22A2',         // ⊢
  nl: '\u2045',             // ⁅
};

export function defaultTitleFor(route: Partial<AppRoute>): string {
  const view = (route.view ?? 'records') as View;
  if (view === 'records') {
    if (route.scope) {
      const leaf = route.scope.split('.').pop() || route.scope;
      return leaf;
    }
    if (route.space) return route.space.replace(/^space[_.]/, '').replace(/_/g, ' ');
    return VIEW_TITLES.records;
  }
  return VIEW_TITLES[view] ?? view;
}

export function defaultIconFor(route: Partial<AppRoute>): string {
  const view = (route.view ?? 'records') as View;
  return VIEW_ICONS[view] ?? '\u25A6';
}

function routeFromTab(tab: Tab): AppRoute {
  return {
    view: tab.view,
    space: tab.space,
    scope: tab.scope,
    record: tab.record,
    builderViewId: tab.builderViewId,
    customPageId: tab.customPageId,
    query: tab.query,
  };
}

function tabFromRoute(
  route: Partial<AppRoute>,
  meta?: { title?: string; icon?: string; id?: string },
): Tab {
  return {
    id: meta?.id ?? makeId(),
    view: (route.view ?? 'records') as View,
    space: route.space ?? null,
    scope: route.scope ?? null,
    record: route.record ?? null,
    builderViewId: route.builderViewId ?? null,
    customPageId: route.customPageId ?? null,
    query: route.query ?? {},
    title: meta?.title ?? defaultTitleFor(route),
    icon: meta?.icon ?? defaultIconFor(route),
  };
}

export { routeFromTab, tabFromRoute };

/** Tab identity for "reuse" logic — two tabs are "the same place" when
 * their view+space+scope (and for builder, view-id/page-id) match. */
function sameIdentity(t: Tab, r: Partial<AppRoute>): boolean {
  if (t.view !== (r.view ?? 'records')) return false;
  if ((r.space ?? null) !== null && t.space !== r.space) return false;
  if (t.view === 'records') {
    if ((r.scope ?? null) !== t.scope) return false;
  }
  if (t.view === 'builder') {
    if ((r.builderViewId ?? null) !== t.builderViewId) return false;
    if ((r.customPageId ?? null) !== t.customPageId) return false;
  }
  return true;
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  hydrate: (tabs, activeTabId) => set({ tabs, activeTabId }),

  openTab: (partial, opts) => {
    const state = get();
    if (opts?.reuseByView) {
      const existing = state.tabs.find((t) => sameIdentity(t, partial));
      if (existing) {
        set({
          activeTabId: opts?.inBackground ? state.activeTabId : existing.id,
          tabs: state.tabs.map((t) =>
            t.id === existing.id
              ? {
                  ...t,
                  ...(partial.scope !== undefined ? { scope: partial.scope } : {}),
                  ...(partial.record !== undefined ? { record: partial.record } : {}),
                  ...(partial.query !== undefined ? { query: partial.query } : {}),
                  title: partial.title ?? defaultTitleFor({ ...routeFromTab(t), ...partial }),
                  icon: partial.icon ?? defaultIconFor({ ...routeFromTab(t), ...partial }),
                }
              : t,
          ),
        });
        return existing.id;
      }
    }
    const tab = tabFromRoute(partial, { title: partial.title, icon: partial.icon });
    set({
      tabs: [...state.tabs, tab],
      activeTabId: opts?.inBackground ? state.activeTabId : tab.id,
    });
    return tab.id;
  },

  updateActiveTab: (partial) => {
    const state = get();
    if (!state.activeTabId) return;
    set({
      tabs: state.tabs.map((t) => {
        if (t.id !== state.activeTabId) return t;
        const next: Tab = {
          ...t,
          ...(partial.view !== undefined ? { view: partial.view } : {}),
          ...(partial.space !== undefined ? { space: partial.space } : {}),
          ...(partial.scope !== undefined ? { scope: partial.scope } : {}),
          ...(partial.record !== undefined ? { record: partial.record } : {}),
          ...(partial.builderViewId !== undefined
            ? { builderViewId: partial.builderViewId }
            : {}),
          ...(partial.customPageId !== undefined
            ? { customPageId: partial.customPageId }
            : {}),
          ...(partial.query !== undefined ? { query: partial.query } : {}),
        };
        // Recompute title/icon from the new route unless this tab was
        // given an explicit title that still matches its view.
        const viewChanged = partial.view !== undefined && partial.view !== t.view;
        const scopeChanged = partial.scope !== undefined && partial.scope !== t.scope;
        if (viewChanged || scopeChanged || t.title === defaultTitleFor(routeFromTab(t))) {
          next.title = defaultTitleFor(routeFromTab(next));
          next.icon = defaultIconFor(routeFromTab(next));
        }
        return next;
      }),
    });
  },

  setTabMeta: (id, meta) =>
    set({
      tabs: get().tabs.map((t) => (t.id === id ? { ...t, ...meta } : t)),
    }),

  setActiveTab: (id) => {
    const state = get();
    if (!state.tabs.some((t) => t.id === id)) return;
    set({ activeTabId: id });
  },

  closeTab: (id) => {
    const state = get();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const remaining = state.tabs.filter((t) => t.id !== id);
    let nextActive = state.activeTabId;
    if (state.activeTabId === id) {
      // Prefer the tab to the right, else the tab to the left, else null.
      nextActive = remaining[idx]?.id ?? remaining[idx - 1]?.id ?? null;
    }
    set({ tabs: remaining, activeTabId: nextActive });
  },

  moveTab: (id, toIndex) => {
    const state = get();
    const from = state.tabs.findIndex((t) => t.id === id);
    if (from === -1) return;
    const clamped = Math.max(0, Math.min(toIndex, state.tabs.length - 1));
    if (from === clamped) return;
    const next = state.tabs.slice();
    const [removed] = next.splice(from, 1);
    next.splice(clamped, 0, removed);
    set({ tabs: next });
  },
}));
