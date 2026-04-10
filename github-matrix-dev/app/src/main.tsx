import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { tryRecoverFromChunkError } from './lib/chunk-reload';

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
