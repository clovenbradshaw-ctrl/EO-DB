import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
  ],
  base: './',
  // Shard-fold worker (`src/workers/fold-shard.worker.ts`) is a module worker
  // (constructed with `{ type: 'module' }`) and uses a dynamic import from
  // fold-worker-transport → fold.ts to break a module cycle. That dynamic
  // import triggers code-splitting in the worker bundle, which Vite's default
  // `iife` worker format rejects. Emitting workers as ES modules keeps the
  // `new Worker(url, { type: 'module' })` construction matching the emitted
  // format and lets the dynamic import split normally.
  worker: {
    format: 'es',
  },
  build: {
    outDir: '../../docs',
    emptyOutDir: true,
    rollupOptions: {
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
