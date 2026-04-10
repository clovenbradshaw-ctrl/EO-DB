import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
  ],
  base: './',
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
