import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../../docs',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'matrix-sdk': ['matrix-js-sdk'],
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
  },
});
