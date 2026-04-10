import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Vite fires `vite:preloadError` when a <link rel="modulepreload"> 404s —
// this happens when the current tab was loaded from a previous deploy and
// the new build's chunk hashes no longer match the ones referenced in the
// cached index.html. Force a one-time hard reload to fetch fresh index.html.
// Mirrored by `lazyWithRetry` in Layout.tsx for the import()-rejection path.
window.addEventListener('vite:preloadError', (e) => {
  if (sessionStorage.getItem('eo-chunk-reload') !== '1') {
    sessionStorage.setItem('eo-chunk-reload', '1');
    e.preventDefault();
    window.location.reload();
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
