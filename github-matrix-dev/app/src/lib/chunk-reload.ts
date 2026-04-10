/**
 * Stale-deploy recovery helpers.
 *
 * When a GitHub Pages deploy replaces all chunk hashes, open tabs loaded from
 * the previous deploy try to import chunks whose files no longer exist. The
 * import() promise rejects with "Failed to fetch dynamically imported module"
 * and the view gets stuck on an error.
 *
 * The obvious recovery is `window.location.reload()`. That is not enough on
 * GitHub Pages: `index.html` is served with `cache-control: max-age=600`, so
 * a plain reload re-uses the cached HTML — which still references the same
 * missing chunks. The reload guard flips, the error comes back immediately,
 * and the user is stuck until `max-age` expires or they hard-refresh.
 *
 * `forceFreshReload()` bypasses that by first issuing a `fetch()` with
 * `cache: 'reload'`, which forces the browser to revalidate the HTTP cache
 * entry for `index.html` against the origin. Once the cache is fresh, a
 * normal `location.reload()` picks up the new HTML (and therefore the new
 * chunk hashes). Any failures are swallowed so we always fall through to the
 * reload — even a stale reload is better than a permanent error screen.
 */

export const CHUNK_RELOAD_KEY = 'eo-chunk-reload';

export function isChunkLoadError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = (err as { message?: string }).message || '';
  const name = (err as { name?: string }).name || '';
  return (
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('error loading dynamically imported module') ||
    msg.includes('Importing a module script failed') ||
    // Safari sometimes surfaces this as a generic TypeError without the
    // "dynamically imported module" phrase — fall back to URL shape.
    (name === 'TypeError' && /\/assets\/[^/]+-[A-Za-z0-9_-]+\.js/.test(msg))
  );
}

/**
 * Force-revalidate the current document against the origin, then reload.
 *
 * Never returns in the happy path — the page navigates away. On failure it
 * still attempts `location.reload()` so the caller can treat this as a
 * terminal "goodbye" operation.
 */
export async function forceFreshReload(): Promise<void> {
  try {
    // `cache: 'reload'` tells the browser: ignore any cached entry for this
    // URL, hit the network, and write the fresh response into the HTTP cache.
    // The subsequent reload() then picks up that fresh entry.
    await fetch(window.location.href, {
      cache: 'reload',
      credentials: 'same-origin',
    });
  } catch {
    // Offline or blocked — proceed to reload anyway. A normal reload may
    // still succeed from the HTTP cache; worst case the user sees an offline
    // indicator instead of the chunk-load error screen.
  }
  // Also drop any Cache Storage entries, in case a service worker (now or
  // later) decides to shadow index.html.
  try {
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
  } catch {
    // ignore
  }
  window.location.reload();
}

/**
 * Trigger a one-shot stale-deploy recovery. Guarded by sessionStorage so we
 * don't reload-loop on a genuinely broken deploy. Returns `true` if a reload
 * was scheduled (caller should stop doing work); `false` if the guard was
 * already set (caller should surface the error normally).
 */
export function tryRecoverFromChunkError(): boolean {
  let alreadyTried = false;
  try {
    alreadyTried = sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1';
  } catch {
    // sessionStorage unavailable (private mode, disabled cookies) — treat as
    // "not tried" so we still attempt the reload once.
  }
  if (alreadyTried) return false;
  try {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
  } catch {
    // ignore — reload will still be attempted, may loop once but not forever
    // because the second failure path won't recurse into React.lazy again in
    // the same way.
  }
  // Fire-and-forget: we don't want to block React's Suspense resolution on
  // the network round-trip — the caller returns a never-resolving promise.
  void forceFreshReload();
  return true;
}

export function clearChunkReloadGuard(): void {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    // ignore
  }
}
