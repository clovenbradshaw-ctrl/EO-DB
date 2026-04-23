import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    react(),
  ],
  base: './',
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../../src/shared', import.meta.url)),
    },
  },
  // Shard-fold worker (`src/workers/fold-shard.worker.ts`) is a module worker
  // (constructed with `{ type: 'module' }`) and uses a dynamic import from
  // fold-worker-transport → fold.ts to break a module cycle. That dynamic
  // import triggers code-splitting in the worker bundle, which Vite's default
  // `iife` worker format rejects. Emitting workers as ES modules keeps the
  // `new Worker(url, { type: 'module' })` construction matching the emitted
  // format and lets the dynamic import split normally.
  worker: {
    format: 'es',
    rollupOptions: {
      // `@xenova/transformers` is an optional runtime dependency dynamically
      // imported by `src/nl/classifier.worker.ts` with a `.catch(() => null)`
      // fallback. Marking it external prevents Rollup from failing the build
      // when the package isn't installed; at runtime the dynamic import
      // rejects cleanly and the worker posts an error message back to the
      // main thread.
      external: ['@xenova/transformers'],
    },
  },
  build: {
    outDir: '../../docs',
    emptyOutDir: true,
    rollupOptions: {
      external: ['@xenova/transformers'],
      output: {
        manualChunks: {
          'matrix-sdk': ['matrix-js-sdk'],
          'matrix-crypto': ['@matrix-org/matrix-sdk-crypto-wasm'],
          'react-vendor': ['react', 'react-dom'],
          'collab-editor': [
            'yjs',
            '@tiptap/core',
            '@tiptap/starter-kit',
            '@tiptap/extension-collaboration',
            '@tiptap/extension-collaboration-cursor',
          ],
        },
      },
    },
  },
});
