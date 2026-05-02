import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { tryRecoverFromChunkError } from './lib/chunk-reload';
import { pressureMonitor } from './perf/pressure-monitor';
import { RESET_STORAGE_HASH, resetLocalStorage } from './lib/reset-storage';

// `#/reset-storage` recovery escape hatch — must run before anything else
// that touches OPFS or imports a worker, because the whole point is to
// recover from a state where those imports crash on load.
if (window.location.hash === RESET_STORAGE_HASH) {
  void runResetFlow();
} else {
  bootApp();
}

function bootApp() {
  // Phase 1 of cloud-tiered .eodb: start observing device pressure at boot.
  // This is read-only; nothing in the app changes behavior based on the score yet.
  pressureMonitor.start();

  // Vite fires `vite:preloadError` when a <link rel="modulepreload"> 404s —
  // this happens when the current tab was loaded from a previous deploy and
  // the new build's chunk hashes no longer match the ones referenced in the
  // cached index.html. Force a cache-busting reload to fetch fresh index.html.
  // Mirrored by `lazyWithRetry` in Layout.tsx for the import()-rejection path.
  window.addEventListener('vite:preloadError', (e) => {
    if (tryRecoverFromChunkError()) {
      e.preventDefault();
    }
  });

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

async function runResetFlow() {
  // Render a plain-DOM status page — we deliberately don't mount React here
  // because the reset path is invoked precisely when something on the React
  // side is too broken to load.
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = renderStatus('Clearing local storage…', null);
  }
  let report;
  try {
    report = await resetLocalStorage();
  } catch (e) {
    if (root) {
      root.innerHTML = renderStatus(
        'Reset failed.',
        e instanceof Error ? e.message : String(e),
      );
    }
    return;
  }
  if (root) {
    root.innerHTML = renderStatus('Local storage cleared. Reloading…', summarize(report));
  }
  // Drop the hash so the post-reload boot takes the normal path. Use
  // `replace` to avoid leaving the reset URL in history.
  history.replaceState(null, '', window.location.pathname + window.location.search);
  setTimeout(() => window.location.reload(), 800);
}

function summarize(r: { spacesRemoved: number; rootFilesRemoved: number; cryptoDbsRemoved: number; errors: string[] }): string {
  const parts = [
    `${r.spacesRemoved} space dir(s)`,
    `${r.rootFilesRemoved} root file(s)`,
    `${r.cryptoDbsRemoved} crypto DB(s)`,
  ];
  if (r.errors.length > 0) parts.push(`${r.errors.length} error(s)`);
  return parts.join(', ');
}

function renderStatus(title: string, detail: string | null): string {
  const safeTitle = escapeHtml(title);
  const safeDetail = detail == null ? '' : `<p style="opacity:0.7">${escapeHtml(detail)}</p>`;
  return `
    <div style="font-family:system-ui,sans-serif;padding:2rem;max-width:32rem;margin:4rem auto;line-height:1.5">
      <h1 style="font-size:1.25rem;margin:0 0 1rem">${safeTitle}</h1>
      ${safeDetail}
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
