import { useState, useEffect, useCallback, useRef } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type View = 'records' | 'log' | 'graph' | 'import' | 'compose' | 'settings' | 'builder' | 'messages' | 'people' | 'multiuser' | 'api' | 'members' | 'branch' | 'nl';

const VIEWS = new Set<string>(['records', 'log', 'graph', 'import', 'compose', 'settings', 'builder', 'messages', 'people', 'multiuser', 'api', 'members', 'branch', 'nl']);

export interface AppRoute {
  view: View;
  space: string | null;           // space target e.g. 'space_amino'
  scope: string | null;          // full dot-path e.g. 'tblClients'
  record: string | null;         // full dot-path e.g. 'tblClients.rec123'
  builderViewId: string | null;  // UUID when editing a builder view
  customPageId: string | null;   // slug or ID when viewing a custom page live
  query: Record<string, string>;
}

const DEFAULT_ROUTE: AppRoute = {
  view: 'records',
  space: null,
  scope: null,
  record: null,
  builderViewId: null,
  customPageId: null,
  query: {},
};

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

/** "Client Intake Form" -> "client-intake-form" */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Parse hash -> AppRoute
// ---------------------------------------------------------------------------

export function parseHash(hash: string): AppRoute {
  // Strip leading #
  let raw = hash.startsWith('#') ? hash.slice(1) : hash;
  // Strip leading /
  if (raw.startsWith('/')) raw = raw.slice(1);

  // Split off query params (everything after ?)
  const query: Record<string, string> = {};
  const qIdx = raw.indexOf('?');
  if (qIdx !== -1) {
    const qs = raw.slice(qIdx + 1);
    raw = raw.slice(0, qIdx);
    for (const pair of qs.split('&')) {
      const [k, v] = pair.split('=');
      if (k) query[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
    }
  }

  const segments = raw.split('/').filter(Boolean);
  const route: AppRoute = { ...DEFAULT_ROUTE, query };

  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];

    if (seg === 's' && i + 1 < segments.length) {
      // Space: /s/{spaceTarget}
      route.space = segments[i + 1];
      i += 2;
      continue;
    }

    if (seg === 't' && i + 1 < segments.length) {
      // Scope: /t/{scope}
      route.scope = segments[i + 1];
      i += 2;
      continue;
    }

    if (seg === 'r' && i + 1 < segments.length) {
      // Record: /r/{recordId}
      const recSeg = segments[i + 1];
      route.record = route.scope ? `${route.scope}.${recSeg}` : recSeg;
      i += 2;
      continue;
    }

    if (seg === 'p' && i + 1 < segments.length) {
      // Custom page: /p/{slug}
      route.customPageId = segments[i + 1];
      route.view = 'builder';
      i += 2;
      continue;
    }

    if (seg === 'builder') {
      route.view = 'builder';
      // Optional: /builder/{viewId}
      if (i + 1 < segments.length && !['t', 'r', 'p'].includes(segments[i + 1])) {
        route.builderViewId = segments[i + 1];
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    // System view
    if (VIEWS.has(seg)) {
      route.view = seg as View;
      i += 1;
      continue;
    }

    // Unknown segment — skip
    i += 1;
  }

  return route;
}

// ---------------------------------------------------------------------------
// Serialize AppRoute -> hash string
// ---------------------------------------------------------------------------

export function serializeRoute(route: AppRoute): string {
  const ordered: string[] = [];

  // Space prefix: /s/{spaceTarget}
  if (route.space) {
    ordered.push('s', route.space);
  }

  if (route.customPageId) {
    ordered.push('p', route.customPageId);
  } else if (route.builderViewId) {
    ordered.push('builder', route.builderViewId);
  } else if (route.view === 'builder') {
    ordered.push('builder');
  } else {
    // System view (omit 'records' as default)
    if (route.view !== 'records') {
      ordered.push(route.view);
    }

    if (route.scope) {
      ordered.push('t', route.scope);
    }

    if (route.record && route.scope) {
      const recSeg = route.record.replace(`${route.scope}.`, '');
      ordered.push('r', recSeg);
    }
  }

  let hash = '#/' + ordered.join('/');

  // Query params
  const entries = Object.entries(route.query).filter(([, v]) => v !== '');
  if (entries.length > 0) {
    const qs = entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    hash += '?' + qs;
  }

  return hash;
}

// ---------------------------------------------------------------------------
// React hook: useHashRoute
// ---------------------------------------------------------------------------

export function useHashRoute() {
  const [route, setRoute] = useState<AppRoute>(() => parseHash(window.location.hash));
  const suppressNextHashChange = useRef(false);

  // Listen for browser back/forward
  useEffect(() => {
    function onHashChange() {
      if (suppressNextHashChange.current) {
        suppressNextHashChange.current = false;
        return;
      }
      setRoute(parseHash(window.location.hash));
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((partial: Partial<AppRoute>) => {
    const current = parseHash(window.location.hash);
    const next: AppRoute = { ...current, ...partial };

    // Clear downstream state when changing upstream context
    if ('space' in partial && partial.space !== current.space) {
      if (!('scope' in partial)) next.scope = null;
      if (!('record' in partial)) next.record = null;
      if (!('view' in partial)) next.view = 'records';
      if (!('builderViewId' in partial)) next.builderViewId = null;
      if (!('customPageId' in partial)) next.customPageId = null;
    }
    if ('scope' in partial && partial.scope !== current.scope) {
      if (!('record' in partial)) next.record = null;
    }
    if ('view' in partial && partial.view !== current.view) {
      if (!('scope' in partial)) next.scope = current.scope;
      if (!('record' in partial)) next.record = null;
    }

    const hash = serializeRoute(next);
    if (hash !== window.location.hash) {
      suppressNextHashChange.current = true;
      window.location.hash = hash;
      setRoute(next);
    } else {
      setRoute(next);
    }
  }, []);

  return { route, navigate };
}
